// Writes the Tampermonkey wrapper that loads the working copy through
// @require. Tampermonkey reads permissions from the wrapper and ignores the
// metadata inside the required file, so the wrapper has to repeat every
// @grant, @connect, @match and @run-at. Generating it from the source keeps
// that copy honest when the real metadata block changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const userscriptPath = join(projectDir, 'activity-renamer.user.js');
const wrapperPath = join(projectDir, 'activity-renamer.dev.user.js');

// The install URLs belong to the released script; a local wrapper that kept
// them would offer to update itself from GitHub.
const DROPPED = new Set(['@updateURL', '@downloadURL', '@homepageURL', '@supportURL']);

const source = readFileSync(userscriptPath, 'utf8');
const block = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
if (!block) throw new Error('activity-renamer.user.js has no metadata block');

const lines = [];
for (const line of block[1].split('\n')) {
    const key = line.match(/^\/\/ (@\S+)/);
    if (!key) continue;
    if (DROPPED.has(key[1])) continue;
    lines.push(key[1] === '@name' ? `${line.trimEnd()} (dev)` : line.trimEnd());
}

lines.push(`// @require      ${pathToFileURL(userscriptPath).href}`);

writeFileSync(wrapperPath, `// ==UserScript==\n${lines.join('\n')}\n// ==/UserScript==\n`);
console.log(`Wrote ${wrapperPath}`);
console.log('Install it once in Tampermonkey; it then reloads the file on every save.');
