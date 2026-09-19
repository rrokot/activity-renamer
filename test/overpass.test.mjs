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

// Nothing revisits an old activity page to retire its entry, so a cache
// written there is only ever dropped by the next route that needs the room.
const FEATURE_PREFIX = 'activity_renamer_features_v2_';
// CONFIG.featureCacheEntries, the ceiling a write prunes down to.
const FEATURE_CACHE_ENTRIES = 50;

const cachedEntry = savedAt => JSON.stringify({
    signature: 'another-route',
    savedAt,
    passages: [],
    placeCount: 0,
    roadCount: 0,
});

const featureKeys = renamer => [...renamer.localStorage.store.keys()]
    .filter(key => key.startsWith(FEATURE_PREFIX));

test('drops an expired entry of another route when a route is cached', async () => {
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const { fixture, renamer } = loadScenario('loop-with-revisit', {
        storage: {
            [`${FEATURE_PREFIX}expired`]: cachedEntry(fortyDaysAgo),
            [`${FEATURE_PREFIX}fresh`]: cachedEntry(Date.now()),
            unrelated_strava_key: 'left alone',
        },
    });

    await renamer.generate();

    assert.deepEqual(
        featureKeys(renamer).sort(),
        [`${FEATURE_PREFIX}${fixture.activityId}`, `${FEATURE_PREFIX}fresh`].sort(),
        'the entry past featureCacheDays goes; the recent one stays',
    );
    assert.equal(renamer.localStorage.getItem('unrelated_strava_key'), 'left alone',
        'the sweep reaches only this script’s own cache keys');
});

test('keeps the feature cache down to the newest activities', async () => {
    const surplus = 10;
    const seeded = Object.fromEntries(
        Array.from({ length: FEATURE_CACHE_ENTRIES + surplus }, (unused, age) => [
            `${FEATURE_PREFIX}seed${age}`,
            cachedEntry(Date.now() - age * 1000),
        ]),
    );
    const { fixture, renamer } = loadScenario('loop-with-revisit', { storage: seeded });

    await renamer.generate();

    const keys = featureKeys(renamer);
    assert.equal(keys.length, FEATURE_CACHE_ENTRIES,
        'the route just named fits inside the ceiling instead of raising it');
    assert.ok(keys.includes(`${FEATURE_PREFIX}${fixture.activityId}`));
    assert.ok(keys.includes(`${FEATURE_PREFIX}seed0`), 'the newest entry survives');
    assert.ok(!keys.includes(`${FEATURE_PREFIX}seed${FEATURE_CACHE_ENTRIES + surplus - 1}`),
        'the oldest entry is the one that pays for the room');
});

// A store Strava itself has filled leaves the ceiling met and the write still
// refused, and silence there would retire the cache for good.
test('makes room and writes again when the store refuses an entry', async () => {
    const { fixture, renamer } = loadScenario('loop-with-revisit', {
        storage: {
            [`${FEATURE_PREFIX}other1`]: cachedEntry(Date.now()),
            [`${FEATURE_PREFIX}other2`]: cachedEntry(Date.now() - 1000),
        },
    });
    const accept = renamer.localStorage.setItem;
    let refusals = 1;
    renamer.localStorage.setItem = (key, value) => {
        if (refusals > 0 && key.startsWith(FEATURE_PREFIX)) {
            refusals -= 1;
            throw new Error('QuotaExceededError');
        }
        accept(key, value);
    };

    await renamer.generate();
    const second = await renamer.generate();

    assert.equal(second, fixture.expected);
    assert.equal(renamer.overpassRequestCount(), 1,
        'the retried write leaves a cache the second run can use');
    assert.ok(!featureKeys(renamer).includes(`${FEATURE_PREFIX}other2`),
        'the older of the two entries paid for the retry');
});

test('names the route anyway when no eviction can make room', async () => {
    const { fixture, renamer } = loadScenario('loop-with-revisit', {
        storage: { [`${FEATURE_PREFIX}other`]: cachedEntry(Date.now()) },
    });
    renamer.localStorage.setItem = key => {
        if (key.startsWith(FEATURE_PREFIX)) throw new Error('QuotaExceededError');
    };

    const name = await renamer.generate();

    assert.equal(name, fixture.expected, 'a store that stays full costs speed, not a name');
    assert.deepEqual(featureKeys(renamer), [], 'nothing was left claiming to be cached');
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
