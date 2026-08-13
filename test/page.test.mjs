import assert from 'node:assert/strict';
import test from 'node:test';

import {
    loadRenamer,
} from './support/harness.mjs';
// A page's style-src can drop an injected <style> tag, but never reaches a
// constructed sheet — the same reason the network calls avoid page fetch.
test('adopts its stylesheet through the CSSOM when it can', () => {
    const renamer = loadRenamer({ constructedStylesheets: true });

    assert.equal(renamer.document.adoptedStyleSheets.length, 1);
    assert.match(renamer.document.adoptedStyleSheets[0].cssText, /\.strava-route-panel/);
    assert.equal(renamer.byId('strava-route-styles'), null, 'no <style> tag is needed');
});

test('falls back to a style tag on engines without constructed sheets', () => {
    const renamer = loadRenamer();
    const style = renamer.byId('strava-route-styles');

    assert.ok(style, 'the stylesheet is installed');
    assert.match(style.textContent, /\.strava-route-panel/);
    assert.equal(style.parentNode, renamer.document.head);
});

test('stops watching the whole page once the button is in', () => {
    const renamer = loadRenamer();

    assert.ok(renamer.button, 'the button is injected on load');
    assert.equal(renamer.observers.filter(observer => observer.connected).length, 1,
        'exactly one narrow observer is left watching');
});

test('re-injects the button when Strava re-renders the title field', () => {
    const renamer = loadRenamer();
    const form = renamer.document.querySelector('form');

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
    assert.equal(renamer.observers.filter(observer => observer.connected).length, 1);
});

test('reports an activity without GPS instead of naming it', async () => {
    const renamer = loadRenamer({ gpx: '<?xml version="1.0"?><gpx version="1.1"></gpx>' });

    await renamer.generate();

    assert.deepEqual(renamer.alerts, ['No GPS data found (manual entry or indoor activity?)']);
    assert.equal(renamer.name, '');
});
