# Strava Activity Route Renamer

A Tampermonkey userscript that names a Strava activity after the places the
route actually passes, read like a travel narrative:

    Cottbus - Sielow - Guhrow - Burg - Dissen - Sielow - Cottbus

It downloads the activity GPX, asks Overpass for the OSM settlements and named
roads along the track, and fills in the title field on the activity edit page.

## Install

Open `strava-rename.user.js` in Tampermonkey. The script asks for
`GM_xmlhttpRequest` (so Strava's Content-Security-Policy cannot block Overpass
or Nominatim) and `GM_getValue`/`GM_setValue` (so the saved places survive
clearing the site data). Without those grants it falls back to `fetch` and
`localStorage` and still works. There is no `@updateURL`: a local copy has to be
re-imported by hand after every change.

## How a name is built

1. **GPX** — the full-resolution track is downloaded from Strava.
2. **Overpass** — one query returns `place=city|town|village` nodes within
   `placeRadiusM` of the simplified track, plus named roads within
   `roadMatchRadiusM`. Roads are only used when settlements are scarce. Three
   mirrors are tried in turn, so a busy instance costs a second, not a retry
   cycle.
3. **Passages** — every distinct pass within the radius of a feature becomes an
   event, ordered along the track. Adjacent duplicates merge; a genuine revisit
   stays in the name.
4. **Selection** — `automaticPlaceLimit` derives the number of slots from the
   route's *map extent* (not its length). The first and last settlement are
   always kept — a street the ride merely started on is dropped rather than
   promoted — favorites and pinned places never lose their slot, and the rest
   goes to the settlements that spread widest over the map.

Everything is tunable in the `CONFIG` block at the top of the script. Settings
that change what gets cached are part of the cache signature, so editing one
invalidates stale entries automatically.

## The ★ dialog

Everything is edited inline, with a live preview of the resulting title:

- **Add by address** — Nominatim search; pick a result and give it a name.
- **Saved places** — a custom name replaces the OSM name whenever the route
  comes within the saved radius. Deleting asks once.
- **Never in a name** — a blocked name is left out of every title (the suburb
  you start in, a generic street name).
- **Always in a name** — a pinned name is kept even when the automatic slots
  run out. Pinning a blocked place unblocks it, and the other way round.
- **Backup** — the JSON of everything above, to copy out or paste back in.

Blocking, pinning, and editing a favorite rewrite the title immediately.

## Tests

    npm test

No dependencies, no network: `test/harness.mjs` evaluates the userscript in a
`node:vm` sandbox with a stubbed edit page (`test/dom.mjs`), stubbed storage and
`GM_*` API, immediate timers and a scripted `fetch`. A test clicks the button
and asserts the value that lands in the title field, so the assertions cover the
same path the browser takes. `test/dialog.mjs` drives the dialog the way a user
does — every action re-renders it, so elements are looked up again after each
click.

### Fixtures

`test/fixtures/*.json` describe a scenario in readable form:

```json
{
  "activityId": "19000955530",
  "expected": "Cottbus - Sielow - ...",
  "stepM": 20,
  "places": [{ "id": 1, "name": "Sielow - Žylow", "place": "village", "lat": 51.793, "lon": 14.287 }],
  "roads":  [{ "id": 2, "name": "Dorfstraße", "highway": "residential", "geometry": [[51.79, 14.28], [51.80, 14.27]] }],
  "waypoints": [[51.757, 14.332], [51.7925, 14.2875]]
}
```

`waypoints` are densified to a synthetic 1-point-per-`stepM` track, and
`places`/`roads` are turned into an Overpass response. The coordinates are the
real Lusatian villages, so distances behave like the user's actual rides.

To pin a regression against a **real** activity, export its GPX from Strava,
drop it next to the fixtures and reference it instead of `waypoints`:

```json
{ "gpxFile": "19000955530.gpx", "expected": "..." }
```

A real Overpass reply can be captured the same way — save the JSON body and
load it in the test with `jsonResponse(JSON.parse(...))` instead of
`overpassElements(fixture)`. This matters because low-resolution tracks pick
different corners than the full-resolution GPX the browser uses.

### Benchmarking a change

`USERSCRIPT_PATH` points the harness at another revision, which is how the grid
index was measured against the previous full scan:

```sh
git show HEAD:strava-rename.user.js > /tmp/old.js
USERSCRIPT_PATH=/tmp/old.js node your-benchmark.mjs
```
