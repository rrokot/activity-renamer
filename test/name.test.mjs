import assert from 'node:assert/strict';
import test from 'node:test';

import {
    densifyTrack,
    jsonResponse,
    loadFixture,
    loadRenamer,
    loadScenario,
    overpassElements,
    toGpx,
} from './support/harness.mjs';
test('names a loop as a travel narrative of the settlements passed', async () => {
    const { fixture, renamer } = loadScenario('loop-with-revisit');

    const name = await renamer.generate();

    assert.equal(name, fixture.expected);
    assert.doesNotMatch(name, /Schmogrow/, 'a village skirted at 900 m is not visited');
    assert.equal(name.split(' - ').filter(part => part === 'Sielow').length, 2,
        'a revisited village stays in the narrative twice');
    assert.doesNotMatch(name, /Chóśebuz|Žylow|\(/,
        'bilingual variants and parentheticals are stripped');
});

test('falls back to named roads when settlements are scarce', async () => {
    const { fixture, renamer } = loadScenario('road-fallback');

    const name = await renamer.generate();

    assert.equal(name, fixture.expected);
    assert.doesNotMatch(name, /Feldweg/, 'a track is not a nameworthy road');
});

test('starts and ends at a settlement rather than at a street', async () => {
    const { fixture, renamer } = loadScenario('road-endpoints');

    const name = await renamer.generate();

    assert.equal(name, fixture.expected);
    assert.doesNotMatch(name, /Bahnhofstraße|Werbener Weg/);
});

test('spreads the limited slots over the map when settlements are dense', async () => {
    const { fixture, renamer } = loadScenario('dense-settlements');
    const known = new Set(fixture.places
        .map(place => place.name.split(' - ')[0].replace(/\s*\([^)]*\)$/, '')));

    const name = await renamer.generate();
    const parts = name.split(' - ');

    assert.equal(name, fixture.expected);
    assert.equal(parts[0], 'Cottbus');
    assert.equal(parts[parts.length - 1], 'Cottbus');
    assert.ok(parts.length <= 7, `expected at most 7 parts, got ${parts.length}`);
    for (const part of parts) assert.ok(known.has(part), `${part} is not a fixture place`);
});

// The browser always names the full-resolution GPX, while the fixtures are
// coarse. A different sampling must not pick different corners.
test('names a full-resolution track the same way', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const points = densifyTrack(fixture.waypoints, 5);
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(points),
        overpassResponses: [jsonResponse({ elements: overpassElements(fixture) })],
    });

    assert.ok(points.length > 7000, `expected a dense track, got ${points.length} points`);
    assert.equal(await renamer.generate(), fixture.expected);
});

// Overpass hands back every named road along a long ride. Matching them must
// not degrade into a scan of the whole track per road.
test('stays fast when Overpass returns hundreds of roads', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const points = densifyTrack(fixture.waypoints, 5);
    const roads = Array.from({ length: 300 }, (unused, i) => {
        const [lat, lon] = points[Math.floor((i / 300) * (points.length - 1))];
        return {
            id: 50000000 + i,
            name: `Straße ${i}`,
            highway: 'residential',
            stepM: 25,
            geometry: [[lat + 0.0004, lon - 0.004], [lat + 0.0004, lon + 0.004]],
        };
    });
    // Only one settlement, so the road fallback actually runs.
    const elements = overpassElements({ ...fixture, places: fixture.places.slice(0, 1), roads });
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(points),
        overpassResponses: [jsonResponse({ elements })],
    });

    const started = performance.now();
    const name = await renamer.generate();
    const elapsedMs = performance.now() - started;

    assert.match(name, /^Cottbus - .*Straße.* - Cottbus$/);
    assert.ok(name.split(' - ').length <= 7);
    assert.ok(elapsedMs < 5000, `naming took ${elapsedMs.toFixed(0)} ms`);
});

test('a saved place renames the settlement it covers', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        storage: {
            strava_route_saved_places_v1: JSON.stringify([{
                id: 'place_burg',
                name: 'Gurkenpause',
                lat: 51.85,
                lon: 14.145,
                radiusM: 500,
                address: 'Burg (Spreewald)',
            }]),
        },
    });

    const name = await renamer.generate();

    assert.equal(name, 'Cottbus - Sielow - Guhrow - Gurkenpause - Dissen - Sielow - Cottbus');
});

test('a saved place away from any settlement joins the narrative', async () => {
    const { renamer } = loadScenario('loop-with-revisit', {
        storage: {
            strava_route_saved_places_v1: JSON.stringify([{
                id: 'place_rast',
                name: 'Kahnfährhafen',
                lat: 51.83,
                lon: 14.19,
                radiusM: 300,
                address: 'Zwischen Burg und Dissen',
            }]),
        },
    });

    const name = await renamer.generate();

    assert.match(name, /Kahnfährhafen/);
    assert.equal(name.split(' - ')[0], 'Cottbus');
});

test('keeps the title within the length Strava accepts', async () => {
    const fixture = loadFixture('loop-with-revisit');
    const places = fixture.places.map(place => ({
        ...place,
        name: `${place.name.split(' - ')[0]} an der Spree im Oberspreewald`,
    }));
    const renamer = loadRenamer({
        activityId: fixture.activityId,
        gpx: toGpx(fixture.points),
        overpassResponses: [
            jsonResponse({ elements: overpassElements({ ...fixture, places }) }),
        ],
    });

    const name = await renamer.generate();

    assert.ok(name.length <= 200, `title is ${name.length} characters long`);
    assert.match(name, /^Cottbus an der Spree im Oberspreewald - /, 'the start survives');
    assert.match(name, / - Cottbus an der Spree im Oberspreewald$/, 'the finish survives');
});
