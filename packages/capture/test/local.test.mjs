/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

import {loadLocalCaptureConfig, runLocalCapture} from '../local.mjs';
import {FakePage, fakePlaywright} from './helpers.mjs';

function config(overrides = {}) {
    return {
        outDir: 'corpus/captures',
        browser: {name: 'chromium'},
        viewport: {width: 1280, height: 720, deviceScaleFactor: 1},
        observationMs: 25,
        navigationTimeoutMs: 1000,
        egressLocation: null,
        storageState: null,
        pages: [{id: 'example', url: 'https://example.test/', group: 'example.test'}],
        ...overrides
    };
}

async function writeConfig(dir, configValue, name = 'local.json') {
    const filename = path.join(dir, name);
    await writeFile(filename, JSON.stringify(configValue, null, 2));
    return filename;
}

test('loadLocalCaptureConfig resolves file pages against the config directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-local-config-'));
    try {
        await writeFile(path.join(dir, 'page.html'), '<!doctype html><html><body>Ok</body></html>');
        const filename = await writeConfig(dir, config({
            pages: [{file: 'page.html'}]
        }));

        const loaded = await loadLocalCaptureConfig(filename);
        const page = loaded.pages[0];

        assert.equal(loaded.browser.name, 'chromium');
        assert.equal(page.id, 'page');
        assert.ok(page.url.startsWith('file:///'));
        assert.ok(page.url.endsWith('page.html'));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('loadLocalCaptureConfig accepts HTTP and file URLs and rejects invalid pages', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-local-invalid-'));
    try {
        const valid = await loadLocalCaptureConfig(await writeConfig(dir, config({
            pages: [
                {url: 'http://a.example.test/page'},
                {url: 'https://b.example.test/page'},
                {url: 'file:///tmp/page.html'}
            ]
        })));
        assert.deepEqual(valid.pages.map(page => new URL(page.url).protocol),
            ['http:', 'https:', 'file:']);

        await assert.rejects(async () => loadLocalCaptureConfig(await writeConfig(dir,
            config({pages: [{url: 'ftp://example.test/'}]}), 'bad-protocol.json')),
        /HTTP, HTTPS, or file URL/);

        await assert.rejects(async () => loadLocalCaptureConfig(await writeConfig(dir,
            config({pages: [{url: 'https://example.test/', file: 'page.html'}]}), 'ambiguous.json')),
        /both url and file/);

        await assert.rejects(async () => loadLocalCaptureConfig(await writeConfig(dir,
            config({browser: {name: 'chromium', wsEndpoint: 'wss://steel.example.test'}}), 'steel.json')),
        /smelt-steel-capture/);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('loadLocalCaptureConfig rejects colliding page ids and URL schemes in file entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-local-collide-'));
    try {
        await mkdir(path.join(dir, 'a'));
        await mkdir(path.join(dir, 'b'));
        await writeFile(path.join(dir, 'a', 'index.html'), '<!doctype html><html><body>A</body></html>');
        await writeFile(path.join(dir, 'b', 'index.html'), '<!doctype html><html><body>B</body></html>');

        await assert.rejects(async () => loadLocalCaptureConfig(await writeConfig(dir, config({
            pages: [{file: 'a/index.html'}, {file: 'b/index.html'}]
        }))), /collides with/);

        await assert.rejects(async () => loadLocalCaptureConfig(await writeConfig(dir, config({
            pages: [{file: 'https://example.test/page.html'}]
        }), 'scheme.json')), /Put URLs in the url field/);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('loadLocalCaptureConfig resolves string storage states and rejects invalid timing values', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-local-state-'));
    try {
        await writeFile(path.join(dir, 'state.json'), '{"cookies":[],"origins":[]}');
        const loaded = await loadLocalCaptureConfig(await writeConfig(dir, config({
            storageState: 'state.json'
        })));

        assert.deepEqual(loaded.storageState, {cookies: [], origins: []});

        await assert.rejects(async () => loadLocalCaptureConfig(await writeConfig(dir, config({
            storageState: 5
        }), 'numeric-state.json')), /config.storageState must be an object/);

        await assert.rejects(async () => loadLocalCaptureConfig(await writeConfig(dir, config({
            observationMs: 'not-a-number'
        }), 'bad-timing.json')), /config.observationMs must be a finite nonnegative number/);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('runLocalCapture closes the browser when context creation fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-local-leak-'));
    try {
        const page = new FakePage('<!doctype html><html><body>Ok</body></html>');
        const playwright = fakePlaywright(page);
        const browser = playwright.browser;
        browser.newContext = async () => {
            throw new Error('storageState path is not a valid file');
        };

        await assert.rejects(() => runLocalCapture(config({outDir: dir}), {playwright}),
            /not a valid file/);
        assert.equal(browser.closed, true);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('runLocalCapture writes local-backend captures and closes the browser', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-local-capture-'));
    try {
        const page = new FakePage('<!doctype html><html><body><div id="consent" role="dialog"><button>Accept</button></div></body></html>');
        const playwright = fakePlaywright(page);
        const captures = await runLocalCapture(config({outDir: dir}), {
            playwright,
            capturedAt: '2026-09-07T23:40:00Z'
        });

        assert.equal(captures.length, 1);
        assert.equal(captures[0].id, 'example');
        assert.equal(playwright.browser.launchOptions.headless, true);
        assert.equal(playwright.browser.closed, true);

        const snapshot = JSON.parse(await readFile(captures[0].paths.snapshot, 'utf8'));
        const features = JSON.parse(await readFile(captures[0].paths.features, 'utf8'));
        const metadata = JSON.parse(await readFile(captures[0].paths.metadata, 'utf8'));
        assert.equal(snapshot.metadata.backend, 'local');
        assert.equal(features.metadata.backend, 'local');
        assert.equal(metadata.backend, 'local');
        assert.equal(metadata.group, 'example.test');
        assert.ok(snapshot.elements.some(element => element.attributes.id === 'consent'));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('runLocalCapture passes headed mode through to the browser launch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-local-headed-'));
    try {
        const page = new FakePage('<!doctype html><html><body>Ok</body></html>');
        const playwright = fakePlaywright(page);

        await runLocalCapture(config({outDir: dir}), {
            playwright,
            headless: false,
            capturedAt: '2026-09-07T23:41:00Z'
        });

        assert.equal(playwright.browser.launchOptions.headless, false);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('the bundled fixture crawl loads and points at existing files', async () => {
    const crawlPath = fileURLToPath(new URL('../fixtures/crawl.json', import.meta.url));
    const loaded = await loadLocalCaptureConfig(crawlPath);

    assert.deepEqual(loaded.pages.map(page => page.id),
        ['positive', 'negative', 'delayed', 'frame']);
    for (const page of loaded.pages) {
        assert.equal(new URL(page.url).protocol, 'file:');
        await stat(fileURLToPath(page.url));
    }
});

test('smelt-local-capture prints usage without a config path', () => {
    const result = spawnSync(process.execPath,
        [fileURLToPath(new URL('../local-cli.mjs', import.meta.url))],
        {encoding: 'utf8'});

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: smelt-local-capture/);
});
