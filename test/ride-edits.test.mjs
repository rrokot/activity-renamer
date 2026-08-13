import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chipNames,
    nameChip,
    openPanel,
    panelButton,
    panelField,
    passedRowButton,
} from './support/panel.mjs';
import { loadFixture, loadScenario } from './support/harness.mjs';

const BLOCKED_KEY = 'activity_renamer_blocked_names_v1';
const ACTIVITY_OVERRIDES_KEY = 'activity_renamer_ride_names_v1';

test('leaves a blocked place out of the name', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        userscriptStorage: { [BLOCKED_KEY]: JSON.stringify(['Burg']) },
    });

    const name = await renamer.generate();

    assert.equal(name, 'Cottbus - Sielow - Guhrow - Dissen - Sielow - Cottbus');
    assert.ok(renamer.logs.some(line => line.includes('Blocked from the name: Burg')));
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

test('removing a chip does not exclude its place', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const { renamer } = loadScenario('loop-with-revisit');

    assert.equal(await renamer.generate(), fixture.expected);
    openPanel(renamer);
    nameChip(renamer, 'Burg').drop.click();

    assert.equal(renamer.name, 'Cottbus - Sielow - Guhrow - Dissen - Sielow - Cottbus');
    assert.ok(!chipNames(renamer).includes('Burg'), 'the chip is gone from the name');
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY)),
        [{
            activityId: fixture.activityId,
            kept: ['Cottbus', 'Sielow', 'Guhrow', 'Dissen', 'Sielow', 'Cottbus'],
            placeCount: 6,
        }],
        'the remaining name is stored without a banned-place list',
    );
    const exclude = passedRowButton(renamer, 'Exclude', 'Burg');
    assert.equal(exclude.getAttribute('aria-pressed'), 'false');
    assert.equal(
        exclude.parentNode.parentNode.children[0].children[1].textContent.includes('Excluded'),
        false,
    );

    passedRowButton(renamer, 'Add', 'Burg').click();

    assert.equal(renamer.name, fixture.expected, 'the removed place remains available');
    assert.equal(renamer.userscriptStore.has(BLOCKED_KEY), false);

    nameChip(renamer, 'Burg').drop.click();
    passedRowButton(renamer, 'Exclude', 'Burg').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)), ['Burg']);
    assert.equal(renamer.name, 'Cottbus - Sielow - Guhrow - Dissen - Sielow - Cottbus');

    panelButton(renamer, 'Excluded').click();
    panelButton(renamer, 'Unblock').click();
    panelButton(renamer, 'Other places').click();
    passedRowButton(renamer, 'Add', 'Burg').click();

    assert.equal(renamer.name, fixture.expected);
});

test('removing a repeated chip removes the clicked occurrence', async () => {
    const { renamer } = loadScenario('loop-with-revisit');
    await renamer.generate();
    openPanel(renamer);
    const sielowChips = renamer.panel.querySelectorAll('button')
        .filter(button => button.className === 'activity-renamer-chip-name'
            && button.textContent === 'Sielow');

    sielowChips[0].parentNode.children[1].click();

    assert.equal(renamer.name, 'Cottbus - Guhrow - Burg - Dissen - Sielow - Cottbus');
});

test('dropping an automatic place removes its slot instead of choosing a replacement', async () => {
    const { fixture, renamer } = loadScenario('dense-settlements');
    await renamer.generate();
    openPanel(renamer);
    const before = renamer.name.split(' - ');

    nameChip(renamer, 'Schmogrow').drop.click();

    const after = renamer.name.split(' - ');
    assert.equal(after.length, before.length - 1);
    assert.doesNotMatch(renamer.name, /Schmogrow/);
    assert.equal(panelField(renamer, 'activity-renamer-name-place-count').value, '6');
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY)), [{
        activityId: fixture.activityId,
        kept: ['Cottbus', 'Sielow', 'Burg', 'Briesen', 'Kolkwitz', 'Cottbus'],
        placeCount: 6,
    }]);

    passedRowButton(renamer, 'Add', 'Werben').click();

    assert.match(renamer.name, /Werben/, 'the village whose Add button was clicked is added');
    assert.doesNotMatch(renamer.name, /Schmogrow/, 'the removed village is not substituted');
});

// Werben loses the automatic selection to places that spread wider over the
// map; adding it by hand is the way to overrule that for this ride.
test('an added place survives the slots running out', async () => {
    const fixture = loadFixture('dense-settlements');
    const { renamer } = loadScenario('dense-settlements');

    assert.equal(await renamer.generate(), fixture.expected);
    assert.doesNotMatch(renamer.name, /Werben/);

    openPanel(renamer);
    const countBeforeAddition = renamer.name.split(' - ').length;
    passedRowButton(renamer, 'Add', 'Werben').click();

    assert.match(renamer.name, /Werben/);
    assert.equal(renamer.name.split(' - ').length, countBeforeAddition + 1,
        'Add increases the number of places instead of replacing one');
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY)),
        [{
            activityId: fixture.activityId,
            kept: [
                'Cottbus', 'Sielow', 'Werben', 'Schmogrow',
                'Burg', 'Briesen', 'Kolkwitz', 'Cottbus',
            ],
            placeCount: 8,
        }],
    );

    const beforeRemoval = renamer.name.split(' - ');
    nameChip(renamer, 'Werben').drop.click();

    assert.equal(renamer.name.split(' - ').length, beforeRemoval.length - 1);
    assert.doesNotMatch(renamer.name, /Werben/);
    assert.equal(
        JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY))[0].dropped,
        undefined,
    );
});

test('adding a hidden kept place extends the visible name', async () => {
    const fixture = loadFixture('dense-settlements');
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([{
                activityId: fixture.activityId,
                kept: fixture.expected.split(' - '),
                placeCount: 2,
            }]),
        },
    });
    await renamer.generate();
    openPanel(renamer);

    assert.equal(chipNames(renamer).length, 2);
    assert.doesNotMatch(renamer.name, /Sielow/);

    passedRowButton(renamer, 'Add', 'Sielow').click();

    assert.equal(renamer.name, 'Cottbus - Sielow - Cottbus');
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY)), [{
        activityId: fixture.activityId,
        kept: ['Cottbus', 'Sielow', 'Cottbus'],
        placeCount: 3,
    }]);
});

test('the panel chevron stays free of edit counters', async () => {
    const { renamer } = loadScenario('dense-settlements');

    await renamer.generate();

    assert.equal(renamer.panelToggleButton.textContent, '');

    openPanel(renamer);
    passedRowButton(renamer, 'Add', 'Werben').click();

    assert.equal(renamer.panelToggleButton.textContent, '');
    assert.equal(renamer.panelToggleButton.title, 'Hide Activity Renamer');

    nameChip(renamer, 'Werben').drop.click();

    assert.equal(renamer.panelToggleButton.textContent, '');
});

// The whole point of the per-ride lists: the same village stays automatic
// everywhere else.
test('a name added to one ride reaches no other activity', async () => {
    const fixture = loadFixture('dense-settlements');
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([
                { activityId: '19000955531', kept: ['Werben'] },
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
    openPanel(renamer);
    passedRowButton(renamer, 'Add', 'Guhrow').click();

    assert.match(renamer.name, /Guhrow/);
    assert.deepEqual(
        JSON.parse(renamer.userscriptStore.get(BLOCKED_KEY)),
        ['Guhrow'],
        'the block still speaks for every other ride',
    );
});
