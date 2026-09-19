# Activity Renamer development guide

This file is for contributors and coding agents. Keep `README.md` focused on
installation, usage and user-visible behaviour.

## Project shape

- `activity-renamer.user.js` is the complete userscript and the only production
  source file.
- `package.json` contains the matching package version and the commands below.
- `test/*.test.mjs` contains behavioural tests.
- `test/support/` contains the DOM, panel and userscript harness.
- `test/fixtures/` contains readable route scenarios.
- `test/bench/` names every fixture with two revisions and reports the
  differences.
- `scripts/` holds the release and local-development helpers.

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

Generate the wrapper instead of maintaining that copy by hand:

    npm run dev:wrapper

It writes `activity-renamer.dev.user.js` from the source metadata, dropping the
install URLs so the local copy does not update itself from GitHub. Install it
in Tampermonkey once; it then serves the working copy on every save.

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

Both run automatically after an edit to the userscript or a test file: the
`PostToolUse` hook in `.claude/settings.json` calls
`.claude/hooks/verify-userscript.sh`, which reports a failure instead of
letting it pass unnoticed.

While working on a change, `npm run test:watch` reruns the suite on save.
`npm run coverage` reports which parts of the userscript the suite never
reaches; the sandbox is given the script's absolute path so the coverage
report can attribute it to the file on disk.

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

1. run `npm version patch --no-git-tag-version` (or `minor`/`major`), which
   sets the version in `package.json`, copies it into the userscript's
   `@version` and stages the userscript, without committing or tagging;
2. run `npm test` and `git diff --check`;
3. review the exact staged files before committing.

Keep unrelated user changes intact. Do not commit unless the user asks.

To see what a change does to real titles, name every fixture with both
revisions and compare:

```sh
git show HEAD:activity-renamer.user.js > ../old.js
npm run bench -- ../old.js
```

It prints the baseline title, the current one and the fixture's expectation for
every scenario that moved. `USERSCRIPT_PATH` is what points the harness at
another revision, so a one-off script can use it the same way.
