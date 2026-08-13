import assert from 'node:assert/strict';
import test from 'node:test';

import {
    loadScenario,
} from './support/harness.mjs';

const SAVED_PLACES_KEY = 'activity_renamer_saved_places_v1';
const MAX_NAME_PLACES_KEY = 'activity_renamer_max_name_places_v1';

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
        userscriptStorage: { [SAVED_PLACES_KEY]: JSON.stringify([burgPlace]) },
    });

    const name = await renamer.generate();

    assert.match(name, /Gurkenpause/);
});

test('reads the maximum name places from userscript manager storage', async () => {
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: { [MAX_NAME_PLACES_KEY]: JSON.stringify(2) },
    });

    const name = await renamer.generate();

    assert.equal(name.split(' - ').length, 2);
});
