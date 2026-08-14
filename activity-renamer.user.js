// ==UserScript==
// @name         Activity Renamer
// @namespace    https://github.com/rrokot/activity-renamer
// @version      0.1.21
// @description  Names Strava activities from nearby OSM settlements and named roads
// @author       Antigravity
// @homepageURL  https://github.com/rrokot/activity-renamer
// @supportURL   https://github.com/rrokot/activity-renamer/issues
// @updateURL    https://raw.githubusercontent.com/rrokot/activity-renamer/master/activity-renamer.user.js
// @downloadURL  https://raw.githubusercontent.com/rrokot/activity-renamer/master/activity-renamer.user.js
// @match        https://www.strava.com/activities/*/edit
// @grant        GM.xmlHttpRequest
// @grant        GM.getValues
// @grant        GM.setValue
// @connect      overpass-api.de
// @connect      overpass.kumi.systems
// @connect      overpass.private.coffee
// @connect      nominatim.openstreetmap.org
// @run-at       document-idle
// ==/UserScript==

(async function() {
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
        autoNamePlaceCeiling: 7,
        minNamePlaces: 2,
        namePlaceSliderMax: 10,
        autoPlaceSpacingKm: 1.3,
        autoPlaceSpacingMinKm: 0.1,
        favoriteRadiusM: 200,
        favoriteRadiusMinM: 10,
        favoriteRadiusMaxM: 5000,
        rideHistory: 50,
        maxPlaceNameLength: 80,
        maxNameLength: 200,
        stripPlaceParentheticals: true,
        nominatimIntervalMs: 1050,
        successStateMs: 1500,
        errorStateMs: 2000,
    };

    const STRINGS = {
        idle: 'Build Name',
        downloading: '⌛ Downloading...',
        analyzing: '⌛ Analyzing...',
        places: '⌛ Loading nearby landmarks',
        overpassBusy: '⌛ Overpass busy; retrying in',
        done: '✔️ Done!',
        error: '❌ Error',
        noGps: 'No GPS data found (manual entry or indoor activity?)',
        noPlaces: 'No named OSM place, road, or Favorite near this route.',
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
        routeFeatures: 'activity_renamer_features_v2_',
    };
    const STORAGE_KEY = {
        favorites: 'activity_renamer_saved_places_v1',
        blockedNames: 'activity_renamer_blocked_names_v1',
        rideOverrides: 'activity_renamer_ride_names_v1',
        autoPlaceSpacingKm: 'activity_renamer_auto_place_spacing_km_v1',
    };
    const settings = new Map();
    // Strava's edit form still ships its own control kit, so the panel dresses
    // its buttons and fields in it instead of imitating them. btn-sm is the
    // 32px size the form uses for compact actions; input-sm is its matching
    // field. Everything the page paints this way follows Strava's own changes.
    const STRAVA_CLASS = {
        primaryButton: 'btn btn-primary btn-sm',
        neutralButton: 'btn btn-default btn-sm',
        field: 'form-control input-sm',
    };

    // One stylesheet instead of a style object per element. It is adopted
    // through the CSSOM rather than injected as a <style> tag, because a
    // page's style-src policy can drop the tag but never reaches constructed
    // sheets — the same reason the network calls go through the manager.
    //
    // The buttons and fields wear Strava's own control classes (STRAVA_CLASS
    // above), so the page paints them and they keep following Strava. What is
    // left here is layout, the panel shell, and the parts Strava has no class
    // for. Their skin is repeated inside a cascade layer, which every unlayered
    // rule outranks: Strava wins while its classes exist, and the panel is
    // still readable on the day they go.
    //
    // Spacing, radii and the brand colours come from the design tokens Strava
    // declares on :root, used without a var() fallback so a renamed token drops
    // its rule instead of silently drifting out of date. The edit form predates
    // those tokens and paints from an older palette that has no token to point
    // at, so those five values are measured from the form and named once below.
    const STYLES = `
.activity-renamer-controls,
.activity-renamer-panel {
    --activity-renamer-line: #dfdfe8;
    --activity-renamer-muted: #6d6d78;
    --activity-renamer-handle-line: #ceced3;
    --activity-renamer-rail-start: #f4f4f4;
    --activity-renamer-rail-rest: #f0f0f0;
}
@layer activity-renamer-fallback {
    .activity-renamer-control {
        min-height: 32px;
        padding: 6px 12px;
        border: var(--border-width-thin) solid transparent;
        border-radius: var(--border-radius-sm);
        transition: background-color 200ms, border-color 200ms, color 200ms;
    }
    .activity-renamer-primary-button {
        color: var(--color-corewhite);
        background-color: var(--color-coreo3);
        border-color: var(--color-coreo3);
    }
    .activity-renamer-primary-button:hover:not([disabled]):not([data-state]),
    .activity-renamer-primary-button:hover:not([disabled])[data-state="idle"] {
        background-color: var(--color-extendedorangeo2);
        border-color: var(--color-extendedorangeo2);
    }
    .activity-renamer-neutral-button {
        color: var(--color-coreasphalt);
        background-color: var(--color-corewhite);
        border-color: var(--activity-renamer-line);
    }
    .activity-renamer-neutral-button:hover:not([disabled]) {
        background-color: var(--color-coren7);
    }
    .activity-renamer-field {
        padding: 10px 16px;
        font-family: inherit;
        font-size: 13px;
        color: var(--color-coreasphalt);
        background: var(--color-corewhite);
        border: var(--border-width-thin) solid var(--activity-renamer-line);
        border-radius: var(--border-radius-xs);
    }
}
/* The shape of a control, which the page's own button rules would otherwise
   flatten. Every value here is the one Strava's .btn already computes, so this
   agrees with the page instead of overruling it; the paint stays in the layer
   above, where Strava keeps the last word. */
.activity-renamer-control.activity-renamer-control {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    font-family: inherit;
    font-size: 14px;
    font-weight: 700;
    line-height: normal;
    white-space: nowrap;
    vertical-align: middle;
    cursor: pointer;
}
.activity-renamer-control.activity-renamer-control:active:not([disabled]) {
    transform: translateY(1px);
}
.activity-renamer-button.activity-renamer-button {
    flex: 0 0 auto;
    margin-left: auto;
}
.activity-renamer-button.activity-renamer-button[data-state="loading"] {
    background-color: var(--color-extendedneutraln4);
    border-color: var(--color-extendedneutraln4);
}
.activity-renamer-button.activity-renamer-button[data-state="success"] {
    background-color: var(--color-extendedgreeng2);
    border-color: var(--color-extendedgreeng2);
}
.activity-renamer-button.activity-renamer-button[data-state="error"] {
    background-color: var(--color-extendedredr3);
    border-color: var(--color-extendedredr3);
}
.activity-renamer-button--toggle.activity-renamer-button--toggle {
    margin-left: var(--space-3xs);
    min-width: 32px;
    width: 32px;
    padding: 0;
}
.activity-renamer-button--toggle .activity-renamer-chevron {
    width: 16px;
    height: 16px;
    transform: translateX(-2px);
    transform-origin: center;
    transition: transform 140ms cubic-bezier(0.16, 1, 0.3, 1);
}
.activity-renamer-button--toggle[aria-expanded="true"] .activity-renamer-chevron {
    transform: translateX(-2px) rotate(180deg);
}
.activity-renamer-button--toggle.activity-renamer-button--toggle[disabled] {
    opacity: 0.5;
    cursor: default;
}
.activity-renamer-controls { display: flex; align-items: center; }
/* The same white card on a hairline that the editor gives Privacy Controls. */
.activity-renamer-panel {
    box-sizing: border-box;
    width: 100%;
    margin: var(--space-xs) 0 var(--space-md);
    padding: var(--space-sm);
    color: var(--color-coreasphalt);
    background: var(--color-corewhite);
    border: var(--border-width-thin) solid var(--activity-renamer-line);
    border-radius: var(--border-radius-sm);
}
.activity-renamer-panel[aria-busy="true"] { cursor: progress; }
.activity-renamer-panel h4 {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    margin: var(--space-md) 0 var(--space-3xs);
    font-size: 13px;
    font-weight: 700;
}
.activity-renamer-panel .activity-renamer-section-icon {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    color: inherit;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.8;
}
.activity-renamer-panel .activity-renamer-section-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 32px;
    width: 32px;
    min-height: 32px;
    margin: 0;
    padding: 0;
    color: var(--activity-renamer-muted);
    background: none;
    border: none;
    cursor: pointer;
    transition: box-shadow 120ms ease, color 120ms ease;
}
.activity-renamer-panel .activity-renamer-section-tab[aria-selected="true"] {
    color: var(--color-coreo3);
    box-shadow: inset 0 -2px 0 var(--color-coreo3);
}
.activity-renamer-panel .activity-renamer-section-tab:hover {
    color: var(--color-coreo3);
}
.activity-renamer-panel .activity-renamer-section-tabs {
    display: flex;
    align-items: center;
    gap: var(--space-3xs);
    margin: var(--space-2xs) 0 var(--space-3xs);
}
.activity-renamer-panel .activity-renamer-panel-button .activity-renamer-section-icon {
    width: 16px;
    height: 16px;
}
.activity-renamer-panel .activity-renamer-panel-button.activity-renamer-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    width: 32px;
    padding: 0;
}
.activity-renamer-panel .activity-renamer-note {
    margin: 0 0 var(--space-2xs);
    color: var(--activity-renamer-muted);
    font-size: 12px;
}
.activity-renamer-panel .activity-renamer-panel-button[disabled] { opacity: 0.5; cursor: default; }
.activity-renamer-panel .activity-renamer-field {
    flex: 1 1 auto;
    min-width: 0;
}
.activity-renamer-panel .activity-renamer-field--narrow { flex: 0 0 130px; }
.activity-renamer-panel .activity-renamer-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2xs);
}
.activity-renamer-panel .activity-renamer-name-count {
    margin: 0 0 var(--space-2xs);
}
.activity-renamer-panel .activity-renamer-name-count-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
}
.activity-renamer-panel .activity-renamer-name-count-slider {
    appearance: none;
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    margin: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
}
.activity-renamer-panel .activity-renamer-name-count-slider::-webkit-slider-runnable-track {
    height: 4px;
    background:
        linear-gradient(
            90deg,
            transparent 0 var(--activity-renamer-slider-progress),
            var(--activity-renamer-rail-rest) var(--activity-renamer-slider-progress) 100%
        ),
        linear-gradient(90deg, var(--activity-renamer-rail-start), var(--color-coreo3));
    border-radius: 2px;
}
.activity-renamer-panel .activity-renamer-name-count-slider::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 28px;
    margin-top: -12px;
    background: var(--color-corewhite);
    border: var(--border-width-thin) solid var(--activity-renamer-handle-line);
    border-radius: 2px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}
.activity-renamer-panel .activity-renamer-name-count-slider::-moz-range-track {
    height: 4px;
    background:
        linear-gradient(
            90deg,
            transparent 0 var(--activity-renamer-slider-progress),
            var(--activity-renamer-rail-rest) var(--activity-renamer-slider-progress) 100%
        ),
        linear-gradient(90deg, var(--activity-renamer-rail-start), var(--color-coreo3));
    border: 0;
    border-radius: 2px;
}
.activity-renamer-panel .activity-renamer-name-count-slider::-moz-range-thumb {
    width: 16px;
    height: 28px;
    background: var(--color-corewhite);
    border: var(--border-width-thin) solid var(--activity-renamer-handle-line);
    border-radius: 2px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}
.activity-renamer-panel .activity-renamer-name-count .activity-renamer-note {
    margin: var(--space-4xs) 0 0;
}
/* Strava's field padding is written for a full-width input; a two-digit box
   needs the room back. */
.activity-renamer-panel .activity-renamer-name-count input[type="number"] {
    flex: 0 0 auto;
    min-width: 72px;
    width: 72px;
    padding-right: var(--space-2xs);
    padding-left: var(--space-2xs);
}
.activity-renamer-panel .activity-renamer-mode-field {
    transition: border-color 120ms ease, box-shadow 120ms ease;
}
.activity-renamer-panel .activity-renamer-mode-field[data-mode-active="true"] {
    border-color: var(--color-coreo3);
    box-shadow: inset 0 -2px 0 var(--color-coreo3);
}
.activity-renamer-panel .activity-renamer-status {
    min-height: 18px;
    margin-top: var(--space-4xs);
    color: var(--activity-renamer-muted);
    font-size: 12px;
}
.activity-renamer-panel .activity-renamer-status--error { color: var(--color-extendedredr3); }
.activity-renamer-panel .activity-renamer-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: var(--space-2xs);
    row-gap: var(--space-3xs);
    padding: var(--space-3xs) 0;
    border-bottom: var(--divider-size-xs) var(--divider-variant-solid) var(--activity-renamer-line);
}
.activity-renamer-panel .activity-renamer-row-text { flex: 1 1 180px; min-width: 0; }
.activity-renamer-panel .activity-renamer-row-title {
    font-weight: 700;
    line-height: 1.2;
}
.activity-renamer-panel .activity-renamer-row-details {
    margin-top: 0;
    color: var(--activity-renamer-muted);
    font-size: 12px;
    line-height: 1.2;
    overflow-wrap: anywhere;
}
.activity-renamer-panel .activity-renamer-row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3xs);
    margin-left: auto;
}
.activity-renamer-panel .activity-renamer-editor {
    margin: 0 0 var(--space-sm);
    padding: var(--space-xs);
    background: var(--color-coren7);
    border: var(--border-width-thin) solid var(--color-coreo3);
    border-radius: var(--border-radius-sm);
}
.activity-renamer-panel .activity-renamer-editor h4 { margin: 0 0 var(--space-3xs); }
/* The name is edited as the sentence it is: one chip per part, in order. */
.activity-renamer-panel .activity-renamer-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3xs);
    margin: var(--space-2xs) 0;
}
/* The chips borrow the geometry of the editor's own tag pills; the fill stays
   orange because a chip is a place the title already carries. */
.activity-renamer-panel .activity-renamer-chip {
    display: inline-flex;
    align-items: stretch;
    min-height: 32px;
    background: var(--color-coreo3);
    border: var(--border-width-thin) solid var(--color-coreo3);
    border-radius: var(--border-radius-xs);
    overflow: hidden;
}
.activity-renamer-panel .activity-renamer-chip button {
    padding: var(--space-3xs) var(--space-2xs);
    color: var(--color-corewhite);
    background: none;
    border: none;
    cursor: pointer;
}
.activity-renamer-panel .activity-renamer-chip-name { font-weight: 700; }
.activity-renamer-panel .activity-renamer-chip-name:hover:not([disabled]) {
    background: var(--color-extendedorangeo2);
}
.activity-renamer-panel .activity-renamer-chip-drop {
    padding-left: var(--space-3xs);
    border-left: var(--border-width-thin) solid var(--color-corewhite);
}
.activity-renamer-panel .activity-renamer-chip-drop:hover {
    background: var(--color-extendedredr3);
}
.activity-renamer-panel .activity-renamer-attribution {
    margin: var(--space-3xs) 0 var(--space-sm);
    color: var(--activity-renamer-muted);
    font-size: 11px;
}
.activity-renamer-panel .activity-renamer-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}
.activity-renamer-panel button:focus-visible,
.activity-renamer-panel input:focus-visible,
.activity-renamer-panel a:focus-visible {
    outline: 2px solid var(--color-coreo3);
    outline-offset: 2px;
}
@media (max-width: 600px) {
    .activity-renamer-panel { padding: var(--space-xs); }
    .activity-renamer-panel .activity-renamer-field--narrow { flex-basis: 100%; }
    .activity-renamer-panel .activity-renamer-row {
        align-items: flex-start;
    }
    .activity-renamer-panel .activity-renamer-name-count-controls { align-items: center; }
}
`;

    let installedStyleSheet = null;

    function installStyles() {
        if (installedStyleSheet) return;
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLES);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        installedStyleSheet = sheet;
    }

    const BUTTON_ID = 'activity-renamer-rename-btn';
    const PANEL_TOGGLE_BUTTON_ID = 'activity-renamer-panel-toggle';
    const NAME_PANEL_ID = 'activity-renamer-name-panel';
    const LOG_PREFIX = '[Activity Renamer]';
    const TRANSIENT_OVERPASS_STATUSES = new Set([406, 429, 502, 503, 504]);

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
    let namePanelState = null;
    let nameBuildBusy = false;
    let lastNominatimCallAt = 0;
    let nominatimQueue = Promise.resolve();

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const log = message => console.log(`${LOG_PREFIX} ${message}`);

    function hostOf(url) {
        return String(url).replace(/^https?:\/\//, '').split('/')[0];
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
    // Content-Security-Policy cannot block Overpass or Nominatim.
    function requestCrossOrigin(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
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

    async function loadSettings() {
        const keys = Object.values(STORAGE_KEY);
        const stored = await GM.getValues(keys);
        for (const key of keys) settings.set(key, stored[key] ?? null);
    }

    // User settings live exclusively in the userscript manager's storage and
    // are read from memory after the initial load.
    function readSetting(key) {
        const stored = settings.get(key) ?? null;
        if (typeof stored !== 'string') return stored;
        try {
            return JSON.parse(stored);
        } catch {
            throw new Error(`Stored setting ${key} is not valid JSON.`);
        }
    }

    function writeSetting(key, value) {
        const stored = JSON.stringify(value);
        settings.set(key, stored);
        void GM.setValue(key, stored).catch(error => {
            console.error(`${LOG_PREFIX} Failed to save ${key}:`, error);
        });
    }

    function minimumNamePlaces() {
        return Math.max(1, Math.floor(CONFIG.minNamePlaces));
    }

    function normalizeNamePlaceCount(value) {
        const minimum = minimumNamePlaces();
        const normalized = Number(value);
        return Number.isInteger(normalized) && normalized >= minimum ? normalized : null;
    }

    function normalizeAutoPlaceSpacingKm(value) {
        const normalized = Number(value);
        return Number.isFinite(normalized) && normalized >= CONFIG.autoPlaceSpacingMinKm
            ? normalized
            : null;
    }

    function autoPlaceSpacingKm() {
        return normalizeAutoPlaceSpacingKm(readSetting(STORAGE_KEY.autoPlaceSpacingKm))
            ?? CONFIG.autoPlaceSpacingKm;
    }

    // A name typed into a field, loaded from storage or read from OSM reaches
    // the same single-spaced shape.
    function collapseWhitespace(value) {
        return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    }

    // The single gate every Favorite passes, whether loaded from storage or
    // changed in the editor.
    function isUsableRadius(radiusM) {
        return Number.isFinite(radiusM)
            && radiusM >= CONFIG.favoriteRadiusMinM
            && radiusM <= CONFIG.favoriteRadiusMaxM;
    }

    function isUsableCoordinate(lat, lon) {
        return Number.isFinite(lat) && lat >= -90 && lat <= 90
            && Number.isFinite(lon) && lon >= -180 && lon <= 180;
    }

    function isUsablePlaceName(name) {
        return Boolean(name) && name.length <= CONFIG.maxPlaceNameLength;
    }

    function normalizeFavorite(value) {
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

    function loadFavorites() {
        const stored = readSetting(STORAGE_KEY.favorites);
        if (!Array.isArray(stored)) return [];
        return stored.map(normalizeFavorite).filter(Boolean);
    }

    function storeFavorites(favorites) {
        const normalized = favorites.map(normalizeFavorite).filter(Boolean);
        writeSetting(STORAGE_KEY.favorites, normalized);
        return normalized;
    }

    function createFavoriteId() {
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

    function normalizeNameSequence(values) {
        return (Array.isArray(values) ? values : []).map(normalizeListedName).filter(Boolean);
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

    // Two overrides belong to the ride in front of the user and to no other:
    // places this name must contain and the desired number of places. The store
    // keeps one entry per activity, only after its generated name is edited.
    const NO_RIDE_OVERRIDE = { kept: [], placeCount: null };

    function loadRideOverrideEntries() {
        const stored = readSetting(STORAGE_KEY.rideOverrides);
        if (!Array.isArray(stored)) return [];
        return stored
            .map(entry => ({
                activityId: String(entry?.activityId ?? ''),
                kept: normalizeNameSequence(entry?.kept),
                placeCount: normalizeNamePlaceCount(entry?.placeCount),
            }))
            .filter(entry =>
                entry.activityId && (entry.kept.length > 0 || entry.placeCount !== null));
    }

    function loadRideOverride(activityId = getActivityId()) {
        if (!activityId) return NO_RIDE_OVERRIDE;
        const entry = loadRideOverrideEntries().find(item => item.activityId === activityId);
        return entry ? {
            kept: entry.kept,
            placeCount: entry.placeCount,
        } : NO_RIDE_OVERRIDE;
    }

    function saveRideOverride(activityId, { kept, placeCount = null }) {
        const entries = loadRideOverrideEntries().filter(entry => entry.activityId !== activityId);
        if (kept.length > 0 || placeCount !== null) {
            const entry = { activityId, kept };
            if (placeCount !== null) entry.placeCount = placeCount;
            entries.push(entry);
        }
        writeSetting(STORAGE_KEY.rideOverrides, entries.slice(-CONFIG.rideHistory));
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

    function insertNameInRouteOrder(names, name, passage) {
        const landmarks = currentRouteView()?.landmarks || [];
        const targetOrder = passage?.anchor;
        if (!Number.isFinite(targetOrder) || landmarks.length === 0) return names.concat(name);

        let landmarkIndex = 0;
        const orders = names.map(existingName => {
            while (landmarkIndex < landmarks.length
                && String(landmarks[landmarkIndex].name).toLocaleLowerCase()
                    !== existingName.toLocaleLowerCase()) {
                landmarkIndex++;
            }
            if (landmarkIndex >= landmarks.length) return Infinity;
            return landmarks[landmarkIndex++].passage.anchor;
        });
        const insertAt = orders.findIndex(order => order > targetOrder);
        const result = names.slice();
        result.splice(insertAt < 0 ? result.length : insertAt, 0, name);
        return result;
    }

    function keepInThisName(name, passage) {
        const activityId = getActivityId();
        const normalized = normalizeListedName(name);
        if (!activityId || !normalized) return false;
        const current = loadRideOverride(activityId);
        const names = currentActivityNames() || [];
        saveRideOverride(activityId, {
            kept: insertNameInRouteOrder(names, normalized, passage),
            placeCount: Math.max(current.placeCount ?? 0, names.length) + 1,
        });
        refreshActivityName();
        return true;
    }

    // Removing a chip stores the resulting name, not a ban on the clicked
    // place. Every remaining chip stays stable while the count goes down.
    function dropFromThisName(name, index) {
        const activityId = getActivityId();
        const normalized = normalizeListedName(name);
        if (!activityId || !normalized) return false;
        const names = currentActivityNames() || [];
        if (index < 0 || index >= names.length) return false;
        const remaining = names.filter((_, nameIndex) => nameIndex !== index);
        saveRideOverride(activityId, {
            kept: normalizeNameSequence(remaining),
            placeCount: Math.max(minimumNamePlaces(), remaining.length),
        });
        refreshActivityName();
        return true;
    }

    function namingPreferences() {
        return {
            favorites: loadFavorites(),
            blockedNames: loadBlockedNames(),
            ...loadRideOverride(),
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

    // The cache stores passages, not the later selection of passages for a
    // title. Only settings that change landmark discovery belong here.
    const CACHE_RELEVANT_CONFIG = [
        'placeRadiusM',
        'roadMatchRadiusM',
        'overpassMaxRoutePoints',
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
                        'User-Agent': 'Activity-Renamer (https://github.com/rrokot/activity-renamer)',
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
    // panel spell it out.
    const rangeLabel = range => `${range.fromKm.toFixed(2)}–${range.toKm.toFixed(2)} km`;

    // Every continuous stretch of track points within a feature's radius is one
    // visit, anchored at the closest point. Settlements, named roads and
    // Favorites all become visits through this single path.
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
        const roadPassages = passagesNearRoads(track, features.roads);
        const passages = placePassages.concat(roadPassages).sort(byTrackOrder);
        // A route with nothing named beside it is worth asking about again:
        // caching the empty answer would outlive an Overpass mirror that
        // simply had no data to give, or an OSM gap somebody later filled.
        if (passages.length > 0) {
            cacheRoutePassages(
                activityId,
                track,
                passages,
                features.places.length,
                features.roads.length,
            );
        }
        return {
            passages,
            cached: false,
            placeCount: features.places.length,
            roadCount: features.roads.length,
        };
    }

    // Nominatim address fields are used only to suggest a readable default
    // when the user searches for a place of their own. Activity names come from OSM
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

    function automaticPlaceLimit(track, ceiling = CONFIG.autoNamePlaceCeiling) {
        const minimum = Math.max(1, Math.floor(CONFIG.minAutoPlaces));
        const maximum = Math.max(minimum, Math.floor(ceiling));
        const spacingKm = autoPlaceSpacingKm();
        return Math.max(
            minimum,
            Math.min(maximum, Math.round(routeMapExtentKm(track) / spacingKm)),
        );
    }

    const projectPoint = (projection, lat, lon) => ({ x: projection.x(lon), y: projection.y(lat) });

    const planarDistanceKm = (first, second) =>
        Math.hypot(first.x - second.x, first.y - second.y);

    function projectedRunPoint(run, track, projection) {
        return projectPoint(projection, run.lat, run.lon);
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
    // Favorites and manually added places are selected before automatic
    // candidates, but a manual place count remains the final number of parts.
    function compactRouteRuns(allRuns, track, placeCount = null) {
        const isForced = run => Boolean(run.favorite || run.kept);
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
        const forcedIndices = indicesWhere(runs, (run, index) =>
            isForced(run) && !endpointIndices.has(index));
        const namePlaceLimit = placeCount ?? Math.max(
            minimumNamePlaces(),
            Math.floor(CONFIG.autoNamePlaceCeiling),
        );
        let selectedForced = new Set(forcedIndices);
        if (placeCount !== null && endpointIndices.size + selectedForced.size > namePlaceLimit) {
            selectedForced = fillCoverageSelection(
                runs,
                track,
                forcedIndices,
                new Set(),
                Math.max(0, namePlaceLimit - endpointIndices.size),
            );
        }
        const availableAutomaticSlots = Math.max(
            0,
            namePlaceLimit - endpointIndices.size - selectedForced.size,
        );
        // The route-length calculation owns the automatic result only. Once
        // the rider enters a count, every remaining slot is available to the
        // manual target instead of treating that target as another ceiling.
        const automaticLimit = placeCount === null
            ? Math.min(availableAutomaticSlots, Math.max(
                0,
                automaticPlaceLimit(track, namePlaceLimit)
                    - endpointIndices.size
                    - selectedForced.size,
            ))
            : availableAutomaticSlots;
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
                endpointIndices.has(index)
                || selectedForced.has(index)
                || selectedAutomatic.has(index))
            .map(run => ({ ...run }));
    }

    // Every event that may reach the name, in track order: one per passage the
    // user has not blocked, plus the Favorites the passages never covered.
    // `suppressed` collects what the block list took out, for the log.
    function routeEvents(passages, track, preferences, shouldLog) {
        const { favorites, blockedNames, kept: keptNames } = preferences;
        const visits = favoriteVisits(track, favorites);
        const blockedKeys = nameKeys(blockedNames);
        const keptKeys = nameKeys(keptNames);
        const coveredVisits = new Set();
        const suppressed = { blocked: new Set() };
        const events = [];
        // What this ride says wins over what the block list says about every
        // ride: the narrower answer is the one the user gave last.
        const nameState = name => {
            if (hasNameKey(name, keptKeys)) return null;
            return hasNameKey(name, blockedKeys) ? 'blocked' : null;
        };

        for (const passage of passages) {
            const match = closestFavoriteForPassage(passage, track, favorites);
            const name = match?.favorite.name || passage.baseName;
            if (!name) continue;
            const hidden = nameState(name);
            if (hidden) {
                suppressed[hidden].add(name);
                continue;
            }

            if (match) {
                for (const visit of visits) {
                    if (visit.favorite.id === match.favorite.id
                        && trackRangesOverlap(visit, passage)) {
                        coveredVisits.add(visit);
                    }
                }
                if (shouldLog) {
                    log(`Favorite ${rangeLabel(passage)}: ${match.favorite.name}`
                        + ` (${match.distanceM.toFixed(0)} m from favorite address)`);
                }
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
                kept: false,
            });
        }

        for (const visit of visits) {
            if (coveredVisits.has(visit)) continue;
            const hidden = nameState(visit.favorite.name);
            if (hidden) {
                suppressed[hidden].add(visit.favorite.name);
                continue;
            }
            if (shouldLog) {
                log(`Favorite ${rangeLabel(visit)}: ${visit.favorite.name}`
                    + ` (${visit.distanceM.toFixed(0)} m from favorite address; full-track visit)`);
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
                kept: false,
            });
        }

        events.sort((a, b) => a.orderIndex - b.orderIndex);
        let keptIndex = 0;
        for (const event of events) {
            if (keptIndex < keptNames.length
                && event.name.toLocaleLowerCase() === keptNames[keptIndex].toLocaleLowerCase()) {
                event.kept = true;
                keptIndex++;
            }
        }
        return { events, suppressed };
    }

    // Passing the same place twice in a row is one mention; a Favorite or a
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
            last.favorite ||= event.favorite;
            last.kept ||= event.kept;
            if (event.favorite) {
                last.featureKind = 'favorite';
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
        const places = count(run => !run.favorite && run.featureKind === 'place');
        const roads = count(run => !run.favorite && run.featureKind === 'road');
        const favorites = count(run => run.favorite);
        const kept = count(run => run.kept && !run.favorite);
        log(`Map extent ${routeMapExtentKm(track).toFixed(1)} km: `
            + `${places} settlements`
            + (roads ? ` + ${roads} named-road fallbacks` : '')
            + ` + ${favorites} Favorites`
            + (kept ? ` (${kept} kept for this ride)` : ''));
        if (suppressed.blocked.size > 0) {
            log(`Blocked from the name: ${Array.from(suppressed.blocked).join(', ')}`);
        }
        if (compacted.length < runs.length) {
            log(`Name compacted from ${runs.length} to ${compacted.length} places: `
                + compacted.map(run => run.name).join(' - '));
        }
    }

    function activityNamesFromPassages(passages, track, preferences, shouldLog = false) {
        const { events, suppressed } = routeEvents(passages, track, preferences, shouldLog);
        const runs = mergeAdjacentEvents(events);
        const compacted = compactRouteRuns(runs, track, preferences.placeCount);
        if (shouldLog) logRouteSelection(compacted, runs, suppressed, track);
        return compacted.map(run => run.name);
    }

    // Settlement and road visits are already ordered by the closest GPX point.
    // Adjacent duplicates merge immediately; a later revisit remains visible.
    function buildActivityName(passages, track) {
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
            names: activityNamesFromPassages(passages, track, namingPreferences(), true),
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

    // An activity without GPS answers the export with Strava's own HTML page,
    // so a document that is not GPX means "no track" rather than a failure.
    function parseGpxTrack(gpxText) {
        const xml = new DOMParser().parseFromString(gpxText, 'text/xml');
        if (xml.querySelector('parsererror')) return null;

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

    // The compact chevron only reflects whether the inline panel is open.
    function updatePanelToggleButton() {
        const button = document.getElementById(PANEL_TOGGLE_BUTTON_ID);
        if (!button) return;
        const ready = lastRouteAnalysis?.activityId === getActivityId();
        const panelOpen = namePanelState?.activityId === getActivityId() && namePanelState.open;
        button.disabled = false;
        button.setAttribute('aria-expanded', String(panelOpen));
        button.setAttribute('aria-controls', NAME_PANEL_ID);
        if (panelOpen) {
            button.title = 'Hide Activity Renamer';
            button.setAttribute('aria-label', button.title);
            return;
        }
        if (!ready) {
            button.title = 'Open Activity Renamer settings; build the route to edit its landmarks';
            button.setAttribute('aria-label', button.title);
            return;
        }
        button.title = 'Open Activity Renamer';
        button.setAttribute('aria-label', button.title);
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
    function currentActivityNames() {
        if (!lastRouteAnalysis || lastRouteAnalysis.activityId !== getActivityId()) return null;
        return activityNamesFromPassages(
            lastRouteAnalysis.passages,
            lastRouteAnalysis.track,
            namingPreferences(),
        );
    }

    // Every edit rewrites the title in place, so its effect is visible immediately.
    function refreshActivityName() {
        const names = currentActivityNames();
        if (names && setActivityName(names)) log(`Name updated: ${names.join(' - ')}`);
        updatePanelToggleButton();
    }

    function favoriteFromForm(existing, passage, name, radiusText) {
        const trimmedName = collapseWhitespace(name);
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

    function storeFavorite(favorite) {
        const favorites = loadFavorites();
        const index = favorites.findIndex(item => item.id === favorite.id);
        if (index >= 0) {
            favorites[index] = favorite;
        } else {
            favorites.push(favorite);
        }
        storeFavorites(favorites);
        refreshActivityName();
        return true;
    }

    function removeFavorite(favoriteId) {
        storeFavorites(loadFavorites().filter(item => item.id !== favoriteId));
        refreshActivityName();
        return true;
    }

    // Every panel action reports the same way: nothing a click in here can hit
    // is worth losing the page over.
    async function runPanelAction(action) {
        try {
            await action();
        } catch (error) {
            console.error(`${LOG_PREFIX} error:`, error);
            alert(`${LOG_PREFIX} error:\n${errorMessage(error)}`);
        }
    }

    function createElement(tagName, className, properties = {}) {
        const element = document.createElement(tagName);
        element.className = className;
        Object.assign(element, properties);
        return element;
    }

    function createPanelButton(text, primary = false) {
        return createElement(
            'button',
            `activity-renamer-control activity-renamer-panel-button ${primary
                ? `activity-renamer-primary-button ${STRAVA_CLASS.primaryButton}`
                : `activity-renamer-neutral-button ${STRAVA_CLASS.neutralButton}`}`,
            { type: 'button', textContent: text },
        );
    }

    // The Strava class is appended last so a caller that replaces className
    // through the properties still gets the page's own field styling.
    function createPanelInput(properties = {}) {
        const input = createElement(
            'input',
            'activity-renamer-field',
            { type: 'text', ...properties },
        );
        input.className += ` ${STRAVA_CLASS.field}`;
        return input;
    }

    function createFieldLabel(inputId, text) {
        const label = createElement('label', 'activity-renamer-sr-only', { textContent: text });
        label.setAttribute('for', inputId);
        return label;
    }

    function activateOnEnter(input, action) {
        input.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.isComposing) return;
            event.preventDefault();
            action();
        });
    }

    const SECTION_ICON_PATHS = {
        add: ['M12 5v14M5 12h14'],
        places: [
            'M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z',
            'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
        ],
        roads: ['M8 3 6 21M16 3l2 18M12 3v4M12 10v4M12 17v4'],
        favorites: ['m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z'],
        excluded: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM5.6 5.6l12.8 12.8'],
    };

    function createSectionIcon(name) {
        const namespace = 'http://www.w3.org/2000/svg';
        const icon = document.createElementNS(namespace, 'svg');
        icon.setAttribute('class', 'activity-renamer-section-icon');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('focusable', 'false');
        for (const data of SECTION_ICON_PATHS[name] || []) {
            const path = document.createElementNS(namespace, 'path');
            path.setAttribute('d', data);
            icon.append(path);
        }
        return icon;
    }

    // Reuse Strava's own caret component at its native size.
    function createStravaChevron() {
        const wrapper = createElement(
            'span',
            'app-icon-wrapper activity-renamer-chevron',
        );
        wrapper.setAttribute('aria-hidden', 'true');
        wrapper.append(createElement('span', 'app-icon icon-caret-down icon-dark'));
        return wrapper;
    }

    function decorateIconButton(button, icon, label) {
        button.className += ' activity-renamer-icon-button';
        button.replaceChildren(
            createSectionIcon(icon),
            createElement('span', 'activity-renamer-sr-only', { textContent: label }),
        );
        button.title = label;
        button.setAttribute('aria-label', label);
        return button;
    }

    function createIconPanelButton(icon, label, primary = false) {
        return decorateIconButton(createPanelButton(label, primary), icon, label);
    }

    function createPanelNote(text) {
        return createElement('p', 'activity-renamer-note', { textContent: text });
    }

    function appendListContents(panel, items, { empty, row }) {
        if (items.length === 0) {
            panel.append(createPanelNote(empty));
            return;
        }
        for (const item of items) row(item);
    }

    function appendPanelRow(container, title, details, actions) {
        const row = createElement('div', 'activity-renamer-row');
        const text = createElement('div', 'activity-renamer-row-text');
        text.append(
            createElement('div', 'activity-renamer-row-title', { textContent: title }),
            createElement('div', 'activity-renamer-row-details', { textContent: details }),
        );

        const controls = createElement('div', 'activity-renamer-row-actions');
        controls.append(...actions);
        row.append(text, controls);
        container.append(row);
    }

    // The name and radius of a Favorite are edited in context, under the item
    // that opened the editor.
    function appendPlaceEditor(panel, state, render) {
        const editing = state.editing;
        if (!editing) return;
        const target = editing.existing || editing.passage;
        const section = createElement('div', 'activity-renamer-editor');
        const title = createElement('h4', '', {
            textContent: editing.existing ? 'Rename this place' : 'Name this place',
        });

        const nameInput = createPanelInput({
            id: 'activity-renamer-place-name-input',
            value: state.editing.name,
            placeholder: 'Name to use in the title',
            maxLength: CONFIG.maxPlaceNameLength,
        });
        nameInput.setAttribute('aria-describedby', 'activity-renamer-place-status');
        nameInput.addEventListener('input', () => {
            state.editing.name = nameInput.value;
        });

        const radiusInput = createPanelInput({
            id: 'activity-renamer-place-radius-input',
            className: 'activity-renamer-field activity-renamer-field--narrow',
            value: state.editing.radiusM,
            placeholder: `Radius ${CONFIG.favoriteRadiusMinM}–${CONFIG.favoriteRadiusMaxM} m`,
        });
        radiusInput.setAttribute('aria-describedby', 'activity-renamer-place-status');
        radiusInput.addEventListener('input', () => {
            state.editing.radiusM = radiusInput.value;
        });

        const saveButton = createPanelButton('Save', true);
        const cancelButton = createPanelButton('Cancel');
        cancelButton.addEventListener('click', () => {
            state.editing = null;
            render();
        });

        const controls = createElement('div', 'activity-renamer-form');
        controls.append(
            createFieldLabel(nameInput.id, 'Place name'),
            nameInput,
            createFieldLabel(radiusInput.id, 'Matching radius in metres'),
            radiusInput,
            saveButton,
            cancelButton,
        );
        const save = () => {
            try {
                storeFavorite(favoriteFromForm(
                    editing.existing,
                    editing.passage,
                    state.editing.name,
                    state.editing.radiusM,
                ));
                state.editing = null;
                render();
            } catch (error) {
                state.editing.error = errorMessage(error);
                render('activity-renamer-place-name-input');
            }
        };
        saveButton.addEventListener('click', save);
        activateOnEnter(nameInput, save);
        activateOnEnter(radiusInput, save);

        const status = createStatusLine(
            state.editing.error
                || `Applies whenever the route comes within the radius of ${
                    target?.address || target?.baseName || 'this place'}.`,
            Boolean(state.editing.error),
        );
        status.id = 'activity-renamer-place-status';

        section.append(title, controls, status);
        panel.append(section);
    }

    // Every section reports itself the same way: one polite live region that
    // turns red when what it says is a problem.
    function createStatusLine(text, isError = false) {
        const status = createElement(
            'div',
            `activity-renamer-status${isError ? ' activity-renamer-status--error' : ''}`,
            { textContent: text },
        );
        status.setAttribute('aria-live', 'polite');
        return status;
    }

    // The search reports itself through the same state the panel renders from,
    // so a failure reads as a line under the field where it can be corrected.
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
        const note = createPanelNote('Add a place by address:');
        const controls = createElement('div', 'activity-renamer-form');

        const input = createPanelInput({
            id: 'activity-renamer-address-input',
            value: state.search.query,
            placeholder: 'Street, house number, city',
            autocomplete: 'street-address',
            maxLength: 200,
        });
        input.setAttribute('aria-describedby', 'activity-renamer-address-status');
        input.addEventListener('input', () => {
            state.search.query = input.value;
        });

        const searchButton = createPanelButton('Find', true);
        searchButton.disabled = state.search.busy;
        input.disabled = state.search.busy;
        controls.append(createFieldLabel(input.id, 'Address'), input, searchButton);

        const status = createStatusLine(state.search.status, state.search.error);
        status.id = 'activity-renamer-address-status';
        const results = document.createElement('div');
        for (const candidate of state.search.candidates) {
            const addButton = createPanelButton('☆ Save', true);
            addButton.addEventListener('click', () =>
                openPlaceEditor(state, render, { passage: candidate, anchor: candidate }));
            appendPanelRow(results, candidate.baseName, candidate.address, [addButton]);
            appendEditorAt(results, state, render, candidate);
        }

        const search = () => {
            void runPanelAction(() => runAddressSearch(state, render));
        };
        searchButton.addEventListener('click', search);
        activateOnEnter(input, search);

        const attribution = createElement('div', 'activity-renamer-attribution');
        attribution.append('Search by Nominatim · © ');
        const attributionLink = document.createElement('a');
        attributionLink.href = 'https://www.openstreetmap.org/copyright';
        attributionLink.target = '_blank';
        attributionLink.rel = 'noopener noreferrer';
        attributionLink.textContent = 'OpenStreetMap contributors';
        attribution.append(attributionLink);

        panel.append(note, controls, status, results, attribution);
    }

    const COLLECTION_TAB_IDS = ['places', 'roads', 'favorites', 'excluded'];

    function appendCollectionTab(panel, state, render, tablist, {
        id, label, icon, appendContents,
    }) {
        const selected = state.activeCollection === id;
        const tab = createPanelButton(label);
        tab.id = `activity-renamer-${id}-tab`;
        tab.className = 'activity-renamer-section-tab';
        decorateIconButton(tab, icon, label);
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(selected));
        tab.setAttribute('aria-controls', `activity-renamer-${id}`);
        tab.tabIndex = selected ? 0 : -1;
        tab.addEventListener('click', () => {
            if (state.activeCollection === id) return;
            state.activeCollection = id;
            render(tab.id);
        });
        tab.addEventListener('keydown', event => {
            const currentIndex = COLLECTION_TAB_IDS.indexOf(id);
            const nextIndex = event.key === 'ArrowRight'
                ? (currentIndex + 1) % COLLECTION_TAB_IDS.length
                : event.key === 'ArrowLeft'
                    ? (currentIndex - 1 + COLLECTION_TAB_IDS.length) % COLLECTION_TAB_IDS.length
                    : event.key === 'Home' ? 0
                        : event.key === 'End' ? COLLECTION_TAB_IDS.length - 1
                            : -1;
            if (nextIndex < 0) return;
            event.preventDefault();
            state.activeCollection = COLLECTION_TAB_IDS[nextIndex];
            render(`activity-renamer-${state.activeCollection}-tab`);
        });
        tablist.append(tab);
        if (!selected) return;

        const container = createElement('div', '', { id: `activity-renamer-${id}` });
        container.setAttribute('role', 'tabpanel');
        container.setAttribute('aria-labelledby', tab.id);
        state.refreshCollection = () => {
            container.replaceChildren();
            appendContents(container, state, render);
        };
        state.refreshCollection();
        panel.append(container);
    }

    function appendFavorites(panel, state, render, tablist) {
        appendCollectionTab(panel, state, render, tablist, {
            id: 'favorites',
            label: 'Favorites',
            icon: 'favorites',
            appendContents: appendFavoriteContents,
        });
    }

    function appendExcluded(panel, state, render, tablist) {
        appendCollectionTab(panel, state, render, tablist, {
            id: 'excluded',
            label: 'Excluded',
            icon: 'excluded',
            appendContents: appendBlockedNameContents,
        });
    }

    // The four collections form one tab set, so exactly one is always visible.
    function appendCollectionSections(panel, state, render) {
        const tablist = createElement('div', 'activity-renamer-section-tabs');
        tablist.setAttribute('role', 'tablist');
        tablist.setAttribute('aria-label', 'Landmark collections');
        panel.append(tablist);
        appendOtherPlaces(panel, state, render, tablist);
        appendOtherRoads(panel, state, render, tablist);
        appendFavorites(panel, state, render, tablist);
        appendExcluded(panel, state, render, tablist);
    }

    const PANEL_SECTIONS = [appendThisName, appendCollectionSections];

    function panelFocusableElements(panel) {
        return Array.from(panel.querySelectorAll('button, input, textarea, select, a'))
            .filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true');
    }

    function capturePanelFocus(panel) {
        const element = document.activeElement;
        if (!element || !panel.contains(element)) return null;
        return {
            id: element.id,
            tagName: element.tagName,
            text: element.textContent,
            title: element.title || '',
        };
    }

    function restorePanelFocus(panel, snapshot, preferredId) {
        if (!snapshot && !preferredId) return;
        let target = preferredId ? panel.querySelector(`#${preferredId}`) : null;
        if (!target && snapshot?.id) target = panel.querySelector(`#${snapshot.id}`);
        if (!target && snapshot) {
            target = panelFocusableElements(panel).find(element =>
                element.tagName === snapshot.tagName
                && element.textContent === snapshot.text
                && (element.title || '') === snapshot.title);
        }
        if (target?.disabled) target = null;
        target?.focus();
    }

    function createNamePanelState() {
        return {
            activityId: getActivityId(),
            open: false,
            view: null,
            editing: null,
            confirmingDeleteId: null,
            activeCollection: 'places',
            refreshCollection: null,
            countError: '',
            densityError: '',
            search: { query: '', candidates: [], status: '', error: false, busy: false },
        };
    }

    function currentNamePanelState() {
        const activityId = getActivityId();
        if (!namePanelState || namePanelState.activityId !== activityId) {
            document.getElementById(NAME_PANEL_ID)?.remove();
            namePanelState = createNamePanelState();
        }
        return namePanelState;
    }

    function ensureNamePanelRoot() {
        const existing = document.getElementById(NAME_PANEL_ID);
        if (existing) return existing;

        const nameInput = document.querySelector('input[name="activity[name]"]');
        if (!nameInput?.parentNode) return null;

        const panel = createElement('section', 'activity-renamer-panel', {
            id: NAME_PANEL_ID,
        });
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'Activity Renamer');
        nameInput.parentNode.insertBefore(panel, nameInput.nextSibling);
        return panel;
    }

    // Every action mutates one persistent state object. If Strava rebuilds its
    // edit form, the root is mounted again without losing an address query or
    // an in-progress place edit.
    function renderNamePanel(preferredFocusId = null) {
        const state = currentNamePanelState();
        if (!state.open) return;
        const panel = ensureNamePanelRoot();
        if (!panel) return;

        const focusSnapshot = capturePanelFocus(panel);
        state.view = currentRouteView();
        state.refreshCollection = null;
        panel.replaceChildren();
        for (const section of PANEL_SECTIONS) section(panel, state, renderNamePanel);
        panel.setAttribute('aria-busy', String(nameBuildBusy));
        if (nameBuildBusy) {
            for (const control of panel.querySelectorAll('button, input')) control.disabled = true;
        }
        restorePanelFocus(panel, focusSnapshot, preferredFocusId);
    }

    function toggleNamePanel() {
        const state = currentNamePanelState();
        state.open = !state.open;
        if (state.open) renderNamePanel();
        else document.getElementById(NAME_PANEL_ID)?.remove();
        updatePanelToggleButton();
    }

    // What the panel is looking at: the ride analyzed for this page, the name
    // it currently produces, and the landmark behind every part of that name.
    function currentRouteView() {
        const analysis = lastRouteAnalysis?.activityId === getActivityId() ? lastRouteAnalysis : null;
        if (!analysis) return null;

        const favorites = loadFavorites();
        const landmarks = analysis.passages.map(passage => {
            const match = closestFavoriteForPassage(passage, analysis.track, favorites);
            return { passage, match, name: match?.favorite.name || passage.baseName };
        });
        const byName = new Map();
        for (const landmark of landmarks) {
            if (landmark.name && !byName.has(landmark.name)) byName.set(landmark.name, landmark);
        }
        return { names: currentActivityNames() || [], landmarks, byName, favorites };
    }

    // One place builds the editor state, so a chip, a landmark, a Favorite
    // and a search result all open the same form — under whatever was clicked.
    function openPlaceEditor(state, render, { existing = null, passage = null, anchor }) {
        state.editing = {
            existing,
            passage,
            anchor,
            name: existing?.name || passage?.baseName || '',
            radiusM: String(existing?.radiusM ?? CONFIG.favoriteRadiusM),
            error: '',
        };
        state.confirmingDeleteId = null;
        render('activity-renamer-place-name-input');
    }

    function appendEditorAt(container, state, render, anchor) {
        const editing = state.editing;
        const isSameFavorite = editing?.existing?.id && editing.existing.id === anchor?.id;
        if (editing?.anchor === anchor || isSameFavorite) {
            appendPlaceEditor(container, state, render);
        }
    }

    const NAME_ANCHOR = 'name';

    // The name as the sentence it is: one chip per part, in the order they are
    // written. The chip's own label renames the place, the ✕ takes it out of
    // this ride.
    function appendThisName(panel, state, render) {
        const view = state.view;
        if (!view) {
            panel.append(createPanelNote('Build the name first, then edit route landmarks here.'));
            return;
        }

        if (view.names.length === 0) {
            appendNamePlaceCount(panel, state, render);
            panel.append(createPanelNote('Nothing is in the name. Add a landmark below.'));
        } else {
            const chips = createElement('div', 'activity-renamer-chips');
            const updateChips = () => {
                const currentView = currentRouteView();
                if (!currentView) return;
                state.view = currentView;
                chips.replaceChildren(...currentView.names.map((name, index, names) =>
                    createNameChip(name, index, names.length, currentView, state, render)));
                state.refreshCollection?.();
            };
            updateChips();
            appendNamePlaceCount(panel, state, render, updateChips);
            panel.append(chips);
        }

        appendEditorAt(panel, state, render, NAME_ANCHOR);
    }

    function appendNamePlaceCount(panel, state, render, updateChips = () => {}) {
        if (!state.view) return;
        const inputId = 'activity-renamer-name-place-count';
        const sliderId = 'activity-renamer-name-place-count-slider';
        const noteId = 'activity-renamer-name-place-count-note';
        const minimum = minimumNamePlaces();
        const sliderMaximum = Math.max(minimum, Math.floor(CONFIG.namePlaceSliderMax));
        const section = createElement('div', 'activity-renamer-name-count');
        const controls = createElement('div', 'activity-renamer-name-count-controls');
        const sliderLabel = createFieldLabel(sliderId, 'Places in name');
        const slider = createPanelInput({
            id: sliderId,
            type: 'range',
            min: String(minimum),
            max: String(sliderMaximum),
            step: '1',
            value: String(Math.min(sliderMaximum, Math.max(minimum, state.view.names.length))),
        });
        slider.className = 'activity-renamer-name-count-slider';
        const syncSliderProgress = () => {
            const progress = (Number(slider.value) - minimum)
                / Math.max(1, sliderMaximum - minimum) * 100;
            slider.style.setProperty(
                '--activity-renamer-slider-progress',
                `${Math.max(0, Math.min(100, progress))}%`,
            );
        };
        syncSliderProgress();
        const inputLabel = createFieldLabel(inputId, 'Places in name');
        const input = createPanelInput({
            id: inputId,
            type: 'number',
            min: String(minimum),
            step: '1',
            inputMode: 'numeric',
            value: String(state.view.names.length),
        });
        input.className += ' activity-renamer-mode-field';
        if (state.countError) input.setAttribute('aria-describedby', noteId);

        const densityId = 'activity-renamer-auto-place-spacing';
        const densityNoteId = 'activity-renamer-auto-place-spacing-note';
        const densityExplanation = 'Automatic density, saved for every activity: '
            + `map span divided by this value, rounded to ${
                CONFIG.minAutoPlaces}–${CONFIG.autoNamePlaceCeiling} places.`;
        const densityLabel = createFieldLabel(
            densityId,
            'Kilometres of map span per automatic place',
        );
        const densityInput = createPanelInput({
            id: densityId,
            type: 'number',
            min: String(CONFIG.autoPlaceSpacingMinKm),
            step: '0.1',
            inputMode: 'decimal',
            value: String(autoPlaceSpacingKm()),
            title: densityExplanation,
        });
        densityInput.className += ' activity-renamer-mode-field';
        if (state.densityError) densityInput.setAttribute('aria-describedby', densityNoteId);

        const syncMode = automatic => {
            input.dataset.modeActive = String(!automatic);
            densityInput.dataset.modeActive = String(automatic);
            input.title = automatic
                ? 'Manual place count for this activity. Change it to switch to manual mode.'
                : 'Manual place count for this activity — active.';
            input.setAttribute(
                'aria-label',
                `Manual place count for this activity${automatic ? '' : ', active mode'}`,
            );
            densityInput.title = `${densityExplanation} ${automatic
                ? 'Automatic mode is active.'
                : 'Change it to switch to automatic mode.'}`;
            densityInput.setAttribute(
                'aria-label',
                `${densityLabel.textContent}${automatic ? ', active mode' : ''}`,
            );
        };
        syncMode(loadRideOverride().placeCount === null);

        const applyValue = (rawValue, { allowReset, reportInvalid }) => {
            const activityId = getActivityId();
            const current = loadRideOverride(activityId);
            if (rawValue.trim() === '') {
                if (!allowReset) return;
                saveRideOverride(activityId, { ...current, placeCount: null });
                state.countError = '';
                syncMode(true);
                refreshActivityName();
                render(inputId);
                return;
            }
            const value = Number(rawValue);
            if (!Number.isInteger(value) || value < minimum) {
                if (reportInvalid) {
                    state.countError = `Enter a whole number of ${minimum} or more.`;
                    render(inputId);
                }
                return;
            }
            saveRideOverride(activityId, { ...current, placeCount: value });
            state.countError = '';
            syncMode(false);
            refreshActivityName();
            updateChips();
        };
        const applyDensity = (rawValue, reportInvalid) => {
            const value = normalizeAutoPlaceSpacingKm(rawValue);
            if (value === null) {
                if (reportInvalid) {
                    state.densityError = `Enter a number of ${
                        CONFIG.autoPlaceSpacingMinKm} or more.`;
                    render(densityId);
                }
                return;
            }

            writeSetting(STORAGE_KEY.autoPlaceSpacingKm, value);
            const activityId = getActivityId();
            if (activityId) {
                const current = loadRideOverride(activityId);
                saveRideOverride(activityId, { ...current, placeCount: null });
            }
            state.countError = '';
            state.densityError = '';
            syncMode(true);
            refreshActivityName();

            const names = currentActivityNames();
            if (!names) return;
            input.value = String(names.length);
            slider.value = String(Math.min(sliderMaximum, Math.max(minimum, names.length)));
            syncSliderProgress();
            updateChips();
        };
        slider.addEventListener('input', () => {
            syncSliderProgress();
            input.value = slider.value;
            applyValue(slider.value, {
                allowReset: false,
                reportInvalid: false,
            });
        });
        input.addEventListener('input', () => {
            const value = Number(input.value);
            if (Number.isInteger(value) && value >= minimum) {
                slider.value = String(Math.min(sliderMaximum, value));
                syncSliderProgress();
            }
            applyValue(input.value, {
                allowReset: false,
                reportInvalid: false,
            });
        });
        input.addEventListener('change', () => {
            applyValue(input.value, {
                allowReset: true,
                reportInvalid: true,
            });
            if (!state.countError && input.value.trim() !== '') render(inputId);
        });
        densityInput.addEventListener('input', () => {
            applyDensity(densityInput.value, false);
        });
        densityInput.addEventListener('change', () => {
            applyDensity(densityInput.value, true);
        });
        activateOnEnter(densityInput, () => applyDensity(densityInput.value, true));

        controls.append(sliderLabel, slider, inputLabel, input, densityLabel, densityInput);
        section.append(controls);
        if (state.countError) {
            const note = createPanelNote(state.countError);
            note.className = 'activity-renamer-note activity-renamer-status--error';
            note.id = noteId;
            section.append(note);
        }
        if (state.densityError) {
            const note = createPanelNote(state.densityError);
            note.className = 'activity-renamer-note activity-renamer-status--error';
            note.id = densityNoteId;
            section.append(note);
        }
        panel.append(section);
    }

    function createNameChip(name, index, nameCount, view, state, render) {
        const chip = createElement('div', 'activity-renamer-chip');
        const landmark = view.byName.get(name);
        // A Favorite can reach the name through a full-track visit that no
        // passage covers, so the chip falls back to matching it by name.
        const favorite = landmark?.match?.favorite
            || view.favorites.find(item => item.name === name)
            || null;

        const renameButton = createElement('button', 'activity-renamer-chip-name', {
            type: 'button',
            textContent: name,
            title: favorite || landmark
                ? `Rename ${name} wherever a route comes near it`
                : `${name} has no place to rename`,
        });
        renameButton.disabled = !favorite && !landmark;
        renameButton.addEventListener('click', () => openPlaceEditor(state, render, {
            existing: favorite,
            passage: landmark?.passage || null,
            anchor: NAME_ANCHOR,
        }));

        const dropButton = createElement('button', 'activity-renamer-chip-drop', {
            type: 'button',
            textContent: '✕',
            title: `Take ${name} out of this ride’s name`,
        });
        if (nameCount <= minimumNamePlaces()) {
            dropButton.disabled = true;
            dropButton.title = `A name needs at least ${minimumNamePlaces()} places`;
        }
        dropButton.addEventListener('click', () => runPanelAction(() => {
            dropFromThisName(name, index);
            render();
        }));

        chip.append(renameButton, dropButton);
        return chip;
    }

    // Settlements the route came near but the name does not mention: those the
    // automatic selection had no slot for and those the block list silences
    // everywhere.
    function appendOtherPlaceContents(panel, state, render) {
        const view = state.view;
        const inName = new Set(view?.names || []);
        const blocked = nameKeys(loadBlockedNames());
        const places = (view?.landmarks || []).filter(landmark =>
            landmark.passage.featureKind !== 'road'
            && landmark.name
            && !inName.has(landmark.name));
        appendListContents(panel, places, {
            empty: view
                ? 'Every settlement of this route is in the name.'
                : 'Build the name to load nearby places.',
            row: landmark => {
                appendLandmarkRow(panel, landmark, blocked, state, render);
                appendEditorAt(panel, state, render, landmark.passage);
            },
        });
    }

    function appendOtherPlaces(panel, state, render, tablist) {
        appendCollectionTab(panel, state, render, tablist, {
            id: 'places',
            label: 'Other places',
            icon: 'places',
            appendContents: appendOtherPlaceContents,
        });
    }

    function uniqueLandmarksByName(landmarks) {
        const byName = new Map();
        for (const landmark of landmarks) {
            if (landmark.name && !byName.has(landmark.name)) {
                byName.set(landmark.name, landmark);
            }
        }
        return Array.from(byName.values());
    }

    function appendOtherRoadContents(panel, state, render) {
        const view = state.view;
        const inName = new Set(view?.names || []);
        const roads = uniqueLandmarksByName((view?.landmarks || []).filter(landmark =>
            landmark.passage.featureKind === 'road' && !inName.has(landmark.name)));
        if (roads.length === 0) {
            panel.append(createPanelNote(view
                ? 'No other named roads were passed.'
                : 'Build the name to load nearby roads.'));
            return;
        }
        const blocked = nameKeys(loadBlockedNames());
        for (const road of roads) {
            appendLandmarkRow(panel, road, blocked, state, render);
            appendEditorAt(panel, state, render, road.passage);
        }
    }

    function appendOtherRoads(panel, state, render, tablist) {
        appendCollectionTab(panel, state, render, tablist, {
            id: 'roads',
            label: 'Other roads',
            icon: 'roads',
            appendContents: appendOtherRoadContents,
        });
    }

    function appendLandmarkRow(panel, landmark, blockedNames, state, render) {
        const { passage, match, name } = landmark;

        const addButton = createIconPanelButton(
            'add',
            `Add ${name} to this activity name`,
            true,
        );
        addButton.addEventListener('click', () => runPanelAction(() => {
            keepInThisName(name, passage);
            render();
        }));

        const favoriteLabel = match
            ? `Edit Favorite ${match.favorite.name}`
            : `Save a preferred name for ${name}`;
        const renameButton = createIconPanelButton('favorites', favoriteLabel);
        renameButton.addEventListener('click', () => openPlaceEditor(state, render, {
            existing: match?.favorite || null,
            passage,
            anchor: passage,
        }));

        const isBlocked = hasNameKey(name, blockedNames);
        const blockLabel = isBlocked
            ? `Allow ${name} in generated names again`
            : `Exclude ${name} from every activity name`;
        const blockButton = createIconPanelButton('excluded', blockLabel);
        blockButton.setAttribute('aria-pressed', String(isBlocked));
        blockButton.addEventListener('click', () => runPanelAction(() => {
            toggleBlockedName(name);
            render();
        }));

        const reason = isBlocked ? 'Excluded' : null;
        const sourceDetails = name === passage.baseName
            ? passage.featureKind === 'road' ? passage.roadType : passage.placeType
            : passage.address;
        const details = [reason, rangeLabel(passage), sourceDetails]
            .filter(Boolean)
            .join(' · ');
        appendPanelRow(panel, name, details, [addButton, renameButton, blockButton]);
    }

    // A Favorite replaces the OSM name on every ride that comes near it.
    function appendFavoriteContents(panel, state, render) {
        appendListContents(panel, loadFavorites(), {
            empty: 'No favorites yet. Rename a place above, or add one by address.',
            row: favorite => {
                const editButton = createPanelButton('Edit');
                editButton.addEventListener('click', () =>
                    openPlaceEditor(state, render, { existing: favorite, anchor: favorite }));

                const confirming = state.confirmingDeleteId === favorite.id;
                const deleteButton = createPanelButton(confirming ? 'Confirm delete' : 'Delete');
                deleteButton.addEventListener('click', () => runPanelAction(() => {
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
                appendPanelRow(
                    panel,
                    favorite.name,
                    `${favorite.address || coordinates} · ${favorite.radiusM} m`,
                    [editButton, deleteButton],
                );
                appendEditorAt(panel, state, render, favorite);
            },
        });
        appendAddressSearch(panel, state, render);
    }

    function appendBlockedNameContents(panel, state, render) {
        appendListContents(panel, loadBlockedNames(), {
            empty: 'Nothing is excluded. Use the exclude action on a place to hide it from every name.',
            row: name => {
                const removeButton = createPanelButton('Unblock');
                removeButton.addEventListener('click', () => runPanelAction(() => {
                    toggleBlockedName(name);
                    render();
                }));
                appendPanelRow(panel, name, 'Left out of every name', [removeButton]);
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

        currentNamePanelState().open = true;
        button.disabled = true;
        nameBuildBusy = true;
        updatePanelToggleButton();
        renderNamePanel();
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

            const activityName = buildActivityName(routeFeatures.passages, track);
            // Remote country and gaps in OpenStreetMap both end here. Neither is
            // a fault of the run, so the rider is told rather than alarmed.
            if (activityName.names.length === 0) {
                alert(STRINGS.noPlaces);
                return;
            }
            lastRouteAnalysis = { activityId, track, passages: activityName.passages };

            // Logged after the fact: an over-long narrative reaches the field
            // shortened, and the log should show what was actually written.
            setActivityName(activityName.names);
            renderNamePanel();
            log(`Name: ${fitNameLength(activityName.names)}`);
            setButtonState(button, STRINGS.done, 'success');
            await sleep(CONFIG.successStateMs);
        } catch (error) {
            console.error(LOG_PREFIX, error);
            alert(`Error:\n${errorMessage(error)}`);
            setButtonState(button, STRINGS.error, 'error');
            await sleep(CONFIG.errorStateMs);
        } finally {
            nameBuildBusy = false;
            button.disabled = false;
            setButtonState(button, STRINGS.idle);
            updatePanelToggleButton();
            renderNamePanel();
        }
    }

    // The editor offers a polyline style only where a route was recorded, which
    // makes this field the page's one answer to "is there a track to name". The
    // map container and the map image say the same, but through styling rather
    // than through the form, so they are not read.
    const ROUTE_MARKER_SELECTOR = 'select[name="activity[selected_polyline_style]"]';
    const SPORT_TYPE_SELECTOR = 'select[name="activity[sport_type]"]';

    function pageShowsRoute() {
        return Boolean(document.querySelector(ROUTE_MARKER_SELECTOR));
    }

    function pageSportType() {
        return document.querySelector(SPORT_TYPE_SELECTOR)?.value || '';
    }

    // Silence is the intended outcome on a page the script leaves alone, but it
    // is also what a redesigned editor would produce, and only the log tells the
    // two apart afterwards. Once per page is enough: the observers keep asking.
    let skipLogged = false;

    function skipPage(reason) {
        if (!skipLogged) log(`No controls added: ${reason}`);
        skipLogged = true;
        return false;
    }

    function injectButton() {
        if (document.getElementById(BUTTON_ID)) {
            if (namePanelState?.open && !document.getElementById(NAME_PANEL_ID)) renderNamePanel();
            return true;
        }

        const titleLabel = document.querySelector('label[for="activity_name"]');
        if (!titleLabel?.parentNode) return false;
        // A virtual ride records a real track through a world OpenStreetMap
        // does not describe, so its route is no basis for a name either.
        const sportType = pageSportType();
        if (sportType.startsWith('Virtual')) {
            return skipPage(`${sportType} happens in a virtual world`);
        }
        if (!pageShowsRoute()) {
            return skipPage('this activity has no recorded route'
                + ' (if it does, the Strava editor markup has changed)');
        }

        installStyles();

        const button = createElement(
            'button',
            `activity-renamer-control activity-renamer-button activity-renamer-primary-button ${
                STRAVA_CLASS.primaryButton}`,
            {
                id: BUTTON_ID,
                type: 'button',
                title: 'Generate name from GPS track',
            },
        );
        setButtonState(button, STRINGS.idle);
        button.addEventListener('click', event => {
            event.preventDefault();
            void generateAndFillName(button);
        });

        const panelToggleButton = createElement(
            'button',
            'activity-renamer-control activity-renamer-button activity-renamer-neutral-button'
                + ` activity-renamer-button--toggle ${STRAVA_CLASS.neutralButton}`,
            { id: PANEL_TOGGLE_BUTTON_ID, type: 'button' },
        );
        panelToggleButton.append(createStravaChevron());
        panelToggleButton.addEventListener('click', event => {
            event.preventDefault();
            toggleNamePanel();
        });

        const wrapper = createElement('div', 'activity-renamer-controls');
        titleLabel.parentNode.insertBefore(wrapper, titleLabel);
        wrapper.append(titleLabel, button, panelToggleButton);
        updatePanelToggleButton();
        if (namePanelState?.open) renderNamePanel();
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
            if (document.getElementById(BUTTON_ID)) {
                if (namePanelState?.open && !document.getElementById(NAME_PANEL_ID)) renderNamePanel();
                return;
            }
            closeObserver.disconnect();
            if (!injectButton()) watchForEditForm();
            else watchInjectedButton();
        });
        closeObserver.observe(container, { childList: true, subtree: true });
    }

    await loadSettings();
    if (injectButton()) watchInjectedButton();
    else watchForEditForm();
})();
