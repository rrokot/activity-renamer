import assert from 'node:assert/strict';
import test from 'node:test';

import {
    loadScenario,
} from './support/harness.mjs';

const FAVORITES_KEY = 'activity_renamer_saved_places_v1';

const burgPlace = {
    id: 'place_burg',
    name: 'Gurkenpause',
    lat: 51.85,
    lon: 14.145,
    radiusM: 500,
    address: 'Burg (Spreewald)',
};

// One adapter serves every key, so proving Favorites arrive through the
// userscript manager proves the path. The place-count override and the
// automatic density ride the same adapter in overpass.test.mjs.
test('reads Favorites from the userscript manager storage', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgPlace]) },
    });

    const name = await renamer.generate();

    assert.match(name, /Gurkenpause/);
});
