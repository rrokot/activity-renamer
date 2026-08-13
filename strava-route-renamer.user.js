// ==UserScript==
// @name         Strava Route Renamer
// @namespace    https://github.com/rrokot/strava-route-renamer
// @version      6.0.0
// @description  Names Strava activities from nearby OSM settlements and named roads
// @author       Antigravity
// @match        https://www.strava.com/activities/*/edit
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
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
        savedPlaceRadiusM: 200,
        savedPlaceRadiusMinM: 10,
        savedPlaceRadiusMaxM: 5000,
        rideHistory: 50,
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
        adjust: '✎ Adjust',
        adjustTitle: 'Adjust the generated name',
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
        savedPlaces: 'strava_route_saved_places_v1',
        blockedNames: 'strava_route_blocked_names_v1',
        rideNames: 'strava_route_ride_names_v1',
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
/* Whichever section renders first opens flush with the preview above it. */
.strava-route-overlay .strava-route-panel > h4:first-of-type { margin-top: 0; }
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
/* The name is edited as the sentence it is: one chip per part, in order. */
.strava-route-overlay .strava-route-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3xs);
    margin: var(--space-2xs) 0;
}
.strava-route-overlay .strava-route-chip {
    display: inline-flex;
    align-items: stretch;
    background: var(--color-extendedneutraln7);
    border: var(--border-width-thin) solid var(--color-extendedneutraln5);
    border-radius: var(--border-radius-sm);
    overflow: hidden;
}
.strava-route-overlay .strava-route-chip button {
    padding: var(--space-3xs) var(--space-2xs);
    color: var(--color-extendedneutraln1);
    background: none;
    border: none;
    cursor: pointer;
}
.strava-route-overlay .strava-route-chip-name { font-weight: 600; }
.strava-route-overlay .strava-route-chip button:hover { background: var(--color-extendedneutraln6); }
.strava-route-overlay .strava-route-chip-drop {
    padding-left: var(--space-3xs);
    color: var(--color-extendedneutraln3);
    border-left: var(--border-width-thin) solid var(--color-extendedneutraln5);
}
.strava-route-overlay .strava-route-chip-drop:hover { color: var(--color-extendedredr3); }
.strava-route-overlay .strava-route-preview-value {
    margin: 0 0 var(--space-sm);
    padding-left: var(--space-2xs);
    color: var(--color-extendedneutraln3);
    border-left: var(--divider-size-md) var(--divider-variant-solid) var(--color-coreo3);
    font-size: 12px;
    overflow-wrap: anywhere;
}
.strava-route-overlay .strava-route-preview-value--empty { font-style: italic; }
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
    const ADJUST_BUTTON_ID = 'strava-route-adjust-btn';
    const NAME_DIALOG_ID = 'strava-route-name-dialog';
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

    // Keys earlier versions wrote and this one no longer reads: the favorites
    // that became saved places, and the two shapes the per-ride list went
    // through. Renaming a key orphans what is under the old one, so the old one
    // is cleared instead of left to sit in the profile for good.
    const RETIRED_STORAGE_KEYS = [
        'strava_route_favorites_v1',
        'strava_route_pinned_names_v1',
        'strava_route_kept_names_v1',
    ];

    function forgetRetiredSettings() {
        const forgotten = [];
        for (const key of RETIRED_STORAGE_KEYS) {
            if (localStorage.getItem(key) !== null) {
                localStorage.removeItem(key);
                forgotten.push(key);
            }
            if (typeof GM_deleteValue === 'function' && GM_getValue(key, null) !== null) {
                GM_deleteValue(key);
                forgotten.push(key);
            }
        }
        if (forgotten.length > 0) log(`Cleared retired settings: ${forgotten.join(', ')}`);
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

    // A name typed into a field, pasted in a backup or read from OSM reaches
    // the same single-spaced shape.
    function collapseWhitespace(value) {
        return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    }

    // The single gate every saved place passes, whether it comes from the form, a
    // pasted backup or an older version of the script.
    function isUsableRadius(radiusM) {
        return Number.isFinite(radiusM)
            && radiusM >= CONFIG.savedPlaceRadiusMinM
            && radiusM <= CONFIG.savedPlaceRadiusMaxM;
    }

    function isUsableCoordinate(lat, lon) {
        return Number.isFinite(lat) && lat >= -90 && lat <= 90
            && Number.isFinite(lon) && lon >= -180 && lon <= 180;
    }

    function isUsablePlaceName(name) {
        return Boolean(name) && name.length <= CONFIG.maxPlaceNameLength;
    }

    function normalizeSavedPlace(value) {
        if (!value || typeof value !== 'object') return null;
        const name = collapseWhitespace(value.name);
        const lat = Number(value.lat);
        const lon = Number(value.lon);
        const radiusM = Number(value.radiusM);
        if (!value.id || !isUsablePlaceName(name)
            || !isUsableCoordinate(lat, lon)
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

    function loadSavedPlaces() {
        const stored = readSetting(STORAGE_KEY.savedPlaces);
        if (!Array.isArray(stored)) return [];
        return stored.map(normalizeSavedPlace).filter(Boolean);
    }

    function storeSavedPlaces(savedPlaces) {
        const normalized = savedPlaces.map(normalizeSavedPlace).filter(Boolean);
        writeSetting(STORAGE_KEY.savedPlaces, normalized);
        return normalized;
    }

    function createSavedPlaceId() {
        return `place_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // Some places sit on the route but never belong in its name: the suburb the
    // ride starts in, a hamlet whose land the road merely crosses. Blocking is
    // by name, so it also silences a generic road name wherever it turns up.
    // Both name lists store the same shape and share this gate.
    function normalizeListedName(value) {
        const name = collapseWhitespace(value);
        return isUsablePlaceName(name) ? name : null;
    }

    function normalizeListedNames(values) {
        const names = [];
        const seen = new Set();
        for (const value of Array.isArray(values) ? values : []) {
            const name = normalizeListedName(value);
            const key = name?.toLocaleLowerCase();
            if (!name || seen.has(key)) continue;
            seen.add(key);
            names.push(name);
        }
        return names;
    }

    function loadNameList(key) {
        return normalizeListedNames(readSetting(key));
    }

    function saveNameList(key, names) {
        const normalized = normalizeListedNames(names);
        writeSetting(key, normalized);
        return normalized;
    }

    const loadBlockedNames = () => loadNameList(STORAGE_KEY.blockedNames);

    function nameKeys(names) {
        return new Set(names.map(name => name.toLocaleLowerCase()));
    }

    function hasNameKey(name, keys) {
        return keys.has(String(name).toLocaleLowerCase());
    }

    // Two answers belong to the ride in front of the user and to no other: a
    // place this name must contain, and a place this name is better off
    // without. Saying either about every ride is what a saved place and the block
    // list are for. The store keeps one entry per activity, and only for the
    // rides whose names were last adjusted by hand.
    const NO_RIDE_NAMES = { kept: [], dropped: [] };

    function loadRideEntries() {
        const stored = readSetting(STORAGE_KEY.rideNames);
        if (!Array.isArray(stored)) return [];
        return stored
            .map(entry => ({
                activityId: String(entry?.activityId ?? ''),
                kept: normalizeListedNames(entry?.kept),
                dropped: normalizeListedNames(entry?.dropped),
            }))
            .filter(entry =>
                entry.activityId && (entry.kept.length > 0 || entry.dropped.length > 0));
    }

    function loadRideNames(activityId = getActivityId()) {
        if (!activityId) return NO_RIDE_NAMES;
        const entry = loadRideEntries().find(item => item.activityId === activityId);
        return entry ? { kept: entry.kept, dropped: entry.dropped } : NO_RIDE_NAMES;
    }

    function saveRideNames(activityId, { kept, dropped }) {
        const entries = loadRideEntries().filter(entry => entry.activityId !== activityId);
        if (kept.length > 0 || dropped.length > 0) entries.push({ activityId, kept, dropped });
        writeSetting(STORAGE_KEY.rideNames, entries.slice(-CONFIG.rideHistory));
    }

    const withoutName = (names, name) =>
        names.filter(entry => entry.toLocaleLowerCase() !== name.toLocaleLowerCase());

    // The same click adds and removes; only the store behind the list differs.
    function withNameToggled(names, name) {
        const without = withoutName(names, name);
        return without.length === names.length ? names.concat(name) : without;
    }

    function toggleBlockedName(name) {
        const normalized = normalizeListedName(name);
        if (!normalized) return false;
        saveNameList(STORAGE_KEY.blockedNames,
            withNameToggled(loadBlockedNames(), normalized));
        refreshActivityName();
        return true;
    }

    // Adding a place to this name and taking it out are opposite answers to one
    // question, so setting either clears the other.
    function toggleRideName(list, name) {
        const activityId = getActivityId();
        const normalized = normalizeListedName(name);
        if (!activityId || !normalized) return false;
        const other = list === 'kept' ? 'dropped' : 'kept';
        const current = loadRideNames(activityId);
        saveRideNames(activityId, {
            [list]: withNameToggled(current[list], normalized),
            [other]: withoutName(current[other], normalized),
        });
        refreshActivityName();
        return true;
    }

    const keepInThisName = name => toggleRideName('kept', name);

    // Taking a place out of the name undoes whatever put it there: a place the
    // rider added is simply un-added, which restores the name they had before
    // the click. Only a place the automatic choice picked has to be recorded as
    // removed, or the next rewrite brings it straight back.
    function dropFromThisName(name) {
        const list = hasNameKey(name, nameKeys(loadRideNames().kept)) ? 'kept' : 'dropped';
        return toggleRideName(list, name);
    }

    function namingPreferences() {
        return {
            savedPlaces: loadSavedPlaces(),
            blockedNames: loadBlockedNames(),
            ...loadRideNames(),
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

    // German is the local language of the rides this was written for; the
    // plain name is the fallback for everything the mapper tagged once.
    function osmName(element) {
        const rawName = element?.tags?.['name:de'] || element?.tags?.name;
        return typeof rawName === 'string' && rawName.trim() ? rawName : null;
    }

    function parsePlaceNodes(elements) {
        const places = [];
        for (const element of elements || []) {
            const lat = Number(element?.lat);
            const lon = Number(element?.lon);
            const placeType = element?.tags?.place;
            const rawName = osmName(element);
            if (element?.type !== 'node'
                || !Number.isFinite(lat) || !Number.isFinite(lon)
                || !PLACE_NODE_TYPES.includes(placeType)
                || !rawName) {
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
            const rawName = osmName(element);
            // The geometry of a way is the expensive part of the reply, so the
            // tag checks decide first.
            if (element?.type !== 'way'
                || !Object.hasOwn(ROAD_TYPE_PRIORITY, roadType)
                || !rawName) {
                continue;
            }
            const geometry = (element.geometry || [])
                .map(point => ({ lat: Number(point?.lat), lon: Number(point?.lon) }))
                .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
            if (geometry.length < 2) continue;

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

    // Where along the ride something happened, the way every log line and the
    // dialog spell it out.
    const rangeLabel = range => `${range.fromKm.toFixed(2)}–${range.toKm.toFixed(2)} km`;

    // Every continuous stretch of track points within a feature's radius is one
    // visit, anchored at the closest point. Settlements, named roads and
    // saved places all become visits through this single path.
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
        const passages = placePassages.concat(roadPassages).sort(byTrackOrder);
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
    // when the user searches for a place of their own. Route names come from OSM
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

    function candidateFromSearchResult(result) {
        const lat = Number(result?.lat);
        const lon = Number(result?.lon);
        const address = typeof result?.display_name === 'string' ? result.display_name.trim() : '';
        if (!isUsableCoordinate(lat, lon) || !address) return null;

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

    async function searchAddresses(query) {
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
        return data.map(candidateFromSearchResult).filter(Boolean);
    }

    function closestSavedPlaceForPassage(passage, track, savedPlaces) {
        let best = null;
        for (const savedPlace of savedPlaces) {
            let distanceM = Infinity;
            let closestIndex = passage.start;
            for (let index = passage.start; index <= passage.end; index++) {
                const pointDistanceM = haversineKm(
                    savedPlace.lat,
                    savedPlace.lon,
                    track.latitudes[index],
                    track.longitudes[index],
                ) * 1000;
                if (pointDistanceM < distanceM) {
                    distanceM = pointDistanceM;
                    closestIndex = index;
                }
                if (distanceM < 0.5) break;
            }
            if (distanceM <= savedPlace.radiusM && (!best || distanceM < best.distanceM)) {
                best = { savedPlace, distanceM, index: closestIndex };
            }
        }
        return best;
    }

    function savedPlaceVisits(track, savedPlaces) {
        return savedPlaces
            .flatMap(savedPlace => visitsFromDistances(
                track,
                trackDistancesToPoint(track, savedPlace.lat, savedPlace.lon, savedPlace.radiusM),
                { savedPlace },
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

    const projectPoint = (projection, lat, lon) => ({ x: projection.x(lon), y: projection.y(lat) });

    const planarDistanceKm = (first, second) =>
        Math.hypot(first.x - second.x, first.y - second.y);

    function projectedRunPoint(run, track, projection) {
        const fallbackIndex = Math.max(
            0,
            Math.min(track.latitudes.length - 1, Math.round(run.orderIndex)),
        );
        const lat = Number.isFinite(run.lat) ? run.lat : track.latitudes[fallbackIndex];
        const lon = Number.isFinite(run.lon) ? run.lon : track.longitudes[fallbackIndex];
        return projectPoint(projection, lat, lon);
    }

    // A settlement outranks any road, and a bigger road outranks a smaller one.
    function runPriority(run) {
        return run.featureKind === 'road' ? ROAD_TYPE_PRIORITY[run.roadType] || 0 : 100;
    }

    // Both selectors below pick the candidate with the highest scores, compared
    // in order of importance; the tolerance keeps float noise from deciding a
    // tie that the next score should settle.
    const SCORE_EPSILON = 1e-9;

    function scoresBetter(candidate, best) {
        for (let i = 0; i < candidate.length; i++) {
            if (candidate[i] > best[i] + SCORE_EPSILON) return true;
            if (candidate[i] < best[i] - SCORE_EPSILON) return false;
        }
        return false;
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

        // Widest spread first, then the candidate furthest from what is already
        // in the name, then the more important feature.
        while (selected.size < targetSize) {
            const selectedPoints = Array.from(selected, index => points.get(index));
            let bestIndex = -1;
            let bestScores = [-1, -1, -1];
            for (const index of candidateIndices) {
                if (selected.has(index)) continue;
                const point = points.get(index);
                const nearestSelectedKm = selectedPoints.length === 0 ? 0 : Math.min(
                    ...selectedPoints.map(selectedPoint =>
                        planarDistanceKm(point, selectedPoint)),
                );
                const scores = [
                    convexHullArea(selectedPoints.concat(point)),
                    nearestSelectedKm,
                    runPriority(runs[index]),
                ];
                if (scoresBetter(scores, bestScores)) {
                    bestScores = scores;
                    bestIndex = index;
                }
            }
            if (bestIndex < 0) break;
            selected.add(bestIndex);
        }
        return selected;
    }

    // With a single slot to give away, the place furthest from where the ride
    // began and ended says the most about it.
    function selectSingleCoverageIndex(runs, track, candidateIndices) {
        if (candidateIndices.length === 0) return -1;
        const projection = trackProjection(track);
        const lastIndex = track.latitudes.length - 1;
        const start = projectPoint(projection, track.latitudes[0], track.longitudes[0]);
        const finish = projectPoint(
            projection, track.latitudes[lastIndex], track.longitudes[lastIndex]);

        let bestIndex = candidateIndices[0];
        let bestScores = [-1, -1];
        for (const index of candidateIndices) {
            const point = projectedRunPoint(runs[index], track, projection);
            const scores = [
                Math.min(planarDistanceKm(point, start), planarDistanceKm(point, finish)),
                runPriority(runs[index]),
            ];
            if (scoresBetter(scores, bestScores)) {
                bestScores = scores;
                bestIndex = index;
            }
        }
        return bestIndex;
    }

    const indicesWhere = (items, predicate) =>
        items.flatMap((item, index) => (predicate(item, index) ? [index] : []));

    // Settlements have absolute priority. Named roads fill only unused slots.
    // Interior saved places and kept places occupy normal places in the limit;
    // the first and last displayed route points do not consume it.
    function compactRouteRuns(allRuns, track) {
        const isForced = run => Boolean(run.saved || run.kept);
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
        // What the automatic slots may still choose from: everything the name
        // does not already contain for another reason.
        const isCandidate = (run, index) => !endpointIndices.has(index) && !isForced(run);
        const placeIndices = indicesWhere(runs, (run, index) =>
            isCandidate(run, index) && run.featureKind === 'place');
        const placeNames = new Set(placeIndices.map(index => runs[index].name));
        const roadIndices = indicesWhere(runs, (run, index) =>
            isCandidate(run, index) && run.featureKind === 'road' && !placeNames.has(run.name));
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

    // Every event that may reach the name, in track order: one per passage the
    // user has not blocked, plus the saved places the passages never covered.
    // `suppressed` collects what the block list took out, for the log.
    function routeEvents(passages, track, preferences, shouldLog) {
        const { savedPlaces, blockedNames, kept: keptNames, dropped } = preferences;
        const visits = savedPlaceVisits(track, savedPlaces);
        const blockedKeys = nameKeys(blockedNames);
        const keptKeys = nameKeys(keptNames);
        const droppedKeys = nameKeys(dropped);
        const coveredVisits = new Set();
        const suppressed = { dropped: new Set(), blocked: new Set() };
        const events = [];
        // What this ride says wins over what the block list says about every
        // ride: the narrower answer is the one the user gave last.
        const nameState = name => {
            if (hasNameKey(name, droppedKeys)) return { kept: false, hidden: 'dropped' };
            if (hasNameKey(name, keptKeys)) return { kept: true, hidden: null };
            return { kept: false, hidden: hasNameKey(name, blockedKeys) ? 'blocked' : null };
        };

        for (const passage of passages) {
            const match = closestSavedPlaceForPassage(passage, track, savedPlaces);
            const name = match?.savedPlace.name || passage.baseName;
            if (!name) continue;
            const { kept, hidden } = nameState(name);
            if (hidden) {
                suppressed[hidden].add(name);
                continue;
            }

            if (match) {
                for (const visit of visits) {
                    if (visit.savedPlace.id === match.savedPlace.id
                        && trackRangesOverlap(visit, passage)) {
                        coveredVisits.add(visit);
                    }
                }
                if (shouldLog) {
                    log(`Saved place ${rangeLabel(passage)}: ${match.savedPlace.name}`
                        + ` (${match.distanceM.toFixed(0)} m from saved address)`);
                }
            }

            events.push({
                name,
                km: passage.km,
                fromKm: passage.fromKm,
                toKm: passage.toKm,
                saved: Boolean(match),
                orderIndex: match?.index ?? passage.anchor,
                lat: match?.savedPlace.lat ?? passage.lat,
                lon: match?.savedPlace.lon ?? passage.lon,
                featureKind: match ? 'saved' : passage.featureKind,
                roadType: passage.roadType || null,
                kept,
            });
        }

        for (const visit of visits) {
            if (coveredVisits.has(visit)) continue;
            const { kept, hidden } = nameState(visit.savedPlace.name);
            if (hidden) {
                suppressed[hidden].add(visit.savedPlace.name);
                continue;
            }
            if (shouldLog) {
                log(`Saved place ${rangeLabel(visit)}: ${visit.savedPlace.name}`
                    + ` (${visit.distanceM.toFixed(0)} m from saved address; full-track visit)`);
            }
            events.push({
                name: visit.savedPlace.name,
                km: visit.km,
                fromKm: visit.fromKm,
                toKm: visit.toKm,
                saved: true,
                orderIndex: visit.index,
                lat: visit.savedPlace.lat,
                lon: visit.savedPlace.lon,
                featureKind: 'saved',
                roadType: null,
                kept,
            });
        }

        events.sort((a, b) => a.orderIndex - b.orderIndex);
        return { events, suppressed };
    }

    // Passing the same place twice in a row is one mention; a saved place or a
    // settlement outranks the road name it shares its stretch of track with.
    function mergeAdjacentEvents(events) {
        const runs = [];
        for (const event of events) {
            const last = runs[runs.length - 1];
            if (last?.name !== event.name) {
                runs.push({ ...event });
                continue;
            }
            last.km += event.km;
            last.fromKm = Math.min(last.fromKm, event.fromKm);
            last.toKm = Math.max(last.toKm, event.toKm);
            last.saved ||= event.saved;
            last.kept ||= event.kept;
            if (event.saved) {
                last.featureKind = 'saved';
            } else if (event.featureKind === 'place' && last.featureKind === 'road') {
                last.featureKind = 'place';
            }
        }
        return runs;
    }

    // Why the name came out the way it did: what the slots went to, what the
    // block list took out, and what did not fit.
    function logRouteSelection(compacted, runs, suppressed, track) {
        const count = predicate => compacted.filter(predicate).length;
        const places = count(run => !run.saved && run.featureKind === 'place');
        const roads = count(run => !run.saved && run.featureKind === 'road');
        const savedPlaces = count(run => run.saved);
        const kept = count(run => run.kept && !run.saved);
        log(`Map extent ${routeMapExtentKm(track).toFixed(1)} km: `
            + `${places} settlements`
            + (roads ? ` + ${roads} named-road fallbacks` : '')
            + ` + ${savedPlaces} saved places`
            + (kept ? ` (${kept} kept for this ride)` : ''));
        if (suppressed.blocked.size > 0) {
            log(`Blocked from the name: ${Array.from(suppressed.blocked).join(', ')}`);
        }
        if (suppressed.dropped.size > 0) {
            log(`Removed from this ride: ${Array.from(suppressed.dropped).join(', ')}`);
        }
        if (compacted.length < runs.length) {
            log(`Name compacted from ${runs.length} to ${compacted.length} places: `
                + compacted.map(run => run.name).join(' - '));
        }
    }

    function routeNamesFromPassages(passages, track, preferences, shouldLog = false) {
        const { events, suppressed } = routeEvents(passages, track, preferences, shouldLog);
        const runs = mergeAdjacentEvents(events);
        const compacted = compactRouteRuns(runs, track);
        if (shouldLog) logRouteSelection(compacted, runs, suppressed, track);
        return compacted.map(run => run.name);
    }

    // Settlement and road visits are already ordered by the closest GPX point.
    // Adjacent duplicates merge immediately; a later revisit remains visible.
    function routePlaceNames(passages, track) {
        const placePassages = passages.filter(passage => passage.featureKind === 'place');
        for (const passage of placePassages) {
            log(`Nearby place ${rangeLabel(passage)}: ${passage.baseName}`
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

    // The button opens the name of the ride in front of the rider, so what it
    // counts is what that rider changed about it by hand — not how many places
    // are saved for every other ride.
    function updateAdjustButton() {
        const button = document.getElementById(ADJUST_BUTTON_ID);
        if (!button) return;
        const { kept, dropped } = loadRideNames();
        const edits = kept.length + dropped.length;
        button.textContent = edits > 0 ? `${STRINGS.adjust} (${edits})` : STRINGS.adjust;
        button.title = edits > 0
            ? `${STRINGS.adjustTitle} — ${edits} change${edits === 1 ? '' : 's'} of your own`
            : STRINGS.adjustTitle;
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

    // Every edit rewrites the title in place, so the effect of a click is
    // visible immediately — including on the button, which counts the changes
    // this ride carries.
    function refreshActivityName() {
        const names = currentRouteNames();
        if (names && setActivityName(names)) log(`Name updated: ${names.join(' - ')}`);
        updateAdjustButton();
    }

    function savedPlaceFromForm(existing, passage, name, radiusText) {
        const trimmedName = collapseWhitespace(name);
        if (!isUsablePlaceName(trimmedName)) {
            throw new Error(`The name must be 1–${CONFIG.maxPlaceNameLength} characters long.`);
        }
        const radiusM = Number(String(radiusText).replace(',', '.'));
        if (!isUsableRadius(radiusM)) {
            throw new Error(`The radius must be a number from ${CONFIG.savedPlaceRadiusMinM}`
                + ` to ${CONFIG.savedPlaceRadiusMaxM} metres.`);
        }

        const savedPlace = normalizeSavedPlace({
            id: existing?.id || createSavedPlaceId(),
            name: trimmedName,
            lat: existing?.lat ?? passage?.lat,
            lon: existing?.lon ?? passage?.lon,
            radiusM,
            address: existing?.address || passage?.address || passage?.baseName || '',
        });
        if (!savedPlace) throw new Error('That place has no usable coordinates.');
        return savedPlace;
    }

    function storeSavedPlace(savedPlace) {
        const savedPlaces = loadSavedPlaces();
        const index = savedPlaces.findIndex(item => item.id === savedPlace.id);
        if (index >= 0) {
            savedPlaces[index] = savedPlace;
        } else {
            savedPlaces.push(savedPlace);
        }
        storeSavedPlaces(savedPlaces);
        refreshActivityName();
        return true;
    }

    function removeSavedPlace(savedPlaceId) {
        storeSavedPlaces(loadSavedPlaces().filter(item => item.id !== savedPlaceId));
        refreshActivityName();
        return true;
    }

    // Every dialog action reports the same way: nothing a click in here can hit
    // is worth losing the page over.
    async function runDialogAction(action) {
        try {
            await action();
        } catch (error) {
            console.error(`${LOG_PREFIX} Route names error:`, error);
            alert(`Route names error:\n${errorMessage(error)}`);
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

    function createSectionTitle(text) {
        return createElement('h4', '', { textContent: text });
    }

    function createDialogNote(text) {
        return createElement('p', 'strava-route-note', { textContent: text });
    }

    // Every list in the dialog reads the same way: a counted title, one line of
    // guidance while it is empty, one row per entry once it is not.
    function appendListSection(panel, title, items, { empty, row }) {
        panel.append(createSectionTitle(`${title} (${items.length})`));
        if (items.length === 0) {
            panel.append(createDialogNote(empty));
            return;
        }
        for (const item of items) row(item);
    }

    function appendDialogRow(container, title, details, actions) {
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

    // The name and radius of a saved place are edited in the dialog itself: modal
    // prompts stack up, cannot show what is being edited and are blocked in
    // some browsers.
    function appendPlaceEditor(panel, state, render) {
        const editing = state.editing;
        if (!editing) return;
        const target = editing.existing || editing.passage;
        const section = createElement('div', 'strava-route-editor');
        const title = createSectionTitle(
            editing.existing ? 'Rename this place' : 'Name this place');

        const nameInput = createDialogInput({
            id: 'strava-route-place-name-input',
            value: state.editing.name,
            placeholder: 'Name to use in the title',
            maxLength: CONFIG.maxPlaceNameLength,
        });
        nameInput.addEventListener('input', () => {
            state.editing.name = nameInput.value;
        });

        const radiusInput = createDialogInput({
            id: 'strava-route-place-radius-input',
            className: 'strava-route-field strava-route-field--narrow',
            value: state.editing.radiusM,
            placeholder: `Radius ${CONFIG.savedPlaceRadiusMinM}–${CONFIG.savedPlaceRadiusMaxM} m`,
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
                storeSavedPlace(savedPlaceFromForm(
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

    // The search reports itself through the same state the panel renders from,
    // so a failure reads as a line under the field instead of a modal.
    async function runAddressSearch(state, render) {
        const query = collapseWhitespace(state.search.query);
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
            const candidates = await searchAddresses(query);
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
    }

    // A place the route never came near — a café one street off it — has no
    // landmark row to start from, so it is searched for by address.
    function appendAddressSearch(panel, state, render) {
        const note = createDialogNote('Add a place by address:');
        const form = createElement('form', 'strava-route-form');

        const input = createDialogInput({
            id: 'strava-route-address-input',
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
            const addButton = createDialogButton('☆ Save', true);
            addButton.addEventListener('click', () =>
                openPlaceEditor(state, render, { passage: candidate, anchor: candidate }));
            appendDialogRow(results, candidate.baseName, candidate.address, [addButton]);
            appendEditorAt(results, state, render, candidate);
        }

        form.addEventListener('submit', event => {
            event.preventDefault();
            void runDialogAction(() => runAddressSearch(state, render));
        });

        const attribution = createElement('div', 'strava-route-attribution');
        attribution.append('Search by Nominatim · © ');
        const attributionLink = document.createElement('a');
        attributionLink.href = 'https://www.openstreetmap.org/copyright';
        attributionLink.target = '_blank';
        attributionLink.rel = 'noopener noreferrer';
        attributionLink.textContent = 'OpenStreetMap contributors';
        attribution.append(attributionLink);

        panel.append(note, form, status, results, attribution);
    }

    // Names kept for a single ride are left out: they are a note about one
    // activity, not a saved place worth carrying to another browser.
    function backupPayload() {
        return {
            savedPlaces: loadSavedPlaces(),
            blockedNames: loadBlockedNames(),
        };
    }

    function applyBackup(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error('That is not valid JSON.');
        }
        const savedPlaces = Array.isArray(parsed) ? parsed : parsed?.savedPlaces;
        if (!Array.isArray(savedPlaces)) {
            throw new Error('A backup must contain a "savedPlaces" array.');
        }
        const normalized = savedPlaces.map(normalizeSavedPlace).filter(Boolean);
        if (savedPlaces.length > 0 && normalized.length === 0) {
            throw new Error('No usable saved place in that backup.');
        }
        storeSavedPlaces(normalized);
        const blocked = saveNameList(STORAGE_KEY.blockedNames, parsed?.blockedNames);
        refreshActivityName();
        return {
            savedPlaces: normalized.length,
            blockedNames: blocked.length,
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
        importButton.addEventListener('click', () => runDialogAction(() => {
            if (!state.backup.armed) {
                state.backup.armed = true;
                state.backup.text = textarea.value;
                state.backup.status = 'This overwrites the saved places. Click again to confirm.';
                render();
                return;
            }
            const imported = applyBackup(textarea.value);
            log(`Imported ${imported.savedPlaces} saved places`
                + ` and ${imported.blockedNames} blocked names`);
            state.backup = { text: null, armed: false, status: 'Backup imported.' };
            render();
        }));

        const controls = createElement('div', 'strava-route-row-actions');
        controls.append(copyButton, importButton);

        panel.append(title, note, textarea, controls, status);
    }

    // The dialog is about one thing — the sentence in the title field — so that
    // is what it opens with, editable part by part, followed by the places the
    // ride passed that are not in it. Everything below is a setting behind that
    // name: what a place is called everywhere, what is never named at all, and
    // the backup nobody opens twice.
    const DIALOG_SECTIONS = [
        appendThisName,
        appendAlsoPassed,
        appendSavedPlaces,
        appendBlockedNames,
        appendBackupSection,
    ];

    function openNameDialog() {
        document.getElementById(NAME_DIALOG_ID)?.remove();

        const overlay = createElement('div', 'strava-route-overlay', {
            id: NAME_DIALOG_ID,
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
            view: null,
            editing: null,
            confirmingDeleteId: null,
            search: { query: '', candidates: [], status: '', error: false, busy: false },
            backup: { text: null, armed: false, status: '' },
        };
        // The route is read once per render and shared: two sections describe
        // the same name from opposite sides.
        const render = () => {
            state.view = currentRouteView();
            panel.replaceChildren();
            appendDialogHeader(panel, close);
            for (const section of DIALOG_SECTIONS) section(panel, state, render);
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

    // What the dialog is looking at: the ride analyzed for this page, the name
    // it currently produces, and the landmark behind every part of that name.
    function currentRouteView() {
        const analysis = lastRouteAnalysis?.activityId === getActivityId() ? lastRouteAnalysis : null;
        if (!analysis) return null;

        const savedPlaces = loadSavedPlaces();
        const landmarks = analysis.passages.map(passage => {
            const match = closestSavedPlaceForPassage(passage, analysis.track, savedPlaces);
            return { passage, match, name: match?.savedPlace.name || passage.baseName };
        });
        const byName = new Map();
        for (const landmark of landmarks) {
            if (landmark.name && !byName.has(landmark.name)) byName.set(landmark.name, landmark);
        }
        return { names: currentRouteNames() || [], landmarks, byName, savedPlaces };
    }

    // One place builds the editor state, so a chip, a landmark, a saved place
    // and a search result all open the same form — under whatever was clicked.
    function openPlaceEditor(state, render, { existing = null, passage = null, anchor }) {
        state.editing = {
            existing,
            passage,
            anchor,
            name: existing?.name || passage?.baseName || '',
            radiusM: String(existing?.radiusM ?? CONFIG.savedPlaceRadiusM),
            error: '',
        };
        state.confirmingDeleteId = null;
        render();
    }

    function appendEditorAt(container, state, render, anchor) {
        if (state.editing?.anchor === anchor) appendPlaceEditor(container, state, render);
    }

    const NAME_ANCHOR = 'name';

    // The name as the sentence it is: one chip per part, in the order they are
    // written. The chip's own label renames the place, the ✕ takes it out of
    // this ride. Below them stands the exact string the title field will hold —
    // an over-long narrative reaches it shortened, and that is worth seeing.
    function appendThisName(panel, state, render) {
        const view = state.view;
        panel.append(createSectionTitle(view ? `This name (${view.names.length})` : 'This name'));
        if (!view) {
            panel.append(createDialogNote('Generate the name first, then adjust it here.'));
            return;
        }

        if (view.names.length === 0) {
            panel.append(createDialogNote('Nothing is in the name. Add a landmark below.'));
        } else {
            const chips = createElement('div', 'strava-route-chips');
            for (const name of view.names) {
                chips.append(createNameChip(name, view, state, render));
            }
            panel.append(chips);
        }

        panel.append(createElement(
            'p',
            `strava-route-preview-value${view.names.length ? '' : ' strava-route-preview-value--empty'}`,
            {
                id: 'strava-route-name-preview',
                textContent: view.names.length
                    ? fitNameLength(view.names)
                    : 'The title field is left alone while the name is empty.',
            },
        ));
        appendEditorAt(panel, state, render, NAME_ANCHOR);
    }

    function createNameChip(name, view, state, render) {
        const chip = createElement('div', 'strava-route-chip');
        const landmark = view.byName.get(name);
        // A saved place can reach the name through a full-track visit that no
        // passage covers, so the chip falls back to matching it by name.
        const savedPlace = landmark?.match?.savedPlace
            || view.savedPlaces.find(saved => saved.name === name)
            || null;

        const renameButton = createElement('button', 'strava-route-chip-name', {
            type: 'button',
            textContent: name,
            title: savedPlace || landmark
                ? `Rename ${name} wherever a route comes near it`
                : `${name} has no place to rename`,
        });
        renameButton.disabled = !savedPlace && !landmark;
        renameButton.addEventListener('click', () => openPlaceEditor(state, render, {
            existing: savedPlace,
            passage: landmark?.passage || null,
            anchor: NAME_ANCHOR,
        }));

        const dropButton = createElement('button', 'strava-route-chip-drop', {
            type: 'button',
            textContent: '✕',
            title: `Take ${name} out of this ride’s name`,
        });
        dropButton.addEventListener('click', () => runDialogAction(() => {
            dropFromThisName(name);
            render();
        }));

        chip.append(renameButton, dropButton);
        return chip;
    }

    // Everything the route came near that the name does not mention: the places
    // the automatic selection had no slot for, the ones taken out by hand, and
    // the ones the block list silences everywhere.
    function appendAlsoPassed(panel, state, render) {
        const view = state.view;
        if (!view) return;

        const inName = new Set(view.names);
        const dropped = nameKeys(loadRideNames().dropped);
        const blocked = nameKeys(loadBlockedNames());
        appendListSection(
            panel,
            'Also passed',
            view.landmarks.filter(landmark => landmark.name && !inName.has(landmark.name)),
            {
                empty: 'Every landmark of this route is in the name.',
                row: landmark => {
                    appendAlsoPassedRow(panel, landmark, { dropped, blocked }, state, render);
                    appendEditorAt(panel, state, render, landmark.passage);
                },
            },
        );
    }

    function appendAlsoPassedRow(panel, landmark, keys, state, render) {
        const { passage, match, name } = landmark;

        const addButton = createDialogButton('⊕ Add', true);
        addButton.title = `Put ${name} into this ride’s name`;
        addButton.addEventListener('click', () => runDialogAction(() => {
            keepInThisName(name);
            render();
        }));

        const renameButton = createDialogButton(
            match ? `★ ${match.savedPlace.name}` : '★ Rename');
        renameButton.addEventListener('click', () => openPlaceEditor(state, render, {
            existing: match?.savedPlace || null,
            passage,
            anchor: passage,
        }));

        const isBlocked = hasNameKey(name, keys.blocked);
        const blockButton = createDialogButton(isBlocked ? '⛔ Blocked' : '⛔ Never');
        blockButton.title = `Leave ${name} out of every name, on every ride`;
        blockButton.addEventListener('click', () => runDialogAction(() => {
            toggleBlockedName(name);
            render();
        }));

        // Why it is not in the name comes first; a place that simply lost the
        // slot says nothing and goes straight to where it was passed.
        const reason = hasNameKey(name, keys.dropped) ? 'Removed from this ride'
            : isBlocked ? 'Never in a name'
                : null;
        const details = [reason, rangeLabel(passage), passage.address]
            .filter(Boolean)
            .join(' · ');
        appendDialogRow(panel, name, details, [addButton, renameButton, blockButton]);
    }

    // A saved name replaces the OSM one on every ride that comes near it, so
    // this is the list of the places the rider has words of their own for.
    function appendSavedPlaces(panel, state, render) {
        appendListSection(panel, 'Saved places', loadSavedPlaces(), {
            empty: 'No saved names yet. Rename a place above, or add one by address.',
            row: savedPlace => {
                const editButton = createDialogButton('Edit');
                editButton.addEventListener('click', () =>
                    openPlaceEditor(state, render, { existing: savedPlace, anchor: savedPlace }));

                const confirming = state.confirmingDeleteId === savedPlace.id;
                const deleteButton = createDialogButton(confirming ? 'Confirm delete' : 'Delete');
                deleteButton.addEventListener('click', () => runDialogAction(() => {
                    if (!confirming) {
                        state.confirmingDeleteId = savedPlace.id;
                        render();
                        return;
                    }
                    removeSavedPlace(savedPlace.id);
                    state.confirmingDeleteId = null;
                    render();
                }));

                const coordinates = `${savedPlace.lat.toFixed(5)}, ${savedPlace.lon.toFixed(5)}`;
                appendDialogRow(
                    panel,
                    `★ ${savedPlace.name}`,
                    `${savedPlace.address || coordinates} · ${savedPlace.radiusM} m`,
                    [editButton, deleteButton],
                );
                appendEditorAt(panel, state, render, savedPlace);
            },
        });
        appendAddressSearch(panel, state, render);
    }

    function appendBlockedNames(panel, state, render) {
        appendListSection(panel, 'Never in a name', loadBlockedNames(), {
            empty: 'Nothing is blocked. “Never” on a landmark silences a name for good.',
            row: name => {
                const removeButton = createDialogButton('Unblock');
                removeButton.addEventListener('click', () => runDialogAction(() => {
                    toggleBlockedName(name);
                    render();
                }));
                appendDialogRow(panel, `⛔ ${name}`, 'Left out of every name', [removeButton]);
            },
        });
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
                throw new Error('The route has no named OSM place, road, or savedPlace radius.');
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

        const adjustButton = createElement(
            'button',
            'strava-route-button strava-route-button--secondary',
            { id: ADJUST_BUTTON_ID, type: 'button', textContent: STRINGS.adjust },
        );
        adjustButton.addEventListener('click', event => {
            event.preventDefault();
            runDialogAction(openNameDialog);
        });

        const wrapper = createElement('div', 'strava-route-controls');
        titleLabel.parentNode.insertBefore(wrapper, titleLabel);
        wrapper.append(titleLabel, button, adjustButton);
        runDialogAction(updateAdjustButton);
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

    forgetRetiredSettings();
    migrateSettingToUserscriptStorage(STORAGE_KEY.savedPlaces);
    migrateSettingToUserscriptStorage(STORAGE_KEY.blockedNames);
    migrateSettingToUserscriptStorage(STORAGE_KEY.rideNames);
    if (injectButton()) watchInjectedButton();
    else watchForEditForm();
})();
