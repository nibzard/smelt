/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access} from 'node:fs/promises';
import {cp, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const exportScript = join(packageDir, 'scripts', 'export.mjs');
const SMOKE_HTML = `<html><body><main id="content"><h1>Example</h1></main>
<section id="consent" role="dialog" aria-modal="true" style="position:fixed">
<p>We use cookies for analytics.</p><button>Accept all</button>
</section></body></html>`;

const sha256 = text => `sha256-${createHash('sha256').update(text, 'utf8').digest('hex')}`;

function runExport(args) {
    return spawnSync(process.execPath, [exportScript, ...args], {encoding: 'utf8'});
}

test('export builds a self-contained dist that detects and self-verifies', async () => {
    const outDir = await mkdtemp(join(packageDir, '.tmp-export-'));
    try {
        const run = runExport(['--out', outDir]);
        assert.equal(run.status, 0, run.stderr);

        const integrity = JSON.parse(await readFile(join(outDir, 'integrity.json'), 'utf8'));
        assert.equal(integrity.schemaVersion, 1);
        assert.equal(integrity.task, 'consent-banners');
        assert.equal(integrity.size.withinBudget, true);
        assert.ok(integrity.size.eagerGzippedBytes > 0);
        assert.ok(integrity.size.eagerGzippedBytes < integrity.size.budgetBytes);

        // The recorded hashes match the shipped bytes, not just the sources.
        const rulesOut = await readFile(join(outDir, 'rules.js'), 'utf8');
        const modelOut = await readFile(join(outDir, 'model.smelt.json'), 'utf8');
        assert.equal(integrity.rules.sha256, sha256(rulesOut));
        assert.equal(integrity.model.sha256, sha256(modelOut));
        assert.equal(rulesOut,
            await readFile(join(packageDir, 'rules.mjs'), 'utf8'),
            'rules.js is the unminified, auditable copy');

        // The Node branch: the wrapper detects with the inlined artifact.
        const detect = await import(pathToFileURL(join(outDir, 'detect.mjs')).href);
        const result = await detect.detect(SMOKE_HTML);
        assert.notEqual(result.found, null);
        assert.deepEqual(result.degraded, []);
        assert.equal(detect.MODEL_SHA256, integrity.model.sha256);
        assert.equal(detect.RULES_SHA256, integrity.rules.sha256);
        assert.equal(detect.VERSION, integrity.packageVersion);
        assert.equal(detect.PACKAGE_VERSION, integrity.packageVersion);
        const check = await detect.verifyIntegrity();
        assert.equal(check.ok, true);
        assert.equal(check.modelSha256, integrity.model.sha256);
        assert.deepEqual(check.corpus, integrity.model.corpus);

        // The browser branch: shadowing Buffer forces the atob decoder and
        // the Uint8Array integrity path through the same generated source.
        const source = await readFile(join(outDir, 'detect.mjs'), 'utf8');
        await writeFile(join(outDir, 'detect-browser.mjs'),
            'const Buffer = undefined;\n' + source, 'utf8');
        const browserDetect =
            await import(pathToFileURL(join(outDir, 'detect-browser.mjs')).href);
        const browserResult = await browserDetect.detect(SMOKE_HTML);
        assert.notEqual(browserResult.found, null);
        assert.equal((await browserDetect.verifyIntegrity()).ok, true);

        // An insecure context has no crypto.subtle: the self-check must
        // return a structured not-ok result while detection keeps working.
        await writeFile(join(outDir, 'detect-insecure.mjs'),
            'const Buffer = undefined;\nconst crypto = {};\n' + source, 'utf8');
        const insecureDetect =
            await import(pathToFileURL(join(outDir, 'detect-insecure.mjs')).href);
        assert.notEqual((await insecureDetect.detect(SMOKE_HTML)).found, null);
        const insecureCheck = await insecureDetect.verifyIntegrity();
        assert.equal(insecureCheck.ok, false);
        assert.match(insecureCheck.error, /crypto\.subtle is unavailable/);
    } finally {
        await rm(outDir, {recursive: true, force: true});
    }
});

test('export rejects an invalid model artifact', async () => {
    const packageCopy = await mkdtemp(join(packageDir, '.tmp-package-'));
    try {
        for (const name of ['index.mjs', 'rules.mjs', 'model.smelt.json', 'package.json']) {
            await cp(join(packageDir, name), join(packageCopy, name));
        }
        const artifact = JSON.parse(await readFile(join(packageCopy, 'model.smelt.json'),
            'utf8'));
        artifact.abi = 'smelt-model-v0';
        await writeFile(join(packageCopy, 'model.smelt.json'), JSON.stringify(artifact),
            'utf8');
        const run = runExport(['--package-dir', packageCopy,
            '--out', join(packageCopy, 'dist')]);
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /model artifact is invalid/);
    } finally {
        await rm(packageCopy, {recursive: true, force: true});
    }
});

test('export rejects a model trained against different rules', async () => {
    const packageCopy = await mkdtemp(join(packageDir, '.tmp-package-'));
    try {
        for (const name of ['index.mjs', 'rules.mjs', 'model.smelt.json', 'package.json']) {
            await cp(join(packageDir, name), join(packageCopy, name));
        }
        await writeFile(join(packageCopy, 'rules.mjs'),
            `${await readFile(join(packageDir, 'rules.mjs'), 'utf8')}\n// drifted\n`, 'utf8');
        const run = runExport(['--package-dir', packageCopy,
            '--out', join(packageCopy, 'dist')]);
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /different rules/);
    } finally {
        await rm(packageCopy, {recursive: true, force: true});
    }
});

test('export rejects index.mjs that drifted from the template', async () => {
    const packageCopy = await mkdtemp(join(packageDir, '.tmp-package-'));
    try {
        for (const name of ['index.mjs', 'rules.mjs', 'model.smelt.json', 'package.json']) {
            await cp(join(packageDir, name), join(packageCopy, name));
        }
        await writeFile(join(packageCopy, 'index.mjs'),
            (await readFile(join(packageDir, 'index.mjs'), 'utf8'))
                .replace("with {type: 'json'}", "with { type: 'json' }"),
            'utf8');
        const run = runExport(['--package-dir', packageCopy,
            '--out', join(packageCopy, 'dist')]);
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /0 lines matching the model artifact import/);
    } finally {
        await rm(packageCopy, {recursive: true, force: true});
    }
});

test('a failed re-export leaves the previous dist intact', async () => {
    const outDir = await mkdtemp(join(packageDir, '.tmp-export-'));
    try {
        const good = runExport(['--out', outDir]);
        assert.equal(good.status, 0, good.stderr);
        const integrityBefore = await readFile(join(outDir, 'integrity.json'), 'utf8');
        const detectBefore = await readFile(join(outDir, 'detect.mjs'), 'utf8');
        const modelBefore = await readFile(join(outDir, 'model.smelt.json'), 'utf8');

        const bad = runExport(['--out', outDir, '--budget', '100']);
        assert.notEqual(bad.status, 0);
        assert.match(bad.stderr, /the budget is 100/);

        assert.equal(await readFile(join(outDir, 'integrity.json'), 'utf8'), integrityBefore);
        assert.equal(await readFile(join(outDir, 'detect.mjs'), 'utf8'), detectBefore);
        assert.equal(await readFile(join(outDir, 'model.smelt.json'), 'utf8'), modelBefore);
        const leftovers = (await readdir(outDir)).filter(name => name.startsWith('.'));
        assert.deepEqual(leftovers, [], 'no staging directory may survive a failed run');
    } finally {
        await rm(outDir, {recursive: true, force: true});
    }
});

test('export refuses an output directory outside the repository', async () => {
    const outside = join(packageDir, '..', '..', '..', '..', 'tmp', 'smelt-export-test');
    const run = runExport(['--out', outside]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /must stay inside/);
    await assert.rejects(access(outside), /ENOENT/);
});
