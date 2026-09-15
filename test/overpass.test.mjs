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
import { buildNotice } from './support/panel.mjs';

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

// Place count and density pick among passages already fetched, so neither
// belongs in the cache signature and neither may send the rider to Overpass.
const SELECTION_SETTINGS = [
    {
        what: 'the ride place-count override',
        before: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([{
                activityId: '19000955532', kept: [], placeCount: 3,
            }]),
        },
        after: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([{
                activityId: '19000955532', kept: [], placeCount: 12,
            }]),
        },
        assertName: (name, fixture) => assert.ok(
            name.split(' - ').length > fixture.expected.split(' - ').length,
            'the override can use more landmarks than the automatic calculation',
        ),
    },
    {
        what: 'the automatic place density',
        before: {},
        after: { [AUTO_PLACE_SPACING_KEY]: JSON.stringify(8) },
        assertName: name => assert.equal(name.split(' - ').length, 3),
    },
];

for (const { what, before, after, assertName } of SELECTION_SETTINGS) {
    test(`reuses the feature cache after ${what} changes`, async () => {
        const first = loadScenario('dense-settlements', { userscriptStorage: before });
        await first.renamer.generate();

        const cacheKey = `activity_renamer_features_v2_${first.fixture.activityId}`;
        const second = loadScenario('dense-settlements', {
            storage: { [cacheKey]: first.renamer.localStorage.getItem(cacheKey) },
            userscriptStorage: after,
        });

        const name = await second.renamer.generate();

        assertName(name, second.fixture);
        assert.equal(second.renamer.overpassRequestCount(), 0,
            `${what} does not invalidate cached OSM passages`);
    });
}

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
    assert.ok(renamer.logs.some(line => line.includes('retrying via')));
    assert.deepEqual(renamer.warnings, [], 'a busy public server is not this run misbehaving');
    assert.ok(renamer.timerDelays.includes(1000), 'switching mirrors does not wait out a backoff');
});

// Every mirror busy at once is a bad minute for OpenStreetMap, not a broken
// run: the sweep is repeated, and what the rider is told is to come back.
test('sweeps the mirrors again before giving the rider a wait', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [jsonResponse({}, 504)],
    });

    await renamer.generate();

    assert.equal(renamer.overpassRequestCount(), 15, 'five mirrors, three rounds');
    assert.deepEqual(
        renamer.timerDelays.filter(delay => delay >= 5000),
        [5000, 10000],
        'each finished sweep waits longer than the last',
    );
    const notice = buildNotice(renamer);
    assert.match(notice.textContent, /busy right now/);
    assert.equal(notice.className, 'activity-renamer-status', 'no red for a busy public server');
    assert.deepEqual(renamer.errors, []);
    assert.equal(renamer.button.dataset.state, 'idle');
    assert.equal(renamer.name, '');
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
    const notice = buildNotice(renamer);
    assert.match(notice.textContent, /HTTP 400/);
    assert.match(notice.className, /activity-renamer-status--error/);
    assert.equal(renamer.name, '');
});
