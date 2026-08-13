import assert from 'node:assert/strict';
import test from 'node:test';

import {
    dialogButton,
    chipNames,
    dialogField,
    dialogText,
    nameChip,
    namePreview,
    openDialog,
    sectionTitles,
    submitForm,
    typeInto,
} from './dialog.mjs';
import { jsonResponse, loadFixture, loadRenamer, loadScenario } from './harness.mjs';

const FAVORITES_KEY = 'strava_route_favorites_v1';

const burgFavorite = {
    id: 'favorite_burg',
    name: 'Gurkenpause',
    lat: 51.85,
    lon: 14.145,
    radiusM: 500,
    address: 'Burg (Spreewald)',
};

test('reads favorites from the userscript manager storage', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        userscriptManager: true,
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgFavorite]) },
        storage: {},
    });

    const name = await renamer.generate();

    assert.match(name, /Gurkenpause/);
});

test('moves favorites out of localStorage on startup', () => {
    const renamer = loadRenamer({
        userscriptManager: true,
        storage: { [FAVORITES_KEY]: JSON.stringify([burgFavorite]) },
    });

    assert.equal(
        JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY))[0].name,
        'Gurkenpause',
        'the userscript manager now holds the favorites',
    );
    assert.equal(renamer.localStorage.getItem(FAVORITES_KEY), null,
        'the site-data copy is gone, so clearing site data cannot lose them');
});

test('keeps working without the storage grants', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        storage: { [FAVORITES_KEY]: JSON.stringify([burgFavorite]) },
    });

    assert.match(await renamer.generate(), /Gurkenpause/);
    assert.equal(renamer.userscriptStore.size, 0);
});

// The dialog opens on the sentence it is about, then the places that could
// join it, and only then the settings behind them.
test('reads from this name down to the rarely touched settings', async () => {
    const { renamer } = loadScenario('lusatia-loop', { userscriptManager: true });

    await renamer.generate();
    openDialog(renamer);

    assert.deepEqual(sectionTitles(renamer), [
        'This name (7)',
        'Also passed (0)',
        'Saved places (0)',
        'Never in a name (0)',
        'Backup',
    ]);
    assert.deepEqual(chipNames(renamer), renamer.name.split(' - '),
        'one chip per part of the title, in the order they are written');
});

test('renames a place from its chip in the name', async () => {
    const fixture = loadFixture('lusatia-loop');
    const { renamer } = loadScenario('lusatia-loop', { userscriptManager: true });

    assert.equal(await renamer.generate(), fixture.expected);
    openDialog(renamer);

    // The chip is the place: clicking its name is how it gets another one.
    nameChip(renamer, 'Burg').rename.click();

    typeInto(dialogField(renamer, 'strava-route-favorite-name-input'), 'Gurkenpause');
    typeInto(dialogField(renamer, 'strava-route-favorite-radius-input'), '500');
    submitForm(dialogField(renamer, 'strava-route-favorite-name-input'));

    assert.equal(renamer.alerts.length, 0, 'nothing is asked through a modal prompt');
    assert.match(renamer.name, /Gurkenpause/);
    assert.equal(namePreview(renamer), renamer.name, 'the preview mirrors the title');
    assert.equal(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)).length, 1);
    assert.ok(chipNames(renamer).includes('Gurkenpause'));
});

test('reports a bad radius in the form and keeps the values', async () => {
    const { renamer } = loadScenario('lusatia-loop', { userscriptManager: true });
    await renamer.generate();
    openDialog(renamer);
    nameChip(renamer, 'Burg').rename.click();

    typeInto(dialogField(renamer, 'strava-route-favorite-name-input'), 'Zu weit');
    typeInto(dialogField(renamer, 'strava-route-favorite-radius-input'), '9000');
    submitForm(dialogField(renamer, 'strava-route-favorite-name-input'));

    assert.match(dialogText(renamer), /radius must be a number from 10 to 5000/i);
    assert.equal(dialogField(renamer, 'strava-route-favorite-name-input').value, 'Zu weit',
        'the typed name survives the error');
    assert.equal(renamer.userscriptStore.has(FAVORITES_KEY), false);
});

test('deletes a favorite only after a second click', () => {
    const renamer = loadRenamer({
        userscriptManager: true,
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgFavorite]) },
    });
    openDialog(renamer);

    dialogButton(renamer, 'Delete').click();

    assert.equal(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)).length, 1);

    dialogButton(renamer, 'Confirm delete').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)), []);
});

test('offers the saved favorites as a JSON backup', () => {
    const renamer = loadRenamer({
        userscriptManager: true,
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgFavorite]) },
    });

    openDialog(renamer);
    const backup = JSON.parse(dialogField(renamer, 'strava-route-backup-input').value);
    dialogButton(renamer, 'Copy').click();

    assert.deepEqual(backup.favorites, [burgFavorite]);
    assert.deepEqual(JSON.parse(renamer.clipboard[0]).favorites, [burgFavorite]);
});

test('imports a pasted backup after confirming', () => {
    const renamer = loadRenamer({ userscriptManager: true });
    openDialog(renamer);

    typeInto(dialogField(renamer, 'strava-route-backup-input'),
        JSON.stringify({ favorites: [burgFavorite] }));
    dialogButton(renamer, 'Import').click();

    assert.equal(renamer.userscriptStore.has(FAVORITES_KEY), false,
        'the first click only arms the destructive action');

    dialogButton(renamer, 'Replace everything').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)), [burgFavorite]);
});

test('rejects a malformed backup without touching the saved favorites', () => {
    const renamer = loadRenamer({
        userscriptManager: true,
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgFavorite]) },
    });
    openDialog(renamer);

    typeInto(dialogField(renamer, 'strava-route-backup-input'), 'not json at all');
    dialogButton(renamer, 'Import').click();
    dialogButton(renamer, 'Replace everything').click();

    assert.ok(renamer.alerts.some(message => message.includes('not valid JSON')));
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)), [burgFavorite]);
});

test('searching an address offers it as a favorite candidate', async () => {
    const renamer = loadRenamer({
        nominatimResponses: [jsonResponse([{
            lat: '51.8501',
            lon: '14.1452',
            name: 'Bismarckturm',
            display_name: 'Bismarckturm, Burg (Spreewald), Spree-Neiße, Brandenburg, Deutschland',
            address: { village: 'Burg (Spreewald)', county: 'Spree-Neiße', country: 'Deutschland' },
        }])],
    });

    openDialog(renamer);
    typeInto(dialogField(renamer, 'strava-route-favorite-address-input'), 'Bismarckturm Burg');
    submitForm(dialogField(renamer, 'strava-route-favorite-address-input'));
    await renamer.settle();

    assert.match(dialogText(renamer), /Bismarckturm/);
    assert.match(dialogText(renamer), /Found 1/);

    dialogButton(renamer, '☆ Save').click();
    submitForm(dialogField(renamer, 'strava-route-favorite-name-input'));

    assert.equal(JSON.parse(renamer.localStorage.getItem(FAVORITES_KEY))[0].name, 'Bismarckturm');
});
