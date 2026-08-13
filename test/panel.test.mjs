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
    passedRowButton,
    sectionTitles,
    typeInto,
} from './support/panel.mjs';
import {
    jsonResponse,
    loadFixture,
    loadRenamer,
    loadScenario,
} from './support/harness.mjs';

const FAVORITES_KEY = 'activity_renamer_saved_places_v1';
const ACTIVITY_OVERRIDES_KEY = 'activity_renamer_ride_names_v1';
const AUTO_PLACE_SPACING_KEY = 'activity_renamer_auto_place_spacing_km_v1';

const burgPlace = {
    id: 'place_burg',
    name: 'Gurkenpause',
    lat: 51.85,
    lon: 14.145,
    radiusM: 500,
    address: 'Burg (Spreewald)',
};

test('the four place collections behave as one tab set', async () => {
    const { renamer } = loadScenario('loop-with-revisit');

    await renamer.generate();
    openPanel(renamer);

    assert.deepEqual(sectionTitles(renamer), []);
    assert.deepEqual(chipNames(renamer), renamer.name.split(' - '),
        'one chip per part of the title, in the order they are written');
    const favorites = panelButton(renamer, 'Favorites');
    const never = panelButton(renamer, 'Excluded');
    const places = panelButton(renamer, 'Other places');
    const roads = panelButton(renamer, 'Other roads');
    const tabs = [places, roads, favorites, never];
    const tablist = renamer.panel.querySelectorAll('div')
        .find(element => element.className === 'activity-renamer-section-tabs');
    const sectionIcons = tablist.querySelectorAll('svg');
    assert.equal(sectionIcons.length, 4);
    assert.ok(sectionIcons.every(icon => icon.getAttribute('aria-hidden') === 'true'));
    assert.ok(tabs
        .every(button => button.children.every(child =>
            child.tagName === 'svg'
            || child.className === 'activity-renamer-sr-only')),
    'tabs show only icons while retaining hidden accessible names');
    assert.ok(tabs.every(button => button.querySelectorAll('span')
        .every(span => !span.className.includes('activity-renamer-chevron'))));
    assert.equal(places.className, favorites.className,
        'all four collections use the same visual treatment');
    assert.equal(tablist.getAttribute('role'), 'tablist');
    assert.ok(tabs.every(tab => tab.getAttribute('role') === 'tab'));
    assert.equal(places.getAttribute('aria-selected'), 'true');
    assert.equal(places.tabIndex, 0);
    assert.equal(favorites.getAttribute('aria-selected'), 'false');
    assert.equal(favorites.tabIndex, -1);

    favorites.click();

    assert.equal(panelButton(renamer, 'Favorites').getAttribute('aria-selected'), 'true');
    assert.equal(panelButton(renamer, 'Other places').getAttribute('aria-selected'), 'false');
    assert.equal(panelButton(renamer, 'Excluded').getAttribute('aria-selected'), 'false');
    assert.equal(renamer.panel.querySelector('#activity-renamer-favorites').getAttribute('role'),
        'tabpanel');
    assert.equal(
        renamer.panel.querySelector('label[for="activity-renamer-address-input"]').textContent,
        'Address',
    );

    panelButton(renamer, 'Favorites').click();
    assert.equal(panelButton(renamer, 'Favorites').getAttribute('aria-selected'), 'true',
        'clicking the active tab cannot collapse the tab set');

    panelButton(renamer, 'Favorites').dispatchEvent({
        type: 'keydown',
        key: 'ArrowRight',
        preventDefault() {},
    });

    assert.equal(panelButton(renamer, 'Favorites').getAttribute('aria-selected'), 'false');
    assert.equal(panelButton(renamer, 'Excluded').getAttribute('aria-selected'), 'true');
    assert.equal(renamer.panel.querySelector('#activity-renamer-favorites'), null);
    assert.ok(renamer.panel.querySelector('#activity-renamer-excluded'));
});

test('embeds a region beside Title and leaves focus in the page flow', async () => {
    const renamer = loadRenamer();
    await renamer.ready;
    const panel = openPanel(renamer);

    assert.equal(panel.tagName, 'section');
    assert.equal(panel.getAttribute('role'), 'region');
    assert.equal(panel.getAttribute('aria-labelledby'), null);
    assert.equal(panel.getAttribute('aria-label'), 'Activity Renamer');
    assert.equal(panel.querySelector('h3'), null);
    assert.equal(panel.parentNode, renamer.input.parentNode);
    const siblings = panel.parentNode.children;
    const description = siblings.find(element => element.textContent === 'Description');
    assert.equal(siblings.indexOf(panel), siblings.indexOf(renamer.input) + 1);
    assert.ok(siblings.indexOf(panel) < siblings.indexOf(description));
    assert.equal(panel.querySelectorAll('form').length, 0, 'the Strava form has no nested forms');
    assert.equal(renamer.panelToggleButton.getAttribute('aria-expanded'), 'true');
    assert.equal(renamer.document.activeElement, renamer.panelToggleButton);

    renamer.panelToggleButton.click();

    assert.equal(renamer.panel, null);
    assert.equal(renamer.panelToggleButton.getAttribute('aria-expanded'), 'false');
});

test('stores a permanent automatic place density', async () => {
    const { renamer } = loadScenario('dense-settlements');
    await renamer.generate();
    openPanel(renamer);

    const density = panelField(renamer, 'activity-renamer-auto-place-spacing');
    assert.equal(density.type, 'number');
    assert.equal(density.min, '0.1');
    assert.equal(density.max, undefined, 'the density field has no upper limit');
    assert.equal(density.step, '0.1');
    assert.equal(density.value, '1.3');
    const densityLabel = renamer.panel.querySelector(
        'label[for="activity-renamer-auto-place-spacing"]',
    );
    assert.equal(densityLabel.className, 'activity-renamer-sr-only');
    assert.match(density.title, /map span divided by this value/i);
    const count = panelField(renamer, 'activity-renamer-name-place-count');
    assert.equal(density.parentNode, count.parentNode);
    assert.ok(density.parentNode.children.indexOf(density)
        > density.parentNode.children.indexOf(count),
    'the unlabeled density input sits directly to the right of the place count');
    assert.equal(count.dataset.modeActive, 'false');
    assert.equal(density.dataset.modeActive, 'true');
    assert.match(density.title, /automatic mode is active/i);
    assert.match(
        renamer.document.adoptedStyleSheets[0].cssText,
        /activity-renamer-mode-field\[data-mode-active="true"\]/,
    );

    count.value = '6';
    count.dispatchEvent({ type: 'input' });
    assert.equal(renamer.name.split(' - ').length, 6);
    assert.equal(count.dataset.modeActive, 'true');
    assert.equal(density.dataset.modeActive, 'false');
    assert.match(count.title, /active/i);

    typeInto(density, '8');

    assert.equal(JSON.parse(renamer.userscriptStore.get(AUTO_PLACE_SPACING_KEY)), 8);
    assert.equal(renamer.name.split(' - ').length, 3);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY)), [],
        'changing density returns the current activity to automatic mode');
    assert.equal(panelField(renamer, 'activity-renamer-name-place-count').value, '3');
    assert.equal(count.dataset.modeActive, 'false');
    assert.equal(density.dataset.modeActive, 'true');

    const invalid = density;
    invalid.value = '0';
    invalid.dispatchEvent({ type: 'change' });

    assert.equal(JSON.parse(renamer.userscriptStore.get(AUTO_PLACE_SPACING_KEY)), 8);
    assert.match(panelText(renamer), /number of 0\.1 or more/i);
    assert.equal(
        panelField(renamer, 'activity-renamer-auto-place-spacing')
            .getAttribute('aria-describedby'),
        'activity-renamer-auto-place-spacing-note',
    );
});

test('shows the calculated place count and overrides it for this ride', async () => {
    const { fixture, renamer } = loadScenario('dense-settlements');
    await renamer.generate();
    openPanel(renamer);

    const limit = panelField(renamer, 'activity-renamer-name-place-count');
    assert.equal(limit.tagName, 'input');
    assert.equal(limit.type, 'number');
    assert.equal(limit.min, '2');
    assert.equal(limit.max, undefined, 'the numeric field has no upper limit');
    assert.equal(limit.step, '1');
    assert.equal(limit.value, String(renamer.name.split(' - ').length));
    const slider = panelField(renamer, 'activity-renamer-name-place-count-slider');
    assert.equal(slider.type, 'range');
    assert.equal(slider.min, '2');
    assert.equal(slider.max, '10');
    assert.equal(slider.step, '1');
    assert.equal(slider.value, limit.value);
    assert.equal(
        slider.style.getPropertyValue('--activity-renamer-slider-progress'),
        '62.5%',
    );
    assert.equal(
        renamer.panel.querySelector('label[for="activity-renamer-name-place-count"]').className,
        'activity-renamer-sr-only',
        'the shared control label remains available to assistive technology',
    );
    const countBlock = limit.parentNode.parentNode;
    const chips = countBlock.nextSibling;
    assert.equal(chips.className, 'activity-renamer-chips');
    assert.ok(renamer.panel.children.indexOf(countBlock) < renamer.panel.children.indexOf(chips),
        'the count controls sit immediately before the place chips');
    assert.equal(limit.getAttribute('aria-describedby'), null);
    assert.equal(
        renamer.panel.querySelector('#activity-renamer-name-place-count-note'),
        null,
        'the explanatory note is not permanently visible',
    );
    const calculatedCount = Number(limit.value);
    const namesBeforeSlider = chipNames(renamer);

    slider.value = '4';
    slider.dispatchEvent({ type: 'input' });

    assert.equal(renamer.name.split(' - ').length, 4,
        'dragging the slider updates the name immediately');
    assert.equal(limit.value, '4', 'the linked number follows the slider');
    assert.equal(
        slider.style.getPropertyValue('--activity-renamer-slider-progress'),
        '25%',
    );
    assert.equal(chipNames(renamer).length, 4,
        'the chips update while the slider is moving');
    assert.equal(panelField(renamer, 'activity-renamer-name-place-count-slider'), slider,
        'live updates keep the dragged slider mounted');
    const namesAfterSlider = chipNames(renamer);
    const returnedPlace = namesBeforeSlider.find(name =>
        namesBeforeSlider.filter(candidate => candidate === name).length
        > namesAfterSlider.filter(candidate => candidate === name).length);
    assert.ok(returnedPlace, 'reducing the count removes one place from the name');
    assert.ok(passedRowButton(renamer, 'Add', returnedPlace),
        'the removed place returns to Other places while the slider is moving');

    const shortened = panelField(renamer, 'activity-renamer-name-place-count');
    shortened.value = '3';
    shortened.dispatchEvent({ type: 'change' });

    assert.equal(renamer.name.split(' - ').length, 3);
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY)), [{
        activityId: fixture.activityId,
        kept: [],
        placeCount: 3,
    }]);
    assert.equal(renamer.panelToggleButton.textContent, '');
    assert.equal(panelField(renamer, 'activity-renamer-name-place-count').value, '3');
    assert.equal(
        renamer.document.activeElement,
        panelField(renamer, 'activity-renamer-name-place-count'),
    );

    const expanded = panelField(renamer, 'activity-renamer-name-place-count');
    expanded.value = '12';
    expanded.dispatchEvent({ type: 'change' });

    assert.equal(
        panelField(renamer, 'activity-renamer-name-place-count').value,
        String(renamer.name.split(' - ').length),
        'the field reports the resulting count, not merely the requested count',
    );
    assert.ok(
        renamer.name.split(' - ').length > calculatedCount,
        'a manual override can exceed the route-length calculation',
    );
    assert.equal(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY))[0].placeCount, 12);

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
        'activity-renamer-name-place-count-note',
    );
    assert.equal(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY))[0].placeCount, 12);

    const automatic = panelField(renamer, 'activity-renamer-name-place-count');
    automatic.value = '';
    automatic.dispatchEvent({ type: 'change' });

    assert.equal(renamer.name, fixture.expected);
    assert.equal(
        panelField(renamer, 'activity-renamer-name-place-count').value,
        String(fixture.expected.split(' - ').length),
    );
    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY)), []);
    assert.equal(renamer.panelToggleButton.textContent, '');
});

test('treats the selected count as final when a manual place would exceed it', async () => {
    const fixture = loadFixture('dense-settlements');
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: {
            [ACTIVITY_OVERRIDES_KEY]: JSON.stringify([{
                activityId: fixture.activityId,
                kept: ['Werben'],
            }]),
        },
    });
    await renamer.generate();
    openPanel(renamer);

    const count = panelField(renamer, 'activity-renamer-name-place-count');
    const slider = panelField(renamer, 'activity-renamer-name-place-count-slider');
    assert.equal(count.min, '2');
    assert.equal(slider.min, '2');
    assert.equal(slider.max, '10');
    count.value = '2';
    count.dispatchEvent({ type: 'change' });

    assert.equal(panelField(renamer, 'activity-renamer-name-place-count').value, '2');
    assert.equal(chipNames(renamer).length, 2,
        'manual additions are prioritized but do not overflow the final count');
    assert.equal(JSON.parse(renamer.userscriptStore.get(ACTIVITY_OVERRIDES_KEY))[0].placeCount, 2,
        'the requested final count remains two');
});

test('does not let many Favorites overflow the count selected on the slider', async () => {
    const fixture = loadFixture('dense-settlements');
    const favorites = fixture.places.map((place, index) => ({
        id: `favorite_${index}`,
        name: `Favorite ${index + 1}`,
        lat: place.lat,
        lon: place.lon,
        radiusM: 500,
        address: place.name,
    }));
    const { renamer } = loadScenario('dense-settlements', {
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify(favorites) },
    });
    await renamer.generate();
    openPanel(renamer);

    assert.ok(chipNames(renamer).length > 2, 'the route begins with many Favorite visits');
    const slider = panelField(renamer, 'activity-renamer-name-place-count-slider');
    slider.value = '2';
    slider.dispatchEvent({ type: 'input' });

    assert.equal(chipNames(renamer).length, 2,
        'two on the slider means two resulting chips, even with many Favorites');
    assert.equal(renamer.name.split(' - ').length, 2);
});

test('keeps roads in their own tab when settlements fill the name', async () => {
    const { fixture, renamer } = loadScenario('dense-settlements');

    assert.equal(await renamer.generate(), fixture.expected);
    openPanel(renamer);

    const roadsTab = panelButton(renamer, 'Other roads');
    const werbenTitle = renamer.panel.querySelectorAll('div')
        .find(element => element.className === 'activity-renamer-row-title'
            && element.textContent === 'Werben');
    assert.equal(werbenTitle.nextSibling.textContent.includes('Werben'), false,
        'a place name is not repeated in its details line');
    assert.match(werbenTitle.nextSibling.textContent, /village/);
    assert.doesNotMatch(panelText(renamer), /Burger Chaussee/);

    roadsTab.click();

    assert.ok(panelButton(renamer, 'Other roads'));
    assert.match(panelText(renamer), /Burger Chaussee/);

    const pathData = button => button.querySelectorAll('path')
        .map(path => path.getAttribute('d'));
    const favoriteAction = renamer.panel.querySelectorAll('button')
        .find(button => button.title.startsWith('Save a preferred name for'));
    const excludeAction = renamer.panel.querySelectorAll('button')
        .find(button => button.title.startsWith('Exclude '));
    assert.ok(favoriteAction.className.includes('activity-renamer-neutral-button'));
    assert.ok(renamer.panelToggleButton.className.includes('activity-renamer-neutral-button'),
        'the panel chevron and Favorite actions share one neutral button style');
    assert.deepEqual(
        pathData(favoriteAction),
        pathData(panelButton(renamer, 'Favorites')),
        'Favorite actions reuse the section star SVG',
    );
    assert.deepEqual(
        pathData(excludeAction),
        pathData(panelButton(renamer, 'Excluded')),
        'exclude actions reuse the section exclusion SVG',
    );
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

    assert.equal(renamer.alerts.length, 0, 'the edit stays inside the panel');
    assert.match(renamer.name, /Gurkenpause/);
    assert.equal(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)).length, 1);
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
    assert.equal(renamer.userscriptStore.has(FAVORITES_KEY), false);
});

test('deletes a Favorite only after a second click', async () => {
    const renamer = loadRenamer({
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgPlace]) },
    });
    await renamer.ready;
    openPanel(renamer);
    panelButton(renamer, 'Favorites').click();

    panelButton(renamer, 'Delete').click();

    assert.equal(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)).length, 1);

    panelButton(renamer, 'Confirm delete').click();

    assert.deepEqual(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY)), []);
});

test('edits an existing Favorite inside the page', async () => {
    const renamer = loadRenamer({
        userscriptStorage: { [FAVORITES_KEY]: JSON.stringify([burgPlace]) },
    });
    await renamer.ready;
    openPanel(renamer);
    panelButton(renamer, 'Favorites').click();

    panelButton(renamer, 'Edit').click();

    const name = panelField(renamer, 'activity-renamer-place-name-input');
    assert.equal(name.value, 'Gurkenpause');
    typeInto(name, 'Spreewaldpause');
    activateGroup(name);

    assert.equal(
        JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY))[0].name,
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
    panelButton(renamer, 'Favorites').click();
    typeInto(panelField(renamer, 'activity-renamer-address-input'), 'Bismarckturm Burg');
    panelField(renamer, 'activity-renamer-address-input')
        .dispatchEvent({ type: 'keydown', key: 'Enter' });
    await renamer.settle();

    assert.match(panelText(renamer), /Bismarckturm/);
    assert.match(panelText(renamer), /Found 1/);

    panelButton(renamer, '☆ Save').click();
    activateGroup(panelField(renamer, 'activity-renamer-place-name-input'));

    assert.equal(JSON.parse(renamer.userscriptStore.get(FAVORITES_KEY))[0].name, 'Bismarckturm');
});
