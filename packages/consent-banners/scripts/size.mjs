/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Enforce the total gzip size budget for the consent wedge package.

import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

let build;
try {
    ({build} = await import('esbuild'));
} catch {
    console.error('esbuild is not installed. Run "npm install" in the repository root, ' +
        'then run "npm run size" again.');
    process.exit(1);
}

const BUDGET_BYTES = 51200;
const STATIC_IMPORT = /(?:from|import)"\.\/([^"]+)"/g;
const DYNAMIC_IMPORT = /import\("\.\/([^"]+)"\)/g;
const entry = fileURLToPath(new URL('../index.mjs', import.meta.url));
const modelPath = fileURLToPath(new URL('../model.smelt.json', import.meta.url));

// Code splitting keeps the Node-only linkedom fallback in a chunk that the
// entry imports dynamically, so browsers never fetch it. The budget covers
// everything a browser loads eagerly: engine, rules, and model together.
const result = await build({
    entryPoints: [entry],
    bundle: true,
    splitting: true,
    outdir: 'size-check',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false
});

const basename = file => file.path.split(/[\\/]/).pop();
const chunks = new Map(result.outputFiles.map(file => [basename(file), file]));
const importsOf = (name, pattern) => [...chunks.get(name).text.matchAll(pattern)]
    .map(match => match[1])
    .filter(target => chunks.has(target));

const eager = new Set(['index.js']);
const queue = [...eager];
while (queue.length > 0) {
    for (const target of importsOf(queue.pop(), STATIC_IMPORT)) {
        if (!eager.has(target)) {
            eager.add(target);
            queue.push(target);
        }
    }
}
const lazy = [...chunks.keys()].filter(name => !eager.has(name));

const reached = new Set();
queue.push(...eager);
while (queue.length > 0) {
    for (const target of importsOf(queue.pop(), DYNAMIC_IMPORT)) {
        if (!reached.has(target)) {
            reached.add(target);
            queue.push(target);
        }
    }
}

const eagerBytes = [...eager].reduce((total, name) => total + chunks.get(name).contents.length, 0);
const eagerGzippedBytes = [...eager].reduce((total, name) =>
    total + gzipSync(chunks.get(name).contents).length, 0);
const model = await readFile(modelPath);
const modelGzippedBytes = gzipSync(model).length;

console.log(`eager chunks ${[...eager].sort().join(', ')}: ${eagerBytes} bytes raw`);
console.log(`gzipped: ${eagerGzippedBytes} bytes`);
console.log(`model artifact: ${model.length} bytes raw, ${modelGzippedBytes} bytes gzipped`);
for (const name of lazy.sort()) {
    const chunk = chunks.get(name);
    console.log(`lazy chunk ${name}: ${chunk.contents.length} bytes raw, ` +
        `${gzipSync(chunk.contents).length} bytes gzipped` +
        (reached.has(name) ? '' : ' (NOT reachable through dynamic imports)'));
}
console.log('consent package budget: < 51200 bytes gzipped for the eagerly loaded ' +
    'chunks, engine, rules, and model together (IDEA.md 3.4.1). The Node-only ' +
    'linkedom fallback ships as a lazy chunk outside the budget.');

let failed = false;
const orphans = lazy.filter(name => !reached.has(name));
if (orphans.length > 0) {
    console.error(`Chunks not reachable through dynamic imports: ${orphans.join(', ')}. ` +
        'The linkedom fallback must stay behind a dynamic import.');
    failed = true;
}
if (lazy.length === 0) {
    console.error('No lazy chunk was produced. The linkedom fallback must stay behind ' +
        'a dynamic import so it stays out of the eager budget.');
    failed = true;
}
if (eagerGzippedBytes >= BUDGET_BYTES) {
    console.error('The consent package exceeds the total gzip size budget.');
    failed = true;
}
if (failed) process.exitCode = 1;
