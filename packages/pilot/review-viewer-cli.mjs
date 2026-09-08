#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {readFile} from 'node:fs/promises';

import {buildReviewViewer} from './review-viewer.mjs';

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    const value = process.argv[index + 1];
    // A flag with no value, or one whose value is the next flag, is a
    // command-line typo. --proposals treated as absent would silently
    // render every advisory panel missing, so fail loudly instead.
    if (typeof value !== 'string' || value.startsWith('--')) {
        throw new Error(`--${name} needs a value.`);
    }
    return value;
}

try {
    const queuePath = option('queue', 'tasks/consent-banners/review-queue.json');
    const queue = JSON.parse(await readFile(queuePath, 'utf8'));
    const items = queue.items ?? queue.queue ?? [];
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error(`Review queue holds no items: ${queuePath}`);
    }
    const proposalsPath = option('proposals');
    const result = await buildReviewViewer({
        items,
        capturesDir: option('captures', 'corpus/captures'),
        outDir: option('out', 'runs/review-viewer'),
        labelsDir: option('labels', 'corpus/manifests/labels'),
        proposalsPath
    });
    // A proposals file that exists but parses to nothing must not look
    // like a normal no-proposal build. The wrong-file route (for example
    // a pretty-printed JSON document) is a warning, because the pages
    // still render; advisory panels alone go missing.
    if (result.proposals) {
        if (result.proposals.records === 0) {
            console.error(`Warning: no readable proposals records in `
                + `${proposalsPath}. Every page renders without an advisory `
                + 'panel. The file must hold one JSON record per line.');
        } else if (result.proposals.unreadableLines > 0) {
            console.error(`Warning: skipped ${result.proposals.unreadableLines} `
                + `unreadable proposals line(s) in ${proposalsPath}. Those `
                + 'captures render without a panel unless a valid record '
                + 'appears later in the file.');
        }
    }
    console.log(JSON.stringify({pages: result.pages, index: result.indexPath}));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
