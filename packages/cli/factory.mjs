/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Provision the pinned Python factory environment with uv (IDEA.md 3.5.2).
// `uv sync --locked` creates .venv from uv.lock on first use and is a fast
// no-op afterwards. When uv is absent, the launcher degrades to the system
// Python with a warning that names the exact pins.

import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const cliDir = fileURLToPath(new URL('.', import.meta.url));

export const FACTORY_PINS = 'lightgbm==4.7.0 numpy==2.2.6';

/**
 * The Python executable name the factory tools spawn.
 *
 * @param {string} [platform] Process platform override for tests.
 * @returns {string} 'python' on Windows, 'python3' elsewhere.
 */
export function pythonCommand(platform = process.platform) {
    return platform === 'win32' ? 'python' : 'python3';
}

/**
 * The executables directory inside a virtual environment.
 *
 * @param {string} venvDir Virtual environment directory.
 * @param {string} [platform] Process platform override for tests.
 * @returns {string} 'Scripts' on Windows, 'bin' elsewhere, joined to venvDir.
 */
export function pythonBinDir(venvDir, platform = process.platform) {
    return join(venvDir, platform === 'win32' ? 'Scripts' : 'bin');
}

function systemPythonWorks(env, python) {
    const probe = spawnSync(python, ['-c', 'import lightgbm, numpy'], {env, encoding: 'utf8'});
    return probe.status === 0;
}

/**
 * Ensure the pinned Python environment exists. With uv, provision (or
 * reuse) .venv from the committed lock; without uv, fall back to the
 * system Python and say exactly what is missing.
 *
 * @param {object} [options] {env, venvDir}
 * @returns {object} {ok, mode: 'uv'|'system', binDir, python, cold,
 *     ms, warning?, error?}
 */
export function ensureFactoryEnvironment(options = {}) {
    const started = performance.now();
    const env = options.env ?? process.env;
    const venvDir = options.venvDir ?? join(cliDir, '.venv');
    const python = pythonCommand();
    const uvVersion = spawnSync('uv', ['--version'], {env, encoding: 'utf8'});
    const finish = extra => ({ok: false, mode: 'system', binDir: null, python,
        cold: false, ms: Math.round(performance.now() - started), ...extra});

    if (uvVersion.status !== 0) {
        const warning = 'uv is not installed. The system Python must provide ' +
            `${FACTORY_PINS}. Install uv (https://docs.astral.sh/uv/) for the ` +
            'pinned environment.';
        if (systemPythonWorks(env, python)) {
            return {ok: true, mode: 'system', binDir: null, python,
                cold: false, ms: Math.round(performance.now() - started),
                warning: `${warning} The system Python has both packages.`};
        }
        return finish({warning, error: 'Neither uv nor a working system Python ' +
            `with ${FACTORY_PINS} is available.`});
    }

    const cold = !existsSync(join(pythonBinDir(venvDir), python)) &&
        !existsSync(join(venvDir, 'pyvenv.cfg'));
    // UV_PROJECT_ENVIRONMENT makes the lock provision exactly venvDir, so
    // cold detection, sync, and the import probe all agree on one place.
    const sync = spawnSync('uv', ['sync', '--locked'],
        {cwd: cliDir, env: {...env, UV_PROJECT_ENVIRONMENT: venvDir}, encoding: 'utf8',
            maxBuffer: 1024 * 1024 * 8});
    if (sync.status !== 0) {
        return finish({mode: 'uv', error: `uv sync failed: ${(sync.stderr ?? sync.error?.message ??
            'unknown error').trim().slice(0, 300)}`});
    }
    const binDir = pythonBinDir(venvDir);
    const check = spawnSync(join(binDir, python), ['-c', 'import lightgbm, numpy'],
        {env, encoding: 'utf8'});
    if (check.status !== 0) {
        return finish({mode: 'uv', binDir, error: 'The provisioned environment ' +
            'cannot import lightgbm and numpy.'});
    }
    return {ok: true, mode: 'uv', binDir, python, cold,
        ms: Math.round(performance.now() - started)};
}
