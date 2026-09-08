/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A deterministic offline agent for the rules loop. It needs no API key,
// so contributors can exercise the whole loop without a teacher account.
// Iteration 1 proposes a genuine text-pattern edit, iteration 2 returns
// the incumbent unchanged, iteration 3 proposes an unsafe edit.

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
    const payload = JSON.parse(chunks.join(''));
    const source = payload.rulesSource;
    let answer;
    if (payload.iteration === 1) {
        answer = source.replace('const CONSENT_TEXT = /\\b(cookie|cookies|',
            'const CONSENT_TEXT = /\\b(we value your privacy|cookie|cookies|');
    } else if (payload.iteration === 2) {
        answer = source;
    } else {
        answer = "import fs from 'node:fs';\nexport const A = fs;";
    }
    process.stdout.write(JSON.stringify({
        source: answer,
        costUsd: 0,
        usage: {iterations: payload.iteration, digestFailures: payload.digest.totals.failures}
    }));
});
