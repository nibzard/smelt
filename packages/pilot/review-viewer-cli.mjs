#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {readFile} from 'node:fs/promises';

import {buildReviewViewer} from './review-viewer.mjs';

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}

try {
    const queuePath = option('queue', 'tasks/consent-banners/review-queue.json');
    const queue = JSON.parse(await readFile(queuePath, 'utf8'));
    const items = queue.items ?? queue.queue ?? [];
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error(`Review queue holds no items: ${queuePath}`);
    }
    const result = await buildReviewViewer({
        items,
        capturesDir: option('captures', 'corpus/captures'),
        outDir: option('out', 'runs/review-viewer')
    });
    console.log(JSON.stringify({pages: result.pages, index: result.indexPath}));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
