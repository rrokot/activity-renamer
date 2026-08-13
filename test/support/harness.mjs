// Loads strava-route-renamer.user.js into a sandboxed VM with a stubbed
// browser, so the naming pipeline can be exercised end to end (click the
// button, read the filled-in activity name) without a browser, a Strava login
// or network access.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
    FakeDOMParser,
    FakeMutationObserver,
    createEditPageDocument,
    createLocalStorage,
} from './dom.mjs';

const testDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const projectDir = dirname(testDir);
export const fixturesDir = join(testDir, 'fixtures');
// USERSCRIPT_PATH lets a benchmark run the same scenario against another
// revision of the script.
const userscriptPath = process.env.USERSCRIPT_PATH
    || join(projectDir, 'strava-route-renamer.user.js');

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Waypoints describe the shape of a ride; the recorder fills in the rest.
export function densifyTrack(waypoints, stepM = 20) {
    const points = [];
    for (let i = 1; i < waypoints.length; i++) {
        const [fromLat, fromLon] = waypoints[i - 1];
        const [toLat, toLon] = waypoints[i];
        const legM = haversineKm(fromLat, fromLon, toLat, toLon) * 1000;
        const steps = Math.max(1, Math.round(legM / stepM));
        for (let step = 0; step < steps; step++) {
            const ratio = step / steps;
            points.push([
                fromLat + (toLat - fromLat) * ratio,
                fromLon + (toLon - fromLon) * ratio,
            ]);
        }
    }
    points.push(waypoints[waypoints.length - 1]);
    return points;
}

export function toGpx(points) {
    const trkpts = points
        .map(([lat, lon]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`)
        .join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<gpx version="1.1" creator="test-harness">\n  <trk>\n    <trkseg>\n'
        + `${trkpts}\n`
        + '    </trkseg>\n  </trk>\n</gpx>\n';
}

// Fixtures describe OSM data in a readable shape; Overpass elements are
// generated from it so fixtures stay diffable.
export function overpassElements(fixture) {
    const elements = [];
    for (const place of fixture.places || []) {
        elements.push({
            type: 'node',
            id: place.id,
            lat: place.lat,
            lon: place.lon,
            tags: { place: place.place, name: place.name, ...(place.tags || {}) },
        });
    }
    for (const road of fixture.roads || []) {
        elements.push({
            type: 'way',
            id: road.id,
            tags: { highway: road.highway, name: road.name, ...(road.tags || {}) },
            geometry: densifyTrack(road.geometry, road.stepM || 40)
                .map(([lat, lon]) => ({ lat, lon })),
        });
    }
    return elements;
}

export function loadFixture(name) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'));
    const points = fixture.gpxFile
        ? parseGpxPoints(readFileSync(join(fixturesDir, fixture.gpxFile), 'utf8'))
        : densifyTrack(fixture.waypoints, fixture.stepM);
    return { ...fixture, points };
}

export function parseGpxPoints(gpxText) {
    return Array.from(gpxText.matchAll(/<trkpt\b[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"/gi))
        .map(match => [Number(match[1]), Number(match[2])]);
}

class HttpError extends Error {}

function jsonResponse(body, status = 200, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        rawHeaders: headers,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function textResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => JSON.parse(body),
        text: async () => body,
    };
}

export { jsonResponse, textResponse, HttpError };

/**
 * Boots the userscript against a stubbed Strava edit page.
 *
 * @param {object} options
 * @param {string} [options.activityId] activity id in the page URL
 * @param {string} [options.gpx] GPX body served for the export request
 * @param {Array}  [options.overpassResponses] queued Overpass replies (last one repeats)
 * @param {Array}  [options.nominatimResponses] queued Nominatim replies (last one repeats)
 * @param {object} [options.storage] initial localStorage contents
 * @param {Function} [options.prompt] window.prompt stub
 * @param {Function} [options.confirm] window.confirm stub
 */
export function loadRenamer(options = {}) {
    const {
        activityId = '19000955530',
        gpx = toGpx([[51.75, 14.33], [51.76, 14.34]]),
        overpassResponses = [jsonResponse({ elements: [] })],
        nominatimResponses = [jsonResponse([])],
        storage = {},
    } = options;

    // Modal prompts block the page and cannot show what is being edited; the
    // dialog does all of that inline now, so reaching for one is a bug.
    const refuseModal = name => () => {
        throw new Error(`window.${name} must not be used`);
    };

    const logs = [];
    const warnings = [];
    const errors = [];
    const alerts = [];
    const requests = [];
    const timerDelays = [];
    let pendingTimers = 0;
    let inFlightRequests = 0;

    const overpassQueue = overpassResponses.slice();
    const nominatimQueue = nominatimResponses.slice();
    const nextFrom = queue => (queue.length > 1 ? queue.shift() : queue[0]);

    const localStorage = createLocalStorage(storage);
    const userscriptStore = new Map(Object.entries(options.userscriptStorage || {}));
    const clipboard = [];
    const { document, input, label } = createEditPageDocument();
    if (options.constructedStylesheets) document.adoptedStyleSheets = [];

    const respond = async (url, init, transport) => {
        requests.push({ url, init, transport });
        if (url.includes('/export_gpx')) {
            if (gpx === null) return textResponse('Not found', 404);
            return textResponse(gpx);
        }
        if (url.includes('overpass')) {
            const response = nextFrom(overpassQueue);
            if (response instanceof Error) throw response;
            return typeof response === 'function' ? response(init) : response;
        }
        if (url.includes('nominatim')) {
            const response = nextFrom(nominatimQueue);
            if (response instanceof Error) throw response;
            return typeof response === 'function' ? response(init) : response;
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const sandbox = {
        console: {
            log: (...args) => logs.push(args.join(' ')),
            warn: (...args) => warnings.push(args.join(' ')),
            error: (...args) => errors.push(args.map(String).join(' ')),
        },
        // Timers fire immediately: retry backoff and success-state delays must
        // not slow the suite down, but their durations stay observable.
        setTimeout: (handler, delay = 0) => {
            timerDelays.push(delay);
            pendingTimers++;
            return setTimeout(() => {
                pendingTimers--;
                handler();
            }, 0);
        },
        clearTimeout: handle => clearTimeout(handle),
        fetch: (url, init) => {
            inFlightRequests++;
            return respond(String(url), init, 'fetch').finally(() => {
                inFlightRequests--;
            });
        },
        // Present only when the scenario grants it, mirroring an install with
        // and without @grant GM_xmlhttpRequest.
        GM_xmlhttpRequest: options.userscriptManager
            ? details => {
                inFlightRequests++;
                respond(String(details.url), { method: details.method, body: details.data }, 'gm')
                    .then(async response => details.onload?.({
                        status: response.status,
                        responseText: await response.text(),
                        responseHeaders: Object.entries(response.rawHeaders || {})
                            .map(([name, value]) => `${name}: ${value}`).join('\r\n'),
                    }))
                    .catch(error => details.onerror?.({ error: String(error) }))
                    .finally(() => {
                        inFlightRequests--;
                    });
            }
            : undefined,
        localStorage,
        document,
        DOMParser: FakeDOMParser,
        MutationObserver: FakeMutationObserver,
        URLSearchParams,
        Event: class Event {
            constructor(type, init = {}) {
                this.type = type;
                Object.assign(this, init);
            }
        },
        GM_getValue: options.userscriptManager
            ? (key, fallback = undefined) =>
                (userscriptStore.has(key) ? userscriptStore.get(key) : fallback)
            : undefined,
        GM_setValue: options.userscriptManager
            ? (key, value) => void userscriptStore.set(key, value)
            : undefined,
        GM_deleteValue: options.userscriptManager
            ? key => void userscriptStore.delete(key)
            : undefined,
        // Constructed stylesheets are the CSP-proof path; without them the
        // script must fall back to a <style> tag.
        CSSStyleSheet: options.constructedStylesheets
            ? class CSSStyleSheet {
                replaceSync(css) {
                    this.cssText = css;
                }
            }
            : undefined,
        navigator: { clipboard: { writeText: text => void clipboard.push(String(text)) } },
        alert: message => alerts.push(String(message)),
        window: {
            location: { pathname: `/activities/${activityId}/edit`, href: '' },
            prompt: refuseModal('prompt'),
            confirm: refuseModal('confirm'),
        },
    };
    sandbox.window.alert = sandbox.alert;
    sandbox.window.document = document;
    sandbox.window.localStorage = localStorage;
    sandbox.globalThis = sandbox;

    FakeMutationObserver.instances.length = 0;
    vm.runInNewContext(readFileSync(userscriptPath, 'utf8'), sandbox, {
        filename: 'strava-route-renamer.user.js',
    });

    const settle = async (maxTurns = 5000) => {
        for (let turn = 0; turn < maxTurns; turn++) {
            await new Promise(resolve => setImmediate(resolve));
            if (turn > 2 && pendingTimers === 0 && inFlightRequests === 0) return;
        }
        throw new Error('Userscript did not settle');
    };

    const byId = id => document.getElementById(id);

    return {
        sandbox,
        document,
        input,
        label,
        logs,
        warnings,
        errors,
        alerts,
        requests,
        timerDelays,
        localStorage,
        userscriptStore,
        clipboard,
        observers: FakeMutationObserver.instances,
        settle,
        byId,
        get button() {
            return byId('strava-route-rename-btn');
        },
        get adjustButton() {
            return byId('strava-route-adjust-btn');
        },
        get dialog() {
            return byId('strava-route-name-dialog');
        },
        get name() {
            return input.value;
        },
        async generate() {
            this.button.click();
            await settle();
            return input.value;
        },
        overpassRequestCount() {
            return requests.filter(request => request.url.includes('overpass')).length;
        },
    };
}

// Convenience: boot the renamer straight from a fixture.
export function loadScenario(fixtureName, overrides = {}) {
    const fixture = loadFixture(fixtureName);
    return {
        fixture,
        renamer: loadRenamer({
            activityId: fixture.activityId,
            gpx: toGpx(fixture.points),
            overpassResponses: [jsonResponse({ elements: overpassElements(fixture) })],
            storage: fixture.savedPlaces
                ? { strava_route_saved_places_v1: JSON.stringify(fixture.savedPlaces) }
                : {},
            ...overrides,
        }),
    };
}
