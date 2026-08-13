import assert from 'node:assert/strict';
import test from 'node:test';

import {
    loadScenario,
} from './support/harness.mjs';

const SAVED_PLACES_KEY = 'activity_renamer_saved_places_v1';

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
