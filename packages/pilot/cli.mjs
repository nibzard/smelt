/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {readFile} from 'node:fs/promises';
import {compareWorkflows, evaluate, evaluateGroupedSplits} from './index.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 && args.length !== 3) {
    console.error('Usage: node packages/pilot/cli.mjs [--workflows] <labels-or-baseline.json> <predictions-or-smelt.json>');
    process.exitCode = 1;
} else {
    try {
        const workflowMode = args[0] === '--workflows';
        const filenames = workflowMode ? args.slice(1) : args;
        const [left, right] = await Promise.all(filenames.map(async filename =>
            JSON.parse(await readFile(filename, 'utf8'))));
        const report = workflowMode ? compareWorkflows({baseline: left, smelt: right}) :
            left?.splits || Array.isArray(left) ?
                evaluateGroupedSplits(left, right) :
                evaluate(left, right);
        console.log(JSON.stringify(report, null, 2));
    } catch (error) {
        console.error(`Evaluation failed: ${error.message}`);
        process.exitCode = 1;
    }
}
