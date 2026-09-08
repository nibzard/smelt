/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Shared gzip accounting for the consent package budget (IDEA.md 3.4.1):
// everything a browser loads eagerly — engine, rules, and model together —
// must stay under the budget. Code splitting keeps the Node-only linkedom
// fallback in a lazy chunk outside it.

import {gzipSync} from 'node:zlib';

const STATIC_IMPORT = /(?:from|import)"\.\/([^"]+)"/g;
const DYNAMIC_IMPORT = /import\("\.\/([^"]+)"\)/g;

async function loadEsbuild() {
    try {
        return await import('esbuild');
    } catch {
        throw new Error('esbuild is not installed. Run "npm install" in the ' +
            'repository root, then run this script again.');
    }
}

/**
 * Bundle an ESM entry for the browser and measure the eagerly loaded bytes.
 *
 * @param {string} entry Absolute path to the entry module.
 * @returns {Promise<object>} {eager: string[], eagerBytes,
 *     eagerGzippedBytes, lazy: [{name, bytes, gzippedBytes, reached}]}
 */
export async function measureBundle(entry) {
    const {build} = await loadEsbuild();
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

    const entryName = basename({path: entry}).replace(/\.m?js$/, '.js');
    const root = chunks.has(entryName) ? entryName : 'index.js';
    const eager = new Set([root]);
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

    return {
        eager: [...eager].sort(),
        eagerBytes: [...eager].reduce(
            (total, name) => total + chunks.get(name).contents.length, 0),
        eagerGzippedBytes: [...eager].reduce(
            (total, name) => total + gzipSync(chunks.get(name).contents).length, 0),
        lazy: lazy.sort().map(name => ({
            name,
            bytes: chunks.get(name).contents.length,
            gzippedBytes: gzipSync(chunks.get(name).contents).length,
            reached: reached.has(name)
        }))
    };
}
