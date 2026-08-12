import assert from 'node:assert/strict';
import test from 'node:test';

import {
    densifyTrack,
    jsonResponse,
    loadFixture,
    loadRenamer,
    loadScenario,
    overpassElements,
    toGpx,
} from './harness.mjs';

test('names a loop as a travel narrative of the settlements passed', async () => {
    const { fixture, renamer } = loadScenario('lusatia-loop');

    const name = await renamer.generate();

    assert.equal(name, fixture.expected);
    assert.doesNotMatch(name, /Schmogrow/, 'a village skirted at 900 m is not visited');
    assert.equal(name.split(' - ').filter(part => part === 'Sielow').length, 2,
        'a revisited village stays in the narrative twice');
    assert.doesNotMatch(name, /Chóśebuz|Žylow|\(/,
        'bilingual variants and parentheticals are stripped');
});

test('falls back to named roads when settlements are scarce', async () => {
    const { fixture, renamer } = loadScenario('road-fallback');

    const name = await renamer.generate();

    assert.equal(name, fixture.expected);
    assert.doesNotMatch(name, /Feldweg/, 'a track is not a nameworthy road');
});

test('starts and ends at a settlement rather than at a street', async () => {
    const { fixture, renamer } = loadScenario('road-endpoints');

    const name = await renamer.generate();

    assert.equal(name, fixture.expected);
    assert.doesNotMatch(name, /Bahnhofstraße|Werbener Weg/);
});

test('spreads the limited slots over the map when settlements are dense', async () => {
    const { fixture, renamer } = loadScenario('spreewald-dense');
    const known = new Set(fixture.places
        .map(place => place.name.split(' - ')[0].replace(/\s*\([^)]*\)$/, '')));

    const name = await renamer.generate();
    const parts = name.split(' - ');

    assert.equal(name, fixture.expected);
    assert.equal(parts[0], 'Cottbus');
    assert.equal(parts[parts.length - 1], 'Cottbus');
    assert.ok(parts.length <= 7, `expected at most 7 parts, got ${parts.length}`);
    for (const part of parts) assert.ok(known.has(part), `${part} is not a fixture place`);
});

// The browser always names the full-resolution GPX, while the fixtures are
// coarse. A different sampling must not pick different corners.
test('names a full-resolution track the same way', async () => {
    const fixture = loadFixture('lusatia-loop');
    const points = densifyTrack(fixture.waypoints, 5);
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(points),
        overpassResponses: [jsonResponse({ elements: overpassElements(fixture) })],
    });

    assert.ok(points.length > 7000, `expected a dense track, got ${points.length} points`);
    assert.equal(await renamer.generate(), fixture.expected);
});

// Overpass hands back every named road along a long ride. Matching them must
// not degrade into a scan of the whole track per road.
test('stays fast when Overpass returns hundreds of roads', async () => {
    const fixture = loadFixture('lusatia-loop');
    const points = densifyTrack(fixture.waypoints, 5);
    const roads = Array.from({ length: 300 }, (unused, i) => {
        const [lat, lon] = points[Math.floor((i / 300) * (points.length - 1))];
        return {
            id: 50000000 + i,
            name: `Straße ${i}`,
            highway: 'residential',
            stepM: 25,
            geometry: [[lat + 0.0004, lon - 0.004], [lat + 0.0004, lon + 0.004]],
        };
    });
    // Only one settlement, so the road fallback actually runs.
    const elements = overpassElements({ ...fixture, places: fixture.places.slice(0, 1), roads });
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(points),
        overpassResponses: [jsonResponse({ elements })],
    });

    const started = performance.now();
    const name = await renamer.generate();
    const elapsedMs = performance.now() - started;

    assert.match(name, /^Cottbus - .*Straße.* - Cottbus$/);
    assert.ok(name.split(' - ').length <= 7);
    assert.ok(elapsedMs < 5000, `naming took ${elapsedMs.toFixed(0)} ms`);
});

test('a favorite renames the settlement it covers', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        storage: {
            strava_route_favorites_v1: JSON.stringify([{
                id: 'favorite_burg',
                name: 'Gurkenpause',
                lat: 51.85,
                lon: 14.145,
                radiusM: 500,
                address: 'Burg (Spreewald)',
            }]),
        },
    });

    const name = await renamer.generate();

    assert.equal(name, 'Cottbus - Sielow - Guhrow - Gurkenpause - Dissen - Sielow - Cottbus');
});

test('a favorite away from any settlement joins the narrative', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        storage: {
            strava_route_favorites_v1: JSON.stringify([{
                id: 'favorite_rast',
                name: 'Kahnfährhafen',
                lat: 51.83,
                lon: 14.19,
                radiusM: 300,
                address: 'Zwischen Burg und Dissen',
            }]),
        },
    });

    const name = await renamer.generate();

    assert.match(name, /Kahnfährhafen/);
    assert.equal(name.split(' - ')[0], 'Cottbus');
});

test('reuses the cached landmarks on the second run', async () => {
    const { fixture, renamer } = loadScenario('lusatia-loop');

    const first = await renamer.generate();
    const second = await renamer.generate();

    assert.equal(first, fixture.expected);
    assert.equal(second, fixture.expected);
    assert.equal(renamer.overpassRequestCount(), 1, 'the second run is served from cache');
    assert.ok(
        [...renamer.localStorage.store.keys()].some(key => key.startsWith('strava_route_features_')),
        'passages are cached per activity',
    );
});

test('discards a cache written under different naming settings', async () => {
    const fixture = loadFixture('lusatia-loop');
    const cacheKey = `strava_route_features_v1_${fixture.activityId}`;
    const { renamer } = loadScenario('lusatia-loop', {
        storage: {
            [cacheKey]: JSON.stringify({
                signature: 'written-by-an-older-config',
                savedAt: Date.now(),
                passages: [],
                placeCount: 0,
                roadCount: 0,
            }),
        },
    });

    const name = await renamer.generate();

    assert.equal(name, fixture.expected);
    assert.equal(renamer.overpassRequestCount(), 1, 'a stale signature forces a refetch');
});

test('falls over to another Overpass mirror when one is busy', async () => {
    const fixture = loadFixture('lusatia-loop');
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [
            jsonResponse({}, 504),
            jsonResponse({ elements: overpassElements(fixture) }),
        ],
    });

    const name = await renamer.generate();
    const hosts = renamer.requests
        .filter(request => request.url.includes('overpass'))
        .map(request => new URL(request.url).host);

    assert.equal(name, fixture.expected);
    assert.equal(hosts.length, 2);
    assert.notEqual(hosts[0], hosts[1], 'the retry goes to a different instance');
    assert.ok(renamer.warnings.some(line => line.includes('retrying via')));
    assert.ok(renamer.timerDelays.includes(1000), 'switching mirrors does not wait out a backoff');
});

test('routes cross-origin calls through the userscript manager when granted', async () => {
    const fixture = loadFixture('lusatia-loop');
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [jsonResponse({ elements: overpassElements(fixture) })],
        userscriptManager: true,
    });

    const name = await renamer.generate();
    const transportFor = pattern => renamer.requests
        .filter(request => request.url.includes(pattern))
        .map(request => request.transport);

    assert.equal(name, fixture.expected);
    assert.deepEqual(transportFor('overpass'), ['gm'], 'Overpass bypasses the page CSP');
    assert.deepEqual(transportFor('export_gpx'), ['fetch'], 'the GPX stays a same-origin fetch');
});

test('does not retry a permanent Overpass rejection', async () => {
    const fixture = loadFixture('lusatia-loop');
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [jsonResponse({}, 400), jsonResponse({ elements: [] })],
    });

    await renamer.generate();

    assert.equal(renamer.overpassRequestCount(), 1);
    assert.ok(renamer.alerts.some(message => message.includes('HTTP 400')));
    assert.equal(renamer.name, '');
});

test('keeps the title within the length Strava accepts', async () => {
    const fixture = loadFixture('lusatia-loop');
    const places = fixture.places.map(place => ({
        ...place,
        name: `${place.name.split(' - ')[0]} an der Spree im Oberspreewald`,
    }));
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [
            jsonResponse({ elements: overpassElements({ ...fixture, places }) }),
        ],
    });

    const name = await renamer.generate();

    assert.ok(name.length <= 200, `title is ${name.length} characters long`);
    assert.match(name, /^Cottbus an der Spree im Oberspreewald - /, 'the start survives');
    assert.match(name, / - Cottbus an der Spree im Oberspreewald$/, 'the finish survives');
});

// A page's style-src can drop an injected <style> tag, but never reaches a
// constructed sheet — the same reason the network calls avoid page fetch.
test('adopts its stylesheet through the CSSOM when it can', () => {
    const renamer = loadRenamer({ constructedStylesheets: true });

    assert.equal(renamer.document.adoptedStyleSheets.length, 1);
    assert.match(renamer.document.adoptedStyleSheets[0].cssText, /\.strava-route-panel/);
    assert.equal(renamer.byId('strava-route-styles'), null, 'no <style> tag is needed');
});

test('falls back to a style tag on engines without constructed sheets', () => {
    const renamer = loadRenamer();
    const style = renamer.byId('strava-route-styles');

    assert.ok(style, 'the stylesheet is installed');
    assert.match(style.textContent, /\.strava-route-panel/);
    assert.equal(style.parentNode, renamer.document.head);
});

test('stops watching the whole page once the button is in', () => {
    const renamer = loadRenamer();

    assert.ok(renamer.button, 'the button is injected on load');
    assert.equal(renamer.observers.filter(observer => observer.connected).length, 1,
        'exactly one narrow observer is left watching');
});

test('re-injects the button when Strava re-renders the title field', () => {
    const renamer = loadRenamer();
    const form = renamer.document.querySelector('form');

    // Strava rebuilds the field, throwing our wrapper away with it.
    form.replaceChildren();
    const label = renamer.document.createElement('label');
    label.setAttribute('for', 'activity_name');
    const input = renamer.document.createElement('input');
    input.setAttribute('name', 'activity[name]');
    form.append(label, input);
    assert.equal(renamer.button, null);

    for (const observer of renamer.observers.filter(candidate => candidate.connected)) {
        observer.emit();
    }

    assert.ok(renamer.button, 'the button comes back');
    assert.equal(renamer.observers.filter(observer => observer.connected).length, 1);
});

test('reports an activity without GPS instead of naming it', async () => {
    const renamer = loadRenamer({ gpx: '<?xml version="1.0"?><gpx version="1.1"></gpx>' });

    await renamer.generate();

    assert.deepEqual(renamer.alerts, ['No GPS data found (manual entry or indoor activity?)']);
    assert.equal(renamer.name, '');
});

