import assert from 'node:assert/strict';
import test from 'node:test';

import {
    loadRenamer,
    loadScenario,
} from './support/harness.mjs';

const SAVED_PLACES_KEY = 'strava_route_saved_places_v1';

const burgPlace = {
    id: 'place_burg',
    name: 'Gurkenpause',
    lat: 51.85,
    lon: 14.145,
    radiusM: 500,
    address: 'Burg (Spreewald)',
};

test('reads saved places from the userscript manager storage', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptManager: true,
        userscriptStorage: { [SAVED_PLACES_KEY]: JSON.stringify([burgPlace]) },
        storage: {},
    });

    const name = await renamer.generate();

    assert.match(name, /Gurkenpause/);
});

test('moves saved places out of localStorage on startup', () => {
    const renamer = loadRenamer({
        userscriptManager: true,
        storage: { [SAVED_PLACES_KEY]: JSON.stringify([burgPlace]) },
    });

    assert.equal(
        JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY))[0].name,
        'Gurkenpause',
        'the userscript manager now holds the saved places',
    );
    assert.equal(renamer.localStorage.getItem(SAVED_PLACES_KEY), null,
        'the site-data copy is gone, so clearing site data cannot lose them');
});

test('keeps working without the storage grants', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        storage: { [SAVED_PLACES_KEY]: JSON.stringify([burgPlace]) },
    });

    assert.match(await renamer.generate(), /Gurkenpause/);
    assert.equal(renamer.userscriptStore.size, 0);
});

// Renaming a key orphans whatever sat under the old one, so the keys earlier
// versions wrote are cleared on the way in rather than left in the profile.
test('clears the keys earlier versions wrote', () => {
    const renamer = loadRenamer({
        userscriptManager: true,
        storage: { strava_route_favorites_v1: JSON.stringify([burgPlace]) },
        userscriptStorage: {
            strava_route_pinned_names_v1: JSON.stringify(['Guhrow']),
            strava_route_kept_names_v1: JSON.stringify([{ activityId: '1', names: ['Burg'] }]),
        },
    });

    assert.equal(renamer.localStorage.getItem('strava_route_favorites_v1'), null);
    assert.equal(renamer.userscriptStore.has('strava_route_pinned_names_v1'), false);
    assert.equal(renamer.userscriptStore.has('strava_route_kept_names_v1'), false);
    assert.ok(renamer.logs.some(line => line.includes('Cleared retired settings')));
});
