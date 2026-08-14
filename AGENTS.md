# Activity Renamer development guide

This file is for contributors and coding agents. Keep `README.md` focused on
installation, usage and user-visible behaviour.

## Project shape

- `activity-renamer.user.js` is the complete userscript and the only production
  source file.
- `package.json` contains the matching package version and the test command.
- `test/*.test.mjs` contains behavioural tests.
- `test/support/` contains the DOM, panel and userscript harness.
- `test/fixtures/` contains readable route scenarios.

The production script intentionally has no runtime dependencies or build step.
Keep it directly installable in Tampermonkey.

## Tampermonkey runtime

Use only the modern promise-based APIs currently declared in the metadata:

- `GM.xmlHttpRequest` for Overpass and Nominatim;
- `GM.getValues` for the initial batch read;
- `GM.setValue` for settings writes.

Do not add legacy `GM_*` APIs, plain-fetch cross-origin fallbacks, settings
fallbacks, migrations or compatibility branches unless the user explicitly
requests them.

When the source is loaded from a local wrapper through `@require`, Tampermonkey
uses the wrapper's metadata. The wrapper must repeat every required `@grant`,
`@connect`, `@match` and `@run-at`; the metadata inside the required file is
ignored for permissions.

## Panel styling

The panel has to read as part of the edit form, so it borrows rather than
imitates. Three rules keep it there:

- Dress controls in Strava's own classes through `STRAVA_CLASS`
  (`btn btn-primary btn-sm`, `btn btn-default btn-sm`, `form-control input-sm`,
  `sr-only`) instead of writing a button or field skin. `STYLES` then owns
  layout, the panel shell and the parts Strava has no class for.
- Do not repeat what those classes already paint, not even as a fallback. The
  script is tied to the editor's markup anyway, so a Strava rewrite means a
  visibly broken panel and a fix, which beats a panel that keeps working while
  drifting away from the form around it.
- Take spacing, radii and brand colour from the design tokens on `:root`,
  without a `var()` fallback. The edit form itself predates those tokens and
  paints from an older palette that has none: `#dfdfe8` hairlines, `#6d6d78`
  secondary text, a `#ceced3` slider handle over an `#f4f4f4`-to-orange rail.
  Those five are named once at the top of `STYLES`; do not invent a sixth
  without measuring it on the page first.

## Naming pipeline

The script downloads the full-resolution GPX, simplifies it for the Overpass
query, collects nearby settlements and named roads, converts feature proximity
into ordered passages, and selects a bounded narrative. Settlements outrank
roads. Start and finish settlements are protected, Favorites and manually added
places retain their slots, and genuine revisits remain in the result.

Configuration lives in `CONFIG` near the top of the userscript. Settings that
affect cached results must remain part of the cache signature so changes
invalidate stale entries.

## Tests

Run the complete suite before committing:

    npm test

Also check patch whitespace:

    git diff --check

The tests require no network. `test/support/harness.mjs` evaluates the
userscript in a `node:vm` sandbox with a stubbed Strava edit page, Tampermonkey
storage and HTTP responses. Tests click the injected controls and assert the
same title-field path used in the browser.

Test responsibilities:

| File | Responsibility |
|---|---|
| `name.test.mjs` | Narrative order, revisits, roads, endpoints, slots and title length |
| `ride-edits.test.mjs` | Per-activity additions/removals, blocking and overrides |
| `panel.test.mjs` | Sections, tabs, place counts, panel semantics, focus, validation and address search |
| `storage.test.mjs` | Tampermonkey storage |
| `overpass.test.mjs` | Mirrors, retry policy, transport and feature cache |
| `page.test.mjs` | Injection, observers, stylesheet, pages the script leaves alone and activities without GPS |

## Fixtures

Each `test/fixtures/*.json` file describes one scenario and is named after the
behaviour it protects. Its fields are:

- `activityId`: synthetic activity identifier;
- `expected`: complete expected title;
- `stepM`: spacing used when densifying a coarse route;
- `places`: synthetic Overpass settlement nodes;
- `roads`: synthetic Overpass road ways;
- `waypoints`: coarse route coordinates.

Coordinates use real geography so distance calculations behave like actual
rides, but fixtures should stay as small as the regression permits. Do not
merge fixtures merely to reduce the test count when they protect different
rules. For example, `road-fallback.json` verifies that roads fill missing
places, while `road-endpoints.json` verifies that endpoint roads do not replace
settlements.

To reproduce a regression with a full track, put the GPX beside the fixtures
and use `gpxFile` instead of `waypoints`:

```json
{ "gpxFile": "19000955530.gpx", "expected": "..." }
```

A captured Overpass response can be loaded with
`jsonResponse(JSON.parse(...))` instead of `overpassElements(fixture)`.

## Versioning and commits

When releasing a code change:

1. update `@version` in `activity-renamer.user.js`;
2. set the same version in `package.json`;
3. run `npm test` and `git diff --check`;
4. review the exact staged files before committing.

Keep unrelated user changes intact. Do not commit unless the user asks.

For comparisons against another userscript revision, point the harness at it
with `USERSCRIPT_PATH`:

```sh
git show HEAD:activity-renamer.user.js > /tmp/old.js
USERSCRIPT_PATH=/tmp/old.js node your-benchmark.mjs
```
