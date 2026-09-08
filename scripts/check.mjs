/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {readdir, readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['node_modules', '.git', 'dist', 'corpus', 'runs']);
let checked = 0;

async function check(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (ignored.has(entry.name)) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await check(filename);
        else if (entry.isFile() && entry.name.endsWith('.mjs')) {
            const result = spawnSync(process.execPath, ['--check', filename], {stdio: 'inherit'});
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(`Syntax check failed: ${filename}`);
            checked++;
        }
    }
}

await check(root);
const runtime = path.join(root, 'packages/runtime');
let lines = 0;
for (const entry of await readdir(runtime)) {
    if (!entry.endsWith('.mjs')) continue;
    const source = await readFile(path.join(runtime, entry), 'utf8');
    lines += source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}
if (lines >= 2000) throw new Error(`Runtime has ${lines} lines; the charter requires fewer than 2000.`);
console.log(`Checked ${checked} modules. Runtime: ${lines}/1999 lines.`);
