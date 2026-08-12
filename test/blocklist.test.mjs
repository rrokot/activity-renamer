import assert from 'node:assert/strict';
import test from 'node:test';

import { dialogButton, dialogField, namePreview, openDialog, typeInto } from './dialog.mjs';
import { loadFixture, loadScenario } from './harness.mjs';

const BLOCKED_KEY = 'strava_route_blocked_names_v1';
const PINNED_KEY = 'strava_route_pinned_names_v1';

function landmarkToggle(renamer, label, place) {
    const button = renamer.dialog.querySelectorAll('button')
        .filter(candidate => candidate.textContent === label)
        .find(candidate => candidate.title.includes(place));
    if (!button) throw new Error(`No "${label}" toggle for ${place}`);
    return button;
}

test('leaves a blocked place out of the name', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        storage: { [BLOCKED_KEY]: JSON.stringify(['Guhrow']) },
    });

    const name = await renamer.generate();

    assert.equal(name, 'Cottbus - Sielow - Burg - Dissen - Sielow - Cottbus');
    assert.ok(renamer.logs.some(line => line.includes('Blocked from the name: Guhrow')));
});

test('blocks by name regardless of spelling case', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        storage: { [BLOCKED_KEY]: JSON.stringify(['  gUHROW  ']) },
    });

    assert.doesNotMatch(await renamer.generate(), /Guhrow/);
});

test('a blocked start reads as the next real place', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        storage: { [BLOCKED_KEY]: JSON.stringify(['Cottbus']) },
    });

    const name = await renamer.generate();

    assert.equal(name.split(' - ')[0], 'Sielow');
    assert.doesNotMatch(name, /Cottbus/);
});

test('blocking a landmark from the dialog rewrites the title in place', async () => {
    const fixture = loadFixture('lusatia-loop');
    const { renamer } = loadScenario('lusatia-loop', { userscriptManager: true });

    assert.equal(await renamer.generate(), fixture.expected);
    openDialog(renamer);
    landmarkToggle(renamer, '⛔ Block', 'Guhrow').click();

    assert.equal(renamer.name, 'Cottbus - Sielow - Burg - Dissen - Sielow - Cottbus');
    assert.equal(namePreview(renamer), renamer.name);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)), ['Guhrow']);

    dialogButton(renamer, 'Unblock').click();

    assert.equal(renamer.name, fixture.expected);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)), []);
});

// Werben loses the automatic selection to places that spread wider over the
// map; pinning is the way to overrule that.
test('a pinned place is kept even when the slots run out', async () => {
    const fixture = loadFixture('spreewald-dense');
    const { renamer } = loadScenario('spreewald-dense', { userscriptManager: true });

    assert.equal(await renamer.generate(), fixture.expected);
    assert.doesNotMatch(renamer.name, /Werben/);

    openDialog(renamer);
    landmarkToggle(renamer, '📌 Pin', 'Werben').click();

    assert.match(renamer.name, /Werben/);
    assert.equal(namePreview(renamer), renamer.name);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(PINNED_KEY)), ['Werben']);

    dialogButton(renamer, 'Unpin').click();

    assert.equal(renamer.name, fixture.expected);
});

test('pinning a blocked place unblocks it', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        userscriptManager: true,
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['Guhrow']) },
    });

    await renamer.generate();
    openDialog(renamer);
    landmarkToggle(renamer, '📌 Pin', 'Guhrow').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)), []);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(PINNED_KEY)), ['Guhrow']);
    assert.match(renamer.name, /Guhrow/);
});

test('carries blocked and pinned names through a backup', () => {
    const { renamer } = loadScenario('lusatia-loop', {
        userscriptManager: true,
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['Guhrow']) },
    });

    openDialog(renamer);
    const backup = JSON.parse(dialogField(renamer, 'strava-route-backup-input').value);

    assert.deepEqual(backup.blockedNames, ['Guhrow']);

    typeInto(dialogField(renamer, 'strava-route-backup-input'),
        JSON.stringify({ favorites: [], blockedNames: ['Werben', 'Werben', 'Dissen'] }));
    dialogButton(renamer, 'Import').click();
    dialogButton(renamer, 'Replace everything').click();

    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)),
        ['Werben', 'Dissen'],
        'duplicates are collapsed on the way in',
    );
});
