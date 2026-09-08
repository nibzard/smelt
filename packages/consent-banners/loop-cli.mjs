/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Command entry for the bounded rules agent loop. The agent runs as a
// subprocess: it receives {digest, rulesSource, program} on stdin and
// prints JSON with at least {source} (IDEA.md 3.2.1).

import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {createCommandAgent, runRulesLoop} from './loop.mjs';

function usage() {
    console.error('Usage: node packages/consent-banners/loop-cli.mjs <manifest.json> <log.json> \\');
    console.error("          --command 'claude -p --output-format json' \\");
    console.error('          [--program program.md] [--rules-out rules.json] \\');
    console.error('          [--max-iterations N] [--epsilon E] [--cost-cap USD] \\');
    console.error('          [--consecutive-discards N] [--no-parity]');
}

function parseArgs(argv) {
    const options = {numbers: {}, flags: new Set(), program: null, rulesOut: null, command: null};
    const numberFlags = {
        '--max-iterations': 'maxIterations',
        '--epsilon': 'epsilon',
        '--cost-cap': 'costCapUsd',
        '--consecutive-discards': 'consecutiveDiscardStop'
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--no-parity') {
            options.flags.add('no-parity');
        } else if (numberFlags[arg]) {
            const value = Number(argv[++i]);
            const name = numberFlags[arg];
            const valid = Number.isFinite(value) && (name === 'epsilon' ? value > 0 :
                name === 'costCapUsd' ? value >= 0 : value >= 1);
            if (!valid) {
                throw new Error(`Expected a valid number after ${arg}: ` +
                    'epsilon above 0, cost cap of 0 or more, and counts of 1 or more.');
            }
            options.numbers[name] = value;
        } else if (arg === '--program' || arg === '--rules-out' || arg === '--command') {
            if (i + 1 >= argv.length) throw new Error(`Expected a value after ${arg}.`);
            const value = argv[++i];
            if (arg === '--program') options.program = value;
            else if (arg === '--rules-out') options.rulesOut = value;
            else options.command = value;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

// Split a --command value on unquoted whitespace so quoted arguments and
// paths with spaces survive.
function splitCommand(text) {
    const parts = [];
    let current = '';
    let quote = null;
    for (const ch of text) {
        if (quote !== null) {
            if (ch === quote) quote = null;
            else current += ch;
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
        } else if (/\s/.test(ch)) {
            if (current) {
                parts.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }
    if (quote !== null) throw new Error('The --command value has an unterminated quote.');
    if (current) parts.push(current);
    if (parts.length === 0) throw new Error('The --command value is empty.');
    return parts;
}

async function readJson(filename) {
    return JSON.parse(await readFile(filename, 'utf8'));
}

async function loadSplit(split, baseDir) {
    const captures = await Promise.all(split.captures.map(async record => ({
        id: record.id,
        snapshot: await readJson(path.resolve(baseDir, record.snapshot)),
        features: await readJson(path.resolve(baseDir, record.features))
    })));
    return {
        labels: await readJson(path.resolve(baseDir, split.labels)),
        captures
    };
}

const argv = process.argv.slice(2);
if (argv.length < 2) {
    usage();
    process.exitCode = 1;
} else {
    try {
        const parsed = parseArgs(argv.slice(2));
        if (parsed.command === null) {
            throw new Error('Pass --command with the agent executable and its arguments.');
        }
        const [manifestFile, logFile] = argv;
        const baseDir = path.dirname(path.resolve(manifestFile));
        const manifest = await readJson(manifestFile);
        const input = {
            schemaVersion: manifest.schemaVersion,
            development: await loadSplit(manifest.development, baseDir),
            program: parsed.program === null ? null :
                await readFile(path.resolve(baseDir, parsed.program), 'utf8')
        };
        const parts = splitCommand(parsed.command);
        const log = await runRulesLoop(input, {
            agent: createCommandAgent(parts[0], parts.slice(1)),
            ...parsed.numbers,
            parityHolds: !parsed.flags.has('no-parity')
        });
        await writeFile(logFile, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
        if (parsed.rulesOut !== null && log.final.changed) {
            // The log is the diagnostics source; a rules-output failure must
            // not hide it or masquerade as a loop failure.
            try {
                await writeFile(parsed.rulesOut,
                    `${JSON.stringify({rulesHash: log.final.rulesHash, source: log.final.source}, null, 2)}\n`,
                    'utf8');
            } catch (error) {
                console.error(`Could not write rules output ${parsed.rulesOut}: ${error.message}`);
                process.exitCode = 1;
            }
        }
        const last = log.iterations[log.iterations.length - 1];
        console.error(`Loop stopped for ${log.stoppedFor} after ${log.totals.iterations} ` +
            `iterations: ${log.final.kept} kept, ${log.final.discarded} discarded.`);
        console.error(`Dev F1 ${log.incumbent.f1} -> ${log.final.f1} ` +
            `(gain ${log.totals.f1Gain}, spent $${log.totals.spentUsd}).`);
        if (last) console.error(`Last verdict: ${last.verdict} (${last.reasons[0] ?? 'improved'}).`);
    } catch (error) {
        console.error(`Loop failed: ${error.message}`);
        process.exitCode = 1;
    }
}
