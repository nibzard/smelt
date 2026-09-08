/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Real-browser coverage for the review viewer: the reviewer clicks roots,
// presses the copy button, and the page produces a label record. The test
// feeds that record straight into validateConsentLabels, so the human
// labeling path cannot drift from the labels schema. The file skips
// wherever Chromium is not available; review-viewer.test.mjs covers the
// page structure without a browser.

import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {test} from 'node:test';

import {buildReviewViewer} from '../review-viewer.mjs';
import {validateConsentLabels} from '../labels.mjs';

let playwright = null;
try {
    playwright = await import('playwright');
} catch {
    // Optional on purpose: CI has no browser.
}

function snapshot({withIframe = false, nested = false} = {}) {
    const elements = [
        {id: 'e0', tagName: 'html', textSample: '', attributes: {}, children: ['e1']},
        {id: 'e1', tagName: 'body', textSample: '', attributes: {},
            children: withIframe ? ['e4'] : nested ? ['e2'] : ['e2', 'e3']},
        {id: 'e2', tagName: 'main', textSample: 'Article', attributes: {id: 'content'},
            children: nested ? ['e3'] : []}
    ];
    if (withIframe) {
        elements.push({id: 'e4', tagName: 'iframe', textSample: '',
            attributes: {src: 'https://tracker.example/banner'}, children: []});
    } else {
        elements.push({id: 'e3', tagName: 'div', textSample: 'We use cookies',
            attributes: {id: 'banner'}, children: []});
    }
    return {schemaVersion: 1, rootElementId: 'e0',
        frames: [{id: 'f0', accessible: true}], elements};
}

function features({withIframe = false, nested = false} = {}) {
    const rect = (x, y, width, height) => ({
        rect: {x, y, top: y, right: x + width, bottom: y + height, left: x, width, height},
        display: 'block', visibility: 'visible', opacity: 1, position: 'static', zIndex: null
    });
    const elements = [
        {id: 'e0', layout: rect(0, 0, 1200, 900)},
        {id: 'e1', layout: rect(0, 0, 1200, 900)},
        {id: 'e2', layout: rect(0, nested ? 100 : 0, 700, 500)}
    ];
    if (nested) {
        elements.push({id: 'e3', layout: {rect: rect(10, 120, 600, 200).rect,
            display: 'block', visibility: 'visible', opacity: 1,
            position: 'absolute', zIndex: 5}});
    } else {
        elements.push(withIframe
            ? {id: 'e4', layout: {rect: rect(0, 650, 1200, 250).rect, display: 'block',
                visibility: 'visible', opacity: 1, position: 'fixed', zIndex: 2147483647}}
            : {id: 'e3', layout: {rect: rect(0, 650, 1200, 250).rect, display: 'block',
                visibility: 'visible', opacity: 1, position: 'fixed', zIndex: 2147483647}});
    }
    return {schemaVersion: 1, viewport: {width: 1200, height: 900, deviceScaleFactor: 1},
        elements};
}

async function writeViewerPage(captureId, options = {}) {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-br-in-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-br-out-'));
    await writeFile(resolve(capturesDir, `${captureId}.snapshot.json`),
        JSON.stringify(snapshot(options)));
    await writeFile(resolve(capturesDir, `${captureId}.features.json`),
        JSON.stringify(features(options)));
    await writeFile(resolve(capturesDir, `${captureId}.metadata.json`), JSON.stringify({
        url: 'https://example.com/', egressLocation: 'eu-de-residential',
        targetMetadata: {expect: 'banner', jurisdiction: 'eea'}
    }));
    await buildReviewViewer({
        items: [{capture_id: captureId, group: 'example.com', reason: 'initial label'}],
        capturesDir,
        outDir
    });
    return {pagePath: resolve(outDir, `${captureId}.html`), cleanup: async () => {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
    }};
}

// Chromium must be installed, not just importable: a missing binary makes
// launch() throw, and the whole file skips instead of failing.
async function launchBrowser(t) {
    if (!playwright) return null;
    try {
        return await playwright.chromium.launch({headless: true});
    } catch (error) {
        t.skip(`Chromium is not installed: ${error.message.split('\n')[0]}`);
        return null;
    }
}

async function copiedLabel(page) {
    await page.click('#smelt-copy');
    const text = await page.locator('#smelt-json').textContent();
    // The JSON box fills before any clipboard work, so the label content
    // never depends on clipboard permissions.
    return JSON.parse(text);
}

function datasetFor(label) {
    return {schema_version: 1, split: 'development', pages: [label]};
}

test('browser: clicked roots produce a validating positive label', {skip: !playwright},
    async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu');
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            await page.click('[data-smelt-replay-id="e3"]');
            const label = await copiedLabel(page);

            assert.equal(label.id, 'example-com-eu');
            assert.equal(label.has_banner, true);
            assert.deepEqual(label.acceptable_roots, ['e3']);
            assert.equal(label.banner_root, 'e3');
            assert.equal(label.jurisdiction, 'eea');
            assert.deepEqual(label.frame, {state: 'top', frame_id: null, element_id: null});
            assert.ok(label.evidence.length > 0);
            // The record the reviewer pastes must pass the schema check.
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: no clicks produce a validating negative label', {skip: !playwright},
    async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu');
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            const label = await copiedLabel(page);

            assert.equal(label.has_banner, false);
            assert.deepEqual(label.acceptable_roots, []);
            assert.equal(label.banner_root, null);
            assert.equal(label.banner_kind, 'unknown');
            assert.deepEqual(label.evidence, []);
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: bar controls and blank-page clicks never change the selection', {skip: !playwright},
    async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu');
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            // Exercise every bar control, then click blank areas of the
            // page. The replayed <body> wraps everything and carries a
            // marker, so a missing guard would select it here.
            await page.selectOption('#smelt-kind', 'dialog');
            await page.selectOption('#smelt-jurisdiction', 'us');
            await page.selectOption('#smelt-confidence', '0.9');
            await page.fill('#smelt-notes', 'checked controls');
            await page.mouse.click(1100, 400);
            await page.mouse.click(20, 10);
            const selected = await page.locator('#smelt-selection').textContent();
            assert.equal(selected.includes('roots:'), false);

            const label = await copiedLabel(page);
            assert.equal(label.has_banner, false);
            assert.deepEqual(label.acceptable_roots, []);
            // The reviewer-chosen fields survive the control interaction.
            assert.equal(label.banner_kind, 'unknown');
            assert.equal(label.jurisdiction, 'us');
            assert.equal(label.confidence, 0.9);
            assert.equal(label.review_notes, 'checked controls');
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: deselecting the banner root promotes the next root', {skip: !playwright},
    async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu');
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            await page.click('[data-smelt-replay-id="e3"]');
            await page.click('[data-smelt-replay-id="e2"]');
            await page.click('[data-smelt-replay-id="e3"]');

            const label = await copiedLabel(page);
            assert.deepEqual(label.acceptable_roots, ['e2']);
            assert.equal(label.banner_root, 'e2');
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: nested elements land at their captured viewport rectangle',
    {skip: !playwright}, async t => {
        const {pagePath, cleanup} = await writeViewerPage('nested-page', {nested: true});
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            const placed = await page.evaluate(() => {
                const banner = document.querySelector('[data-smelt-replay-id="e3"]');
                const bar = document.getElementById('smelt-bar');
                const rect = banner.getBoundingClientRect();
                return {x: rect.x, y: rect.y, w: rect.width, h: rect.height,
                    barHeight: bar.offsetHeight};
            });
            // Offsets compose through the boxed ancestors, so the banner
            // lands at its captured rectangle plus the bar shift, exactly
            // once — not once per nesting level.
            assert.ok(Math.abs(placed.x - 10) < 1, `x: ${placed.x}`);
            assert.ok(Math.abs(placed.y - (120 + placed.barHeight)) < 1,
                `y: ${placed.y} vs ${120 + placed.barHeight}`);
            assert.ok(Math.abs(placed.w - 600) < 1, `width: ${placed.w}`);
            assert.ok(Math.abs(placed.h - 200) < 1, `height: ${placed.h}`);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: an iframe root records the frame element', {skip: !playwright},
    async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu', {withIframe: true});
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            // The frame host is blanked, and its clickable catcher sits
            // above it: a click inside the frame box must select the
            // frame element, not vanish into a child document.
            const state = await page.evaluate(() => {
                const host = document.querySelector('iframe[data-smelt-replay-id="e4"]');
                return {blanked: host.src === 'about:blank' || host.getAttribute('src') === 'about:blank',
                    sandboxed: host.hasAttribute('sandbox'),
                    catchers: document.querySelectorAll('.smelt-frame-catch').length,
                    requested: performance.getEntriesByType('resource')
                        .filter(entry => entry.name.startsWith('http')).length};
            });
            assert.equal(state.blanked, true);
            assert.equal(state.sandboxed, true);
            assert.equal(state.catchers, 1);
            // No remote URL was ever requested: the src never existed in
            // the page source.
            assert.equal(state.requested, 0);

            await page.click('.smelt-frame-catch');
            const label = await copiedLabel(page);

            assert.deepEqual(label.frame,
                {state: 'unknown', frame_id: null, element_id: 'e4'});
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });
