// Copies the version from package.json into the userscript's @version line.
// `npm version patch` runs this through the "version" script, so the manifest
// and the metadata block can no longer drift apart between releases.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const userscriptPath = join(projectDir, 'activity-renamer.user.js');

const { version } = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
const source = readFileSync(userscriptPath, 'utf8');

// No `$` anchor: a checkout with CRLF endings would leave the carriage return
// outside the captured version.
const versionLine = /^(\/\/ @version\s+)(\S+)/m;
const current = source.match(versionLine);
if (!current) throw new Error('activity-renamer.user.js has no @version line');

if (current[2] === version) {
    console.log(`@version is already ${version}`);
} else {
    writeFileSync(userscriptPath, source.replace(versionLine, `$1${version}`));
    console.log(`@version ${current[2]} -> ${version}`);
}
