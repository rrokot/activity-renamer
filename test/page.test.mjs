import assert from 'node:assert/strict';
import test from 'node:test';

import {
    loadRenamer,
    loadScenario,
} from './support/harness.mjs';
// A page's style-src cannot block a constructed stylesheet.
test('adopts its stylesheet through the CSSOM', async () => {
    const renamer = loadRenamer();
    await renamer.ready;

    assert.equal(renamer.document.adoptedStyleSheets.length, 1);
    assert.match(renamer.document.adoptedStyleSheets[0].cssText, /\.activity-renamer-panel/);
});

test('stops watching the whole page once the button is in', async () => {
    const renamer = loadRenamer();
    await renamer.ready;

    assert.ok(renamer.button, 'the button is injected on load');
    assert.equal(renamer.observers.filter(observer => observer.connected).length, 1,
        'exactly one narrow observer is left watching');
});

test('keeps global settings available before the route name is built', async () => {
    const { renamer } = loadScenario('loop-with-revisit');
    await renamer.ready;

    assert.equal(renamer.editNameButton.disabled, false);
    assert.equal(
        renamer.editNameButton.title,
        'Open Activity Renamer settings; build the route to edit its landmarks',
    );
    assert.equal(renamer.editNameButton.textContent, '');
    assert.equal(renamer.editNameButton.getAttribute('aria-label'), renamer.editNameButton.title);

    renamer.editNameButton.click();

    assert.ok(renamer.panel);
    assert.equal(renamer.panel.querySelector('h3'), null);
    assert.equal(renamer.panel.getAttribute('aria-label'), 'Activity Renamer');
    assert.ok(renamer.panel.querySelector('#activity-renamer-favorites-toggle'));
    assert.ok(renamer.panel.querySelector('#activity-renamer-never-toggle'));

    await renamer.generate();

    assert.equal(renamer.editNameButton.disabled, false);
    assert.equal(renamer.editNameButton.title, 'Hide Activity Renamer');
    assert.equal(renamer.editNameButton.getAttribute('aria-expanded'), 'true');
    assert.ok(renamer.panel.querySelectorAll('button')
        .find(button => button.className === 'activity-renamer-chip-name'));
});

test('re-injects the button when Strava re-renders the title field', async () => {
    const renamer = loadRenamer();
    await renamer.ready;
    const form = renamer.document.querySelector('form');
    renamer.editNameButton.click();
    assert.ok(renamer.panel);

    // Strava rebuilds the field, throwing our wrapper away with it.
    form.replaceChildren();
    const label = renamer.document.createElement('label');
    label.setAttribute('for', 'activity_name');
    const input = renamer.document.createElement('input');
    input.setAttribute('name', 'activity[name]');
    form.append(label, input);
    assert.equal(renamer.button, null);

    for (const observer of renamer.observers.filter(candidate => candidate.connected)) {
        observer.emit();
    }

    assert.ok(renamer.button, 'the button comes back');
    assert.ok(renamer.panel, 'the open panel is mounted again');
    assert.equal(renamer.editNameButton.getAttribute('aria-expanded'), 'true');
    assert.equal(renamer.observers.filter(observer => observer.connected).length, 1);
});

test('reports an activity without GPS instead of naming it', async () => {
    const renamer = loadRenamer({ gpx: '<?xml version="1.0"?><gpx version="1.1"></gpx>' });

    await renamer.generate();

    assert.deepEqual(renamer.alerts, ['No GPS data found (manual entry or indoor activity?)']);
    assert.equal(renamer.name, '');
    assert.equal(renamer.editNameButton.disabled, false);
});
