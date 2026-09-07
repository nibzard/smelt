/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';

import {capturePage, loadSteelCaptureConfig, runSteelCapture, writeCapture} from '../steel.mjs';

class FakePage {
    constructor(html, browserVersion = '128.0.0') {
        this.doc = parseHTML(html, {url: 'https://example.test/'}).document;
        this.browserVersion = browserVersion;
        this.initScripts = [];
        this.viewport = null;
        this.gotoUrl = null;
    }

    async setViewportSize(viewport) {
        this.viewport = viewport;
        this.doc.defaultView.innerWidth = viewport.width;
        this.doc.defaultView.innerHeight = viewport.height;
    }

    async addInitScript(script) {
        this.initScripts.push(script);
    }

    async goto(url) {
        this.gotoUrl = url;
        Object.defineProperty(this.doc, 'URL', {value: url, configurable: true});
    }

    async waitForLoadState() {}

    async waitForTimeout() {}

    context() {
        return {browser: () => ({version: () => this.browserVersion})};
    }

    async evaluate(callback, payload) {
        const previousDocument = globalThis.document;
        const previousNavigator = globalThis.navigator;
        const previousInnerWidth = globalThis.innerWidth;
        const previousInnerHeight = globalThis.innerHeight;
        const previousDevicePixelRatio = globalThis.devicePixelRatio;
        const previousNode = globalThis.Node;
        const previousPerformance = globalThis.performance;
        Object.defineProperty(globalThis, 'document', {value: this.doc, configurable: true});
        Object.defineProperty(globalThis, 'navigator', {
            value: {userAgent: 'FakeSteelBrowser/1.0'},
            configurable: true
        });
        globalThis.innerWidth = this.viewport.width;
        globalThis.innerHeight = this.viewport.height;
        globalThis.devicePixelRatio = 1;
        globalThis.Node = this.doc.defaultView.Node;
        globalThis.performance = {
            getEntriesByType: () => [{toJSON: () => ({type: 'navigate'})}]
        };
        try {
            return callback(payload);
        } finally {
            restore('document', previousDocument);
            restore('navigator', previousNavigator);
            globalThis.innerWidth = previousInnerWidth;
            globalThis.innerHeight = previousInnerHeight;
            globalThis.devicePixelRatio = previousDevicePixelRatio;
            globalThis.Node = previousNode;
            globalThis.performance = previousPerformance;
        }
    }

    async close() {}
}

function restore(name, value) {
    if (value === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, {value, configurable: true});
}

function config(overrides = {}) {
    return {
        outDir: 'corpus/captures',
        browser: {name: 'chromium', wsEndpoint: 'wss://steel.example.test/session'},
        viewport: {width: 1280, height: 720, deviceScaleFactor: 1},
        observationMs: 25,
        navigationTimeoutMs: 1000,
        egressLocation: 'eu-west',
        storageState: {label: 'fresh'},
        pages: [{id: 'example', url: 'https://example.test/', group: 'example.test'}],
        ...overrides
    };
}

test('loadSteelCaptureConfig validates the Steel capture format', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-steel-config-'));
    const filename = path.join(dir, 'steel.json');
    await writeFile(filename, JSON.stringify(config(), null, 2));

    const loaded = await loadSteelCaptureConfig(filename);
    assert.equal(loaded.browser.name, 'chromium');
    assert.equal(loaded.browser.wsEndpoint, 'wss://steel.example.test/session');
    assert.equal(loaded.pages[0].id, 'example');
    assert.equal(loaded.egressLocation, 'eu-west');

    await rm(dir, {recursive: true, force: true});
});

test('capturePage injects the engine and records Steel metadata', async () => {
    const page = new FakePage('<!doctype html><html><body><div id="consent" role="dialog"><button>Accept</button></div></body></html>');
    const captureConfig = config();
    const result = await capturePage(page, captureConfig.pages[0], captureConfig, {
        capturedAt: '2026-09-07T22:00:00Z'
    });

    assert.equal(result.snapshot.schemaVersion, 1);
    assert.equal(result.features.schemaVersion, 1);
    assert.equal(result.snapshot.metadata.backend, 'steel');
    assert.equal(result.snapshot.metadata.browserName, 'chromium');
    assert.equal(result.snapshot.metadata.userAgent, 'FakeSteelBrowser/1.0');
    assert.equal(result.metadata.group, 'example.test');
    assert.equal(page.initScripts.length, 1);
    assert.ok(result.snapshot.elements.some(element => element.attributes.id === 'consent'));
});

test('writeCapture writes snapshot, features, and metadata files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-steel-capture-'));
    const page = new FakePage('<!doctype html><html><body><main>Ok</main></body></html>');
    const captureConfig = config();
    const result = await capturePage(page, captureConfig.pages[0], captureConfig, {
        capturedAt: '2026-09-07T22:01:00Z'
    });
    const paths = await writeCapture(dir, 'example', result);

    assert.equal(JSON.parse(await readFile(paths.snapshot, 'utf8')).metadata.captureId, 'example');
    assert.equal(JSON.parse(await readFile(paths.features, 'utf8')).metadata.backend, 'steel');
    assert.equal(JSON.parse(await readFile(paths.metadata, 'utf8')).group, 'example.test');

    await rm(dir, {recursive: true, force: true});
});

test('runSteelCapture requires a Steel browser endpoint', async () => {
    await assert.rejects(() => runSteelCapture(config({browser: {name: 'chromium', wsEndpoint: null}}), {
        playwright: {}
    }), /STEEL_BROWSER_WS_ENDPOINT/);
});
