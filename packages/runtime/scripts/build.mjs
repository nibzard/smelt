/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

await build({
    entryPoints: [fileURLToPath(new URL('../index.mjs', import.meta.url))],
    outfile: fileURLToPath(new URL('../dist/runtime.mjs', import.meta.url)),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    sourcemap: true
});
console.log('Built packages/runtime/dist/runtime.mjs');
