# Activity Renamer

A Tampermonkey userscript that names a Strava activity after the places the
route actually passes, read like a travel narrative:

    Cottbus - Sielow - Guhrow - Burg - Dissen - Sielow - Cottbus

It downloads the activity GPX, asks Overpass for the OSM settlements and named
roads along the track, and fills in the title field on the activity edit page.

## Install

Open `activity-renamer.user.js` in Tampermonkey. The script asks for
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
   promoted — saved places and the places added to this ride by hand never lose
   their slot, and the rest goes to the settlements that spread widest over the
   map.

Everything is tunable in the `CONFIG` block at the top of the script. Settings
that change what gets cached are part of the cache signature, so editing one
invalidates stale entries automatically.

## The ✎ Adjust dialog

`✎ Adjust` sits next to the generate button and opens the name of the ride you
are editing. It counts what you changed about that name by hand — `✎ Adjust
(2)` on an activity you came back to — and nothing else: how many places are
saved for every ride is not news about this one.

The dialog is about one thing — the sentence in the title field — so that is
what it opens with, and everything below it is a setting behind that name.

- **This name** — the title as chips, one per part, in the order they are
  written: `[Cottbus ✕] [Sielow ✕] [Guhrow ✕]`. The chip's label renames the
  place, the ✕ takes it out of *this* ride. Under the chips stands the exact
  string the field will hold, which is shorter than the chips when Strava's
  length limit bites.
- **Also passed** — everything the route came near that the name does not
  mention: what the slots had no room for, what you took out by hand, and what
  the block list silences. `⊕ Add` puts a place into this name, `★ Rename`
  names it for every ride, `⛔ Never` silences it for every ride.
- **Saved places** — a saved name replaces the OSM one whenever a route comes
  within the radius, on every ride. Deleting asks once. The address search at
  the bottom adds a place the route never passed.
- **Never in a name** — the blocked names, and the way back.
- **Backup** — the JSON of the saved places and blocked names. Per-ride edits
  stay out of it.

Two decisions belong to the ride being edited and to no other: **added** and
**removed**. They are stored per activity id, they overrule the block list for
that title only, and the store holds the last `rideHistory` rides. Saying the
same thing about *every* ride is what a saved place and the block list are for.
Taking a place out undoes whatever put it there — a place you added is
un-added, a place the automatic choice picked is recorded as removed — so the
✕ always restores the name you had before your own click.

Every edit rewrites the title immediately.

## Tests

    npm test

No dependencies, no network: `test/support/harness.mjs` evaluates the userscript
in a `node:vm` sandbox with a stubbed edit page (`test/support/dom.mjs`), stubbed
storage and `GM_*` API, immediate timers and a scripted `fetch`. A test clicks
the button and asserts the value that lands in the title field, so the
assertions cover the same path the browser takes. `test/support/dialog.mjs`
drives the dialog the way a user does — every action re-renders it, so elements
are looked up again after each click.

Each file holds one subject, named after it:

| file | pins |
|---|---|
| `name.test.mjs` | the narrative: revisits, road fallback, endpoints, slots, length |
| `ride-edits.test.mjs` | adding and removing for one ride, the block list, the button's count |
| `dialog.test.mjs` | sections, chips, the editor and its errors, address search, backup |
| `storage.test.mjs` | userscript storage, the move out of `localStorage`, retired keys |
| `overpass.test.mjs` | mirrors, retries, transport, the passage cache |
| `page.test.mjs` | button injection, observers, stylesheet, an activity without GPS |

### Fixtures

`test/fixtures/*.json` describe a scenario in readable form, named after the
behaviour it pins rather than the region it was traced from:

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
git show HEAD:activity-renamer.user.js > /tmp/old.js
USERSCRIPT_PATH=/tmp/old.js node your-benchmark.mjs
```
