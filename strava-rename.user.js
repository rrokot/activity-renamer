// ==UserScript==
// @name         Strava Activity Route Renamer
// @namespace    https://tampermonkey.net/
// @version      4.4.3
// @description  Names Strava activities from crossed OSM residential areas with custom favorite places
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
        overpassMaxRoutePoints: 50,
        overpassTimeoutMs: 25000,
        overpassMaxAttempts: 3,
        overpassRetryBaseMs: 5000,
        maxNamePlaces: 7,
        favoriteRadiusM: 200,
        stripPlaceParentheticals: true,
        geocodeCachePrecision: 4,
        nominatimIntervalMs: 1050,
        nominatimPlaceZoom: 14,
        nominatimAddressZoom: 18,
        successStateMs: 1500,
        errorStateMs: 2000,
    };

    const STRINGS = {
        idle: 'Generate from Geo',
        downloading: '⌛ Downloading...',
        analyzing: '⌛ Analyzing...',
        landuse: '⌛ Loading residential areas',
        overpassBusy: '⌛ Overpass busy; retrying in',
        geocoding: '⌛ Geocoding',
        done: '✔️ Done!',
        error: '❌ Error',
        noGps: 'No GPS data found (manual entry or indoor activity?)',
        noId: 'Could not detect activity ID from URL.',
    };

    const API_URL = {
        nominatim: 'https://nominatim.openstreetmap.org/reverse',
        nominatimSearch: 'https://nominatim.openstreetmap.org/search',
        overpass: 'https://overpass-api.de/api/interpreter',
    };
    const CACHE_PREFIX = {
        geocode: 'strava_geocode_v9_',
        residential: 'strava_residential_v1_',
    };
    const STORAGE_KEY = {
        favorites: 'strava_route_favorites_v1',
    };
    const BUTTON_ID = 'strava-route-rename-btn';
    const FAVORITES_BUTTON_ID = 'strava-route-favorites-btn';
    const FAVORITES_DIALOG_ID = 'strava-route-favorites-dialog';
    const LOG_PREFIX = '[Strava Renamer]';
    const TRANSIENT_OVERPASS_STATUSES = new Set([429, 502, 503, 504]);
    const BUTTON_COLORS = {
        idle: '#fc4c02',
        hover: '#e34402',
        loading: '#888',
        success: '#4caf50',
        error: '#f44336',
    };
    let lastRouteAnalysis = null;
    let lastNominatimCallAt = 0;
    let nominatimQueue = Promise.resolve();

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const log = message => console.log(`${LOG_PREFIX} ${message}`);

    function requestNominatim(url) {
        const request = nominatimQueue.then(async () => {
            const waitMs = CONFIG.nominatimIntervalMs - (Date.now() - lastNominatimCallAt);
            if (waitMs > 0) await sleep(waitMs);
            try {
                return await fetch(url, { headers: { 'Accept': 'application/json' } });
            } finally {
                lastNominatimCallAt = Date.now();
            }
        });
        nominatimQueue = request.catch(() => undefined);
        return request;
    }

    function errorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }

    function readJsonCache(key) {
        const stored = localStorage.getItem(key);
        if (stored === null) return null;
        try {
            return JSON.parse(stored);
        } catch {
            localStorage.removeItem(key);
            return null;
        }
    }

    function writeJsonCache(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // Cache failures must not prevent naming the route.
        }
    }

    function normalizeFavorite(value) {
        if (!value || typeof value !== 'object') return null;
        const name = typeof value.name === 'string' ? value.name.trim().replace(/\s+/g, ' ') : '';
        const lat = Number(value.lat);
        const lon = Number(value.lon);
        const radiusM = Number(value.radiusM);
        if (!value.id || !name || name.length > 80
            || !Number.isFinite(lat) || lat < -90 || lat > 90
            || !Number.isFinite(lon) || lon < -180 || lon > 180
            || !Number.isFinite(radiusM) || radiusM < 10 || radiusM > 5000) {
            return null;
        }
        return {
            id: String(value.id),
            name,
            lat,
            lon,
            radiusM: Math.round(radiusM),
            address: typeof value.address === 'string' ? value.address.trim() : '',
        };
    }

    function loadFavorites() {
        const stored = readJsonCache(STORAGE_KEY.favorites);
        if (!Array.isArray(stored)) return [];
        return stored.map(normalizeFavorite).filter(Boolean);
    }

    function saveFavorites(favorites) {
        const normalized = favorites.map(normalizeFavorite).filter(Boolean);
        writeJsonCache(STORAGE_KEY.favorites, normalized);
        updateFavoritesButtonLabel(normalized.length);
        return normalized;
    }

    function createFavoriteId() {
        return `favorite_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function geocodeCacheKey(lat, lon, zoom) {
        const precision = CONFIG.geocodeCachePrecision;
        const roundedLat = Number(lat).toFixed(precision);
        const roundedLon = Number(lon).toFixed(precision);
        return `${CACHE_PREFIX.geocode}z${zoom}_${roundedLat}_${roundedLon}`;
    }

    function setButtonState(button, text, state = 'idle') {
        button.textContent = text;
        button.dataset.state = state;
        button.style.backgroundColor = BUTTON_COLORS[state] || BUTTON_COLORS.idle;
        button.style.color = 'white';
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        const earthRadiusKm = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function indexAtDistance(cumulativeKm, targetKm) {
        let lo = 0;
        let hi = cumulativeKm.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cumulativeKm[mid] < targetKm) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        const previousIsCloser = lo > 0
            && Math.abs(cumulativeKm[lo - 1] - targetKm) < Math.abs(cumulativeKm[lo] - targetKm);
        return previousIsCloser ? lo - 1 : lo;
    }

    // Douglas-Peucker simplification keeps the Overpass linestring compact.
    // The query radius includes the simplification tolerance, so no residential
    // polygon near the original GPX line is lost when bends are removed.
    function simplifyTrackForOverpass(track) {
        const n = track.latitudes.length;
        if (n <= 2) {
            return {
                points: Array.from({ length: n }, (_, i) => ({
                    lat: track.latitudes[i],
                    lon: track.longitudes[i],
                })),
                toleranceKm: 0,
            };
        }

        const refLat = track.latitudes.reduce((sum, lat) => sum + lat, 0) / n;
        const kx = 111.32 * Math.cos(refLat * Math.PI / 180);
        const ky = 110.57;
        const xs = track.longitudes.map(lon => lon * kx);
        const ys = track.latitudes.map(lat => lat * ky);

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
        while (indices.length > CONFIG.overpassMaxRoutePoints) {
            toleranceKm *= 1.5;
            indices = indicesAt(toleranceKm);
        }
        return {
            points: indices.map(i => ({
                lat: track.latitudes[i],
                lon: track.longitudes[i],
            })),
            toleranceKm,
        };
    }

    const sameCoordinate = (a, b) =>
        Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;

    function normalizeRing(geometry) {
        return (geometry || [])
            .filter(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
            .map(point => ({ lat: point.lat, lon: point.lon }));
    }

    // Multipolygon members may be split into several OSM ways. Join matching
    // endpoints into closed rings before running point-in-polygon tests.
    function stitchRings(geometries) {
        const pending = geometries.map(normalizeRing).filter(geometry => geometry.length >= 2);
        const rings = [];
        while (pending.length) {
            let ring = pending.pop();
            let joined = true;
            while (!sameCoordinate(ring[0], ring[ring.length - 1]) && joined) {
                joined = false;
                const head = ring[0];
                const tail = ring[ring.length - 1];
                for (let i = 0; i < pending.length; i++) {
                    const segment = pending[i];
                    const first = segment[0];
                    const last = segment[segment.length - 1];
                    if (sameCoordinate(tail, first)) {
                        ring = ring.concat(segment.slice(1));
                    } else if (sameCoordinate(tail, last)) {
                        ring = ring.concat(segment.slice(0, -1).reverse());
                    } else if (sameCoordinate(head, last)) {
                        ring = segment.slice(0, -1).concat(ring);
                    } else if (sameCoordinate(head, first)) {
                        ring = segment.slice(1).reverse().concat(ring);
                    } else {
                        continue;
                    }
                    pending.splice(i, 1);
                    joined = true;
                    break;
                }
            }
            if (ring.length >= 4 && sameCoordinate(ring[0], ring[ring.length - 1])) rings.push(ring);
        }
        return rings;
    }

    function createResidentialArea(outers, inners = []) {
        if (!outers.length) return null;
        const bbox = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
        for (const ring of outers) {
            for (const point of ring) {
                bbox.south = Math.min(bbox.south, point.lat);
                bbox.west = Math.min(bbox.west, point.lon);
                bbox.north = Math.max(bbox.north, point.lat);
                bbox.east = Math.max(bbox.east, point.lon);
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
                if (ring.length >= 4 && sameCoordinate(ring[0], ring[ring.length - 1])) {
                    const area = createResidentialArea([ring]);
                    if (area) areas.push(area);
                }
                continue;
            }
            if (element.type !== 'relation') continue;
            const members = (element.members || [])
                .filter(member => member.type === 'way' && member.geometry);
            const outerSegments = members
                .filter(member => member.role !== 'inner')
                .map(member => member.geometry);
            const innerSegments = members
                .filter(member => member.role === 'inner')
                .map(member => member.geometry);
            const area = createResidentialArea(stitchRings(outerSegments), stitchRings(innerSegments));
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
        let bestKm = Infinity;
        for (let i = 1; i < ring.length; i++) {
            bestKm = Math.min(bestKm, pointSegmentDistanceKm(lat, lon, ring[i - 1], ring[i]));
            if (bestKm <= limitKm) break;
        }
        return bestKm;
    }

    function pointTouchesResidential(lat, lon, areas) {
        const bufferKm = CONFIG.residentialBufferM / 1000;
        const dLat = bufferKm / 110.57;
        const dLon = bufferKm / Math.max(1, 111.32 * Math.cos(lat * Math.PI / 180));
        for (const area of areas) {
            const bbox = area.bbox;
            if (lat < bbox.south - dLat || lat > bbox.north + dLat
                || lon < bbox.west - dLon || lon > bbox.east + dLon) {
                continue;
            }

            const inOuter = area.outers.some(ring => pointInRing(lat, lon, ring));
            const inInner = area.inners.some(ring => pointInRing(lat, lon, ring));
            if (inOuter && !inInner) return true;

            const nearOuterBoundary = area.outers.some(ring =>
                ringDistanceKm(lat, lon, ring, bufferKm) <= bufferKm);
            const nearInnerBoundary = area.inners.some(ring =>
                ringDistanceKm(lat, lon, ring, bufferKm) <= bufferKm);
            if (nearOuterBoundary || nearInnerBoundary) return true;
        }
        return false;
    }

    function crossedResidentialRanges(track, areas) {
        const ranges = [];
        let start = null;
        for (let i = 0; i < track.latitudes.length; i++) {
            const inside = pointTouchesResidential(track.latitudes[i], track.longitudes[i], areas);
            if (inside && start === null) {
                start = i;
            }
            if (!inside && start !== null) {
                ranges.push({ start, end: i - 1 });
                start = null;
            }
        }
        if (start !== null) {
            ranges.push({ start, end: track.latitudes.length - 1 });
        }

        return ranges.map(range => {
            const fromKm = range.start === 0 ? 0
                : (track.cumulativeKm[range.start - 1] + track.cumulativeKm[range.start]) / 2;
            const toKm = range.end === track.latitudes.length - 1 ? track.totalKm
                : (track.cumulativeKm[range.end] + track.cumulativeKm[range.end + 1]) / 2;
            return {
                ...range,
                fromKm,
                toKm,
                km: toKm - fromKm,
                anchor: indexAtDistance(track.cumulativeKm, (fromKm + toKm) / 2),
            };
        });
    }

    function residentialCacheKey(activityId) {
        return `${CACHE_PREFIX.residential}${activityId}`;
    }

    function trackSignature(track) {
        const last = track.latitudes.length - 1;
        return [
            track.latitudes.length,
            track.totalKm.toFixed(3),
            track.latitudes[0].toFixed(5),
            track.longitudes[0].toFixed(5),
            track.latitudes[last].toFixed(5),
            track.longitudes[last].toFixed(5),
            CONFIG.residentialBufferM,
        ].join(':');
    }

    function isValidCachedRange(range, trackLength) {
        return Number.isInteger(range.start)
            && Number.isInteger(range.end)
            && Number.isInteger(range.anchor)
            && range.start >= 0
            && range.end >= range.start
            && range.anchor >= range.start
            && range.anchor <= range.end
            && range.end < trackLength
            && Number.isFinite(range.fromKm)
            && Number.isFinite(range.toKm)
            && Number.isFinite(range.km);
    }

    function cachedResidentialRanges(activityId, track) {
        const key = residentialCacheKey(activityId);
        const value = readJsonCache(key);
        if (!value) return null;

        const maxAge = CONFIG.residentialCacheDays * 24 * 60 * 60 * 1000;
        const isValid = value.signature === trackSignature(track)
            && Number.isFinite(value.savedAt)
            && Date.now() - value.savedAt <= maxAge
            && Array.isArray(value.ranges)
            && value.ranges.every(range => isValidCachedRange(range, track.latitudes.length));
        if (!isValid) {
            localStorage.removeItem(key);
            return null;
        }
        return value.ranges;
    }

    function cacheResidentialRanges(activityId, track, ranges) {
        writeJsonCache(residentialCacheKey(activityId), {
            signature: trackSignature(track),
            savedAt: Date.now(),
            ranges,
        });
    }

    function residentialOverpassQuery(points, radiusM) {
        const line = points
            .map(point => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`).join(',');
        return `[out:json][timeout:${Math.ceil(CONFIG.overpassTimeoutMs / 1000)}];\n`
            + `(way["landuse"="residential"](around:${radiusM},${line});`
            + `relation["landuse"="residential"](around:${radiusM},${line}););\n`
            + 'out body geom;';
    }

    function overpassRetryDelay(response, attempt) {
        const exponentialDelay = CONFIG.overpassRetryBaseMs * 2 ** (attempt - 1);
        const retryAfter = response?.headers?.get?.('Retry-After');
        if (!retryAfter) return exponentialDelay;

        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) return Math.max(exponentialDelay, seconds * 1000);

        const retryAt = Date.parse(retryAfter);
        const serverDelay = Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
        return Math.max(exponentialDelay, serverDelay);
    }

    async function parseOverpassElements(response) {
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

    async function fetchOverpassElements(points, radiusM, onRetry) {
        const query = residentialOverpassQuery(points, radiusM);
        const attempts = Math.max(1, Math.floor(CONFIG.overpassMaxAttempts));
        let failure = new Error('Failed to load OSM residential areas');

        for (let attempt = 1; attempt <= attempts; attempt++) {
            let response;
            try {
                response = await fetch(API_URL.overpass, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    },
                    body: `data=${encodeURIComponent(query)}`,
                });
            } catch (error) {
                failure = new Error(`Failed to load OSM residential areas: ${errorMessage(error)}`);
            }

            if (response?.ok) return parseOverpassElements(response);

            if (response) {
                failure = new Error(`Failed to load OSM residential areas: HTTP ${response.status}`);
                if (!TRANSIENT_OVERPASS_STATUSES.has(response.status)) throw failure;
            }
            if (attempt === attempts) throw failure;

            const delay = overpassRetryDelay(response, attempt);
            onRetry?.(delay);
            console.warn(`${LOG_PREFIX} ${failure.message}; retrying in ${(delay / 1000).toFixed(1)}s`
                + ` (${attempt}/${attempts})`);
            await sleep(delay);
        }
        throw failure;
    }

    async function fetchResidentialAreas(track, onRetry) {
        const simplified = simplifyTrackForOverpass(track);
        const radiusM = Math.ceil(CONFIG.residentialBufferM + simplified.toleranceKm * 1000 + 10);
        const elements = await fetchOverpassElements(simplified.points, radiusM, onRetry);
        return parseResidentialAreas(elements);
    }

    async function loadResidentialRanges(activityId, track, onRetry) {
        const cached = cachedResidentialRanges(activityId, track);
        if (cached) return { ranges: cached, cached: true, areaCount: null };
        const areas = await fetchResidentialAreas(track, onRetry);
        const ranges = crossedResidentialRanges(track, areas);
        cacheResidentialRanges(activityId, track, ranges);
        return { ranges, cached: false, areaCount: areas.length };
    }

    // Keep the first language variant in bilingual OSM names. Optionally remove
    // a trailing parenthetical qualifier while preserving hyphenated names.
    function cleanPlaceName(name) {
        let cleaned = name.split(/\s+[-–—]\s+|\s*\/\s*/)[0];
        if (CONFIG.stripPlaceParentheticals) {
            cleaned = cleaned.replace(/\s*\([^)]*\)\s*$/, '');
        }
        return cleaned.trim() || name;
    }

    // Zoom 18 gives the exact address hierarchy; zoom 14 gives the local
    // settlement/boundary. Every passage uses the same priority: a named
    // settlement, then its district, then the containing city.
    const LOCAL_SETTLEMENT_FIELDS = ['hamlet', 'village', 'town'];
    const PRIMARY_ADDRESS_FIELDS = ['hamlet', 'village', 'town', 'city'];
    const DISTRICT_ADDRESS_FIELDS = ['city_district', 'suburb'];
    const RURAL_PARENT_FIELDS = ['village', 'town'];
    const SETTLEMENT_TYPES = new Set(['hamlet', 'village', 'town', 'city']);

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

    function cleanOptionalPlaceName(value) {
        return typeof value === 'string' && value.trim() ? cleanPlaceName(value) : null;
    }

    function formatAddress(address) {
        if (!address) return '';
        const parts = [];
        const add = value => {
            const cleaned = cleanOptionalPlaceName(value);
            if (cleaned && !parts.includes(cleaned)) parts.push(cleaned);
        };

        const road = cleanOptionalPlaceName(address.road);
        const houseNumber = typeof address.house_number === 'string' ? address.house_number.trim() : '';
        if (road) parts.push(houseNumber ? `${road} ${houseNumber}` : road);
        for (const field of ['hamlet', 'village', 'town', 'city_district', 'suburb', 'city']) {
            add(address[field]);
        }
        return parts.join(', ');
    }

    function resolvePlaceName(exactGeo, coarseGeo) {
        const address = exactGeo?.address || {};
        const localSettlementName = addressPlaceNames(address, LOCAL_SETTLEMENT_FIELDS)[0] || null;
        const primaryNames = addressPlaceNames(address, PRIMARY_ADDRESS_FIELDS);
        const districtNames = addressPlaceNames(address, DISTRICT_ADDRESS_FIELDS);
        const primaryName = primaryNames[0] || null;
        const districtName = districtNames[0] || null;
        const preferredExactName = localSettlementName || districtName || primaryName;
        const coarseName = cleanOptionalPlaceName(coarseGeo?.name);
        const coarseIsRelation = coarseGeo?.osmType === 'relation';

        // A confirmed city must not hide a more specific settlement or district.
        if (coarseName && primaryNames.includes(coarseName)) return preferredExactName;

        // Settlement relations identify the containing place directly.
        if (coarseName && coarseIsRelation && SETTLEMENT_TYPES.has(coarseGeo.addressType)) {
            return coarseName;
        }

        // Nominatim labels both urban and rural districts as suburb relations.
        const isMatchingDistrictBoundary = coarseName && coarseIsRelation
            && coarseGeo.addressType === 'suburb' && districtNames.includes(coarseName);
        if (isMatchingDistrictBoundary) {
            if (address.city) return localSettlementName || coarseName;

            const ruralParent = addressPlaceNames(address, RURAL_PARENT_FIELDS)[0] || null;
            const municipality = cleanOptionalPlaceName(address.municipality);
            if (ruralParent && municipality && ruralParent === municipality) return ruralParent;
            return coarseName;
        }

        // A nearby unrelated place node must not override the exact hierarchy.
        return preferredExactName;
    }

    // The zoom is part of the key because each level has a different role.
    function createGeocoder() {
        let apiCalls = 0;
        return {
            get apiCalls() { return apiCalls; },
            async reverse(lat, lon, zoom) {
                const key = geocodeCacheKey(lat, lon, zoom);
                const cached = readJsonCache(key);
                if (cached) return cached;

                apiCalls += 1;
                const params = new URLSearchParams({
                    lat: String(lat),
                    lon: String(lon),
                    format: 'json',
                    zoom: String(zoom),
                    addressdetails: '1',
                    'accept-language': 'en',
                });
                try {
                    const response = await requestNominatim(`${API_URL.nominatim}?${params}`);
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
                    writeJsonCache(key, geo);
                    return geo;
                } catch (error) {
                    console.error(`${LOG_PREFIX} Geocoding error:`, error);
                    const coordinate = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
                    throw new Error(`Nominatim failed at ${coordinate}: ${errorMessage(error)}`);
                }
            },
        };
    }

    function favoriteCandidateFromSearchResult(result) {
        const lat = Number(result?.lat);
        const lon = Number(result?.lon);
        const address = typeof result?.display_name === 'string' ? result.display_name.trim() : '';
        if (!Number.isFinite(lat) || lat < -90 || lat > 90
            || !Number.isFinite(lon) || lon < -180 || lon > 180 || !address) {
            return null;
        }

        const resultName = cleanOptionalPlaceName(result.name);
        const meaningfulResultName = resultName && !/^\d+[a-z]?$/i.test(resultName) ? resultName : null;
        const placeName = resolvePlaceName({ address: result.address }, null);
        return {
            lat,
            lon,
            address,
            baseName: meaningfulResultName || placeName || formatAddress(result.address) || address,
        };
    }

    async function searchFavoriteAddresses(query) {
        const params = new URLSearchParams({
            q: query,
            format: 'jsonv2',
            addressdetails: '1',
            dedupe: '1',
            limit: '5',
            'accept-language': 'en',
        });
        const response = await requestNominatim(`${API_URL.nominatimSearch}?${params}`);
        if (!response.ok) throw new Error(`Address search failed: HTTP ${response.status}`);

        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Address search returned an invalid response.');
        return data.map(favoriteCandidateFromSearchResult).filter(Boolean);
    }

    function closestFavoriteForPassage(passage, track, favorites) {
        let best = null;
        for (const favorite of favorites) {
            let distanceM = Infinity;
            let closestIndex = passage.start;
            for (let index = passage.start; index <= passage.end; index++) {
                const pointDistanceM = haversineKm(
                    favorite.lat,
                    favorite.lon,
                    track.latitudes[index],
                    track.longitudes[index],
                ) * 1000;
                if (pointDistanceM < distanceM) {
                    distanceM = pointDistanceM;
                    closestIndex = index;
                }
                if (distanceM < 0.5) break;
            }
            if (distanceM <= favorite.radiusM && (!best || distanceM < best.distanceM)) {
                best = { favorite, distanceM, index: closestIndex };
            }
        }
        return best;
    }

    function favoriteVisits(track, favorites) {
        const visits = [];
        for (const favorite of favorites) {
            let visit = null;
            const finishVisit = () => {
                if (!visit) return;
                const fromKm = visit.start === 0 ? 0
                    : (track.cumulativeKm[visit.start - 1] + track.cumulativeKm[visit.start]) / 2;
                const toKm = visit.end === track.latitudes.length - 1 ? track.totalKm
                    : (track.cumulativeKm[visit.end] + track.cumulativeKm[visit.end + 1]) / 2;
                visits.push({
                    ...visit,
                    favorite,
                    fromKm,
                    toKm,
                    km: toKm - fromKm,
                });
                visit = null;
            };

            for (let index = 0; index < track.latitudes.length; index++) {
                const distanceM = haversineKm(
                    favorite.lat,
                    favorite.lon,
                    track.latitudes[index],
                    track.longitudes[index],
                ) * 1000;
                if (distanceM <= favorite.radiusM) {
                    if (!visit) {
                        visit = { start: index, end: index, index, distanceM };
                    } else {
                        visit.end = index;
                        if (distanceM < visit.distanceM) {
                            visit.index = index;
                            visit.distanceM = distanceM;
                        }
                    }
                } else {
                    finishVisit();
                }
            }
            finishVisit();
        }
        return visits.sort((a, b) => a.index - b.index || a.distanceM - b.distanceM);
    }

    function trackRangesOverlap(first, second) {
        return first.start <= second.end && second.start <= first.end;
    }

    // Limit only the displayed narrative; every crossed residential stretch
    // remains valid and is still geocoded. Favorite visits are detected over
    // the complete track. Start, finish, and favorite events are protected.
    function compactRouteRuns(runs) {
        const limit = Math.max(2, Math.floor(CONFIG.maxNamePlaces));
        const kept = runs.map(run => ({ ...run }));

        while (kept.length > limit && kept.length > 2) {
            let removeAt = -1;
            for (let i = 1; i < kept.length - 1; i++) {
                if (kept[i].favorite) continue;
                if (removeAt < 0 || kept[i].km < kept[removeAt].km) removeAt = i;
            }
            if (removeAt < 0) break;
            kept.splice(removeAt, 1);
        }
        return kept;
    }

    function routeNamesFromPassages(passages, track, favorites, shouldLog = false) {
        const visits = favoriteVisits(track, favorites);
        const coveredVisits = new Set();
        const events = [];
        for (const passage of passages) {
            const match = closestFavoriteForPassage(passage, track, favorites);
            const name = match?.favorite.name || passage.baseName;
            if (!name) continue;

            if (match) {
                for (const visit of visits) {
                    if (visit.favorite.id === match.favorite.id && trackRangesOverlap(visit, passage)) {
                        coveredVisits.add(visit);
                    }
                }
            }

            if (shouldLog && match) {
                const distanceLabel = `${passage.fromKm.toFixed(2)}–${passage.toKm.toFixed(2)} km`;
                log(`Favorite ${distanceLabel}: ${match.favorite.name}`
                    + ` (${match.distanceM.toFixed(0)} m from saved address)`);
            }

            events.push({
                name,
                km: passage.km,
                fromKm: passage.fromKm,
                toKm: passage.toKm,
                favorite: Boolean(match),
                orderIndex: match?.index ?? passage.anchor,
            });
        }

        for (const visit of visits) {
            if (coveredVisits.has(visit)) continue;
            if (shouldLog) {
                const distanceLabel = `${visit.fromKm.toFixed(2)}–${visit.toKm.toFixed(2)} km`;
                log(`Favorite ${distanceLabel}: ${visit.favorite.name}`
                    + ` (${visit.distanceM.toFixed(0)} m from saved address; full-track visit)`);
            }
            events.push({
                name: visit.favorite.name,
                km: visit.km,
                fromKm: visit.fromKm,
                toKm: visit.toKm,
                favorite: true,
                orderIndex: visit.index,
            });
        }

        events.sort((a, b) => a.orderIndex - b.orderIndex);
        const runs = [];
        for (const event of events) {
            const last = runs[runs.length - 1];
            if (last?.name === event.name) {
                last.km += event.km;
                last.fromKm = Math.min(last.fromKm, event.fromKm);
                last.toKm = Math.max(last.toKm, event.toKm);
                last.favorite ||= event.favorite;
            } else {
                runs.push({ ...event });
            }
        }

        const compacted = compactRouteRuns(runs);
        if (shouldLog && compacted.length < runs.length) {
            log(`Name compacted from ${runs.length} to ${compacted.length} places: `
                + compacted.map(run => run.name).join(' - '));
        }
        return compacted.map(run => run.name);
    }

    // Every continuous residential stretch contributes exactly one address in
    // travel order. Favorites are also detected between residential stretches.
    // Adjacent duplicates merge immediately; every later revisit remains visible.
    async function routePlaceNames(ranges, track, geocoder, onProgress) {
        const passages = [];
        for (let i = 0; i < ranges.length; i++) {
            onProgress?.(i + 1, ranges.length);
            const range = ranges[i];
            const lat = track.latitudes[range.anchor];
            const lon = track.longitudes[range.anchor];
            const exactGeo = await geocoder.reverse(lat, lon, CONFIG.nominatimAddressZoom);
            const coarseGeo = await geocoder.reverse(lat, lon, CONFIG.nominatimPlaceZoom);
            const baseName = resolvePlaceName(exactGeo, coarseGeo);
            const distanceLabel = `${range.fromKm.toFixed(2)}–${range.toKm.toFixed(2)} km`;
            log(`Residential ${distanceLabel}: ${baseName || 'no settlement address'}`
                + ` (zoom ${CONFIG.nominatimPlaceZoom}: ${coarseGeo?.name || 'none'})`);
            passages.push({
                ...range,
                lat,
                lon,
                baseName,
                address: formatAddress(exactGeo?.address),
            });
        }

        return {
            names: routeNamesFromPassages(passages, track, loadFavorites(), true),
            passages,
        };
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

        const latitudes = [];
        const longitudes = [];
        for (const point of points) {
            const lat = Number.parseFloat(point.getAttribute('lat'));
            const lon = Number.parseFloat(point.getAttribute('lon'));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                throw new Error('Downloaded GPX contains an invalid track point.');
            }
            latitudes.push(lat);
            longitudes.push(lon);
        }

        const cumulativeKm = [0];
        for (let i = 1; i < latitudes.length; i++) {
            cumulativeKm.push(cumulativeKm[i - 1] + haversineKm(
                latitudes[i - 1], longitudes[i - 1], latitudes[i], longitudes[i],
            ));
        }
        return {
            latitudes,
            longitudes,
            cumulativeKm,
            totalKm: cumulativeKm[cumulativeKm.length - 1],
        };
    }

    function updateFavoritesButtonLabel(count = loadFavorites().length) {
        const favoriteCount = count;
        const button = document.getElementById(FAVORITES_BUTTON_ID);
        if (!button) return;
        button.textContent = favoriteCount > 0 ? `★ ${favoriteCount}` : '☆';
        button.title = favoriteCount > 0
            ? `Manage ${favoriteCount} favorite address${favoriteCount === 1 ? '' : 'es'}`
            : 'Add and manage favorite addresses';
    }

    function setActivityName(names) {
        if (!names.length) return false;
        const nameInput = document.querySelector('input[name="activity[name]"]');
        if (!nameInput) return false;
        nameInput.value = names.join(' - ');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.focus();
        return true;
    }

    function refreshActivityNameFromFavorites() {
        if (!lastRouteAnalysis || lastRouteAnalysis.activityId !== getActivityId()) return;
        const names = routeNamesFromPassages(
            lastRouteAnalysis.passages,
            lastRouteAnalysis.track,
            loadFavorites(),
        );
        if (setActivityName(names)) log(`Name updated from favorites: ${names.join(' - ')}`);
    }

    function promptFavorite(existing, passage) {
        const defaultName = existing?.name || passage?.baseName || passage?.address || '';
        const enteredName = window.prompt('Custom name for this address:', defaultName);
        if (enteredName === null) return null;
        const name = enteredName.trim().replace(/\s+/g, ' ');
        if (!name || name.length > 80) {
            alert('Custom name must contain 1–80 characters.');
            return null;
        }

        const enteredRadius = window.prompt(
            'Matching radius in metres (10–5000):',
            String(existing?.radiusM ?? CONFIG.favoriteRadiusM),
        );
        if (enteredRadius === null) return null;
        const radiusM = Number(enteredRadius.replace(',', '.'));
        if (!Number.isFinite(radiusM) || radiusM < 10 || radiusM > 5000) {
            alert('Radius must be a number from 10 to 5000 metres.');
            return null;
        }

        return normalizeFavorite({
            id: existing?.id || createFavoriteId(),
            name,
            lat: existing?.lat ?? passage.lat,
            lon: existing?.lon ?? passage.lon,
            radiusM,
            address: existing?.address || passage.address || passage.baseName || '',
        });
    }

    function saveFavorite(existing, passage) {
        const favorite = promptFavorite(existing, passage);
        if (!favorite) return false;
        const favorites = loadFavorites();
        const index = favorites.findIndex(item => item.id === favorite.id);
        if (index >= 0) {
            favorites[index] = favorite;
        } else {
            favorites.push(favorite);
        }
        saveFavorites(favorites);
        refreshActivityNameFromFavorites();
        return true;
    }

    function removeFavorite(favorite) {
        if (!window.confirm(`Delete favorite "${favorite.name}"?`)) return false;
        const favorites = loadFavorites().filter(item => item.id !== favorite.id);
        saveFavorites(favorites);
        refreshActivityNameFromFavorites();
        return true;
    }

    async function runFavoriteAction(action) {
        try {
            await action();
        } catch (error) {
            console.error(`${LOG_PREFIX} Favorite address error:`, error);
            alert(`Favorite address error:\n${errorMessage(error)}`);
        }
    }

    function createDialogButton(text, primary = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        Object.assign(button.style, {
            flex: '0 0 auto',
            padding: '5px 9px',
            color: primary ? 'white' : '#242428',
            backgroundColor: primary ? BUTTON_COLORS.idle : '#f3f3f3',
            border: '1px solid #d5d5d5',
            borderRadius: '4px',
            cursor: 'pointer',
        });
        return button;
    }

    function appendFavoriteRow(container, title, details, actions) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '8px 0',
            borderBottom: '1px solid #eee',
        });

        const text = document.createElement('div');
        text.style.flex = '1 1 auto';
        const heading = document.createElement('div');
        heading.textContent = title;
        heading.style.fontWeight = '600';
        const description = document.createElement('div');
        description.textContent = details;
        Object.assign(description.style, {
            marginTop: '2px',
            color: '#666',
            fontSize: '12px',
            overflowWrap: 'anywhere',
        });
        text.append(heading, description);

        const controls = document.createElement('div');
        Object.assign(controls.style, {
            display: 'flex',
            gap: '6px',
        });
        controls.append(...actions);
        row.append(text, controls);
        container.append(row);
    }

    function appendManualFavoriteSearch(panel, closeDialog) {
        const title = document.createElement('h4');
        title.textContent = 'Add by address';
        title.style.margin = '0 0 6px';

        const form = document.createElement('form');
        Object.assign(form.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
        });

        const input = document.createElement('input');
        input.id = 'strava-route-favorite-address-input';
        input.type = 'text';
        input.placeholder = 'Street, house number, city';
        input.autocomplete = 'street-address';
        input.maxLength = 200;
        Object.assign(input.style, {
            flex: '1 1 auto',
            minWidth: '0',
            padding: '7px 9px',
            color: '#242428',
            background: 'white',
            border: '1px solid #d5d5d5',
            borderRadius: '4px',
        });

        const searchButton = createDialogButton('Find', true);
        searchButton.type = 'submit';
        form.append(input, searchButton);

        const status = document.createElement('div');
        status.setAttribute('aria-live', 'polite');
        Object.assign(status.style, {
            minHeight: '18px',
            marginTop: '5px',
            color: '#666',
            fontSize: '12px',
        });

        const results = document.createElement('div');
        const setStatus = (message, isError = false) => {
            status.textContent = message;
            status.style.color = isError ? BUTTON_COLORS.error : '#666';
        };

        const renderResults = candidates => {
            results.replaceChildren();
            for (const candidate of candidates) {
                const addButton = createDialogButton('☆ Add', true);
                addButton.addEventListener('click', () => void runFavoriteAction(() => {
                    if (!saveFavorite(null, candidate)) return;
                    closeDialog();
                    openFavoritesDialog();
                }));
                appendFavoriteRow(
                    results,
                    candidate.baseName,
                    candidate.address,
                    [addButton],
                );
            }
        };

        form.addEventListener('submit', event => {
            event.preventDefault();
            void runFavoriteAction(async () => {
                const query = input.value.trim().replace(/\s+/g, ' ');
                if (!query) {
                    setStatus('Enter an address to search.', true);
                    input.focus();
                    return;
                }

                input.disabled = true;
                searchButton.disabled = true;
                results.replaceChildren();
                setStatus('Searching…');
                try {
                    const candidates = await searchFavoriteAddresses(query);
                    renderResults(candidates);
                    setStatus(candidates.length
                        ? `Found ${candidates.length}. Choose the correct address.`
                        : 'No addresses found. Add a city or postcode and try again.',
                    );
                } catch (error) {
                    console.error(`${LOG_PREFIX} Address search error:`, error);
                    setStatus(`Search failed: ${errorMessage(error)}`, true);
                } finally {
                    input.disabled = false;
                    searchButton.disabled = false;
                    input.focus();
                }
            });
        });

        const attribution = document.createElement('div');
        Object.assign(attribution.style, {
            margin: '4px 0 18px',
            color: '#888',
            fontSize: '11px',
        });
        attribution.append('Search by Nominatim · © ');
        const attributionLink = document.createElement('a');
        attributionLink.href = 'https://www.openstreetmap.org/copyright';
        attributionLink.target = '_blank';
        attributionLink.rel = 'noopener noreferrer';
        attributionLink.textContent = 'OpenStreetMap contributors';
        attribution.append(attributionLink);

        panel.append(title, form, status, results, attribution);
    }

    function openFavoritesDialog() {
        document.getElementById(FAVORITES_DIALOG_ID)?.remove();

        const overlay = document.createElement('div');
        overlay.id = FAVORITES_DIALOG_ID;
        Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '10000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            background: 'rgba(0, 0, 0, 0.45)',
        });

        const panel = document.createElement('div');
        Object.assign(panel.style, {
            width: 'min(680px, 100%)',
            maxHeight: '85vh',
            overflowY: 'auto',
            padding: '18px',
            color: '#242428',
            background: 'white',
            borderRadius: '8px',
            boxShadow: '0 12px 36px rgba(0, 0, 0, 0.3)',
        });

        const close = () => {
            document.removeEventListener('keydown', onKeyDown);
            overlay.remove();
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKeyDown);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) close();
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
        });
        const title = document.createElement('h3');
        title.textContent = 'Favorite addresses';
        title.style.margin = '0';
        const closeButton = createDialogButton('Close');
        closeButton.addEventListener('click', close);
        header.append(title, closeButton);
        panel.append(header);

        const note = document.createElement('p');
        note.textContent = 'A custom name applies whenever the route comes within the saved radius.';
        Object.assign(note.style, {
            margin: '8px 0 16px',
            color: '#666',
            fontSize: '13px',
        });
        panel.append(note);

        appendManualFavoriteSearch(panel, close);

        const favorites = loadFavorites();
        const savedTitle = document.createElement('h4');
        savedTitle.textContent = `Saved (${favorites.length})`;
        savedTitle.style.margin = '0 0 4px';
        panel.append(savedTitle);
        if (favorites.length === 0) {
            const empty = document.createElement('p');
            empty.textContent = 'No favorite addresses yet.';
            empty.style.color = '#666';
            panel.append(empty);
        } else {
            for (const favorite of favorites) {
                const editButton = createDialogButton('Edit');
                editButton.addEventListener('click', () => runFavoriteAction(() => {
                    if (!saveFavorite(favorite, null)) return;
                    close();
                    openFavoritesDialog();
                }));
                const deleteButton = createDialogButton('Delete');
                deleteButton.addEventListener('click', () => runFavoriteAction(() => {
                    if (!removeFavorite(favorite)) return;
                    close();
                    openFavoritesDialog();
                }));
                const coordinates = `${favorite.lat.toFixed(5)}, ${favorite.lon.toFixed(5)}`;
                appendFavoriteRow(
                    panel,
                    `★ ${favorite.name}`,
                    `${favorite.address || coordinates} · ${favorite.radiusM} m`,
                    [editButton, deleteButton],
                );
            }
        }

        const routeTitle = document.createElement('h4');
        routeTitle.textContent = 'Addresses on this route';
        routeTitle.style.margin = '20px 0 4px';
        panel.append(routeTitle);

        const analysis = lastRouteAnalysis?.activityId === getActivityId() ? lastRouteAnalysis : null;
        if (!analysis) {
            const empty = document.createElement('p');
            empty.textContent = 'Generate the route name first, then open favorites again.';
            empty.style.color = '#666';
            panel.append(empty);
        } else {
            for (const passage of analysis.passages) {
                const match = closestFavoriteForPassage(passage, analysis.track, favorites);
                const actionButton = createDialogButton(
                    match ? `★ ${match.favorite.name}` : '☆ Add',
                    !match,
                );
                actionButton.addEventListener('click', () => runFavoriteAction(() => {
                    if (!saveFavorite(match?.favorite || null, passage)) return;
                    close();
                    openFavoritesDialog();
                }));
                const distance = `${passage.fromKm.toFixed(2)}–${passage.toKm.toFixed(2)} km`;
                const coordinates = `${passage.lat.toFixed(5)}, ${passage.lon.toFixed(5)}`;
                appendFavoriteRow(
                    panel,
                    `${distance} · ${passage.baseName || 'Unknown place'}`,
                    passage.address || coordinates,
                    [actionButton],
                );
            }
        }

        overlay.append(panel);
        document.body.append(overlay);
    }

    async function generateAndFillName(button) {
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

        button.disabled = true;
        setButtonState(button, STRINGS.downloading, 'loading');

        try {
            const gpxText = await downloadGpx(activityId);
            setButtonState(button, STRINGS.analyzing, 'loading');
            const track = parseGpxTrack(gpxText);
            if (!track) {
                alert(STRINGS.noGps);
                return;
            }
            log(`${track.totalKm.toFixed(1)} km, ${track.latitudes.length} trackpoints`);

            setButtonState(button, `${STRINGS.landuse}...`, 'loading');
            const residential = await loadResidentialRanges(
                activityId,
                track,
                delay => setButtonState(
                    button, `${STRINGS.overpassBusy} ${Math.ceil(delay / 1000)}s...`, 'loading'),
            );
            log(`${residential.ranges.length} crossed residential stretches`
                + (residential.cached ? ' (cached)' : ` from ${residential.areaCount} OSM areas`));

            setButtonState(button, `${STRINGS.geocoding}...`, 'loading');
            const geocoder = createGeocoder();
            const route = await routePlaceNames(
                residential.ranges,
                track,
                geocoder,
                (done, total) => setButtonState(
                    button, `${STRINGS.geocoding} ${done}/${total}...`, 'loading'),
            );
            lastRouteAnalysis = { activityId, track, passages: route.passages };
            if (route.names.length === 0) {
                throw new Error('The route does not enter a named residential area or favorite radius.');
            }
            const newName = route.names.join(' - ');
            log(`${residential.ranges.length} residential addresses, ${geocoder.apiCalls} API calls`);
            log(`Name: ${newName}`);

            setActivityName(route.names);
            setButtonState(button, STRINGS.done, 'success');
            await sleep(CONFIG.successStateMs);
        } catch (error) {
            console.error(LOG_PREFIX, error);
            alert(`Error:\n${errorMessage(error)}`);
            setButtonState(button, STRINGS.error, 'error');
            await sleep(CONFIG.errorStateMs);
        } finally {
            button.disabled = false;
            setButtonState(button, STRINGS.idle);
        }
    }

    function injectButton() {
        if (document.querySelector(`#${BUTTON_ID}`)) return;

        const titleLabel = document.querySelector('label[for="activity_name"]');
        if (!titleLabel?.parentNode) return;

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.title = 'Generate name from GPS track';
        Object.assign(button.style, {
            marginLeft: 'auto',
            verticalAlign: 'middle',
            fontSize: '12px',
            padding: '3px 10px',
            color: 'white',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
        });
        setButtonState(button, STRINGS.idle);
        button.addEventListener('mouseenter', () => {
            if (button.dataset.state === 'idle') {
                button.style.backgroundColor = BUTTON_COLORS.hover;
            }
        });
        button.addEventListener('mouseleave', () => {
            if (button.dataset.state === 'idle') {
                button.style.backgroundColor = BUTTON_COLORS.idle;
            }
        });
        button.addEventListener('click', event => {
            event.preventDefault();
            void generateAndFillName(button);
        });

        const favoritesButton = document.createElement('button');
        favoritesButton.id = FAVORITES_BUTTON_ID;
        favoritesButton.type = 'button';
        Object.assign(favoritesButton.style, {
            marginLeft: '6px',
            verticalAlign: 'middle',
            fontSize: '12px',
            padding: '3px 9px',
            color: BUTTON_COLORS.idle,
            backgroundColor: 'white',
            border: `1px solid ${BUTTON_COLORS.idle}`,
            borderRadius: '3px',
            cursor: 'pointer',
        });
        favoritesButton.addEventListener('click', event => {
            event.preventDefault();
            runFavoriteAction(openFavoritesDialog);
        });

        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, {
            display: 'flex',
            alignItems: 'center',
        });
        titleLabel.parentNode.insertBefore(wrapper, titleLabel);
        wrapper.append(titleLabel, button, favoritesButton);
        runFavoriteAction(updateFavoritesButtonLabel);
        log('Button injected');
    }

    new MutationObserver(injectButton).observe(document.body, { childList: true, subtree: true });
    injectButton();
})();
