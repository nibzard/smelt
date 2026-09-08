/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Enforce the total gzip size budget for the consent wedge package.

import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

import {measureBundle} from './bundle-size.mjs';

const BUDGET_BYTES = 51200;
const entry = fileURLToPath(new URL('../index.mjs', import.meta.url));
const modelPath = fileURLToPath(new URL('../model.smelt.json', import.meta.url));

const measurement = await measureBundle(entry);
const model = await readFile(modelPath);

console.log(`eager chunks ${measurement.eager.join(', ')}: ${measurement.eagerBytes} bytes raw`);
console.log(`gzipped: ${measurement.eagerGzippedBytes} bytes`);
console.log(`model artifact: ${model.length} bytes raw, ` +
    `${gzipSync(model).length} bytes gzipped (embedded in the eager chunk)`);
for (const chunk of measurement.lazy) {
    console.log(`lazy chunk ${chunk.name}: ${chunk.bytes} bytes raw, ` +
        `${chunk.gzippedBytes} bytes gzipped` +
        (chunk.reached ? '' : ' (NOT reachable through dynamic imports)'));
}
console.log('consent package budget: < 51200 bytes gzipped for the eagerly loaded ' +
    'chunks, engine, rules, and model together (IDEA.md 3.4.1). The Node-only ' +
    'linkedom fallback ships as a lazy chunk outside the budget.');

let failed = false;
const orphans = measurement.lazy.filter(chunk => !chunk.reached);
if (orphans.length > 0) {
    console.error(`Chunks not reachable through dynamic imports: ` +
        `${orphans.map(chunk => chunk.name).join(', ')}. ` +
        'The linkedom fallback must stay behind a dynamic import.');
    failed = true;
}
if (measurement.lazy.length === 0) {
    console.error('No lazy chunk was produced. The linkedom fallback must stay behind ' +
        'a dynamic import so it stays out of the eager budget.');
    failed = true;
}
if (measurement.eagerGzippedBytes >= BUDGET_BYTES) {
    console.error('The consent package exceeds the total gzip size budget.');
    failed = true;
}
if (failed) process.exitCode = 1;
