import assert from 'node:assert/strict';
import test from 'node:test';

import {
    jsonResponse,
    loadFixture,
    loadRenamer,
    loadScenario,
    overpassElements,
    toGpx,
} from './support/harness.mjs';

const ACTIVITY_OVERRIDES_KEY = 'activity_renamer_ride_names_v1';
const AUTO_PLACE_SPACING_KEY = 'activity_renamer_auto_place_spacing_km_v1';
test('reuses the cached landmarks on the second run', async () => {
    const { fixture, renamer } = loadScenario('loop-with-revisit');

    const first = await renamer.generate();
    const second = await renamer.generate();

    assert.equal(first, fixture.expected);
    assert.equal(second, fixture.expected);
    assert.equal(renamer.overpassRequestCount(), 1, 'the second run is served from cache');
    assert.ok(
        [...renamer.localStorage.store.keys()].some(key => key.startsWith('activity_renamer_features_')),
        'passages are cached per activity',
    );
});

// Nothing named beside the route may mean an OSM gap, so the answer is asked
// for again instead of standing for a month.
test('does not cache a route without landmarks', async () => {
    const renamer = loadRenamer();

    await renamer.generate();
    await renamer.generate();

    assert.equal(renamer.overpassRequestCount(), 2, 'the empty answer is asked for again');
    assert.ok(
        [...renamer.localStorage.store.keys()]
            .every(key => !key.startsWith('activity_renamer_features_')),
        'no empty passage list is stored',
    );
});

test('discards a cache written under different naming settings', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const cacheKey = `activity_renamer_features_v2_${fixture.activityId}`;
    const { renamer } = loadScenario('loop-with-revisit', {
        storage: {
            [cacheKey]: JSON.stringify({
                signature: 'written-by-a-different-config',
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

test('reuses the feature cache after the ride place-count override changes', async () => {
    const first = loadScenario('dense-settlements', {
        userscriptStorage: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([{
                activityId: '19000955532', kept: [], placeCount: 3,
            }]),
        },
    });
    await first.renamer.generate();

    const cacheKey = `activity_renamer_features_v2_${first.fixture.activityId}`;
    const cached = first.renamer.localStorage.getItem(cacheKey);
    const second = loadScenario('dense-settlements', {
        storage: { [cacheKey]: cached },
        userscriptStorage: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([{
                activityId: '19000955532', kept: [], placeCount: 12,
            }]),
        },
    });

    const expandedName = await second.renamer.generate();
    assert.ok(
        expandedName.split(' - ').length > second.fixture.expected.split(' - ').length,
        'the override can use more landmarks than the automatic calculation',
    );
    assert.equal(second.renamer.overpassRequestCount(), 0,
        'the activity place-count override does not invalidate cached OSM passages');
});

test('reuses the feature cache after the automatic place density changes', async () => {
    const first = loadScenario('dense-settlements');
    await first.renamer.generate();

    const cacheKey = `activity_renamer_features_v2_${first.fixture.activityId}`;
    const cached = first.renamer.localStorage.getItem(cacheKey);
    const second = loadScenario('dense-settlements', {
        storage: { [cacheKey]: cached },
        userscriptStorage: { [AUTO_PLACE_SPACING_KEY]: JSON.stringify(8) },
    });

    const name = await second.renamer.generate();

    assert.equal(name.split(' - ').length, 3);
    assert.equal(second.renamer.overpassRequestCount(), 0,
        'density changes only the selection and keep cached OSM passages');
});

test('falls over to another Overpass mirror when one is busy', async () => {
    const fixture = loadFixture('loop-with-revisit');
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

test('falls over when an Overpass mirror rejects the request headers', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [
            jsonResponse({}, 406),
            jsonResponse({ elements: overpassElements(fixture) }),
        ],
    });

    assert.equal(await renamer.generate(), fixture.expected);
    assert.equal(renamer.overpassRequestCount(), 2);
});

test('routes cross-origin calls through the userscript manager', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [jsonResponse({ elements: overpassElements(fixture) })],
    });

    const name = await renamer.generate();
    const transportFor = pattern => renamer.requests
        .filter(request => request.url.includes(pattern))
        .map(request => request.transport);
    const overpassRequest = renamer.requests.find(request => request.url.includes('overpass'));

    assert.equal(name, fixture.expected);
    assert.deepEqual(transportFor('overpass'), ['gm'], 'Overpass bypasses the page CSP');
    assert.deepEqual(transportFor('export_gpx'), ['fetch'], 'the GPX stays a same-origin fetch');
    assert.match(overpassRequest.init.headers['User-Agent'], /^Activity-Renamer\b/);
});

test('does not retry a permanent Overpass rejection', async () => {
    const fixture = loadFixture('loop-with-revisit');
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
