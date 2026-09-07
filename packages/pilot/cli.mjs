/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {readFile} from 'node:fs/promises';
import {evaluate, evaluateGroupedSplits} from './index.mjs';

const args = process.argv.slice(2);
if (args.length !== 2) {
    console.error('Usage: node packages/pilot/cli.mjs <labels.json> <predictions.json>');
    process.exitCode = 1;
} else {
    try {
        const [labels, predictions] = await Promise.all(args.map(async filename =>
            JSON.parse(await readFile(filename, 'utf8'))));
        const report = labels?.splits || Array.isArray(labels) ?
            evaluateGroupedSplits(labels, predictions) :
            evaluate(labels, predictions);
        console.log(JSON.stringify(report, null, 2));
    } catch (error) {
        console.error(`Evaluation failed: ${error.message}`);
        process.exitCode = 1;
    }
}
