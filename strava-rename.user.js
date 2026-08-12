// ==UserScript==
// @name         Strava Activity Route Renamer
// @namespace    https://tampermonkey.net/
// @version      5.0.0
// @description  Names Strava activities from nearby OSM settlements and named roads
// @author       Antigravity
// @match        https://www.strava.com/activities/*/edit
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      overpass-api.de
// @connect      overpass.kumi.systems
// @connect      overpass.private.coffee
// @connect      nominatim.openstreetmap.org
// @connect      self
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
        overpassMirrorRetryMs: 1000,
        minAutoPlaces: 3,
        maxAutoPlaces: 7,
        autoPlaceSpacingKm: 4,
        favoriteRadiusM: 200,
        favoriteRadiusMinM: 10,
        favoriteRadiusMaxM: 5000,
        maxPlaceNameLength: 80,
        maxNameLength: 200,
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
    };
    // Tried in order, one per attempt: a busy or rate-limiting instance is
    // usually answered instantly by the next mirror.
    const OVERPASS_ENDPOINTS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
    ];
    const CACHE_PREFIX = {
        routeFeatures: 'strava_route_features_v1_',
    };
    const STORAGE_KEY = {
        favorites: 'strava_route_favorites_v1',
        blockedNames: 'strava_route_blocked_names_v1',
        pinnedNames: 'strava_route_pinned_names_v1',
    };
    // One stylesheet instead of a style object per element. It is adopted
    // through the CSSOM rather than injected as a <style> tag, because a
    // page's style-src policy can drop the tag but never reaches constructed
    // sheets — the same reason the network calls go through the manager.
    // Inline styles used to beat Strava's own CSS for free; class rules do not,
    // so dialog rules are scoped under the overlay and the two buttons that sit
    // inside Strava's form repeat their class to outweigh the page.
    //
    // Colours, radii and spacing are Strava's own design tokens, declared on
    // :root by the page, so the dialog follows the site instead of guessing at
    // it. They are used without a var() fallback: if Strava ever renames one,
    // the affected rule drops out rather than silently drifting out of date.
    const STYLE_ID = 'strava-route-styles';
    const STYLES = `
.strava-route-button.strava-route-button {
    flex: 0 0 auto;
    margin-left: auto;
    padding: var(--space-3xs) var(--space-2xs);
    font-size: 12px;
    color: var(--color-corewhite);
    vertical-align: middle;
    background-color: var(--color-coreo3);
    border: none;
    border-radius: var(--border-radius-sm);
    cursor: pointer;
}
.strava-route-button.strava-route-button:hover[data-state="idle"] {
    background-color: var(--color-extendedorangeo2);
}
.strava-route-button.strava-route-button[data-state="loading"] {
    background-color: var(--color-extendedneutraln4);
}
.strava-route-button.strava-route-button[data-state="success"] {
    background-color: var(--color-extendedgreeng2);
}
.strava-route-button.strava-route-button[data-state="error"] {
    background-color: var(--color-extendedredr3);
}
.strava-route-button--secondary.strava-route-button--secondary {
    margin-left: var(--space-3xs);
    color: var(--color-coreo3);
    background-color: var(--color-corewhite);
    border: var(--border-width-thin) solid var(--color-coreo3);
}
.strava-route-controls { display: flex; align-items: center; }
.strava-route-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-md);
    background: rgba(0, 0, 0, 0.45);
}
.strava-route-overlay .strava-route-panel {
    width: min(680px, 100%);
    max-height: 85vh;
    overflow-y: auto;
    padding: var(--space-md);
    color: var(--color-extendedneutraln1);
    background: var(--color-corewhite);
    border-radius: var(--border-radius-md);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3);
}
.strava-route-overlay .strava-route-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-xs);
}
.strava-route-overlay .strava-route-header h3 { margin: 0; }
.strava-route-overlay .strava-route-panel h4 { margin: var(--space-md) 0 var(--space-3xs); }
.strava-route-overlay .strava-route-panel h4.strava-route-first { margin-top: 0; }
.strava-route-overlay .strava-route-note {
    margin: 0 0 var(--space-2xs);
    color: var(--color-extendedneutraln3);
    font-size: 12px;
}
.strava-route-overlay .strava-route-dialog-button {
    flex: 0 0 auto;
    padding: var(--space-3xs) var(--space-2xs);
    color: var(--color-extendedneutraln1);
    background-color: var(--color-extendedneutraln6);
    border: var(--border-width-thin) solid var(--color-extendedneutraln5);
    border-radius: var(--border-radius-sm);
    cursor: pointer;
}
.strava-route-overlay .strava-route-dialog-button--primary {
    color: var(--color-corewhite);
    background-color: var(--color-coreo3);
    border-color: var(--color-coreo3);
}
.strava-route-overlay .strava-route-dialog-button[disabled] { opacity: 0.5; cursor: default; }
.strava-route-overlay .strava-route-field {
    flex: 1 1 auto;
    min-width: 0;
    padding: var(--space-2xs) var(--space-xs);
    color: var(--color-extendedneutraln1);
    background: var(--color-corewhite);
    border: var(--border-width-thin) solid var(--color-extendedneutraln5);
    border-radius: var(--border-radius-sm);
}
.strava-route-overlay .strava-route-field--narrow { flex: 0 0 130px; }
.strava-route-overlay .strava-route-form {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
}
.strava-route-overlay .strava-route-status {
    min-height: 18px;
    margin-top: var(--space-4xs);
    color: var(--color-extendedneutraln3);
    font-size: 12px;
}
.strava-route-overlay .strava-route-status--error { color: var(--color-extendedredr3); }
.strava-route-overlay .strava-route-row {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    padding: var(--space-2xs) 0;
    border-bottom: var(--divider-size-xs) var(--divider-variant-solid) var(--color-extendedneutraln6);
}
.strava-route-overlay .strava-route-row-text { flex: 1 1 auto; }
.strava-route-overlay .strava-route-row-title { font-weight: 600; }
.strava-route-overlay .strava-route-row-details {
    margin-top: var(--space-4xs);
    color: var(--color-extendedneutraln3);
    font-size: 12px;
    overflow-wrap: anywhere;
}
.strava-route-overlay .strava-route-row-actions { display: flex; gap: var(--space-3xs); }
.strava-route-overlay .strava-route-editor {
    margin: 0 0 var(--space-sm);
    padding: var(--space-xs);
    background: var(--color-extendedneutraln7);
    border: var(--border-width-thin) solid var(--color-coreo3);
    border-radius: var(--border-radius-md);
}
.strava-route-overlay .strava-route-editor h4 { margin: 0 0 var(--space-3xs); }
.strava-route-overlay .strava-route-preview {
    margin: var(--space-2xs) 0 var(--space-sm);
    padding: var(--space-2xs) var(--space-xs);
    background: var(--color-extendedneutraln7);
    border-left: var(--divider-size-md) var(--divider-variant-solid) var(--color-coreo3);
    border-radius: var(--border-radius-sm);
}
.strava-route-overlay .strava-route-preview-label {
    color: var(--color-extendedneutraln3);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.strava-route-overlay .strava-route-preview-value {
    margin-top: var(--space-4xs);
    font-weight: 600;
    overflow-wrap: anywhere;
}
.strava-route-overlay .strava-route-preview-value--empty { color: var(--color-extendedneutraln3); }
.strava-route-overlay .strava-route-backup {
    width: 100%;
    box-sizing: border-box;
    padding: var(--space-2xs) var(--space-xs);
    color: var(--color-extendedneutraln1);
    background: var(--color-corewhite);
    border: var(--border-width-thin) solid var(--color-extendedneutraln5);
    border-radius: var(--border-radius-sm);
    font-family: monospace;
    font-size: 12px;
}
.strava-route-overlay .strava-route-attribution {
    margin: var(--space-3xs) 0 var(--space-sm);
    color: var(--color-extendedneutraln4);
    font-size: 11px;
}
`;

    function installStyles() {
        if (document.getElementById(STYLE_ID)) return;
        if (typeof CSSStyleSheet === 'function' && Array.isArray(document.adoptedStyleSheets)) {
            try {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(STYLES);
                document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
                return;
            } catch {
                // Older engines reject constructed sheets; fall back to a tag.
            }
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STYLES;
        (document.head || document.documentElement).append(style);
    }

    const BUTTON_ID = 'strava-route-rename-btn';
    const FAVORITES_BUTTON_ID = 'strava-route-favorites-btn';
    const FAVORITES_DIALOG_ID = 'strava-route-favorites-dialog';
    const LOG_PREFIX = '[Strava Renamer]';
    const TRANSIENT_OVERPASS_STATUSES = new Set([429, 502, 503, 504]);

    // The OSM place ranks worth naming a route after: anything smaller is a
    // hamlet or a farm the rider would not call a destination.
    const PLACE_NODE_TYPES = ['city', 'town', 'village'];

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

    let lastRouteAnalysis = null;
    let lastNominatimCallAt = 0;
    let nominatimQueue = Promise.resolve();

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const log = message => console.log(`${LOG_PREFIX} ${message}`);

    function hostOf(url) {
        return String(url).replace(/^https?:\/\//, '').split('/')[0];
    }

    // Present only when the script is installed with the matching @grant.
    function userscriptRequest() {
        if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
        if (typeof GM === 'object' && typeof GM?.xmlHttpRequest === 'function') {
            return GM.xmlHttpRequest.bind(GM);
        }
        return null;
    }

    function parseResponseHeaders(raw) {
        const headers = new Map();
        for (const line of String(raw || '').split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator < 0) continue;
            headers.set(
                line.slice(0, separator).trim().toLowerCase(),
                line.slice(separator + 1).trim(),
            );
        }
        return headers;
    }

    // Mimics just enough of the fetch Response shape for the callers below.
    function userscriptResponse(response) {
        const headers = parseResponseHeaders(response.responseHeaders);
        const body = response.responseText ?? '';
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
            text: async () => body,
            json: async () => JSON.parse(body),
        };
    }

    // Cross-origin calls go through the userscript manager, so Strava's
    // Content-Security-Policy cannot block Overpass or Nominatim. Installs
    // without the grant keep working through plain fetch.
    function requestCrossOrigin(url, options = {}) {
        const request = userscriptRequest();
        if (!request) return fetch(url, options);

        return new Promise((resolve, reject) => {
            request({
                method: options.method || 'GET',
                url,
                headers: options.headers,
                data: options.body,
                timeout: CONFIG.overpassTimeoutMs + 5000,
                onload: response => resolve(userscriptResponse(response)),
                onerror: () => reject(new Error(`Network error from ${hostOf(url)}`)),
                ontimeout: () => reject(new Error(`${hostOf(url)} timed out`)),
            });
        });
    }

    function requestNominatim(url) {
        const request = nominatimQueue.then(async () => {
            const waitMs = CONFIG.nominatimIntervalMs - (Date.now() - lastNominatimCallAt);
            if (waitMs > 0) await sleep(waitMs);
            try {
                return await requestCrossOrigin(url, { headers: { 'Accept': 'application/json' } });
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

    // Settings the user typed in by hand live in the userscript manager's
    // storage: unlike localStorage it survives clearing the site data and is
    // carried along by the extension's own sync. Only the synchronous GM_*
    // API is used, so the naming path stays synchronous; installs without the
    // grants keep everything in localStorage.
    function hasUserscriptStorage() {
        return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    }

    function readSetting(key) {
        if (!hasUserscriptStorage()) return readJsonCache(key);
        const stored = GM_getValue(key, null);
        if (typeof stored === 'string') {
            try {
                return JSON.parse(stored);
            } catch {
                return null;
            }
        }
        return stored ?? readJsonCache(key);
    }

    function writeSetting(key, value) {
        if (!hasUserscriptStorage()) {
            writeJsonCache(key, value);
            return;
        }
        GM_setValue(key, JSON.stringify(value));
        if (localStorage.getItem(key) !== null) localStorage.removeItem(key);
    }

    // Anything saved by an older install is moved over once, so a browser
    // clean-up cannot take it away afterwards.
    function migrateSettingToUserscriptStorage(key) {
        if (!hasUserscriptStorage() || GM_getValue(key, null) !== null) return;
        const stored = readJsonCache(key);
        if (stored === null) return;
        writeSetting(key, stored);
        log(`Moved ${key} into userscript storage`);
    }

    // The single gate every favorite passes, whether it comes from the form, a
    // pasted backup or an older version of the script.
    function isUsableRadius(radiusM) {
        return Number.isFinite(radiusM)
            && radiusM >= CONFIG.favoriteRadiusMinM
            && radiusM <= CONFIG.favoriteRadiusMaxM;
    }

    function isUsablePlaceName(name) {
        return Boolean(name) && name.length <= CONFIG.maxPlaceNameLength;
    }

    function normalizeFavorite(value) {
        if (!value || typeof value !== 'object') return null;
        const name = typeof value.name === 'string' ? value.name.trim().replace(/\s+/g, ' ') : '';
        const lat = Number(value.lat);
        const lon = Number(value.lon);
        const radiusM = Number(value.radiusM);
        if (!value.id || !isUsablePlaceName(name)
            || !Number.isFinite(lat) || lat < -90 || lat > 90
            || !Number.isFinite(lon) || lon < -180 || lon > 180
            || !isUsableRadius(radiusM)) {
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
        const stored = readSetting(STORAGE_KEY.favorites);
        if (!Array.isArray(stored)) return [];
        return stored.map(normalizeFavorite).filter(Boolean);
    }

    function saveFavorites(favorites) {
        const normalized = favorites.map(normalizeFavorite).filter(Boolean);
        writeSetting(STORAGE_KEY.favorites, normalized);
        updateFavoritesButtonLabel(normalized.length);
        return normalized;
    }

    function createFavoriteId() {
        return `favorite_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // Some places sit on the route but never belong in its name: the suburb the
    // ride starts in, a hamlet whose land the road merely crosses. Blocking is
    // by name, so it also silences a generic road name wherever it turns up.
    function normalizeBlockedName(value) {
        if (typeof value !== 'string') return null;
        const name = value.trim().replace(/\s+/g, ' ');
        return isUsablePlaceName(name) ? name : null;
    }

    function normalizeBlockedNames(values) {
        const names = [];
        const seen = new Set();
        for (const value of Array.isArray(values) ? values : []) {
            const name = normalizeBlockedName(value);
            const key = name?.toLocaleLowerCase();
            if (!name || seen.has(key)) continue;
            seen.add(key);
            names.push(name);
        }
        return names;
    }

    function loadNameList(key) {
        return normalizeBlockedNames(readSetting(key));
    }

    function saveNameList(key, names) {
        const normalized = normalizeBlockedNames(names);
        writeSetting(key, normalized);
        return normalized;
    }

    const loadBlockedNames = () => loadNameList(STORAGE_KEY.blockedNames);
    // A pinned place always makes it into the name, even when the automatic
    // selection would have spent its slots elsewhere.
    const loadPinnedNames = () => loadNameList(STORAGE_KEY.pinnedNames);

    function nameKeys(names) {
        return new Set(names.map(name => name.toLocaleLowerCase()));
    }

    function hasNameKey(name, keys) {
        return keys.has(String(name).toLocaleLowerCase());
    }

    // Blocking and pinning are opposites, so setting one clears the other.
    function toggleNameList(key, name) {
        const normalized = normalizeBlockedName(name);
        if (!normalized) return false;
        const listKey = normalized.toLocaleLowerCase();
        const current = loadNameList(key);
        const without = current.filter(entry => entry.toLocaleLowerCase() !== listKey);
        const adding = without.length === current.length;
        saveNameList(key, adding ? current.concat(normalized) : without);
        if (adding) {
            const otherKey = key === STORAGE_KEY.blockedNames
                ? STORAGE_KEY.pinnedNames
                : STORAGE_KEY.blockedNames;
            saveNameList(otherKey, loadNameList(otherKey)
                .filter(entry => entry.toLocaleLowerCase() !== listKey));
        }
        refreshActivityName();
        return true;
    }

    function namingPreferences() {
        return {
            favorites: loadFavorites(),
            blockedNames: loadBlockedNames(),
            pinnedNames: loadPinnedNames(),
        };
    }

    // The colour of every state, hover included, is a stylesheet rule keyed on
    // this attribute.
    function setButtonState(button, text, state = 'idle') {
        button.textContent = text;
        button.dataset.state = state;
    }

    // Every planar measurement in the script shares one flat projection, fixed
    // at the ride's mean latitude. Projecting each point at its own latitude
    // instead made two measurements of the same distance disagree.
    const KM_PER_DEGREE_LAT = 110.57;
    const KM_PER_DEGREE_LON = 111.32;

    function flatProjection(referenceLat) {
        const kx = Math.max(1, KM_PER_DEGREE_LON * Math.cos(referenceLat * Math.PI / 180));
        return {
            kx,
            ky: KM_PER_DEGREE_LAT,
            x: lon => lon * kx,
            y: lat => lat * KM_PER_DEGREE_LAT,
        };
    }

    function trackProjection(track) {
        const referenceLat = track.latitudes.reduce((sum, lat) => sum + lat, 0)
            / track.latitudes.length;
        return flatProjection(referenceLat);
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

        const projection = trackProjection(track);
        const xs = track.longitudes.map(projection.x);
        const ys = track.latitudes.map(projection.y);

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

    // The cache stores passages, which are the *output* of these settings and
    // not raw OSM data, so every setting that can change them belongs in the
    // signature. Add a key here whenever a new one starts influencing them.
    const CACHE_RELEVANT_CONFIG = [
        'placeRadiusM',
        'roadMatchRadiusM',
        'overpassMaxRoutePoints',
        'minAutoPlaces',
        'maxAutoPlaces',
        'autoPlaceSpacingKm',
        'stripPlaceParentheticals',
    ];

    function namingConfigSignature() {
        return CACHE_RELEVANT_CONFIG
            .map(key => `${key}=${CONFIG[key]}`)
            .concat(`placeTypes=${PLACE_NODE_TYPES.join('+')}`)
            .concat(`roadTypes=${Object.keys(ROAD_TYPE_PRIORITY).join('+')}`)
            .join(',');
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
            namingConfigSignature(),
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
            + `node["place"~"^(${PLACE_NODE_TYPES.join('|')})$"]`
            + `(around:${placeRadiusM},${line});\n`
            + `way["highway"~"^(${Object.keys(ROAD_TYPE_PRIORITY).join('|')})$"]["name"]`
            + `(around:${roadRadiusM},${line});\n`
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
            const endpoint = OVERPASS_ENDPOINTS[(attempt - 1) % OVERPASS_ENDPOINTS.length];
            let response;
            try {
                response = await requestCrossOrigin(endpoint, {
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

            // Another instance has its own quota and queue, so a mirror is
            // tried almost immediately; only a repeat of the same host waits
            // out the exponential backoff.
            const nextEndpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
            const delay = nextEndpoint === endpoint
                ? overpassRetryDelay(response, attempt)
                : Math.max(0, CONFIG.overpassMirrorRetryMs);
            onRetry?.(delay);
            console.warn(`${LOG_PREFIX} ${failure.message} from ${hostOf(endpoint)};`
                + ` retrying via ${hostOf(nextEndpoint)} in ${(delay / 1000).toFixed(1)}s`
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
                || !PLACE_NODE_TYPES.includes(placeType)
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
        return Array.from(roadsByName.values());
    }

    function passageDistances(track, start, end) {
        const fromKm = start === 0 ? 0
            : (track.cumulativeKm[start - 1] + track.cumulativeKm[start]) / 2;
        const toKm = end === track.latitudes.length - 1 ? track.totalKm
            : (track.cumulativeKm[end] + track.cumulativeKm[end + 1]) / 2;
        return { fromKm, toKm, km: toKm - fromKm };
    }

    const byTrackOrder = (first, second) =>
        first.anchor - second.anchor || first.distanceM - second.distanceM;

    // Every continuous stretch of track points within a feature's radius is one
    // visit, anchored at the closest point. Settlements, named roads and
    // favorites all become visits through this single path.
    function visitsFromDistances(track, distancesByIndex, description) {
        const visits = [];
        let visit = null;
        const finishVisit = () => {
            if (!visit) return;
            visits.push({
                ...visit,
                ...passageDistances(track, visit.start, visit.end),
                anchor: visit.index,
                lat: track.latitudes[visit.index],
                lon: track.longitudes[visit.index],
                ...description,
            });
            visit = null;
        };

        for (const index of Array.from(distancesByIndex.keys()).sort((a, b) => a - b)) {
            const distanceM = distancesByIndex.get(index);
            if (visit && index === visit.end + 1) {
                visit.end = index;
                if (distanceM < visit.distanceM) {
                    visit.index = index;
                    visit.distanceM = distanceM;
                }
            } else {
                finishVisit();
                visit = { start: index, end: index, index, distanceM };
            }
        }
        finishVisit();
        return visits;
    }

    // Track points are bucketed into a flat-projected grid once per activity, so
    // a landmark is only measured against the points that can possibly be in
    // range instead of against the whole ride.
    const TRACK_GRID_CELL_KM = 0.25;
    const trackGrids = new WeakMap();

    function buildTrackGrid(track) {
        const projection = trackProjection(track);
        const cells = new Map();
        for (let index = 0; index < track.latitudes.length; index++) {
            const cellX = Math.floor(projection.x(track.longitudes[index]) / TRACK_GRID_CELL_KM);
            const cellY = Math.floor(projection.y(track.latitudes[index]) / TRACK_GRID_CELL_KM);
            const key = `${cellX}:${cellY}`;
            const bucket = cells.get(key);
            if (bucket) {
                bucket.push(index);
            } else {
                cells.set(key, [index]);
            }
        }
        return { projection, cells };
    }

    function trackGrid(track) {
        let grid = trackGrids.get(track);
        if (!grid) {
            grid = buildTrackGrid(track);
            trackGrids.set(track, grid);
        }
        return grid;
    }

    // The grid is a coarse filter: it yields every track point in the projected
    // box, and the caller applies the exact test.
    function* trackPointsInBox(grid, minX, minY, maxX, maxY) {
        const fromX = Math.floor(minX / TRACK_GRID_CELL_KM);
        const toX = Math.floor(maxX / TRACK_GRID_CELL_KM);
        const fromY = Math.floor(minY / TRACK_GRID_CELL_KM);
        const toY = Math.floor(maxY / TRACK_GRID_CELL_KM);
        for (let cellX = fromX; cellX <= toX; cellX++) {
            for (let cellY = fromY; cellY <= toY; cellY++) {
                const bucket = grid.cells.get(`${cellX}:${cellY}`);
                if (bucket) yield* bucket;
            }
        }
    }

    // A place is measured with haversine but filtered on the flat grid, and the
    // two disagree slightly; the box is widened by more than that difference
    // can ever be at ride scale. Road matching needs no such slack: it is
    // planar on both sides.
    const GRID_HAVERSINE_SLACK_KM = 0.02;

    function trackDistancesToPoint(track, lat, lon, radiusM) {
        const grid = trackGrid(track);
        const reachKm = radiusM / 1000 * 1.05 + GRID_HAVERSINE_SLACK_KM;
        const x = grid.projection.x(lon);
        const y = grid.projection.y(lat);
        const distances = new Map();
        for (const index of trackPointsInBox(
            grid, x - reachKm, y - reachKm, x + reachKm, y + reachKm)) {
            const distanceM = haversineKm(
                lat,
                lon,
                track.latitudes[index],
                track.longitudes[index],
            ) * 1000;
            if (distanceM <= radiusM) distances.set(index, distanceM);
        }
        return distances;
    }

    // A settlement contributes one event for every distinct pass within the
    // configured radius. This intentionally uses OSM place nodes rather than
    // reverse-geocoded administrative parents.
    function passagesNearPlaces(track, places) {
        return places
            .flatMap(place => visitsFromDistances(
                track,
                trackDistancesToPoint(track, place.lat, place.lon, CONFIG.placeRadiusM),
                {
                    baseName: place.name,
                    address: `${place.name} (${place.placeType})`,
                    placeId: place.id,
                    placeType: place.placeType,
                    featureKind: 'place',
                },
            ))
            .sort(byTrackOrder);
    }

    function pointSegmentDistanceKm(projection, lat, lon, first, second) {
        const ax = (first.lon - lon) * projection.kx;
        const ay = (first.lat - lat) * projection.ky;
        const bx = (second.lon - lon) * projection.kx;
        const by = (second.lat - lat) * projection.ky;
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        const ratio = lengthSquared === 0 ? 0
            : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
        return Math.hypot(ax + ratio * dx, ay + ratio * dy);
    }

    // A road is matched segment by segment: each segment only queries the grid
    // cells its own extent covers, which keeps long ways cheap.
    function trackDistancesToRoad(track, road, radiusM) {
        const grid = trackGrid(track);
        const radiusKm = radiusM / 1000;
        const distances = new Map();
        for (const geometry of road.geometries) {
            for (let i = 1; i < geometry.length; i++) {
                const first = geometry[i - 1];
                const second = geometry[i];
                const firstX = grid.projection.x(first.lon);
                const firstY = grid.projection.y(first.lat);
                const secondX = grid.projection.x(second.lon);
                const secondY = grid.projection.y(second.lat);
                for (const index of trackPointsInBox(
                    grid,
                    Math.min(firstX, secondX) - radiusKm,
                    Math.min(firstY, secondY) - radiusKm,
                    Math.max(firstX, secondX) + radiusKm,
                    Math.max(firstY, secondY) + radiusKm,
                )) {
                    const distanceKm = pointSegmentDistanceKm(
                        grid.projection,
                        track.latitudes[index],
                        track.longitudes[index],
                        first,
                        second,
                    );
                    if (distanceKm > radiusKm) continue;
                    const distanceM = distanceKm * 1000;
                    const known = distances.get(index);
                    if (known === undefined || distanceM < known) distances.set(index, distanceM);
                }
            }
        }
        return distances;
    }

    function passagesNearRoads(track, roads) {
        return roads
            .flatMap(road => visitsFromDistances(
                track,
                trackDistancesToRoad(track, road, CONFIG.roadMatchRadiusM),
                {
                    baseName: road.name,
                    address: `${road.name} (${road.roadType})`,
                    roadId: road.id,
                    roadType: road.roadType,
                    featureKind: 'road',
                },
            ))
            .sort(byTrackOrder);
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
                && PLACE_NODE_TYPES.includes(passage.placeType);
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
    // when the user searches for a custom favorite. Route names come from OSM
    // place nodes, never from reverse geocoding.
    const LOCAL_SETTLEMENT_FIELDS = ['hamlet', 'village', 'town'];
    const PRIMARY_ADDRESS_FIELDS = ['hamlet', 'village', 'town', 'city'];
    const DISTRICT_ADDRESS_FIELDS = ['city_district', 'suburb'];

    function addressPlaceName(address, fields) {
        if (!address) return null;
        for (const field of fields) {
            if (typeof address[field] !== 'string' || !address[field].trim()) continue;
            const name = cleanPlaceName(address[field]);
            if (name) return name;
        }
        return null;
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

    // The most specific settlement wins: a village before its district, a
    // district before the city it belongs to.
    function suggestedPlaceName(address) {
        return addressPlaceName(address, LOCAL_SETTLEMENT_FIELDS)
            || addressPlaceName(address, DISTRICT_ADDRESS_FIELDS)
            || addressPlaceName(address, PRIMARY_ADDRESS_FIELDS);
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
        const placeName = suggestedPlaceName(result.address);
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
        return favorites
            .flatMap(favorite => visitsFromDistances(
                track,
                trackDistancesToPoint(track, favorite.lat, favorite.lon, favorite.radiusM),
                { favorite },
            ))
            .sort(byTrackOrder);
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

    function projectedRunPoint(run, track, projection) {
        const fallbackIndex = Math.max(
            0,
            Math.min(track.latitudes.length - 1, Math.round(run.orderIndex)),
        );
        const lat = Number.isFinite(run.lat) ? run.lat : track.latitudes[fallbackIndex];
        const lon = Number.isFinite(run.lon) ? run.lon : track.longitudes[fallbackIndex];
        return { x: projection.x(lon), y: projection.y(lat) };
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
        const projection = trackProjection(track);
        const allIndices = Array.from(new Set([...selected, ...candidateIndices]));
        const points = new Map(allIndices.map(index => [
            index,
            projectedRunPoint(runs[index], track, projection),
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
        const projection = trackProjection(track);
        const start = projectedRunPoint({
            orderIndex: 0,
            lat: track.latitudes[0],
            lon: track.longitudes[0],
        }, track, projection);
        const lastIndex = track.latitudes.length - 1;
        const finish = projectedRunPoint({
            orderIndex: lastIndex,
            lat: track.latitudes[lastIndex],
            lon: track.longitudes[lastIndex],
        }, track, projection);
        let bestIndex = candidateIndices[0];
        let bestEndpointSpacingKm = -1;
        let bestPriority = -1;
        for (const index of candidateIndices) {
            const point = projectedRunPoint(runs[index], track, projection);
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
    // Interior favorites and pinned places occupy normal places in the limit;
    // the first and last displayed route points do not consume it.
    function compactRouteRuns(allRuns, track) {
        const isForced = run => Boolean(run.favorite || run.pinned);
        // A ride starts and finishes somewhere with a name people recognise, so
        // a street the route merely began on is dropped rather than promoted
        // into the first or last slot.
        const isNamedPlace = run => run.featureKind !== 'road';
        const firstNamed = allRuns.findIndex(isNamedPlace);
        const lastNamed = allRuns.findLastIndex(isNamedPlace);
        // With a single named place there is nothing to span, so the original
        // endpoints stay: a road name beats no name at all.
        const preferNamedEndpoints = firstNamed >= 0 && lastNamed > firstNamed;
        const startIndex = preferNamedEndpoints ? firstNamed : 0;
        const endIndex = preferNamedEndpoints ? lastNamed : allRuns.length - 1;
        const runs = allRuns.filter((run, index) =>
            (index >= startIndex && index <= endIndex) || isForced(run));

        const endpointIndices = new Set();
        if (runs.length > 0) {
            endpointIndices.add(runs.indexOf(allRuns[startIndex]));
            endpointIndices.add(runs.indexOf(allRuns[endIndex]));
        }
        const interiorForcedCount = runs.reduce(
            (count, run, index) =>
                count + Number(isForced(run) && !endpointIndices.has(index)),
            0,
        );
        const automaticLimit = Math.max(
            0,
            automaticPlaceLimit(track) - interiorForcedCount,
        );
        const placeIndices = runs
            .map((run, index) =>
                !endpointIndices.has(index) && !isForced(run) && run.featureKind === 'place'
                    ? index
                    : -1)
            .filter(index => index >= 0);
        const placeNames = new Set(placeIndices.map(index => runs[index].name));
        const roadIndices = runs
            .map((run, index) =>
                !endpointIndices.has(index)
                    && !isForced(run)
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
                endpointIndices.has(index) || isForced(run) || selectedAutomatic.has(index))
            .map(run => ({ ...run }));
    }

    function routeNamesFromPassages(passages, track, preferences, shouldLog = false) {
        const { favorites, blockedNames, pinnedNames } = preferences;
        const visits = favoriteVisits(track, favorites);
        const blockedKeys = nameKeys(blockedNames);
        const pinnedKeys = nameKeys(pinnedNames);
        const coveredVisits = new Set();
        const suppressed = new Set();
        const events = [];
        for (const passage of passages) {
            const match = closestFavoriteForPassage(passage, track, favorites);
            const name = match?.favorite.name || passage.baseName;
            if (!name) continue;
            if (hasNameKey(name, blockedKeys)) {
                suppressed.add(name);
                continue;
            }

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
                pinned: hasNameKey(name, pinnedKeys),
            });
        }

        for (const visit of visits) {
            if (coveredVisits.has(visit)) continue;
            if (hasNameKey(visit.favorite.name, blockedKeys)) {
                suppressed.add(visit.favorite.name);
                continue;
            }
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
                pinned: hasNameKey(visit.favorite.name, pinnedKeys),
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
                last.pinned ||= event.pinned;
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
            const selectedPinned = compacted.filter(run => run.pinned && !run.favorite).length;
            log(`Map extent ${routeMapExtentKm(track).toFixed(1)} km: `
                + `${selectedPlaces} settlements`
                + (selectedRoads ? ` + ${selectedRoads} named-road fallbacks` : '')
                + ` + ${selectedFavorites} favorites`
                + (selectedPinned ? ` (${selectedPinned} pinned)` : ''));
        }
        if (shouldLog && suppressed.size > 0) {
            log(`Blocked from the name: ${Array.from(suppressed).join(', ')}`);
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
            names: routeNamesFromPassages(passages, track, namingPreferences(), true),
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

    function updateFavoritesButtonLabel(favoriteCount = loadFavorites().length) {
        const button = document.getElementById(FAVORITES_BUTTON_ID);
        if (!button) return;
        button.textContent = favoriteCount > 0 ? `★ ${favoriteCount}` : '☆';
        button.title = favoriteCount > 0
            ? `Manage ${favoriteCount} favorite address${favoriteCount === 1 ? '' : 'es'}`
            : 'Add and manage favorite addresses';
    }

    // Strava refuses an over-long title. The middle of the narrative is the
    // least important part of it, so that is what gives way first.
    function fitNameLength(names) {
        const limit = Math.max(1, Math.floor(CONFIG.maxNameLength));
        const parts = names.slice();
        while (parts.length > 2 && parts.join(' - ').length > limit) {
            parts.splice(Math.floor(parts.length / 2), 1);
        }
        const name = parts.join(' - ');
        return name.length > limit ? `${name.slice(0, limit - 1).trimEnd()}…` : name;
    }

    function setActivityName(names) {
        if (!names.length) return false;
        const nameInput = document.querySelector('input[name="activity[name]"]');
        if (!nameInput) return false;
        nameInput.value = fitNameLength(names);
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        nameInput.focus();
        return true;
    }

    // The names the current settings produce for the analyzed route.
    function currentRouteNames() {
        if (!lastRouteAnalysis || lastRouteAnalysis.activityId !== getActivityId()) return null;
        return routeNamesFromPassages(
            lastRouteAnalysis.passages,
            lastRouteAnalysis.track,
            namingPreferences(),
        );
    }

    // Editing a favorite, a blocked or a pinned name rewrites the title in
    // place, so the effect of the change is visible immediately.
    function refreshActivityName() {
        const names = currentRouteNames();
        if (names && setActivityName(names)) log(`Name updated: ${names.join(' - ')}`);
    }

    function favoriteFromForm(existing, passage, name, radiusText) {
        const trimmedName = name.trim().replace(/\s+/g, ' ');
        if (!isUsablePlaceName(trimmedName)) {
            throw new Error(`The name must be 1–${CONFIG.maxPlaceNameLength} characters long.`);
        }
        const radiusM = Number(String(radiusText).replace(',', '.'));
        if (!isUsableRadius(radiusM)) {
            throw new Error(`The radius must be a number from ${CONFIG.favoriteRadiusMinM}`
                + ` to ${CONFIG.favoriteRadiusMaxM} metres.`);
        }

        const favorite = normalizeFavorite({
            id: existing?.id || createFavoriteId(),
            name: trimmedName,
            lat: existing?.lat ?? passage?.lat,
            lon: existing?.lon ?? passage?.lon,
            radiusM,
            address: existing?.address || passage?.address || passage?.baseName || '',
        });
        if (!favorite) throw new Error('That place has no usable coordinates.');
        return favorite;
    }

    function saveFavorite(favorite) {
        const favorites = loadFavorites();
        const index = favorites.findIndex(item => item.id === favorite.id);
        if (index >= 0) {
            favorites[index] = favorite;
        } else {
            favorites.push(favorite);
        }
        saveFavorites(favorites);
        refreshActivityName();
        return true;
    }

    function removeFavorite(favoriteId) {
        saveFavorites(loadFavorites().filter(item => item.id !== favoriteId));
        refreshActivityName();
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

    function createElement(tagName, className, properties = {}) {
        const element = document.createElement(tagName);
        element.className = className;
        Object.assign(element, properties);
        return element;
    }

    function createDialogButton(text, primary = false) {
        return createElement(
            'button',
            `strava-route-dialog-button${primary ? ' strava-route-dialog-button--primary' : ''}`,
            { type: 'button', textContent: text },
        );
    }

    function createDialogInput(properties = {}) {
        return createElement('input', 'strava-route-field', { type: 'text', ...properties });
    }

    function createSectionTitle(text, first = false) {
        return createElement('h4', first ? 'strava-route-first' : '', { textContent: text });
    }

    function createDialogNote(text) {
        return createElement('p', 'strava-route-note', { textContent: text });
    }

    function appendFavoriteRow(container, title, details, actions) {
        const row = createElement('div', 'strava-route-row');
        const text = createElement('div', 'strava-route-row-text');
        text.append(
            createElement('div', 'strava-route-row-title', { textContent: title }),
            createElement('div', 'strava-route-row-details', { textContent: details }),
        );

        const controls = createElement('div', 'strava-route-row-actions');
        controls.append(...actions);
        row.append(text, controls);
        container.append(row);
    }

    // The name and radius of a favorite are edited in the dialog itself: modal
    // prompts stack up, cannot show what is being edited and are blocked in
    // some browsers.
    function appendFavoriteEditor(panel, state, render) {
        const editing = state.editing;
        const target = editing.existing || editing.passage;
        const section = createElement('div', 'strava-route-editor');
        const title = createSectionTitle(editing.existing ? 'Edit favorite' : 'New favorite');

        const nameInput = createDialogInput({
            id: 'strava-route-favorite-name-input',
            value: state.editing.name,
            placeholder: 'Name to use in the title',
            maxLength: CONFIG.maxPlaceNameLength,
        });
        nameInput.addEventListener('input', () => {
            state.editing.name = nameInput.value;
        });

        const radiusInput = createDialogInput({
            id: 'strava-route-favorite-radius-input',
            className: 'strava-route-field strava-route-field--narrow',
            value: state.editing.radiusM,
            placeholder: `Radius ${CONFIG.favoriteRadiusMinM}–${CONFIG.favoriteRadiusMaxM} m`,
        });
        radiusInput.addEventListener('input', () => {
            state.editing.radiusM = radiusInput.value;
        });

        const saveButton = createDialogButton('Save', true);
        const cancelButton = createDialogButton('Cancel');
        cancelButton.addEventListener('click', () => {
            state.editing = null;
            render();
        });

        const form = createElement('form', 'strava-route-form');
        form.append(nameInput, radiusInput, saveButton, cancelButton);
        saveButton.type = 'submit';
        form.addEventListener('submit', event => {
            event.preventDefault();
            try {
                saveFavorite(favoriteFromForm(
                    editing.existing,
                    editing.passage,
                    state.editing.name,
                    state.editing.radiusM,
                ));
                state.editing = null;
                render();
            } catch (error) {
                state.editing.error = errorMessage(error);
                render();
            }
        });

        const status = createStatusLine(
            state.editing.error
                || `Applies whenever the route comes within the radius of ${
                    target?.address || target?.baseName || 'this place'}.`,
            Boolean(state.editing.error),
        );

        section.append(title, form, status);
        panel.append(section);
    }

    // Every section reports itself the same way: one polite live region that
    // turns red when what it says is a problem.
    function createStatusLine(text, isError = false) {
        const status = createElement(
            'div',
            `strava-route-status${isError ? ' strava-route-status--error' : ''}`,
            { textContent: text },
        );
        status.setAttribute('aria-live', 'polite');
        return status;
    }

    function appendManualFavoriteSearch(panel, state, render) {
        const title = createSectionTitle('Add by address', true);
        const form = createElement('form', 'strava-route-form');

        const input = createDialogInput({
            id: 'strava-route-favorite-address-input',
            value: state.search.query,
            placeholder: 'Street, house number, city',
            autocomplete: 'street-address',
            maxLength: 200,
        });
        input.addEventListener('input', () => {
            state.search.query = input.value;
        });

        const searchButton = createDialogButton('Find', true);
        searchButton.type = 'submit';
        searchButton.disabled = state.search.busy;
        input.disabled = state.search.busy;
        form.append(input, searchButton);

        const status = createStatusLine(state.search.status, state.search.error);
        const results = document.createElement('div');
        for (const candidate of state.search.candidates) {
            const addButton = createDialogButton('☆ Add', true);
            addButton.addEventListener('click', () => {
                state.editing = {
                    passage: candidate,
                    existing: null,
                    name: candidate.baseName,
                    radiusM: String(CONFIG.favoriteRadiusM),
                    error: '',
                };
                render();
            });
            appendFavoriteRow(results, candidate.baseName, candidate.address, [addButton]);
        }

        form.addEventListener('submit', event => {
            event.preventDefault();
            void runFavoriteAction(async () => {
                const query = state.search.query.trim().replace(/\s+/g, ' ');
                if (!query) {
                    state.search.status = 'Enter an address to search.';
                    state.search.error = true;
                    render();
                    return;
                }

                state.search.busy = true;
                state.search.candidates = [];
                state.search.status = 'Searching…';
                state.search.error = false;
                render();
                try {
                    const candidates = await searchFavoriteAddresses(query);
                    state.search.candidates = candidates;
                    state.search.status = candidates.length
                        ? `Found ${candidates.length}. Choose the correct address.`
                        : 'No addresses found. Add a city or postcode and try again.';
                } catch (error) {
                    console.error(`${LOG_PREFIX} Address search error:`, error);
                    state.search.status = `Search failed: ${errorMessage(error)}`;
                    state.search.error = true;
                } finally {
                    state.search.busy = false;
                    render();
                }
            });
        });

        const attribution = createElement('div', 'strava-route-attribution');
        attribution.append('Search by Nominatim · © ');
        const attributionLink = document.createElement('a');
        attributionLink.href = 'https://www.openstreetmap.org/copyright';
        attributionLink.target = '_blank';
        attributionLink.rel = 'noopener noreferrer';
        attributionLink.textContent = 'OpenStreetMap contributors';
        attribution.append(attributionLink);

        panel.append(title, form, status, results, attribution);
    }

    function backupPayload() {
        return {
            favorites: loadFavorites(),
            blockedNames: loadBlockedNames(),
            pinnedNames: loadPinnedNames(),
        };
    }

    function applyBackup(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error('That is not valid JSON.');
        }
        const favorites = Array.isArray(parsed) ? parsed : parsed?.favorites;
        if (!Array.isArray(favorites)) {
            throw new Error('A backup must contain a "favorites" array.');
        }
        const normalized = favorites.map(normalizeFavorite).filter(Boolean);
        if (favorites.length > 0 && normalized.length === 0) {
            throw new Error('No usable favorite in that backup.');
        }
        saveFavorites(normalized);
        const blocked = saveNameList(STORAGE_KEY.blockedNames, parsed?.blockedNames);
        const pinned = saveNameList(STORAGE_KEY.pinnedNames, parsed?.pinnedNames);
        refreshActivityName();
        return {
            favorites: normalized.length,
            blockedNames: blocked.length,
            pinnedNames: pinned.length,
        };
    }

    // Plain text rather than a file download: it survives a copy into any note
    // app and needs no extra permission.
    function appendBackupSection(panel, state, render) {
        const title = createSectionTitle('Backup');

        const note = createDialogNote('Copy this somewhere safe, or paste a backup and import it.');

        const textarea = createElement('textarea', 'strava-route-backup', {
            id: 'strava-route-backup-input',
            rows: 5,
            spellcheck: false,
            value: state.backup.text ?? JSON.stringify(backupPayload(), null, 2),
        });
        textarea.addEventListener('input', () => {
            state.backup.text = textarea.value;
        });

        const status = createStatusLine(state.backup.status);
        const copyButton = createDialogButton('Copy');
        copyButton.addEventListener('click', () => {
            navigator.clipboard?.writeText(textarea.value);
            textarea.focus();
            status.textContent = 'Copied to the clipboard.';
        });

        // Importing replaces everything, so the button asks once before it does.
        const importButton = createDialogButton(
            state.backup.armed ? 'Replace everything' : 'Import', true);
        importButton.addEventListener('click', () => runFavoriteAction(() => {
            if (!state.backup.armed) {
                state.backup.armed = true;
                state.backup.text = textarea.value;
                state.backup.status = 'This overwrites the saved places. Click again to confirm.';
                render();
                return;
            }
            const imported = applyBackup(textarea.value);
            log(`Imported ${imported.favorites} favorites, ${imported.blockedNames} blocked`
                + ` and ${imported.pinnedNames} pinned names`);
            state.backup = { text: null, armed: false, status: 'Backup imported.' };
            render();
        }));

        const controls = createElement('div', 'strava-route-row-actions');
        controls.append(copyButton, importButton);

        panel.append(title, note, textarea, controls, status);
    }

    function openFavoritesDialog() {
        document.getElementById(FAVORITES_DIALOG_ID)?.remove();

        const overlay = createElement('div', 'strava-route-overlay', {
            id: FAVORITES_DIALOG_ID,
        });
        const panel = createElement('div', 'strava-route-panel');

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

        // Every action mutates the dialog state and re-renders, so the name
        // preview and the buttons can never drift apart from the stored data.
        const state = {
            editing: null,
            confirmingDeleteId: null,
            search: { query: '', candidates: [], status: '', error: false, busy: false },
            backup: { text: null, armed: false, status: '' },
        };
        const render = () => {
            panel.replaceChildren();
            appendDialogHeader(panel, close);
            appendNamePreview(panel);
            if (state.editing) appendFavoriteEditor(panel, state, render);
            appendManualFavoriteSearch(panel, state, render);
            appendSavedFavorites(panel, state, render);
            appendNameList(panel, render, STORAGE_KEY.blockedNames);
            appendNameList(panel, render, STORAGE_KEY.pinnedNames);
            appendBackupSection(panel, state, render);
            appendRouteLandmarks(panel, state, render);
        };
        render();

        overlay.append(panel);
        document.body.append(overlay);
    }

    function appendDialogHeader(panel, close) {
        const header = createElement('div', 'strava-route-header');
        const closeButton = createDialogButton('Close');
        closeButton.addEventListener('click', close);
        header.append(
            createElement('h3', '', { textContent: 'Route names' }),
            closeButton,
        );
        panel.append(header);
    }

    // The title field is rewritten on every change; showing the same name here
    // makes the effect of a click obvious while the dialog covers the page.
    function appendNamePreview(panel) {
        const names = currentRouteNames();
        const box = createElement('div', 'strava-route-preview');
        box.append(
            createElement('div', 'strava-route-preview-label', { textContent: 'Name preview' }),
            createElement(
                'div',
                `strava-route-preview-value${names ? '' : ' strava-route-preview-value--empty'}`,
                {
                    id: 'strava-route-name-preview',
                    textContent: names?.join(' - ')
                        || 'Generate the name first, then adjust it here.',
                },
            ),
        );
        panel.append(box);
    }

    function appendSavedFavorites(panel, state, render) {
        const favorites = loadFavorites();
        panel.append(createSectionTitle(`Saved places (${favorites.length})`));
        if (favorites.length === 0) {
            panel.append(createDialogNote('No favorite places yet.'));
            return;
        }

        for (const favorite of favorites) {
            const editButton = createDialogButton('Edit');
            editButton.addEventListener('click', () => {
                state.editing = {
                    existing: favorite,
                    passage: null,
                    name: favorite.name,
                    radiusM: String(favorite.radiusM),
                    error: '',
                };
                state.confirmingDeleteId = null;
                render();
            });

            const confirming = state.confirmingDeleteId === favorite.id;
            const deleteButton = createDialogButton(confirming ? 'Confirm delete' : 'Delete');
            deleteButton.addEventListener('click', () => runFavoriteAction(() => {
                if (!confirming) {
                    state.confirmingDeleteId = favorite.id;
                    render();
                    return;
                }
                removeFavorite(favorite.id);
                state.confirmingDeleteId = null;
                render();
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

    const NAME_LIST_LABELS = {
        [STORAGE_KEY.blockedNames]: {
            title: 'Never in a name',
            empty: 'Block a landmark below to keep it out of every name.',
            marker: '⛔',
            details: 'Left out of every name',
            remove: 'Unblock',
        },
        [STORAGE_KEY.pinnedNames]: {
            title: 'Always in a name',
            empty: 'Pin a landmark below to keep it even when the slots run out.',
            marker: '📌',
            details: 'Kept even when the automatic slots run out',
            remove: 'Unpin',
        },
    };

    function appendNameList(panel, render, key) {
        const labels = NAME_LIST_LABELS[key];
        const names = loadNameList(key);
        panel.append(createSectionTitle(`${labels.title} (${names.length})`));
        if (names.length === 0) {
            panel.append(createDialogNote(labels.empty));
            return;
        }
        for (const name of names) {
            const removeButton = createDialogButton(labels.remove);
            removeButton.addEventListener('click', () => runFavoriteAction(() => {
                toggleNameList(key, name);
                render();
            }));
            appendFavoriteRow(panel, `${labels.marker} ${name}`, labels.details, [removeButton]);
        }
    }

    function appendRouteLandmarks(panel, state, render) {
        panel.append(createSectionTitle('Route landmarks'));
        const analysis = lastRouteAnalysis?.activityId === getActivityId() ? lastRouteAnalysis : null;
        if (!analysis) {
            panel.append(createDialogNote('Generate the route name first, then adjust it here.'));
            return;
        }

        const favorites = loadFavorites();
        const blockedKeys = nameKeys(loadBlockedNames());
        const pinnedKeys = nameKeys(loadPinnedNames());
        for (const passage of analysis.passages) {
            const match = closestFavoriteForPassage(passage, analysis.track, favorites);
            const displayName = match?.favorite.name || passage.baseName;
            const actionButton = createDialogButton(match ? `★ ${match.favorite.name}` : '☆ Add',
                !match);
            actionButton.addEventListener('click', () => {
                state.editing = {
                    existing: match?.favorite || null,
                    passage,
                    name: match?.favorite.name || passage.baseName || '',
                    radiusM: String(match?.favorite.radiusM ?? CONFIG.favoriteRadiusM),
                    error: '',
                };
                render();
            });

            const toggles = [
                { key: STORAGE_KEY.pinnedNames, keys: pinnedKeys, on: '📌 Pinned', off: '📌 Pin' },
                { key: STORAGE_KEY.blockedNames, keys: blockedKeys, on: '⛔ Blocked', off: '⛔ Block' },
            ].map(({ key, keys, on, off }) => {
                const active = Boolean(displayName) && hasNameKey(displayName, keys);
                const button = createDialogButton(active ? on : off);
                button.disabled = !displayName;
                button.title = `${NAME_LIST_LABELS[key].title}: ${displayName || 'unnamed place'}`;
                button.addEventListener('click', () => runFavoriteAction(() => {
                    toggleNameList(key, displayName);
                    render();
                }));
                return button;
            });

            const distance = `${passage.fromKm.toFixed(2)}–${passage.toKm.toFixed(2)} km`;
            const coordinates = `${passage.lat.toFixed(5)}, ${passage.lon.toFixed(5)}`;
            appendFavoriteRow(
                panel,
                `${distance} · ${passage.baseName || 'Unknown place'}`,
                passage.address || coordinates,
                [actionButton, ...toggles],
            );
        }
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

            // Logged after the fact: an over-long narrative reaches the field
            // shortened, and the log should show what was actually written.
            setActivityName(route.names);
            log(`Name: ${fitNameLength(route.names)}`);
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
        if (document.getElementById(BUTTON_ID)) return true;

        const titleLabel = document.querySelector('label[for="activity_name"]');
        if (!titleLabel?.parentNode) return false;

        installStyles();

        const button = createElement('button', 'strava-route-button', {
            id: BUTTON_ID,
            type: 'button',
            title: 'Generate name from GPS track',
        });
        setButtonState(button, STRINGS.idle);
        button.addEventListener('click', event => {
            event.preventDefault();
            void generateAndFillName(button);
        });

        const favoritesButton = createElement(
            'button',
            'strava-route-button strava-route-button--secondary',
            { id: FAVORITES_BUTTON_ID, type: 'button' },
        );
        favoritesButton.addEventListener('click', event => {
            event.preventDefault();
            runFavoriteAction(openFavoritesDialog);
        });

        const wrapper = createElement('div', 'strava-route-controls');
        titleLabel.parentNode.insertBefore(wrapper, titleLabel);
        wrapper.append(titleLabel, button, favoritesButton);
        runFavoriteAction(updateFavoritesButtonLabel);
        log('Button injected');
        return true;
    }

    // Watching the whole page is only needed until the edit form appears. Once
    // the button is in, a narrow observer on its own container is enough to
    // notice a re-render that throws it away, and the wide watch is resumed.
    function watchForEditForm() {
        const wideObserver = new MutationObserver(() => {
            if (injectButton()) {
                wideObserver.disconnect();
                watchInjectedButton();
            }
        });
        wideObserver.observe(document.body, { childList: true, subtree: true });
    }

    function watchInjectedButton() {
        const container = document.getElementById(BUTTON_ID)?.parentNode?.parentNode;
        if (!container) {
            watchForEditForm();
            return;
        }
        const closeObserver = new MutationObserver(() => {
            if (document.getElementById(BUTTON_ID)) return;
            closeObserver.disconnect();
            if (!injectButton()) watchForEditForm();
            else watchInjectedButton();
        });
        closeObserver.observe(container, { childList: true, subtree: true });
    }

    migrateSettingToUserscriptStorage(STORAGE_KEY.favorites);
    migrateSettingToUserscriptStorage(STORAGE_KEY.blockedNames);
    migrateSettingToUserscriptStorage(STORAGE_KEY.pinnedNames);
    if (injectButton()) watchInjectedButton();
    else watchForEditForm();
})();
