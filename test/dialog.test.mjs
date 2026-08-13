import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chipNames,
    dialogButton,
    dialogField,
    dialogText,
    nameChip,
    openDialog,
    sectionTitles,
    submitForm,
    typeInto,
} from './support/dialog.mjs';
import {
    jsonResponse,
    loadFixture,
    loadRenamer,
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

// Favorites and exclusions are separate choices. Both stay out of the common
// ride-editing path until the rider opens the one they need.
test('keeps Favorites and Never in a name separate and independently collapsed', async () => {
    const { renamer } = loadScenario('loop-with-revisit');

    await renamer.generate();
    openDialog(renamer);

    assert.deepEqual(sectionTitles(renamer), [
        'Also passed (0)',
    ]);
    assert.equal(renamer.dialog.querySelector('#activity-renamer-backup-input'), null);
    assert.deepEqual(chipNames(renamer), renamer.name.split(' - '),
        'one chip per part of the title, in the order they are written');
    const favorites = dialogButton(renamer, 'Favorites (0)');
    const never = dialogButton(renamer, 'Never in a name (0)');
    assert.equal(favorites.getAttribute('aria-expanded'), 'false');
    assert.equal(never.getAttribute('aria-expanded'), 'false');

    favorites.click();

    assert.equal(dialogButton(renamer, 'Favorites (0)').getAttribute('aria-expanded'), 'true');
    assert.equal(dialogButton(renamer, 'Never in a name (0)').getAttribute('aria-expanded'), 'false');
    assert.equal(
        renamer.dialog.querySelector('label[for="activity-renamer-address-input"]').textContent,
        'Address',
    );

    dialogButton(renamer, 'Never in a name (0)').click();

    assert.equal(dialogButton(renamer, 'Favorites (0)').getAttribute('aria-expanded'), 'true');
    assert.equal(dialogButton(renamer, 'Never in a name (0)').getAttribute('aria-expanded'), 'true');
    assert.ok(renamer.dialog.querySelector('#activity-renamer-favorites'));
    assert.ok(renamer.dialog.querySelector('#activity-renamer-never'));
});

test('exposes modal semantics, traps focus and restores the opener', async () => {
    const renamer = loadRenamer();
    await renamer.ready;
    openDialog(renamer);

    const panel = renamer.dialog.querySelector('[role="dialog"]');
    const close = dialogButton(renamer, 'Close');
    const last = dialogButton(renamer, 'Never in a name (0)');
    assert.equal(panel.getAttribute('aria-modal'), 'true');
    assert.equal(panel.getAttribute('aria-labelledby'), 'activity-renamer-dialog-title');
    assert.equal(renamer.document.activeElement, panel);

    renamer.document.dispatchEvent({ type: 'keydown', key: 'Tab' });
    assert.equal(renamer.document.activeElement, close, 'Tab enters the dialog controls');

    last.focus();
    renamer.document.dispatchEvent({ type: 'keydown', key: 'Tab' });
    assert.equal(renamer.document.activeElement, close, 'Tab wraps to the first control');

    close.focus();
    renamer.document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
    assert.equal(renamer.document.activeElement, last, 'Shift+Tab wraps to the last control');

    renamer.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(renamer.dialog, null);
    assert.equal(renamer.document.activeElement, renamer.editNameButton);
});

test('shortens the current name and stores the maximum number of places', async () => {
    const { renamer } = loadScenario('dense-settlements');
    await renamer.generate();
    openDialog(renamer);

    const limit = dialogField(renamer, 'activity-renamer-max-name-places');
    assert.equal(limit.tagName, 'input');
    assert.equal(limit.type, 'number');
    assert.equal(limit.min, '2');
    assert.equal(limit.max, undefined, 'the input has no upper limit');
    assert.equal(limit.step, '1');
    assert.equal(limit.value, '7');
    assert.equal(
        renamer.dialog.querySelector('label[for="activity-renamer-max-name-places"]').textContent,
        'Maximum places',
    );

    limit.value = '3';
    limit.dispatchEvent({ type: 'change' });

    assert.equal(renamer.name.split(' - ').length, 3);
    assert.equal(JSON.parse(renamer.userscriptStore.get(MAX_NAME_PLACES_KEY)), 3);
    assert.equal(dialogField(renamer, 'activity-renamer-max-name-places').value, '3');
    assert.equal(
        renamer.document.activeElement,
        dialogField(renamer, 'activity-renamer-max-name-places'),
    );

    const unlimited = dialogField(renamer, 'activity-renamer-max-name-places');
    unlimited.value = '12';
    unlimited.dispatchEvent({ type: 'change' });

    assert.equal(dialogField(renamer, 'activity-renamer-max-name-places').value, '12');
    assert.equal(JSON.parse(renamer.userscriptStore.get(MAX_NAME_PLACES_KEY)), 12);

    const invalid = dialogField(renamer, 'activity-renamer-max-name-places');
    invalid.value = '1';
    invalid.dispatchEvent({ type: 'change' });

    assert.equal(dialogField(renamer, 'activity-renamer-max-name-places').value, '12');
    assert.match(dialogText(renamer), /whole number of 2 or more/i);
    assert.equal(JSON.parse(renamer.userscriptStore.get(MAX_NAME_PLACES_KEY)), 12);
});

test('keeps roads separate and collapsed when settlements fill the name', async () => {
    const { fixture, renamer } = loadScenario('dense-settlements');

    assert.equal(await renamer.generate(), fixture.expected);
    openDialog(renamer);

    const collapsed = dialogButton(renamer, 'Roads (1)');
    assert.doesNotMatch(dialogText(renamer), /Burger Chaussee/);

    collapsed.click();

    assert.ok(dialogButton(renamer, 'Roads (1)'));
    assert.match(dialogText(renamer), /Burger Chaussee/);
});

test('renames a place from its chip in the name', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const { renamer } = loadScenario('loop-with-revisit');

    assert.equal(await renamer.generate(), fixture.expected);
    openDialog(renamer);

    // The chip is the place: clicking its name is how it gets another one.
    nameChip(renamer, 'Burg').rename.click();

    assert.equal(
        renamer.dialog.querySelector('label[for="activity-renamer-place-name-input"]').textContent,
        'Place name',
    );

    typeInto(dialogField(renamer, 'activity-renamer-place-name-input'), 'Gurkenpause');
    typeInto(dialogField(renamer, 'activity-renamer-place-radius-input'), '500');
    submitForm(dialogField(renamer, 'activity-renamer-place-name-input'));

    assert.equal(renamer.alerts.length, 0, 'nothing is asked through a modal prompt');
    assert.match(renamer.name, /Gurkenpause/);
    assert.equal(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY)).length, 1);
    assert.ok(chipNames(renamer).includes('Gurkenpause'));
});

test('reports a bad radius in the form and keeps the values', async () => {
    const { renamer } = loadScenario('loop-with-revisit');
    await renamer.generate();
    openDialog(renamer);
    nameChip(renamer, 'Burg').rename.click();

    typeInto(dialogField(renamer, 'activity-renamer-place-name-input'), 'Zu weit');
    typeInto(dialogField(renamer, 'activity-renamer-place-radius-input'), '9000');
    submitForm(dialogField(renamer, 'activity-renamer-place-name-input'));

    assert.match(dialogText(renamer), /radius must be a number from 10 to 5000/i);
    assert.equal(dialogField(renamer, 'activity-renamer-place-name-input').value, 'Zu weit',
        'the typed name survives the error');
    assert.equal(renamer.userscriptStore.has(SAVED_PLACES_KEY), false);
});

test('deletes a saved place only after a second click', async () => {
    const renamer = loadRenamer({
        userscriptStorage: { [SAVED_PLACES_KEY]: JSON.stringify([burgPlace]) },
    });
    await renamer.ready;
    openDialog(renamer);
    dialogButton(renamer, 'Favorites (1)').click();

    dialogButton(renamer, 'Delete').click();

    assert.equal(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY)).length, 1);

    dialogButton(renamer, 'Confirm delete').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY)), []);
});

test('searching an address offers it as a place to save', async () => {
    const renamer = loadRenamer({
        nominatimResponses: [jsonResponse([{
            lat: '51.8501',
            lon: '14.1452',
            name: 'Bismarckturm',
            display_name: 'Bismarckturm, Burg (Spreewald), Spree-Neiße, Brandenburg, Deutschland',
            address: { village: 'Burg (Spreewald)', county: 'Spree-Neiße', country: 'Deutschland' },
        }])],
    });
    await renamer.ready;

    openDialog(renamer);
    dialogButton(renamer, 'Favorites (0)').click();
    typeInto(dialogField(renamer, 'activity-renamer-address-input'), 'Bismarckturm Burg');
    submitForm(dialogField(renamer, 'activity-renamer-address-input'));
    await renamer.settle();

    assert.match(dialogText(renamer), /Bismarckturm/);
    assert.match(dialogText(renamer), /Found 1/);

    dialogButton(renamer, '☆ Save').click();
    submitForm(dialogField(renamer, 'activity-renamer-place-name-input'));

    assert.equal(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY))[0].name, 'Bismarckturm');
});
