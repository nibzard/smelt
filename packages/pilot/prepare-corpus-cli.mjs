#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {prepareCorpus} from './prepare-corpus.mjs';

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}

try {
    const result = await prepareCorpus({
        capturesDir: option('captures', 'corpus/captures'),
        sessionsDir: option('sessions', 'corpus/sessions'),
        outDir: option('out', 'corpus'),
        queuePath: option('queue', 'tasks/consent-banners/review-queue.json')
    });
    console.log(JSON.stringify({
        captures: result.stats.captures,
        groups: result.stats.groups,
        splits: Object.fromEntries(Object.entries(result.stats.splits)
            .map(([split, value]) => [split, value.pages])),
        reviewQueue: result.queue
    }, null, 2));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
