// ==UserScript==
// @name         Strava Activity Route Renamer
// @namespace    https://tampermonkey.net/
// @version      4.3.1
// @description  Names Strava activities from the OSM residential areas actually crossed by the route
// @author       Antigravity
// @match        https://www.strava.com/activities/*/edit
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        residentialBufferM: 30,
        residentialCacheDays: 30,
        overpassMaxPoints: 180,
        overpassChunkPoints: 50,
        overpassTimeout: 25000,
        overpassAttempts: 3,
        overpassRetryDelay: 2000,
        maxNamePlaces: 7,
        stripParentheticals: true,
        coordPrecision: 4,
        rateLimit: 1050,
        nominatimPlaceZoom: 14,
        nominatimAddressZoom: 18,
        successDelay: 1500,
        errorDelay: 2000,
    };

    const STRINGS = {
        idle: 'Generate from Geo',
        downloading: '⌛ Downloading...',
        analyzing: '⌛ Analyzing...',
        landuse: '⌛ Loading residential areas',
        geocoding: '⌛ Geocoding',
        done: '✔️ Done!',
        error: '❌ Error',
        noGps: 'No GPS data found (manual entry or indoor activity?)',
        noId: 'Could not detect activity ID from URL.',
    };

    const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
    const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
    const GEOCODE_CACHE_PREFIX = 'strava_geocode_v9_';
    const RESIDENTIAL_CACHE_PREFIX = 'strava_residential_v1_';
    const BUTTON_ID = 'strava-route-rename-btn';
    const TRANSIENT_OVERPASS_STATUSES = new Set([429, 502, 503, 504]);
    const BUTTON_COLORS = {
        idle: '#fc4c02',
        hover: '#e34402',
        loading: '#888',
        success: '#4caf50',
        error: '#f44336',
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function geocodeCacheKey(lat, lon, zoom) {
        const precision = CONFIG.coordPrecision;
        return `${GEOCODE_CACHE_PREFIX}z${zoom}_${Number(lat).toFixed(precision)}_${Number(lon).toFixed(precision)}`;
    }

    function setButtonState(btn, text, state = 'idle') {
        btn.textContent = text;
        btn.dataset.state = state;
        btn.style.backgroundColor = BUTTON_COLORS[state] || BUTTON_COLORS.idle;
        btn.style.color = 'white';
    }

    function getDistance(lat1, lon1, lat2, lon2) {
        const earthRadiusKm = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function indexAtDistance(dists, target) {
        let lo = 0;
        let hi = dists.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (dists[mid] < target) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return (lo > 0 && Math.abs(dists[lo - 1] - target) < Math.abs(dists[lo] - target)) ? lo - 1 : lo;
    }

    // Douglas-Peucker simplification keeps the Overpass linestring compact.
    // The query radius includes the simplification tolerance, so no residential
    // polygon near the original GPX line is lost when bends are removed.
    function simplifyTrackForOverpass(track) {
        const n = track.lats.length;
        if (n <= 2) {
            return {
                points: Array.from({ length: n }, (_, i) => ({ lat: track.lats[i], lon: track.lons[i] })),
                toleranceKm: 0,
            };
        }

        const refLat = track.lats.reduce((sum, lat) => sum + lat, 0) / n;
        const kx = 111.32 * Math.cos(refLat * Math.PI / 180);
        const ky = 110.57;
        const xs = track.lons.map(lon => lon * kx);
        const ys = track.lats.map(lat => lat * ky);

        const indicesAt = toleranceKm => {
            const keep = new Uint8Array(n);
            keep[0] = 1;
            keep[n - 1] = 1;
            const stack = [[0, n - 1]];
            while (stack.length) {
                const [a, b] = stack.pop();
                if (b - a < 2) continue;
                const ax = xs[a];
                const ay = ys[a];
                const dx = xs[b] - ax;
                const dy = ys[b] - ay;
                const len2 = dx * dx + dy * dy;
                let best = -1;
                let bestDistance = -1;
                for (let i = a + 1; i < b; i++) {
                    let distance;
                    if (len2 === 0) {
                        distance = Math.hypot(xs[i] - ax, ys[i] - ay);
                    } else {
                        const t = Math.max(0, Math.min(1,
                            ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2));
                        distance = Math.hypot(xs[i] - (ax + t * dx), ys[i] - (ay + t * dy));
                    }
                    if (distance > bestDistance) {
                        bestDistance = distance;
                        best = i;
                    }
                }
                if (best >= 0 && bestDistance > toleranceKm) {
                    keep[best] = 1;
                    stack.push([a, best], [best, b]);
                }
            }
            return Array.from(keep, (v, i) => v ? i : -1).filter(i => i >= 0);
        };

        let toleranceKm = 0.02;
        let indices = indicesAt(toleranceKm);
        while (indices.length > CONFIG.overpassMaxPoints) {
            toleranceKm *= 1.5;
            indices = indicesAt(toleranceKm);
        }
        return {
            points: indices.map(i => ({ lat: track.lats[i], lon: track.lons[i] })),
            toleranceKm,
        };
    }

    const sameCoord = (a, b) =>
        Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;

    function normalizeRing(geometry) {
        return (geometry || [])
            .filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
            .map(p => ({ lat: p.lat, lon: p.lon }));
    }

    // Multipolygon members may be split into several OSM ways. Join matching
    // endpoints into closed rings before running point-in-polygon tests.
    function stitchRings(geometries) {
        const pending = geometries.map(normalizeRing).filter(geometry => geometry.length >= 2);
        const rings = [];
        while (pending.length) {
            let ring = pending.pop();
            let joined = true;
            while (!sameCoord(ring[0], ring[ring.length - 1]) && joined) {
                joined = false;
                const head = ring[0];
                const tail = ring[ring.length - 1];
                for (let i = 0; i < pending.length; i++) {
                    const segment = pending[i];
                    const first = segment[0];
                    const last = segment[segment.length - 1];
                    if (sameCoord(tail, first)) {
                        ring = ring.concat(segment.slice(1));
                    } else if (sameCoord(tail, last)) {
                        ring = ring.concat(segment.slice(0, -1).reverse());
                    } else if (sameCoord(head, last)) {
                        ring = segment.slice(0, -1).concat(ring);
                    } else if (sameCoord(head, first)) {
                        ring = segment.slice(1).reverse().concat(ring);
                    } else {
                        continue;
                    }
                    pending.splice(i, 1);
                    joined = true;
                    break;
                }
            }
            if (ring.length >= 4 && sameCoord(ring[0], ring[ring.length - 1])) rings.push(ring);
        }
        return rings;
    }

    function residentialArea(outers, inners = []) {
        if (!outers.length) return null;
        const bbox = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
        for (const ring of outers) {
            for (const p of ring) {
                bbox.south = Math.min(bbox.south, p.lat);
                bbox.west = Math.min(bbox.west, p.lon);
                bbox.north = Math.max(bbox.north, p.lat);
                bbox.east = Math.max(bbox.east, p.lon);
            }
        }
        return {
            outers,
            inners,
            bbox,
        };
    }

    function parseResidentialAreas(elements) {
        const areas = [];
        for (const element of elements || []) {
            if (element.type === 'way') {
                const ring = normalizeRing(element.geometry);
                if (ring.length >= 4 && sameCoord(ring[0], ring[ring.length - 1])) {
                    const area = residentialArea([ring]);
                    if (area) areas.push(area);
                }
                continue;
            }
            if (element.type !== 'relation') continue;
            const members = (element.members || []).filter(m => m.type === 'way' && m.geometry);
            const outerSegments = members.filter(m => m.role !== 'inner').map(m => m.geometry);
            const innerSegments = members.filter(m => m.role === 'inner').map(m => m.geometry);
            const area = residentialArea(stitchRings(outerSegments), stitchRings(innerSegments));
            if (area) areas.push(area);
        }
        return areas;
    }

    function pointInRing(lat, lon, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const yi = ring[i].lat;
            const yj = ring[j].lat;
            const xi = ring[i].lon;
            const xj = ring[j].lon;
            if ((yi > lat) !== (yj > lat)
                && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    function pointSegmentDistanceKm(lat, lon, a, b) {
        const kx = 111.32 * Math.cos(lat * Math.PI / 180);
        const ky = 110.57;
        const ax = (a.lon - lon) * kx;
        const ay = (a.lat - lat) * ky;
        const bx = (b.lon - lon) * kx;
        const by = (b.lat - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
        return Math.hypot(ax + t * dx, ay + t * dy);
    }

    function ringDistanceKm(lat, lon, ring, limitKm) {
        let best = Infinity;
        for (let i = 1; i < ring.length; i++) {
            best = Math.min(best, pointSegmentDistanceKm(lat, lon, ring[i - 1], ring[i]));
            if (best <= limitKm) break;
        }
        return best;
    }

    function pointTouchesResidential(lat, lon, areas) {
        const bufferKm = CONFIG.residentialBufferM / 1000;
        const dLat = bufferKm / 110.57;
        const dLon = bufferKm / Math.max(1, 111.32 * Math.cos(lat * Math.PI / 180));
        for (const area of areas) {
            const b = area.bbox;
            if (lat < b.south - dLat || lat > b.north + dLat
                || lon < b.west - dLon || lon > b.east + dLon) continue;

            const inOuter = area.outers.some(ring => pointInRing(lat, lon, ring));
            const inInner = area.inners.some(ring => pointInRing(lat, lon, ring));
            if (inOuter && !inInner) return true;

            for (const ring of [...area.outers, ...area.inners]) {
                if (ringDistanceKm(lat, lon, ring, bufferKm) <= bufferKm) return true;
            }
        }
        return false;
    }

    function crossedResidentialRanges(track, areas) {
        const ranges = [];
        let start = null;
        for (let i = 0; i < track.lats.length; i++) {
            const inside = pointTouchesResidential(track.lats[i], track.lons[i], areas);
            if (inside && start === null) {
                start = i;
            }
            if (!inside && start !== null) {
                ranges.push({ start, end: i - 1 });
                start = null;
            }
        }
        if (start !== null) {
            ranges.push({ start, end: track.lats.length - 1 });
        }

        return ranges.map(range => {
            const fromKm = range.start === 0 ? 0
                : (track.dists[range.start - 1] + track.dists[range.start]) / 2;
            const toKm = range.end === track.lats.length - 1 ? track.total
                : (track.dists[range.end] + track.dists[range.end + 1]) / 2;
            return {
                ...range,
                fromKm,
                toKm,
                km: toKm - fromKm,
                anchor: indexAtDistance(track.dists, (fromKm + toKm) / 2),
            };
        });
    }

    function residentialCacheKey(activityId) {
        return `${RESIDENTIAL_CACHE_PREFIX}${activityId}`;
    }

    function trackSignature(track) {
        const last = track.lats.length - 1;
        return [
            track.lats.length,
            track.total.toFixed(3),
            track.lats[0].toFixed(5),
            track.lons[0].toFixed(5),
            track.lats[last].toFixed(5),
            track.lons[last].toFixed(5),
            CONFIG.residentialBufferM,
        ].join(':');
    }

    function cachedResidentialRanges(activityId, track) {
        const key = residentialCacheKey(activityId);
        const stored = localStorage.getItem(key);
        if (!stored) return null;
        try {
            const value = JSON.parse(stored);
            const maxAge = CONFIG.residentialCacheDays * 24 * 60 * 60 * 1000;
            const hasInvalidRange = !Array.isArray(value.ranges) || value.ranges.some(range =>
                !Number.isInteger(range.start)
                || !Number.isInteger(range.end)
                || !Number.isInteger(range.anchor)
                || range.start < 0
                || range.end < range.start
                || range.anchor < range.start
                || range.anchor > range.end
                || range.end >= track.lats.length
                || !Number.isFinite(range.fromKm)
                || !Number.isFinite(range.toKm)
                || !Number.isFinite(range.km));
            if (value.signature !== trackSignature(track)
                || !Number.isFinite(value.savedAt)
                || Date.now() - value.savedAt > maxAge
                || hasInvalidRange) {
                return null;
            }
            return value.ranges;
        } catch {
            localStorage.removeItem(key);
            return null;
        }
    }

    function cacheResidentialRanges(activityId, track, ranges) {
        try {
            localStorage.setItem(residentialCacheKey(activityId), JSON.stringify({
                signature: trackSignature(track),
                savedAt: Date.now(),
                ranges,
            }));
        } catch {
            // localStorage can be unavailable or full; cache misses are harmless.
        }
    }

    function splitOverpassLine(points) {
        const maxPoints = Math.max(2, Math.floor(CONFIG.overpassChunkPoints));
        if (points.length <= maxPoints) return [points];

        // Adjacent chunks share an endpoint so the around filter leaves no gap.
        const chunkCount = Math.ceil((points.length - 1) / (maxPoints - 1));
        return Array.from({ length: chunkCount }, (_, index) => {
            const start = Math.floor(index * (points.length - 1) / chunkCount);
            const end = Math.floor((index + 1) * (points.length - 1) / chunkCount);
            return points.slice(start, end + 1);
        });
    }

    function residentialOverpassQuery(points, radiusM) {
        const line = points
            .map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(',');
        return `[out:json][timeout:${Math.ceil(CONFIG.overpassTimeout / 1000)}];\n`
            + `(way["landuse"="residential"](around:${radiusM},${line});`
            + `relation["landuse"="residential"](around:${radiusM},${line}););\n`
            + 'out body geom;';
    }

    async function fetchOverpassElements(points, radiusM) {
        const query = residentialOverpassQuery(points, radiusM);
        const attempts = Math.max(1, Math.floor(CONFIG.overpassAttempts));
        let lastError;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            let response;
            try {
                response = await fetch(OVERPASS_URL, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    },
                    body: `data=${encodeURIComponent(query)}`,
                });
            } catch (error) {
                lastError = new Error(`Failed to load OSM residential areas: ${error?.message || 'network error'}`);
            }

            if (response?.ok) {
                let data;
                try {
                    data = await response.json();
                } catch {
                    throw new Error('Overpass returned invalid JSON');
                }
                if (!Array.isArray(data?.elements)) {
                    throw new Error('Overpass response has no OSM elements');
                }
                return data.elements;
            }

            if (response) {
                lastError = new Error(`Failed to load OSM residential areas: HTTP ${response.status}`);
                if (!TRANSIENT_OVERPASS_STATUSES.has(response.status)) throw lastError;
            }
            if (attempt === attempts) break;

            const delay = CONFIG.overpassRetryDelay * 2 ** (attempt - 1);
            console.warn(`[Strava Renamer] ${lastError.message}; retrying in ${(delay / 1000).toFixed(1)}s`
                + ` (${attempt}/${attempts})`);
            await sleep(delay);
        }

        throw lastError;
    }

    async function fetchResidentialAreas(track, onProgress) {
        const simplified = simplifyTrackForOverpass(track);
        const radiusM = Math.ceil(CONFIG.residentialBufferM + simplified.toleranceKm * 1000 + 10);
        const chunks = splitOverpassLine(simplified.points);
        const elementsById = new Map();

        for (let index = 0; index < chunks.length; index++) {
            onProgress?.(index + 1, chunks.length);
            const elements = await fetchOverpassElements(chunks[index], radiusM);
            for (const element of elements) {
                elementsById.set(`${element.type}:${element.id}`, element);
            }
        }
        return parseResidentialAreas([...elementsById.values()]);
    }

    async function loadResidentialRanges(activityId, track, onProgress) {
        const cached = cachedResidentialRanges(activityId, track);
        if (cached) return { ranges: cached, cached: true, areaCount: null };
        const areas = await fetchResidentialAreas(track, onProgress);
        const ranges = crossedResidentialRanges(track, areas);
        cacheResidentialRanges(activityId, track, ranges);
        return { ranges, cached: false, areaCount: areas.length };
    }

    // Keep the first language variant in bilingual OSM names. Optionally remove
    // a trailing parenthetical qualifier while preserving hyphenated names.
    function cleanPlaceName(name) {
        let cleaned = name.split(/\s+[-–—]\s+|\s*\/\s*/)[0];
        if (CONFIG.stripParentheticals) {
            cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/, '');
        }
        return cleaned.trim() || name;
    }

    // Zoom 18 gives the exact address hierarchy; zoom 14 gives the local
    // settlement/boundary. Reconcile both levels so a nearby place node does
    // not win and city/village districts do not replace their parent place.
    const PRIMARY_ADDRESS_FIELDS = ['hamlet', 'village', 'town', 'city'];
    const DISTRICT_ADDRESS_FIELDS = ['city_district', 'suburb'];
    const PRIMARY_SETTLEMENT_TYPES = new Set(['hamlet', 'village', 'town', 'city']);

    function addressPlaceNames(address, fields) {
        if (!address) return [];
        const names = [];
        for (const field of fields) {
            if (typeof address[field] !== 'string' || !address[field].trim()) continue;
            const name = cleanPlaceName(address[field]);
            if (name && !names.includes(name)) names.push(name);
        }
        return names;
    }

    function optionalPlaceName(value) {
        return typeof value === 'string' && value.trim() ? cleanPlaceName(value) : null;
    }

    function placeNameOf(exactGeo, placeGeo) {
        const address = exactGeo?.address || {};
        const primaryNames = addressPlaceNames(address, PRIMARY_ADDRESS_FIELDS);
        const districtNames = addressPlaceNames(address, DISTRICT_ADDRESS_FIELDS);
        const primaryName = primaryNames[0] || null;
        const districtName = districtNames[0] || null;
        const placeName = optionalPlaceName(placeGeo?.name);

        // Prefer a coarse result that the exact address hierarchy confirms.
        if (placeName && primaryNames.includes(placeName)) return placeName;

        // Settlement relations identify the containing place directly.
        if (placeName && placeGeo?.osmType === 'relation'
            && PRIMARY_SETTLEMENT_TYPES.has(placeGeo?.addressType)) return placeName;

        // Nominatim labels both urban and rural districts as suburb relations.
        // Collapse a district only when the exact hierarchy confirms its parent.
        const isMatchingDistrictBoundary = placeName && placeGeo?.osmType === 'relation'
            && placeGeo?.addressType === 'suburb' && districtNames.includes(placeName);
        if (isMatchingDistrictBoundary) {
            if (address.city) return primaryName || placeName;

            const ruralParent = addressPlaceNames(address, ['village', 'town'])[0] || null;
            const municipality = optionalPlaceName(address.municipality);
            if (ruralParent && municipality && ruralParent === municipality) return ruralParent;
            return placeName;
        }

        // A nearby unrelated place node must not override the exact hierarchy.
        const cityDistrict = optionalPlaceName(address.city_district);
        return cityDistrict || primaryName || districtName;
    }

    // The zoom is part of the key because each level has a different role.
    function createGeocoder() {
        let lastCallAt = 0;
        let apiCalls = 0;
        return {
            get apiCalls() { return apiCalls; },
            async reverse(lat, lon, zoom) {
                const key = geocodeCacheKey(lat, lon, zoom);
                const stored = localStorage.getItem(key);
                if (stored !== null) {
                    try {
                        return JSON.parse(stored);
                    } catch {
                        localStorage.removeItem(key);
                    }
                }

                const wait = CONFIG.rateLimit - (Date.now() - lastCallAt);
                if (wait > 0) await sleep(wait);

                apiCalls++;
                const params = new URLSearchParams({
                    lat: String(lat),
                    lon: String(lon),
                    format: 'json',
                    zoom: String(zoom),
                    addressdetails: '1',
                    'accept-language': 'en',
                });
                try {
                    const response = await fetch(`${NOMINATIM_URL}?${params}`, {
                        headers: { 'Accept': 'application/json' },
                    });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const data = await response.json();
                    const geo = {
                        osmType: data.osm_type ?? null,
                        addressType: data.addresstype ?? null,
                        name: data.name || null,
                        address: data.address ?? null,
                    };
                    try {
                        localStorage.setItem(key, JSON.stringify(geo));
                    } catch {
                        // A cache write failure must not prevent naming the route.
                    }
                    return geo;
                } catch (error) {
                    console.error('[Strava Renamer] Geocoding error:', error);
                    throw new Error(`Nominatim failed at ${lat.toFixed(5)}, ${lon.toFixed(5)}: ${error.message}`);
                } finally {
                    lastCallAt = Date.now();
                }
            },
        };
    }

    // Limit only the displayed narrative; every crossed residential stretch
    // remains valid and is still geocoded. Every passage is assessed on its
    // own residential distance, regardless of its name or direction. Start
    // and finish are protected.
    function compactRouteRuns(runs) {
        const limit = Math.max(2, Math.floor(CONFIG.maxNamePlaces));
        const kept = runs.map(run => ({ ...run }));

        while (kept.length > limit && kept.length > 2) {
            let removeAt = 1;
            for (let i = 2; i < kept.length - 1; i++) {
                if (kept[i].km < kept[removeAt].km) removeAt = i;
            }

            kept.splice(removeAt, 1);
        }
        return kept;
    }

    // Every continuous residential stretch contributes exactly one address in
    // travel order. Adjacent duplicates merge immediately; every later revisit
    // of a selected place remains visible.
    async function routePlaceNames(ranges, track, geocoder, onProgress) {
        const runs = [];
        for (let i = 0; i < ranges.length; i++) {
            onProgress?.(i + 1, ranges.length);
            const range = ranges[i];
            const lat = track.lats[range.anchor];
            const lon = track.lons[range.anchor];
            const exactGeo = await geocoder.reverse(lat, lon, CONFIG.nominatimAddressZoom);
            const placeGeo = await geocoder.reverse(lat, lon, CONFIG.nominatimPlaceZoom);
            const name = placeNameOf(exactGeo, placeGeo);
            const distanceLabel = `${range.fromKm.toFixed(2)}–${range.toKm.toFixed(2)} km`;
            console.log(`[Strava Renamer] Residential ${distanceLabel}: ${name || 'no settlement address'}`
                + ` (zoom ${CONFIG.nominatimPlaceZoom}: ${placeGeo?.name || 'none'})`);
            if (!name) continue;
            const last = runs[runs.length - 1];
            if (last?.name === name) {
                last.km += range.km;
                last.toKm = range.toKm;
            } else {
                runs.push({ name, km: range.km, fromKm: range.fromKm, toKm: range.toKm });
            }
        }

        const compacted = compactRouteRuns(runs);
        if (compacted.length < runs.length) {
            console.log(`[Strava Renamer] Name compacted from ${runs.length} to ${compacted.length} places: `
                + compacted.map(run => run.name).join(' - '));
        }
        return compacted.map(run => run.name);
    }

    function getActivityId() {
        return window.location.pathname.match(/^\/activities\/(\d+)/)?.[1] || null;
    }

    async function downloadGpx(activityId) {
        const response = await fetch(`/activities/${activityId}/export_gpx`);
        if (!response.ok) {
            throw new Error('Failed to download GPX. Are you logged in?');
        }
        return response.text();
    }

    function parseGpxTrack(gpxText) {
        const xml = new DOMParser().parseFromString(gpxText, 'text/xml');
        if (xml.querySelector('parsererror')) {
            throw new Error('Downloaded GPX is not valid XML.');
        }

        const points = Array.from(xml.getElementsByTagName('trkpt'));
        if (points.length === 0) return null;

        const lats = [];
        const lons = [];
        for (const point of points) {
            const lat = Number.parseFloat(point.getAttribute('lat'));
            const lon = Number.parseFloat(point.getAttribute('lon'));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                throw new Error('Downloaded GPX contains an invalid track point.');
            }
            lats.push(lat);
            lons.push(lon);
        }

        const dists = [0];
        for (let i = 1; i < lats.length; i++) {
            dists.push(dists[i - 1] + getDistance(
                lats[i - 1], lons[i - 1], lats[i], lons[i],
            ));
        }
        return {
            lats,
            lons,
            dists,
            total: dists[dists.length - 1],
        };
    }

    async function generateAndFillName(btn) {
        const activityId = getActivityId();
        if (!activityId) {
            alert(STRINGS.noId);
            return;
        }

        const nameInput = document.querySelector('input[name="activity[name]"]');
        if (!nameInput) {
            alert('Could not find activity name field');
            return;
        }

        btn.disabled = true;
        setButtonState(btn, STRINGS.downloading, 'loading');

        try {
            const gpxText = await downloadGpx(activityId);
            setButtonState(btn, STRINGS.analyzing, 'loading');
            const track = parseGpxTrack(gpxText);
            if (!track) {
                alert(STRINGS.noGps);
                return;
            }
            console.log(`[Strava Renamer] ${track.total.toFixed(1)} km, ${track.lats.length} trackpoints`);

            setButtonState(btn, `${STRINGS.landuse}...`, 'loading');
            const residential = await loadResidentialRanges(
                activityId,
                track,
                (done, total) => setButtonState(
                    btn, `${STRINGS.landuse} ${done}/${total}...`, 'loading'),
            );
            console.log(`[Strava Renamer] ${residential.ranges.length} crossed residential stretches`
                + (residential.cached ? ' (cached)' : ` from ${residential.areaCount} OSM areas`));
            if (residential.ranges.length === 0) {
                throw new Error('The route does not enter an OSM landuse=residential area.');
            }

            setButtonState(btn, `${STRINGS.geocoding}...`, 'loading');
            const geocoder = createGeocoder();
            const places = await routePlaceNames(
                residential.ranges,
                track,
                geocoder,
                (done, total) => setButtonState(
                    btn, `${STRINGS.geocoding} ${done}/${total}...`, 'loading'),
            );
            if (places.length === 0) {
                throw new Error('Residential areas were crossed, but Nominatim returned no settlement address.');
            }
            const newName = places.join(' - ');
            console.log(`[Strava Renamer] ${residential.ranges.length} addresses, ${geocoder.apiCalls} API calls`);
            console.log(`[Strava Renamer] Name: ${newName}`);

            nameInput.value = newName;
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            nameInput.focus();
            setButtonState(btn, STRINGS.done, 'success');
            await sleep(CONFIG.successDelay);
        } catch (error) {
            console.error('[Strava Renamer]', error);
            alert(`Error:\n${error.message}`);
            setButtonState(btn, STRINGS.error, 'error');
            await sleep(CONFIG.errorDelay);
        } finally {
            btn.disabled = false;
            setButtonState(btn, STRINGS.idle);
        }
    }

    function injectButton() {
        if (document.querySelector(`#${BUTTON_ID}`)) return;

        const titleLabel = document.querySelector('label[for="activity_name"]');
        if (!titleLabel?.parentNode) return;

        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.title = 'Generate name from GPS track';
        Object.assign(btn.style, {
            marginLeft: 'auto',
            verticalAlign: 'middle',
            fontSize: '12px',
            padding: '3px 10px',
            color: 'white',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
        });
        setButtonState(btn, STRINGS.idle);
        btn.addEventListener('mouseenter', () => {
            if (btn.dataset.state === 'idle') {
                btn.style.backgroundColor = BUTTON_COLORS.hover;
            }
        });
        btn.addEventListener('mouseleave', () => {
            if (btn.dataset.state === 'idle') {
                btn.style.backgroundColor = BUTTON_COLORS.idle;
            }
        });
        btn.addEventListener('click', event => {
            event.preventDefault();
            void generateAndFillName(btn);
        });

        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, {
            display: 'flex',
            alignItems: 'center',
        });
        titleLabel.parentNode.insertBefore(wrapper, titleLabel);
        wrapper.append(titleLabel, btn);
        console.log('[Strava Renamer] Button injected');
    }

    new MutationObserver(injectButton).observe(document.body, { childList: true, subtree: true });
    injectButton();
})();
