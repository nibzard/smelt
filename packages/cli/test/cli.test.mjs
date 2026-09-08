/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {delimiter, join} from 'node:path';
import {test} from 'node:test';

import {
    FACTORY_PINS,
    cliDir,
    ensureFactoryEnvironment,
    pythonBinDir,
    pythonCommand
} from '../factory.mjs';
import {pythonEnvironment} from '../smelt.mjs';

const smeltBin = join(cliDir, 'smelt.mjs');
const uvWorks = spawnSync('uv', ['--version']).status === 0;
// The fake executables below are POSIX shell scripts.
const posixOnly = process.platform === 'win32' ?
    {skip: 'the fake executables are POSIX shell scripts'} : {};

function runSmelt(args, env = process.env, cwd) {
    return spawnSync(process.execPath, [smeltBin, ...args],
        {env, cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 8});
}

// Write executable fake tools into a fresh directory.
async function fakeBin(scripts) {
    const dir = await mkdtemp(join(cliDir, '.tmp-cli-'));
    for (const [name, body] of Object.entries(scripts)) {
        const file = join(dir, name);
        await writeFile(file, `#!/bin/sh\n${body}\n`);
        await chmod(file, 0o755);
    }
    return dir;
}

// The fake bin comes first, so `uv` resolves to the fake while the shell
// keeps the system tools (mkdir, chmod) it needs to build the stub venv.
function fakeEnvWith(bin, extra = {}) {
    return {...process.env, PATH: [bin, process.env.PATH].join(delimiter), ...extra};
}

// The fake uv answers --version, then mirrors the three sync outcomes:
// SMELT_FAKE_UV_SYNC=create provisions $UV_PROJECT_ENVIRONMENT (and
// refuses without it, so a wiring bug cannot touch the real .venv),
// =empty reports success without a venv, and anything else fails.
const FAKE_UV = `
if [ "$1" = "--version" ]; then
  echo "uv 0.0.0-fake"
  exit 0
fi
if [ "$1" = "sync" ]; then
  if [ "$SMELT_FAKE_UV_SYNC" = "create" ]; then
    if [ -z "$UV_PROJECT_ENVIRONMENT" ]; then
      echo "no UV_PROJECT_ENVIRONMENT" >&2
      exit 1
    fi
    mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
    printf '#!/bin/sh\\nexit 0\\n' > "$UV_PROJECT_ENVIRONMENT/bin/python3"
    chmod +x "$UV_PROJECT_ENVIRONMENT/bin/python3"
    exit 0
  fi
  if [ "$SMELT_FAKE_UV_SYNC" = "empty" ]; then
    exit 0
  fi
  echo "fake uv sync failure" >&2
  exit 1
fi
exit 1
`;

test('python names follow the platform layout', () => {
    assert.equal(pythonCommand('win32'), 'python');
    assert.equal(pythonCommand('linux'), 'python3');
    assert.equal(pythonCommand('darwin'), 'python3');
    assert.equal(pythonBinDir('/v', 'win32'), join('/v', 'Scripts'));
    assert.equal(pythonBinDir('/v', 'linux'), join('/v', 'bin'));
});

test('the launcher reports its surface honestly', () => {
    assert.equal(runSmelt(['--version']).stdout.trim(), '0.0.0');
    const help = runSmelt(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stderr, /crawl <config> \[--steel\]/);
    assert.match(help.stderr, /train <manifest> <out>/);

    const none = runSmelt([]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Usage: smelt/);
    const unknown = runSmelt(['bogus']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command: bogus/);
});

test('the launcher dispatches export and passes exit codes through', async () => {
    const outDir = await mkdtemp(join(cliDir, '.tmp-export-'));
    try {
        const exported = runSmelt(['export', '--out', outDir]);
        assert.equal(exported.status, 0, exported.stderr);
        assert.match(exported.stdout, /Exported @smelt-oss\/consent-banners/);
    } finally {
        await rm(outDir, {recursive: true, force: true});
    }
    // train-cli with no arguments prints usage and exits 1. --no-python
    // keeps this check hermetic: no uv probe, no sync, no network. The
    // launcher must strip its own flag and pass the failure through.
    const trainUsage = runSmelt(['train', '--no-python']);
    assert.equal(trainUsage.status, 1);
    assert.match(trainUsage.stderr, /Usage/);
}, {timeout: 120000});

test('a value equal to the command word reaches the child intact', async () => {
    const workDir = await mkdtemp(join(cliDir, '.tmp-cli-'));
    try {
        // 'export' is the command word and the --out value. Only the
        // command token may be removed, or export sees no value.
        const exported = runSmelt(['export', '--out', 'export'], process.env, workDir);
        assert.equal(exported.status, 0, exported.stderr);
        assert.ok(existsSync(join(workDir, 'export', 'detect.mjs')),
            'the dist directory named after the command word');
    } finally {
        await rm(workDir, {recursive: true, force: true});
    }
}, {timeout: 120000});

test('non-crawl commands receive --steel and the child rejects it', () => {
    // --steel belongs to crawl alone; bench must see it and complain,
    // not run with the flag silently gone.
    const bench = runSmelt(['bench', '--steel']);
    assert.equal(bench.status, 1);
    assert.match(bench.stderr, /Unknown argument: --steel/);
});

test('crawl routes to the Steel CLI only with --steel', () => {
    // Both capture CLIs print usage and exit 1 without a config path, so
    // the stderr names which one ran.
    const local = runSmelt(['crawl']);
    assert.equal(local.status, 1);
    assert.match(local.stderr, /smelt-local-capture/);
    const steel = runSmelt(['crawl', '--steel']);
    assert.equal(steel.status, 1);
    assert.match(steel.stderr, /smelt-steel-capture/);
});

test('without uv the launcher degrades to the system Python', () => {
    const broken = {...process.env, PATH: '/nonexistent'};
    const environment = ensureFactoryEnvironment({env: broken});
    assert.equal(environment.mode, 'system');
    assert.equal(environment.ok, false);
    assert.match(environment.error, /uv/);
    assert.match(environment.error ?? environment.warning ?? '', new RegExp(FACTORY_PINS));
});

test('a working system Python degrades with ok true', posixOnly, async () => {
    const bin = await fakeBin({python3: 'exit 0'});
    try {
        const environment = ensureFactoryEnvironment({env: {...process.env, PATH: bin}});
        assert.equal(environment.mode, 'system');
        assert.equal(environment.ok, true);
        assert.match(environment.warning, /system Python has both packages/);
        assert.match(environment.warning, new RegExp(FACTORY_PINS));
    } finally {
        await rm(bin, {recursive: true, force: true});
    }
});

test('a failing uv sync stops the python commands', posixOnly, async () => {
    const bin = await fakeBin({uv: FAKE_UV});
    try {
        const env = fakeEnvWith(bin);
        const environment = ensureFactoryEnvironment({env});
        assert.equal(environment.mode, 'uv');
        assert.equal(environment.ok, false);
        assert.match(environment.error, /uv sync failed/);

        const train = runSmelt(['train'], env);
        assert.equal(train.status, 1);
        assert.match(train.stderr, /Python factory error: uv sync failed/);
    } finally {
        await rm(bin, {recursive: true, force: true});
    }
});

test('a sync that leaves no python reports the probe failure', posixOnly, async () => {
    const bin = await fakeBin({uv: FAKE_UV});
    const workDir = await mkdtemp(join(cliDir, '.tmp-cli-'));
    try {
        const environment = ensureFactoryEnvironment({
            env: fakeEnvWith(bin, {SMELT_FAKE_UV_SYNC: 'empty'}),
            venvDir: join(workDir, 'venv')
        });
        assert.equal(environment.mode, 'uv');
        assert.equal(environment.ok, false);
        assert.match(environment.error, /cannot import lightgbm and numpy/);
    } finally {
        await rm(workDir, {recursive: true, force: true});
        await rm(bin, {recursive: true, force: true});
    }
});

test('uv sync provisions the requested venv and the cold run says so', posixOnly, async () => {
    const bin = await fakeBin({uv: FAKE_UV});
    const workDir = await mkdtemp(join(cliDir, '.tmp-cli-'));
    const venvDir = join(workDir, 'venv');
    const env = fakeEnvWith(bin, {SMELT_FAKE_UV_SYNC: 'create'});
    const errors = [];
    const originalError = console.error;
    console.error = message => errors.push(String(message));
    let childEnv;
    try {
        // The first provisioning run is the cold one; it prints the
        // provisioned-factory message.
        childEnv = pythonEnvironment({env, venvDir});
        assert.notEqual(childEnv, null);
        // The fake uv writes only where UV_PROJECT_ENVIRONMENT points, so
        // this also proves the option reaches the sync.
        assert.ok(existsSync(join(pythonBinDir(venvDir), 'python3')));
        const second = ensureFactoryEnvironment({env, venvDir});
        assert.equal(second.ok, true, second.error);
        assert.equal(second.cold, false);
    } finally {
        console.error = originalError;
        await rm(workDir, {recursive: true, force: true});
        await rm(bin, {recursive: true, force: true});
    }
    assert.notEqual(childEnv, null);
    assert.ok(errors.some(line => /Provisioned the pinned Python factory/.test(line)),
        JSON.stringify(errors));
    const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path');
    assert.ok(childEnv[pathKey].startsWith(pythonBinDir(venvDir)),
        'the venv executables come first on the child path');
});

test('smelt test runs the size and export gates and reports the pending one', () => {
    const result = runSmelt(['test']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Gate 1 of 3: package size/);
    assert.match(result.stderr, /Gate 2 of 3: export/);
    assert.match(result.stderr, /PENDING: the frozen test set/);
}, {timeout: 120000});

test('uv provisions the pinned factory and reports cold and warm runs',
    {skip: uvWorks ? false : 'uv is not installed'}, async () => {
        await rm(join(cliDir, '.venv'), {recursive: true, force: true});
        const first = ensureFactoryEnvironment();
        assert.equal(first.ok, true, first.error);
        assert.equal(first.mode, 'uv');
        assert.equal(first.cold, true);
        const probe = spawnSync(join(first.binDir, first.python),
            ['-c', 'import lightgbm, numpy; print(lightgbm.__version__)'], {encoding: 'utf8'});
        assert.equal(probe.status, 0, probe.stderr);
        assert.equal(probe.stdout.trim(), '4.7.0');

        const second = ensureFactoryEnvironment();
        assert.equal(second.ok, true);
        assert.equal(second.cold, false);
        assert.ok(second.ms < first.ms + 1000, `warm sync should be fast: ` +
            `${second.ms} ms versus ${first.ms} ms`);
    }, {timeout: 300000});
