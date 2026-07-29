// ==UserScript==
// @name         Strava Activity Route Renamer
// @namespace    https://tampermonkey.net/
// @version      4.7.4
// @description  Names Strava activities from nearby OSM settlements and named roads
// @author       Antigravity
// @match        https://www.strava.com/activities/*/edit
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        placeRadiusM: 300,
        roadMatchRadiusM: 25,
        featureCacheDays: 30,
        overpassMaxRoutePoints: 50,
        overpassTimeoutMs: 25000,
        overpassMaxAttempts: 3,
        overpassRetryBaseMs: 5000,
        minAutoPlaces: 3,
        maxAutoPlaces: 7,
        autoPlaceSpacingKm: 4,
        favoriteRadiusM: 200,
        stripPlaceParentheticals: true,
        nominatimIntervalMs: 1050,
        successStateMs: 1500,
        errorStateMs: 2000,
    };

    const STRINGS = {
        idle: 'Generate from Geo',
        downloading: '⌛ Downloading...',
        analyzing: '⌛ Analyzing...',
        places: '⌛ Loading nearby landmarks',
        overpassBusy: '⌛ Overpass busy; retrying in',
        done: '✔️ Done!',
        error: '❌ Error',
        noGps: 'No GPS data found (manual entry or indoor activity?)',
        noId: 'Could not detect activity ID from URL.',
    };

    const API_URL = {
        nominatimSearch: 'https://nominatim.openstreetmap.org/search',
        overpass: 'https://overpass-api.de/api/interpreter',
    };
    const CACHE_PREFIX = {
        routeFeatures: 'strava_route_features_v1_',
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

    // Douglas-Peucker simplification keeps the Overpass linestring compact.
    // The query radius includes the simplification tolerance, so no settlement
    // near the original GPX line is lost when bends are removed.
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

    function trackSignature(track) {
        const last = track.latitudes.length - 1;
        return [
            track.latitudes.length,
            track.totalKm.toFixed(3),
            track.latitudes[0].toFixed(5),
            track.longitudes[0].toFixed(5),
            track.latitudes[last].toFixed(5),
            track.longitudes[last].toFixed(5),
            CONFIG.placeRadiusM,
            CONFIG.roadMatchRadiusM,
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

    function routeFeatureOverpassQuery(points, placeRadiusM, roadRadiusM) {
        const line = points
            .map(point => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`).join(',');
        return `[out:json][timeout:${Math.ceil(CONFIG.overpassTimeoutMs / 1000)}];\n`
            + '(\n'
            + `node["place"~"^(city|town|village)$"](around:${placeRadiusM},${line});\n`
            + 'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|'
            + `residential|living_street|cycleway)$"]["name"](around:${roadRadiusM},${line});\n`
            + ');\n'
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

    async function fetchOverpassElements(points, placeRadiusM, roadRadiusM, onRetry) {
        const query = routeFeatureOverpassQuery(points, placeRadiusM, roadRadiusM);
        const attempts = Math.max(1, Math.floor(CONFIG.overpassMaxAttempts));
        let failure = new Error('Failed to load nearby OSM landmarks');

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
                failure = new Error(`Failed to load nearby OSM landmarks: ${errorMessage(error)}`);
            }

            if (response?.ok) {
                try {
                    return await parseOverpassElements(response);
                } catch (error) {
                    failure = new Error(`Failed to load nearby OSM landmarks: ${errorMessage(error)}`);
                }
            } else if (response) {
                failure = new Error(`Failed to load nearby OSM landmarks: HTTP ${response.status}`);
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

    async function fetchRouteFeatures(track, onRetry) {
        const simplified = simplifyTrackForOverpass(track);
        const simplificationM = simplified.toleranceKm * 1000;
        const placeRadiusM = Math.ceil(CONFIG.placeRadiusM + simplificationM + 10);
        const roadRadiusM = Math.ceil(CONFIG.roadMatchRadiusM + simplificationM + 10);
        const elements = await fetchOverpassElements(
            simplified.points,
            placeRadiusM,
            roadRadiusM,
            onRetry,
        );
        return {
            places: parsePlaceNodes(elements),
            roads: parseNamedRoads(elements),
        };
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

    function parsePlaceNodes(elements) {
        const places = [];
        for (const element of elements || []) {
            const lat = Number(element?.lat);
            const lon = Number(element?.lon);
            const placeType = element?.tags?.place;
            const rawName = element?.tags?.['name:de'] || element?.tags?.name;
            if (element?.type !== 'node'
                || !Number.isFinite(lat) || !Number.isFinite(lon)
                || !['city', 'town', 'village'].includes(placeType)
                || typeof rawName !== 'string' || !rawName.trim()) {
                continue;
            }
            places.push({
                id: String(element.id),
                name: cleanPlaceName(rawName),
                placeType,
                lat,
                lon,
            });
        }
        return places;
    }

    const ROAD_TYPE_PRIORITY = {
        motorway: 8,
        trunk: 7,
        primary: 6,
        secondary: 5,
        tertiary: 4,
        unclassified: 3,
        residential: 2,
        living_street: 1,
        cycleway: 1,
    };

    function parseNamedRoads(elements) {
        const roadsByName = new Map();
        for (const element of elements || []) {
            const roadType = element?.tags?.highway;
            const rawName = element?.tags?.['name:de'] || element?.tags?.name;
            const geometry = (element?.geometry || [])
                .map(point => ({ lat: Number(point?.lat), lon: Number(point?.lon) }))
                .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
            if (element?.type !== 'way'
                || !Object.hasOwn(ROAD_TYPE_PRIORITY, roadType)
                || typeof rawName !== 'string' || !rawName.trim()
                || geometry.length < 2) {
                continue;
            }

            const name = cleanPlaceName(rawName);
            const key = name.toLocaleLowerCase();
            const existing = roadsByName.get(key);
            if (existing) {
                existing.geometries.push(geometry);
                if (ROAD_TYPE_PRIORITY[roadType] > ROAD_TYPE_PRIORITY[existing.roadType]) {
                    existing.roadType = roadType;
                }
            } else {
                roadsByName.set(key, {
                    id: `road_${element.id}`,
                    name,
                    roadType,
                    geometries: [geometry],
                });
            }
        }
        return Array.from(roadsByName.values(), road => {
            const bbox = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
            for (const geometry of road.geometries) {
                for (const point of geometry) {
                    bbox.south = Math.min(bbox.south, point.lat);
                    bbox.west = Math.min(bbox.west, point.lon);
                    bbox.north = Math.max(bbox.north, point.lat);
                    bbox.east = Math.max(bbox.east, point.lon);
                }
            }
            return { ...road, bbox };
        });
    }

    function passageDistances(track, start, end) {
        const fromKm = start === 0 ? 0
            : (track.cumulativeKm[start - 1] + track.cumulativeKm[start]) / 2;
        const toKm = end === track.latitudes.length - 1 ? track.totalKm
            : (track.cumulativeKm[end] + track.cumulativeKm[end + 1]) / 2;
        return { fromKm, toKm, km: toKm - fromKm };
    }

    // A settlement contributes one event for every distinct pass within the
    // configured radius. This intentionally uses OSM place nodes rather than
    // reverse-geocoded administrative parents.
    function passagesNearPlaces(track, places) {
        const passages = [];
        for (const place of places) {
            let visit = null;
            const finishVisit = () => {
                if (!visit) return;
                const distances = passageDistances(track, visit.start, visit.end);
                passages.push({
                    ...visit,
                    ...distances,
                    anchor: visit.index,
                    lat: track.latitudes[visit.index],
                    lon: track.longitudes[visit.index],
                    baseName: place.name,
                    address: `${place.name} (${place.placeType})`,
                    placeId: place.id,
                    placeType: place.placeType,
                    featureKind: 'place',
                });
                visit = null;
            };

            for (let index = 0; index < track.latitudes.length; index++) {
                const distanceM = haversineKm(
                    place.lat,
                    place.lon,
                    track.latitudes[index],
                    track.longitudes[index],
                ) * 1000;
                if (distanceM <= CONFIG.placeRadiusM) {
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
        return passages.sort((a, b) => a.anchor - b.anchor || a.distanceM - b.distanceM);
    }

    function pointSegmentDistanceKm(lat, lon, first, second) {
        const kx = 111.32 * Math.cos(lat * Math.PI / 180);
        const ky = 110.57;
        const ax = (first.lon - lon) * kx;
        const ay = (first.lat - lat) * ky;
        const bx = (second.lon - lon) * kx;
        const by = (second.lat - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        const ratio = lengthSquared === 0 ? 0
            : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
        return Math.hypot(ax + ratio * dx, ay + ratio * dy);
    }

    function pointRoadDistanceKm(lat, lon, road, limitKm) {
        const dLat = limitKm / 110.57;
        const dLon = limitKm / Math.max(1, 111.32 * Math.cos(lat * Math.PI / 180));
        if (lat < road.bbox.south - dLat || lat > road.bbox.north + dLat
            || lon < road.bbox.west - dLon || lon > road.bbox.east + dLon) {
            return Infinity;
        }

        let bestKm = Infinity;
        for (const geometry of road.geometries) {
            for (let i = 1; i < geometry.length; i++) {
                const first = geometry[i - 1];
                const second = geometry[i];
                if (lat < Math.min(first.lat, second.lat) - dLat
                    || lat > Math.max(first.lat, second.lat) + dLat
                    || lon < Math.min(first.lon, second.lon) - dLon
                    || lon > Math.max(first.lon, second.lon) + dLon) {
                    continue;
                }
                bestKm = Math.min(
                    bestKm,
                    pointSegmentDistanceKm(lat, lon, first, second),
                );
            }
        }
        return bestKm;
    }

    function passagesNearRoads(track, roads) {
        const passages = [];
        const radiusKm = CONFIG.roadMatchRadiusM / 1000;
        for (const road of roads) {
            let visit = null;
            const finishVisit = () => {
                if (!visit) return;
                const distances = passageDistances(track, visit.start, visit.end);
                passages.push({
                    ...visit,
                    ...distances,
                    anchor: visit.index,
                    lat: track.latitudes[visit.index],
                    lon: track.longitudes[visit.index],
                    baseName: road.name,
                    address: `${road.name} (${road.roadType})`,
                    roadId: road.id,
                    roadType: road.roadType,
                    featureKind: 'road',
                });
                visit = null;
            };

            for (let index = 0; index < track.latitudes.length; index++) {
                const distanceKm = pointRoadDistanceKm(
                    track.latitudes[index],
                    track.longitudes[index],
                    road,
                    radiusKm,
                );
                if (distanceKm <= radiusKm) {
                    const distanceM = distanceKm * 1000;
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
        return passages.sort((a, b) => a.anchor - b.anchor || a.distanceM - b.distanceM);
    }

    function routeFeatureCacheKey(activityId) {
        return `${CACHE_PREFIX.routeFeatures}${activityId}`;
    }

    function isValidCachedPassage(passage, trackLength) {
        const commonIsValid = isValidCachedRange(passage, trackLength)
            && typeof passage.baseName === 'string'
            && passage.baseName.length > 0
            && typeof passage.address === 'string'
            && Number.isFinite(passage.lat)
            && Number.isFinite(passage.lon)
            && Number.isFinite(passage.distanceM);
        if (!commonIsValid) return false;
        if (passage.featureKind === 'place') {
            return typeof passage.placeId === 'string'
                && ['city', 'town', 'village'].includes(passage.placeType);
        }
        if (passage.featureKind === 'road') {
            return typeof passage.roadId === 'string'
                && Object.hasOwn(ROAD_TYPE_PRIORITY, passage.roadType);
        }
        return false;
    }

    function cachedRoutePassages(activityId, track) {
        const key = routeFeatureCacheKey(activityId);
        const value = readJsonCache(key);
        if (!value) return null;

        const maxAge = CONFIG.featureCacheDays * 24 * 60 * 60 * 1000;
        const isValid = value.signature === trackSignature(track)
            && Number.isFinite(value.savedAt)
            && Date.now() - value.savedAt <= maxAge
            && Array.isArray(value.passages)
            && value.passages.every(passage => isValidCachedPassage(passage, track.latitudes.length));
        if (!isValid) {
            localStorage.removeItem(key);
            return null;
        }
        return value;
    }

    function cacheRoutePassages(activityId, track, passages, placeCount, roadCount) {
        writeJsonCache(routeFeatureCacheKey(activityId), {
            signature: trackSignature(track),
            savedAt: Date.now(),
            passages,
            placeCount,
            roadCount,
        });
    }

    async function loadRoutePassages(activityId, track, onRetry) {
        const cached = cachedRoutePassages(activityId, track);
        if (cached) {
            return {
                passages: cached.passages,
                cached: true,
                placeCount: cached.placeCount,
                roadCount: cached.roadCount,
            };
        }

        const features = await fetchRouteFeatures(track, onRetry);
        const placePassages = passagesNearPlaces(track, features.places);
        const placeRunCount = placePassages.reduce((count, passage, index) =>
            index > 0 && placePassages[index - 1].baseName === passage.baseName
                ? count
                : count + 1, 0);
        const roadPassages = placeRunCount < automaticPlaceLimit(track)
            ? passagesNearRoads(track, features.roads)
            : [];
        const passages = placePassages
            .concat(roadPassages)
            .sort((a, b) => a.anchor - b.anchor || a.distanceM - b.distanceM);
        cacheRoutePassages(
            activityId,
            track,
            passages,
            features.places.length,
            features.roads.length,
        );
        return {
            passages,
            cached: false,
            placeCount: features.places.length,
            roadCount: features.roads.length,
        };
    }

    // Nominatim address fields are used only to suggest a readable default
    // when the user searches for a custom favorite.
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

    // The map viewport is determined by the route's geographical extent, not
    // by travelled distance. A loop or an out-and-back can be long while still
    // occupying a small area.
    function routeMapExtentKm(track) {
        let south = Infinity;
        let west = Infinity;
        let north = -Infinity;
        let east = -Infinity;
        for (let i = 0; i < track.latitudes.length; i++) {
            south = Math.min(south, track.latitudes[i]);
            west = Math.min(west, track.longitudes[i]);
            north = Math.max(north, track.latitudes[i]);
            east = Math.max(east, track.longitudes[i]);
        }
        if (!Number.isFinite(south)) return 0;
        return haversineKm(south, west, north, east);
    }

    function automaticPlaceLimit(track) {
        const minimum = Math.max(1, Math.floor(CONFIG.minAutoPlaces));
        const maximum = Math.max(minimum, Math.floor(CONFIG.maxAutoPlaces));
        const spacingKm = Math.max(1, Number(CONFIG.autoPlaceSpacingKm));
        return Math.max(
            minimum,
            Math.min(maximum, Math.round(routeMapExtentKm(track) / spacingKm)),
        );
    }

    function projectedRunPoint(run, track, referenceLat) {
        const fallbackIndex = Math.max(
            0,
            Math.min(track.latitudes.length - 1, Math.round(run.orderIndex)),
        );
        const lat = Number.isFinite(run.lat) ? run.lat : track.latitudes[fallbackIndex];
        const lon = Number.isFinite(run.lon) ? run.lon : track.longitudes[fallbackIndex];
        return {
            x: lon * 111.32 * Math.cos(referenceLat * Math.PI / 180),
            y: lat * 110.57,
        };
    }

    function convexHullArea(points) {
        if (points.length < 3) return 0;
        const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
        const cross = (origin, first, second) =>
            (first.x - origin.x) * (second.y - origin.y)
            - (first.y - origin.y) * (second.x - origin.x);
        const lower = [];
        for (const point of sorted) {
            while (lower.length >= 2
                && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
                lower.pop();
            }
            lower.push(point);
        }
        const upper = [];
        for (let i = sorted.length - 1; i >= 0; i--) {
            const point = sorted[i];
            while (upper.length >= 2
                && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
                upper.pop();
            }
            upper.push(point);
        }
        lower.pop();
        upper.pop();
        const hull = lower.concat(upper);
        let twiceArea = 0;
        for (let i = 0; i < hull.length; i++) {
            const next = hull[(i + 1) % hull.length];
            twiceArea += hull[i].x * next.y - next.x * hull[i].y;
        }
        return Math.abs(twiceArea) / 2;
    }

    function fillCoverageSelection(runs, track, candidateIndices, selected, targetSize) {
        if (selected.size >= targetSize || candidateIndices.length === 0) return selected;
        const referenceLat = track.latitudes.reduce((sum, lat) => sum + lat, 0)
            / track.latitudes.length;
        const allIndices = Array.from(new Set([...selected, ...candidateIndices]));
        const points = new Map(allIndices.map(index => [
            index,
            projectedRunPoint(runs[index], track, referenceLat),
        ]));

        while (selected.size < targetSize) {
            const selectedPoints = Array.from(selected, index => points.get(index));
            let bestIndex = -1;
            let bestArea = -1;
            let bestSpacingKm = -1;
            let bestPriority = -1;
            for (const index of candidateIndices) {
                if (selected.has(index)) continue;
                const point = points.get(index);
                const area = convexHullArea(selectedPoints.concat(point));
                const nearestSelectedKm = selectedPoints.length === 0 ? 0 : Math.min(
                    ...selectedPoints.map(selectedPoint =>
                        Math.hypot(point.x - selectedPoint.x, point.y - selectedPoint.y)),
                );
                const priority = runs[index].featureKind === 'road'
                    ? ROAD_TYPE_PRIORITY[runs[index].roadType] || 0
                    : 100;
                if (area > bestArea + 1e-9
                    || (Math.abs(area - bestArea) <= 1e-9
                        && (nearestSelectedKm > bestSpacingKm + 1e-9
                            || (Math.abs(nearestSelectedKm - bestSpacingKm) <= 1e-9
                                && priority > bestPriority)))) {
                    bestArea = area;
                    bestSpacingKm = nearestSelectedKm;
                    bestPriority = priority;
                    bestIndex = index;
                }
            }
            if (bestIndex < 0) break;
            selected.add(bestIndex);
        }
        return selected;
    }

    function selectSingleCoverageIndex(runs, track, candidateIndices) {
        if (candidateIndices.length === 0) return -1;
        const referenceLat = track.latitudes.reduce((sum, lat) => sum + lat, 0)
            / track.latitudes.length;
        const start = projectedRunPoint({
            orderIndex: 0,
            lat: track.latitudes[0],
            lon: track.longitudes[0],
        }, track, referenceLat);
        const lastIndex = track.latitudes.length - 1;
        const finish = projectedRunPoint({
            orderIndex: lastIndex,
            lat: track.latitudes[lastIndex],
            lon: track.longitudes[lastIndex],
        }, track, referenceLat);
        let bestIndex = candidateIndices[0];
        let bestEndpointSpacingKm = -1;
        let bestPriority = -1;
        for (const index of candidateIndices) {
            const point = projectedRunPoint(runs[index], track, referenceLat);
            const endpointSpacingKm = Math.min(
                Math.hypot(point.x - start.x, point.y - start.y),
                Math.hypot(point.x - finish.x, point.y - finish.y),
            );
            const priority = runs[index].featureKind === 'road'
                ? ROAD_TYPE_PRIORITY[runs[index].roadType] || 0
                : 100;
            if (endpointSpacingKm > bestEndpointSpacingKm + 1e-9
                || (Math.abs(endpointSpacingKm - bestEndpointSpacingKm) <= 1e-9
                    && priority > bestPriority)) {
                bestEndpointSpacingKm = endpointSpacingKm;
                bestPriority = priority;
                bestIndex = index;
            }
        }
        return bestIndex;
    }

    // Settlements have absolute priority. Named roads fill only unused slots.
    // Interior favorites occupy normal places in the limit; the first and last
    // displayed route points do not consume it.
    function compactRouteRuns(runs, track) {
        const endpointIndices = new Set();
        if (runs.length > 0) {
            endpointIndices.add(0);
            endpointIndices.add(runs.length - 1);
        }
        const interiorFavoriteCount = runs.reduce(
            (count, run, index) =>
                count + Number(run.favorite && !endpointIndices.has(index)),
            0,
        );
        const automaticLimit = Math.max(
            0,
            automaticPlaceLimit(track) - interiorFavoriteCount,
        );
        const placeIndices = runs
            .map((run, index) =>
                !endpointIndices.has(index) && !run.favorite && run.featureKind === 'place'
                    ? index
                    : -1)
            .filter(index => index >= 0);
        const placeNames = new Set(placeIndices.map(index => runs[index].name));
        const roadIndices = runs
            .map((run, index) =>
                !endpointIndices.has(index)
                    && !run.favorite
                    && run.featureKind === 'road'
                    && !placeNames.has(run.name)
                    ? index
                    : -1)
            .filter(index => index >= 0);
        let selectedAutomatic;

        if (automaticLimit === 0) {
            selectedAutomatic = new Set();
        } else if (placeIndices.length >= automaticLimit) {
            selectedAutomatic = automaticLimit === 1
                ? new Set([selectSingleCoverageIndex(runs, track, placeIndices)])
                : new Set([
                    placeIndices[0],
                    placeIndices[placeIndices.length - 1],
                ]);
            selectedAutomatic = fillCoverageSelection(
                runs,
                track,
                placeIndices,
                selectedAutomatic,
                automaticLimit,
            );
        } else {
            selectedAutomatic = new Set(placeIndices);
            if (selectedAutomatic.size === 0 && roadIndices.length > 0) {
                if (automaticLimit === 1) {
                    selectedAutomatic.add(selectSingleCoverageIndex(runs, track, roadIndices));
                } else {
                    selectedAutomatic.add(roadIndices[0]);
                    selectedAutomatic.add(roadIndices[roadIndices.length - 1]);
                }
            }
            selectedAutomatic = fillCoverageSelection(
                runs,
                track,
                roadIndices,
                selectedAutomatic,
                Math.min(automaticLimit, placeIndices.length + roadIndices.length),
            );
        }
        return runs
            .filter((run, index) =>
                endpointIndices.has(index) || run.favorite || selectedAutomatic.has(index))
            .map(run => ({ ...run }));
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
                lat: match?.favorite.lat ?? passage.lat,
                lon: match?.favorite.lon ?? passage.lon,
                featureKind: match ? 'favorite' : passage.featureKind,
                roadType: passage.roadType || null,
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
                lat: visit.favorite.lat,
                lon: visit.favorite.lon,
                featureKind: 'favorite',
                roadType: null,
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
                if (event.favorite) {
                    last.featureKind = 'favorite';
                } else if (event.featureKind === 'place' && last.featureKind === 'road') {
                    last.featureKind = 'place';
                }
            } else {
                runs.push({ ...event });
            }
        }

        const compacted = compactRouteRuns(runs, track);
        if (shouldLog) {
            const selectedPlaces = compacted.filter(run => !run.favorite
                && run.featureKind === 'place').length;
            const selectedRoads = compacted.filter(run => !run.favorite
                && run.featureKind === 'road').length;
            const selectedFavorites = compacted.filter(run => run.favorite).length;
            log(`Map extent ${routeMapExtentKm(track).toFixed(1)} km: `
                + `${selectedPlaces} settlements`
                + (selectedRoads ? ` + ${selectedRoads} named-road fallbacks` : '')
                + ` + ${selectedFavorites} favorites`);
        }
        if (shouldLog && compacted.length < runs.length) {
            log(`Name compacted from ${runs.length} to ${compacted.length} places: `
                + compacted.map(run => run.name).join(' - '));
        }
        return compacted.map(run => run.name);
    }

    // Settlement and road visits are already ordered by the closest GPX point.
    // Adjacent duplicates merge immediately; a later revisit remains visible.
    function routePlaceNames(passages, track) {
        const placePassages = passages.filter(passage => passage.featureKind === 'place');
        for (const passage of placePassages) {
            const distanceLabel = `${passage.fromKm.toFixed(2)}–${passage.toKm.toFixed(2)} km`;
            log(`Nearby place ${distanceLabel}: ${passage.baseName}`
                + ` (${passage.distanceM.toFixed(0)} m from OSM ${passage.placeType} node)`);
        }
        const roadPassageCount = passages.length - placePassages.length;
        if (roadPassageCount > 0) {
            log(`${roadPassageCount} named-road visits available as fallback`);
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
        const enteredName = window.prompt('Custom name for this place:', defaultName);
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
        routeTitle.textContent = 'Route landmarks';
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

            setButtonState(button, `${STRINGS.places}...`, 'loading');
            const routeFeatures = await loadRoutePassages(
                activityId,
                track,
                delay => setButtonState(
                    button, `${STRINGS.overpassBusy} ${Math.ceil(delay / 1000)}s...`, 'loading'),
            );
            log(`${routeFeatures.passages.length} route landmark visits`
                + (routeFeatures.cached ? ' (cached)' : ` from ${routeFeatures.placeCount} OSM places`
                    + ` and ${routeFeatures.roadCount} named roads`));

            const route = routePlaceNames(routeFeatures.passages, track);
            lastRouteAnalysis = { activityId, track, passages: route.passages };
            if (route.names.length === 0) {
                throw new Error('The route has no named OSM place, road, or favorite radius.');
            }
            const newName = route.names.join(' - ');
            log(`${routeFeatures.passages.length} route landmark visits`);
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
