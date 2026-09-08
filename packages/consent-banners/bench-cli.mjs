#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {runBrowserBenchmark, writeBenchmarkReport} from './bench.mjs';

function usage() {
    return [
        'Usage: node bench-cli.mjs --manifest bench.json --set ci-50 --out runs/bench.json',
        '',
        'Options:',
        '  --manifest <path>       Benchmark manifest with probeSets.',
        '  --set <name>            ci-50, dev-1000, or frozen-1000. Default: ci-50.',
        '  --out <path>            JSON report path. Default: runs/bench.json.',
        '  --warmups <count>       Warm-up calls per page. Default: 3.',
        '  --repetitions <count>   Measured calls per page. Default: 30.',
        '  --cpu-throttle <rate>   Chromium CPU throttle rate. Default: 4.',
        '  --headed                Run a visible browser.'
    ].join('\n');
}

function parseArgs(argv) {
    const options = {
        probeSet: 'ci-50',
        out: 'runs/bench.json',
        headless: true
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--manifest') {
            options.manifest = argv[++index];
        } else if (arg === '--set') {
            options.probeSet = argv[++index];
        } else if (arg === '--out') {
            options.out = argv[++index];
        } else if (arg === '--warmups') {
            options.warmups = Number(argv[++index]);
        } else if (arg === '--repetitions') {
            options.repetitions = Number(argv[++index]);
        } else if (arg === '--cpu-throttle') {
            options.cpuThrottle = Number(argv[++index]);
        } else if (arg === '--headed') {
            options.headless = false;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    if (!options.manifest) {
        throw new Error('Missing --manifest.\n\n' + usage());
    }
    const report = await runBrowserBenchmark(options);
    await writeBenchmarkReport(report, options.out);
    console.log(JSON.stringify({
        out: options.out,
        probeSet: report.probeSet,
        pages: report.corpus.pages,
        p50: report.corpus.repeatedCall.p50,
        p95: report.corpus.repeatedCall.p95
    }));
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
