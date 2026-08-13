import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chipNames,
    activateGroup,
    nameChip,
    openPanel,
    panelButton,
    panelField,
    panelText,
    sectionTitles,
    typeInto,
} from './support/dialog.mjs';
import {
    jsonResponse,
    loadFixture,
    loadRenamer,
    loadScenario,
} from './support/harness.mjs';

const SAVED_PLACES_KEY = 'activity_renamer_saved_places_v1';
const RIDE_KEY = 'activity_renamer_ride_names_v1';

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
    openPanel(renamer);

    assert.deepEqual(sectionTitles(renamer), [
        'Also passed (0)',
    ]);
    assert.equal(renamer.panel.querySelector('#activity-renamer-backup-input'), null);
    assert.deepEqual(chipNames(renamer), renamer.name.split(' - '),
        'one chip per part of the title, in the order they are written');
    const favorites = panelButton(renamer, 'Favorites (0)');
    const never = panelButton(renamer, 'Never in a name (0)');
    assert.equal(favorites.getAttribute('aria-expanded'), 'false');
    assert.equal(never.getAttribute('aria-expanded'), 'false');

    favorites.click();

    assert.equal(panelButton(renamer, 'Favorites (0)').getAttribute('aria-expanded'), 'true');
    assert.equal(panelButton(renamer, 'Never in a name (0)').getAttribute('aria-expanded'), 'false');
    assert.equal(
        renamer.panel.querySelector('label[for="activity-renamer-address-input"]').textContent,
        'Address',
    );

    panelButton(renamer, 'Never in a name (0)').click();

    assert.equal(panelButton(renamer, 'Favorites (0)').getAttribute('aria-expanded'), 'true');
    assert.equal(panelButton(renamer, 'Never in a name (0)').getAttribute('aria-expanded'), 'true');
    assert.ok(renamer.panel.querySelector('#activity-renamer-favorites'));
    assert.ok(renamer.panel.querySelector('#activity-renamer-never'));
});

test('embeds a region beside Title and leaves focus in the page flow', async () => {
    const renamer = loadRenamer();
    await renamer.ready;
    const panel = openPanel(renamer);

    assert.equal(panel.tagName, 'section');
    assert.equal(panel.getAttribute('role'), 'region');
    assert.equal(panel.getAttribute('aria-modal'), null);
    assert.equal(panel.getAttribute('aria-labelledby'), null);
    assert.equal(panel.getAttribute('aria-label'), 'Activity Renamer');
    assert.equal(panel.querySelector('h3'), null);
    assert.equal(panel.parentNode, renamer.input.parentNode);
    const siblings = panel.parentNode.children;
    const description = siblings.find(element => element.textContent === 'Description');
    assert.equal(siblings.indexOf(panel), siblings.indexOf(renamer.input) + 1);
    assert.ok(siblings.indexOf(panel) < siblings.indexOf(description));
    assert.equal(panel.querySelectorAll('form').length, 0, 'the Strava form has no nested forms');
    assert.equal(renamer.editNameButton.getAttribute('aria-expanded'), 'true');
    assert.equal(renamer.document.activeElement, renamer.editNameButton);

    renamer.editNameButton.click();

    assert.equal(renamer.panel, null);
    assert.equal(renamer.editNameButton.getAttribute('aria-expanded'), 'false');
});

test('shows the calculated place count and overrides it for this ride', async () => {
    const { fixture, renamer } = loadScenario('dense-settlements');
    await renamer.generate();
    openPanel(renamer);

    const limit = panelField(renamer, 'activity-renamer-name-place-count');
    assert.equal(limit.tagName, 'input');
    assert.equal(limit.type, 'number');
    assert.equal(limit.min, '2');
    assert.equal(limit.max, undefined, 'the input has no upper limit');
    assert.equal(limit.step, '1');
    assert.equal(limit.value, String(renamer.name.split(' - ').length));
    assert.equal(
        renamer.panel.querySelector('label[for="activity-renamer-name-place-count"]').textContent,
        'Places in name',
    );
    const help = renamer.panel.querySelector('#activity-renamer-name-place-count-tooltip');
    assert.equal(help.getAttribute('role'), 'tooltip');
    assert.match(help.textContent, /Calculated for this route/);
    assert.match(help.textContent, /override this activity/);
    assert.match(help.textContent, /Start, finish, Favorites and manual additions are always kept/);
    assert.equal(
        limit.getAttribute('aria-describedby'),
        'activity-renamer-name-place-count-tooltip',
    );
    assert.equal(
        renamer.panel.querySelector('#activity-renamer-name-place-count-note'),
        null,
        'the explanatory note is not permanently visible',
    );
    const calculatedCount = Number(limit.value);

    limit.value = '6';
    limit.dispatchEvent({ type: 'input' });

    assert.equal(renamer.name.split(' - ').length, 6,
        'the native number-input event updates the name immediately');

    const shortened = panelField(renamer, 'activity-renamer-name-place-count');
    shortened.value = '3';
    shortened.dispatchEvent({ type: 'change' });

    assert.equal(renamer.name.split(' - ').length, 3);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(RIDE_KEY)), [{
        activityId: fixture.activityId,
        kept: [],
        dropped: [],
        placeCount: 3,
    }]);
    assert.equal(renamer.editNameButton.textContent, '1');
    assert.equal(panelField(renamer, 'activity-renamer-name-place-count').value, '3');
    assert.equal(
        renamer.document.activeElement,
        panelField(renamer, 'activity-renamer-name-place-count'),
    );

    const unlimited = panelField(renamer, 'activity-renamer-name-place-count');
    unlimited.value = '12';
    unlimited.dispatchEvent({ type: 'change' });

    assert.equal(
        panelField(renamer, 'activity-renamer-name-place-count').value,
        String(renamer.name.split(' - ').length),
        'the field reports the resulting count, not merely the requested count',
    );
    assert.ok(
        renamer.name.split(' - ').length > calculatedCount,
        'a manual override can exceed the route-length calculation',
    );
    assert.equal(JSON.parse(renamer.userscriptStore.get(RIDE_KEY))[0].placeCount, 12);

    const invalid = panelField(renamer, 'activity-renamer-name-place-count');
    invalid.value = '1';
    invalid.dispatchEvent({ type: 'change' });

    assert.equal(
        panelField(renamer, 'activity-renamer-name-place-count').value,
        String(renamer.name.split(' - ').length),
    );
    assert.match(panelText(renamer), /whole number of 2 or more/i);
    assert.equal(
        panelField(renamer, 'activity-renamer-name-place-count').getAttribute('aria-describedby'),
        'activity-renamer-name-place-count-tooltip activity-renamer-name-place-count-note',
    );
    assert.equal(JSON.parse(renamer.userscriptStore.get(RIDE_KEY))[0].placeCount, 12);

    const automatic = panelField(renamer, 'activity-renamer-name-place-count');
    automatic.value = '';
    automatic.dispatchEvent({ type: 'change' });

    assert.equal(renamer.name, fixture.expected);
    assert.equal(panelField(renamer, 'activity-renamer-name-place-count').value, '7');
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(RIDE_KEY)), []);
    assert.equal(renamer.editNameButton.textContent, '');
});

test('exposes the protected places as the real minimum', async () => {
    const fixture = loadFixture('dense-settlements');
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: {
            [RIDE_KEY]: JSON.stringify([{
                activityId: fixture.activityId,
                kept: ['Werben'],
                dropped: [],
            }]),
        },
    });
    await renamer.generate();
    openPanel(renamer);

    const count = panelField(renamer, 'activity-renamer-name-place-count');
    assert.equal(count.min, '3');
    count.value = '2';
    count.dispatchEvent({ type: 'change' });

    assert.match(panelText(renamer), /3 protected places/i);
    assert.equal(panelField(renamer, 'activity-renamer-name-place-count').value, '7');
});

test('keeps roads separate and collapsed when settlements fill the name', async () => {
    const { fixture, renamer } = loadScenario('dense-settlements');

    assert.equal(await renamer.generate(), fixture.expected);
    openPanel(renamer);

    const collapsed = panelButton(renamer, 'Roads (1)');
    assert.doesNotMatch(panelText(renamer), /Burger Chaussee/);

    collapsed.click();

    assert.ok(panelButton(renamer, 'Roads (1)'));
    assert.match(panelText(renamer), /Burger Chaussee/);
});

test('renames a place from its chip in the name', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const { renamer } = loadScenario('loop-with-revisit');

    assert.equal(await renamer.generate(), fixture.expected);
    openPanel(renamer);

    // The chip is the place: clicking its name is how it gets another one.
    nameChip(renamer, 'Burg').rename.click();

    assert.equal(
        renamer.panel.querySelector('label[for="activity-renamer-place-name-input"]').textContent,
        'Place name',
    );

    typeInto(panelField(renamer, 'activity-renamer-place-name-input'), 'Gurkenpause');
    typeInto(panelField(renamer, 'activity-renamer-place-radius-input'), '500');
    activateGroup(panelField(renamer, 'activity-renamer-place-name-input'));

    assert.equal(renamer.alerts.length, 0, 'nothing is asked through a modal prompt');
    assert.match(renamer.name, /Gurkenpause/);
    assert.equal(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY)).length, 1);
    assert.ok(chipNames(renamer).includes('Gurkenpause'));
});

test('reports a bad radius in the form and keeps the values', async () => {
    const { renamer } = loadScenario('loop-with-revisit');
    await renamer.generate();
    openPanel(renamer);
    nameChip(renamer, 'Burg').rename.click();

    typeInto(panelField(renamer, 'activity-renamer-place-name-input'), 'Zu weit');
    typeInto(panelField(renamer, 'activity-renamer-place-radius-input'), '9000');
    activateGroup(panelField(renamer, 'activity-renamer-place-name-input'));

    assert.match(panelText(renamer), /radius must be a number from 10 to 5000/i);
    assert.equal(panelField(renamer, 'activity-renamer-place-name-input').value, 'Zu weit',
        'the typed name survives the error');
    assert.equal(renamer.userscriptStore.has(SAVED_PLACES_KEY), false);
});

test('deletes a saved place only after a second click', async () => {
    const renamer = loadRenamer({
        userscriptStorage: { [SAVED_PLACES_KEY]: JSON.stringify([burgPlace]) },
    });
    await renamer.ready;
    openPanel(renamer);
    panelButton(renamer, 'Favorites (1)').click();

    panelButton(renamer, 'Delete').click();

    assert.equal(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY)).length, 1);

    panelButton(renamer, 'Confirm delete').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY)), []);
});

test('edits an existing Favorite inside the page', async () => {
    const renamer = loadRenamer({
        userscriptStorage: { [SAVED_PLACES_KEY]: JSON.stringify([burgPlace]) },
    });
    await renamer.ready;
    openPanel(renamer);
    panelButton(renamer, 'Favorites (1)').click();

    panelButton(renamer, 'Edit').click();

    const name = panelField(renamer, 'activity-renamer-place-name-input');
    assert.equal(name.value, 'Gurkenpause');
    typeInto(name, 'Spreewaldpause');
    activateGroup(name);

    assert.equal(
        JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY))[0].name,
        'Spreewaldpause',
    );
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

    openPanel(renamer);
    panelButton(renamer, 'Favorites (0)').click();
    typeInto(panelField(renamer, 'activity-renamer-address-input'), 'Bismarckturm Burg');
    panelField(renamer, 'activity-renamer-address-input')
        .dispatchEvent({ type: 'keydown', key: 'Enter' });
    await renamer.settle();

    assert.match(panelText(renamer), /Bismarckturm/);
    assert.match(panelText(renamer), /Found 1/);

    panelButton(renamer, '☆ Save').click();
    activateGroup(panelField(renamer, 'activity-renamer-place-name-input'));

    assert.equal(JSON.parse(renamer.userscriptStore.get(SAVED_PLACES_KEY))[0].name, 'Bismarckturm');
});
