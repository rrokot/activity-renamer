import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chipNames,
    dialogButton,
    dialogField,
    nameChip,
    namePreview,
    openDialog,
    passedRowButton,
    typeInto,
} from './dialog.mjs';
import { loadFixture, loadScenario } from './harness.mjs';

const BLOCKED_KEY = 'strava_route_blocked_names_v1';
const RIDE_KEY = 'strava_route_ride_names_v1';

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

// Never naming a ride after a place is the escalation of taking it out of this
// one: the ✕ drops it, and the row it lands in offers to silence it for good.
test('dropping a name then blocking it keeps the title rewritten', async () => {
    const fixture = loadFixture('lusatia-loop');
    const { renamer } = loadScenario('lusatia-loop', { userscriptManager: true });

    assert.equal(await renamer.generate(), fixture.expected);
    openDialog(renamer);
    nameChip(renamer, 'Guhrow').drop.click();

    assert.equal(renamer.name, 'Cottbus - Sielow - Burg - Dissen - Sielow - Cottbus');
    assert.equal(namePreview(renamer), renamer.name);
    assert.ok(!chipNames(renamer).includes('Guhrow'), 'the chip is gone from the name');
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(RIDE_KEY)),
        [{ activityId: fixture.activityId, kept: [], dropped: ['Guhrow'] }],
        'the removal belongs to this ride alone',
    );

    passedRowButton(renamer, '⛔ Never', 'Guhrow').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)), ['Guhrow']);
    assert.equal(renamer.name, 'Cottbus - Sielow - Burg - Dissen - Sielow - Cottbus');

    dialogButton(renamer, 'Unblock').click();
    passedRowButton(renamer, '⊕ Add', 'Guhrow').click();

    assert.equal(renamer.name, fixture.expected);
});

// Werben loses the automatic selection to places that spread wider over the
// map; adding it by hand is the way to overrule that for this ride.
test('an added place survives the slots running out', async () => {
    const fixture = loadFixture('spreewald-dense');
    const { renamer } = loadScenario('spreewald-dense', { userscriptManager: true });

    assert.equal(await renamer.generate(), fixture.expected);
    assert.doesNotMatch(renamer.name, /Werben/);

    openDialog(renamer);
    passedRowButton(renamer, '⊕ Add', 'Werben').click();

    assert.match(renamer.name, /Werben/);
    assert.equal(namePreview(renamer), renamer.name);
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(RIDE_KEY)),
        [{ activityId: fixture.activityId, kept: ['Werben'], dropped: [] }],
    );

    // Taking it out again undoes the addition rather than recording a removal,
    // so the ride is left exactly as it was found.
    nameChip(renamer, 'Werben').drop.click();

    assert.equal(renamer.name, fixture.expected);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(RIDE_KEY)), []);
});

// The button that opens the dialog belongs to the ride it opens, so it counts
// what this rider changed here — not how many places are saved for every ride.
test('the button counts the changes this ride carries', async () => {
    const { renamer } = loadScenario('spreewald-dense', { userscriptManager: true });

    await renamer.generate();

    assert.equal(renamer.adjustButton.textContent, '✎ Adjust');

    openDialog(renamer);
    passedRowButton(renamer, '⊕ Add', 'Werben').click();

    assert.equal(renamer.adjustButton.textContent, '✎ Adjust (1)');

    nameChip(renamer, 'Werben').drop.click();

    assert.equal(renamer.adjustButton.textContent, '✎ Adjust');
});

// The whole point of the per-ride lists: the same village stays automatic
// everywhere else.
test('a name added to one ride reaches no other activity', async () => {
    const fixture = loadFixture('spreewald-dense');
    const { renamer } = loadScenario('spreewald-dense', {
        storage: {
            [RIDE_KEY]: JSON.stringify([
                { activityId: '19000955531', kept: ['Werben'], dropped: [] },
            ]),
        },
    });

    assert.equal(await renamer.generate(), fixture.expected);
    assert.doesNotMatch(renamer.name, /Werben/);
});

test('adding a blocked place overrules the block for this ride only', async () => {
    const { renamer } = loadScenario('lusatia-loop', {
        userscriptManager: true,
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['Guhrow']) },
    });

    await renamer.generate();
    openDialog(renamer);
    passedRowButton(renamer, '⊕ Add', 'Guhrow').click();

    assert.match(renamer.name, /Guhrow/);
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)),
        ['Guhrow'],
        'the block still speaks for every other ride',
    );
});

test('carries blocked names through a backup', () => {
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
