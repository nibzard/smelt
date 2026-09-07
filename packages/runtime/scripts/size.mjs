/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Enforce the gzip size budget for the engine core.

import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

let build;
try {
    ({build} = await import('esbuild'));
} catch (exc) {
    console.error('esbuild is not installed. Run "npm install" in packages/runtime, then run "npm run size" again.');
    process.exit(1);
}

const entry = fileURLToPath(new URL('../index.mjs', import.meta.url));

const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    write: false
});

const raw = result.outputFiles[0].contents;
const rawBytes = raw.length;
const gzippedBytes = gzipSync(raw).length;

console.log(`raw bundle: ${rawBytes} bytes`);
console.log(`gzipped: ${gzippedBytes} bytes`);
console.log('engine core charter: < 10240 bytes gzipped (IDEA.md 3.4)');
if (gzippedBytes >= 10240) {
    console.error('Engine exceeds the gzip size budget.');
    process.exitCode = 1;
}
