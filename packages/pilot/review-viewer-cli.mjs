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
    // A proposals file that exists but yields no panels must not look
    // like a normal no-proposal build. Every warning names a cause that
    // is true for every line it counts: junk lines for a wrong file
    // format, objects that are not proposal records (the error records a
    // failed batch writes), nothing at all for an empty file, and zero
    // matched captures for a file from another queue.
    if (result.proposals) {
        if (result.proposals.records === 0) {
            const cause = result.proposals.unreadableLines > 0
                ? `${result.proposals.unreadableLines} line(s) hold no valid `
                    + 'JSON record'
                : result.proposals.labellessLines > 0
                    ? `${result.proposals.labellessLines} line(s) hold objects `
                        + 'that are not proposal records, like the error '
                        + 'records a failed batch writes'
                    : 'the file holds no records at all';
            console.error(`Warning: no readable proposals records in `
                + `${proposalsPath}: ${cause}. Every page renders without `
                + 'an advisory panel.');
        } else if (result.proposals.matched === 0) {
            console.error(`Warning: none of the ${result.proposals.records} `
                + `proposals record(s) in ${proposalsPath} matches a capture `
                + 'in this queue. Every page renders without an advisory panel; '
                + 'the file probably belongs to another queue.');
        } else if (result.proposals.unreadableLines > 0) {
            console.error(`Warning: skipped ${result.proposals.unreadableLines} `
                + `line(s) in ${proposalsPath} that hold no valid proposals `
                + 'record. A capture whose only record was skipped renders '
                + 'without a panel.');
        }
    }
    console.log(JSON.stringify({pages: result.pages, index: result.indexPath}));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
