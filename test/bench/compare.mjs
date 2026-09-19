// Names every fixture twice - with this working copy and with another
// revision of the userscript - and reports where the two disagree.
//
//     git show HEAD:activity-renamer.user.js > ../old.js
//     npm run bench -- ../old.js

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = dirname(fileURLToPath(import.meta.url));
const [baselineArg] = process.argv.slice(2);

if (!baselineArg) {
    console.error('usage: npm run bench -- <baseline-userscript.js>');
    process.exit(2);
}

function titlesFrom(userscriptPath) {
    const env = { ...process.env };
    if (userscriptPath) env.USERSCRIPT_PATH = userscriptPath;
    else delete env.USERSCRIPT_PATH;
    return JSON.parse(execFileSync(process.execPath, [join(benchDir, 'titles.mjs')], {
        env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    }));
}

const baseline = titlesFrom(resolve(baselineArg));
const current = titlesFrom(null);

let changed = 0;
for (const [name, after] of Object.entries(current)) {
    const before = baseline[name];
    if (before && before.title === after.title) continue;
    changed++;
    console.log(name);
    console.log(`  baseline: ${before ? before.title : '(fixture is new)'}`);
    console.log(`  current : ${after.title}`);
    console.log(`  expected: ${after.expected}`);
}

const total = Object.keys(current).length;
console.log(changed === 0
    ? `No change: ${total} fixtures name identically.`
    : `${changed} of ${total} fixtures changed.`);
