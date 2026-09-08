#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The smelt command surface (IDEA.md 3.5.2): a thin Node launcher. It
// provisions the pinned Python factory with uv on first use, then hands
// every command to the workspace tool that implements it.

import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {delimiter, dirname, join} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {ensureFactoryEnvironment} from './factory.mjs';

const require = createRequire(import.meta.url);
const consentRoot = dirname(require.resolve('@smelt-oss/consent-banners'));
const captureRoot = dirname(require.resolve('@smelt-oss/capture'));
const {version} = require('./package.json');

const COMMANDS = new Map([
    ['crawl', {file: () => join(captureRoot, 'local-cli.mjs'), python: false}],
    ['train', {file: () => join(consentRoot, 'train-cli.mjs'), python: true}],
    ['loop', {file: () => join(consentRoot, 'loop-cli.mjs'), python: true}],
    ['bench', {file: () => join(consentRoot, 'bench-cli.mjs'), python: false}],
    ['export', {file: () => join(consentRoot, 'scripts', 'export.mjs'), python: false}]
]);

function usage() {
    console.error('Usage: smelt <command> [args]');
    console.error('');
    console.error('Commands:');
    console.error('  crawl <config> [--steel]  Capture pages; --steel routes to the Steel cloud.');
    console.error('  train <manifest> <out>    Run the consent trainer.');
    console.error('  loop <manifest> <log>     Run the bounded rules agent loop.');
    console.error('  test                      Run the size and export gates.');
    console.error('  bench <args>              Run the browser latency benchmark.');
    console.error('  export <args>             Build the npm dist.');
    console.error('');
    console.error('Flags:');
    console.error('  --no-python               Skip uv provisioning.');
    console.error('  --version                 Print the CLI version.');
}

function run(file, args, env = process.env) {
    const child = spawnSync(process.execPath, [file, ...args], {env, stdio: 'inherit'});
    if (child.error) {
        console.error(`Could not run ${file}: ${child.error.message}`);
        return 1;
    }
    return child.status ?? 1;
}

// Provision the Python factory and return the environment for the child.
// Returns null when the pinned environment is required but unavailable.
export function pythonEnvironment(options = {}) {
    const environment = ensureFactoryEnvironment(options);
    if (environment.mode === 'uv') {
        if (!environment.ok) {
            console.error(`Python factory error: ${environment.error}`);
            return null;
        }
        if (environment.cold) {
            console.error(`Provisioned the pinned Python factory in ${environment.ms} ms.`);
        }
        // Windows spells the variable Path. Reuse that key so the child
        // environment holds one path variable and the prepend wins.
        const env = {...(options.env ?? process.env)};
        const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ??
            'PATH';
        env[pathKey] = `${environment.binDir}${delimiter}${env[pathKey] ?? ''}`;
        return env;
    }
    if (!environment.ok) {
        console.error(`Warning: ${environment.error}`);
        console.error('Continuing without the Python factory; training will fail.');
    } else {
        console.error(`Warning: ${environment.warning}`);
    }
    return options.env ?? process.env;
}

// smelt test: the gates that exist today, in the fixed order from
// IDEA.md 2.6 step 7 (size, then latency, then F1). The latency and F1
// gates need the frozen test set, which waits on the release corpus.
function runTest() {
    console.error('Gate 1 of 3: package size budget.');
    const size = run(join(consentRoot, 'scripts', 'size.mjs'), []);
    if (size !== 0) return size;
    console.error('Gate 2 of 3: export smoke, integrity, and size gates.');
    const exported = run(join(consentRoot, 'scripts', 'export.mjs'), []);
    if (exported !== 0) return exported;
    console.error('Gate 3 of 3: frozen-set latency and F1.');
    console.error('PENDING: the frozen test set arrives with the release corpus. ' +
        'Size and export gates passed.');
    return 0;
}

function main(argv) {
    if (argv.length === 0) {
        usage();
        return 1;
    }
    if (argv.includes('--help') || argv.includes('-h')) {
        usage();
        return 0;
    }
    if (argv.includes('--version')) {
        console.log(version);
        return 0;
    }
    const commandIndex = argv.findIndex(arg => !arg.startsWith('--'));
    const command = commandIndex === -1 ? undefined : argv[commandIndex];
    if (command === 'test') return runTest();
    if (!COMMANDS.has(command)) {
        console.error(`Unknown command: ${command ?? '(none)'}`);
        usage();
        return 1;
    }
    const entry = COMMANDS.get(command);
    let file = entry.file();
    // Strip exactly one command token and the launcher-owned flags. A
    // value may equal the command word: `smelt export --out export` works.
    const args = argv.filter((arg, i) => i !== commandIndex &&
        arg !== '--no-python' && !(command === 'crawl' && arg === '--steel'));
    if (command === 'crawl' && argv.includes('--steel')) {
        file = join(captureRoot, 'steel-cli.mjs');
    }
    let env = process.env;
    if (entry.python && !argv.includes('--no-python')) {
        env = pythonEnvironment();
        if (env === null) return 1;
    }
    return run(file, args, env);
}

// Run only when executed directly, so tests can import the helpers.
function invokedDirectly() {
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (invokedDirectly()) {
    process.exitCode = main(process.argv.slice(2));
}
