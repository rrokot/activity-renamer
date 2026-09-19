// Prints the title this revision produces for every fixture, as JSON.
// compare.mjs runs it twice, once with USERSCRIPT_PATH pointing at another
// revision, and diffs the two maps. Endpoint addresses are left unanswered
// here, as loadScenario does in the tests, so both revisions see the same
// scenario rather than a recorded Nominatim reply.

import { readdirSync } from 'node:fs';

import { fixturesDir, loadScenario } from '../support/harness.mjs';

const titles = {};
for (const file of readdirSync(fixturesDir)) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    const { fixture, renamer } = loadScenario(name);
    titles[name] = { title: await renamer.generate(), expected: fixture.expected };
}

process.stdout.write(JSON.stringify(titles));
