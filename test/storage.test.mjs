import assert from 'node:assert/strict';
import test from 'node:test';

import {
    loadScenario,
} from './support/harness.mjs';

const FAVORITES_KEY = 'activity_renamer_saved_places_v1';
const ACTIVITY_OVERRIDES_KEY = 'activity_renamer_ride_names_v1';

const burgPlace = {
    id: 'place_burg',
    name: 'Gurkenpause',
    lat: 51.85,
    lon: 14.145,
    radiusM: 500,
    address: 'Burg (Spreewald)',
};

test('reads Favorites from the userscript manager storage', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgPlace]) },
    });

    const name = await renamer.generate();

    assert.match(name, /Gurkenpause/);
});

test('reads the place-count override for this activity from userscript storage', async () => {
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([{
                activityId: '19000955532',
                kept: [],
                placeCount: 2,
            }]),
        },
    });

    const name = await renamer.generate();

    assert.equal(name.split(' - ').length, 2);
});
