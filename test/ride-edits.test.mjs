import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chipNames,
    dialogButton,
    nameChip,
    openDialog,
    passedRowButton,
} from './support/dialog.mjs';
import { loadFixture, loadScenario } from './support/harness.mjs';

const BLOCKED_KEY = 'activity_renamer_blocked_names_v1';
const RIDE_KEY = 'activity_renamer_ride_names_v1';

test('leaves a blocked place out of the name', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['Guhrow']) },
    });

    const name = await renamer.generate();

    assert.equal(name, 'Cottbus - Sielow - Burg - Dissen - Sielow - Cottbus');
    assert.ok(renamer.logs.some(line => line.includes('Blocked from the name: Guhrow')));
});

test('blocks by name regardless of spelling case', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['  gUHROW  ']) },
    });

    assert.doesNotMatch(await renamer.generate(), /Guhrow/);
});

test('a blocked start reads as the next real place', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['Cottbus']) },
    });

    const name = await renamer.generate();

    assert.equal(name.split(' - ')[0], 'Sielow');
    assert.doesNotMatch(name, /Cottbus/);
});

// Never naming a ride after a place is the escalation of taking it out of this
// one: the ✕ drops it, and the row it lands in offers to silence it for good.
test('dropping a name then blocking it keeps the title rewritten', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const { renamer } = loadScenario('loop-with-revisit');

    assert.equal(await renamer.generate(), fixture.expected);
    openDialog(renamer);
    nameChip(renamer, 'Guhrow').drop.click();

    assert.equal(renamer.name, 'Cottbus - Sielow - Burg - Dissen - Sielow - Cottbus');
    assert.ok(!chipNames(renamer).includes('Guhrow'), 'the chip is gone from the name');
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(RIDE_KEY)),
        [{ activityId: fixture.activityId, kept: [], dropped: ['Guhrow'] }],
        'the removal belongs to this ride alone',
    );

    passedRowButton(renamer, '⛔', 'Guhrow').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)), ['Guhrow']);
    assert.equal(renamer.name, 'Cottbus - Sielow - Burg - Dissen - Sielow - Cottbus');

    dialogButton(renamer, 'Never in a name (1)').click();
    dialogButton(renamer, 'Unblock').click();
    passedRowButton(renamer, '+', 'Guhrow').click();

    assert.equal(renamer.name, fixture.expected);
});

// Werben loses the automatic selection to places that spread wider over the
// map; adding it by hand is the way to overrule that for this ride.
test('an added place survives the slots running out', async () => {
    const fixture = loadFixture('dense-settlements');
    const { renamer } = loadScenario('dense-settlements');

    assert.equal(await renamer.generate(), fixture.expected);
    assert.doesNotMatch(renamer.name, /Werben/);

    openDialog(renamer);
    passedRowButton(renamer, '+', 'Werben').click();

    assert.match(renamer.name, /Werben/);
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
    const { renamer } = loadScenario('dense-settlements');

    await renamer.generate();

    assert.equal(renamer.editNameButton.textContent, '✎ Edit Name');

    openDialog(renamer);
    passedRowButton(renamer, '+', 'Werben').click();

    assert.equal(renamer.editNameButton.textContent, '✎ Edit Name (1)');

    nameChip(renamer, 'Werben').drop.click();

    assert.equal(renamer.editNameButton.textContent, '✎ Edit Name');
});

// The whole point of the per-ride lists: the same village stays automatic
// everywhere else.
test('a name added to one ride reaches no other activity', async () => {
    const fixture = loadFixture('dense-settlements');
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: {
            [RIDE_KEY]: JSON.stringify([
                { activityId: '19000955531', kept: ['Werben'], dropped: [] },
            ]),
        },
    });

    assert.equal(await renamer.generate(), fixture.expected);
    assert.doesNotMatch(renamer.name, /Werben/);
});

test('adding a blocked place overrules the block for this ride only', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['Guhrow']) },
    });

    await renamer.generate();
    openDialog(renamer);
    passedRowButton(renamer, '+', 'Guhrow').click();

    assert.match(renamer.name, /Guhrow/);
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)),
        ['Guhrow'],
        'the block still speaks for every other ride',
    );
});
