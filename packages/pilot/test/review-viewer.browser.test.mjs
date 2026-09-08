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

function snapshot({withIframe = false, nested = false, overlap = false} = {}) {
    const elements = [
        {id: 'e0', tagName: 'html', textSample: '', attributes: {}, children: ['e1']},
        {id: 'e1', tagName: 'body', textSample: '', attributes: {},
            children: withIframe ? ['e4'] : nested || overlap ? ['e2'] : ['e2', 'e3']},
        {id: 'e2', tagName: 'main', textSample: 'Article', attributes: {id: 'content'},
            children: nested ? ['e3'] : overlap ? ['e5', 'e6'] : []}
    ];
    if (withIframe) {
        elements.push({id: 'e4', tagName: 'iframe', textSample: '',
            attributes: {src: 'https://tracker.example/banner'}, children: []});
    } else if (overlap) {
        // The amazon-footer shape: a small link whose box sits under the
        // much bigger box of a later wrapped inline sibling.
        elements.push({id: 'e5', tagName: 'a', textSample: 'footer link',
            attributes: {href: 'https://example.com/more'}, children: []});
        elements.push({id: 'e6', tagName: 'span',
            textSample: '© example — wrapped copyright line that spans several rows',
            attributes: {}, children: []});
    } else {
        elements.push({id: 'e3', tagName: 'div', textSample: 'We use cookies',
            attributes: {id: 'banner'}, children: []});
    }
    return {schemaVersion: 1, rootElementId: 'e0',
        frames: [{id: 'f0', accessible: true}], elements};
}

function features({withIframe = false, nested = false, overlap = false,
    topBanner = false} = {}) {
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
    } else if (topBanner) {
        // A banner pinned to the very top: the fixed control bar covers
        // it, but elementsFromPoint still lists it under the bar.
        elements.push({id: 'e3', layout: {rect: rect(0, 0, 1200, 120).rect,
            display: 'block', visibility: 'visible', opacity: 1,
            position: 'fixed', zIndex: 2147483647}});
    } else if (overlap) {
        elements.push({id: 'e5', layout: {rect: rect(20, 150, 160, 24).rect,
            display: 'inline', visibility: 'visible', opacity: 1,
            position: 'absolute', zIndex: 4}});
        elements.push({id: 'e6', layout: {rect: rect(10, 140, 640, 220).rect,
            display: 'inline', visibility: 'visible', opacity: 1,
            position: 'absolute', zIndex: 6}});
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
    let proposalsPath;
    if (options.proposal) {
        proposalsPath = resolve(outDir, '..', `proposals-${captureId}.jsonl`);
        await writeFile(proposalsPath,
            `${JSON.stringify({capture_id: captureId, ...options.proposal})}\n`);
    }
    await buildReviewViewer({
        items: [{capture_id: captureId, group: 'example.com', reason: 'initial label'}],
        capturesDir,
        outDir,
        proposalsPath
    });
    return {pagePath: resolve(outDir, `${captureId}.html`), cleanup: async () => {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        if (proposalsPath) await rm(proposalsPath, {force: true});
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
    const text = await page.locator('#smelt-json-text').textContent();
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
            // marker, so a missing guard would select it here. The nav
            // line at the top of the bar is interactive on purpose, so
            // the bar click targets the capture title text instead.
            await page.selectOption('#smelt-kind', 'dialog');
            await page.selectOption('#smelt-jurisdiction', 'us');
            await page.selectOption('#smelt-confidence', '0.9');
            await page.fill('#smelt-notes', 'checked controls');
            await page.mouse.click(1100, 400);
            await page.click('#smelt-bar strong');
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

test('browser: alt+click walks past a covering wrapped inline box',
    {skip: !playwright}, async t => {
        const {pagePath, cleanup} = await writeViewerPage('overlap-page', {overlap: true});
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            // A point inside the link's visual box, which the span's
            // bigger replayed box covers.
            const point = await page.evaluate(() => {
                const link = document.querySelector('[data-smelt-replay-id="e5"]');
                const r = link.getBoundingClientRect();
                return {x: Math.round(r.x + 20), y: Math.round(r.y + 10)};
            });
            const selection = () => page.locator('#smelt-selection').textContent();
            // mouse.click takes no modifiers option; a held key must go
            // through the keyboard, the way a person holds it.
            const altClick = async (x, y) => {
                await page.keyboard.down('Alt');
                try {
                    await page.mouse.click(x, y);
                } finally {
                    await page.keyboard.up('Alt');
                }
            };

            // The hover tip says more elements sit below the top one.
            await page.mouse.move(point.x, point.y);
            const tip = await page.locator('#smelt-hover').textContent();
            assert.match(tip, /e6 <span>/);
            assert.match(tip, /\+2 below \(alt\+click\)/);

            // A plain click hits the covering span: the interception the
            // amazon footer capture showed for real.
            await page.mouse.click(point.x, point.y);
            assert.equal(await selection(), ' roots: [e6]');

            // Alt+click selects the covered link and drops the span.
            await altClick(point.x, point.y);
            assert.equal(await selection(), ' roots: [e5]');

            // The next alt+click walks to the container below both.
            await altClick(point.x, point.y);
            assert.equal(await selection(), ' roots: [e2]');

            const label = await copiedLabel(page);
            assert.deepEqual(label.acceptable_roots, ['e2']);
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: a teacher proposal outlines a root without selecting it',
    {skip: !playwright}, async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu', {
            proposal: {
                adapter: {id: 'fake-teacher'},
                labels: {has_banner: true, banner_root: 'e3', banner_kind: 'dialog',
                    jurisdiction: 'eea', confidence: 0.9, evidence: []},
                verification: {status: 'pass', issues: []}
            }
        });
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            const panel = page.locator('#smelt-proposal');

            // The panel starts collapsed, so an unbiased first pass never
            // sees the teacher's answer.
            assert.equal(await panel.getAttribute('open'), null);
            await panel.locator('summary').click();

            // Outlining the proposed root never selects it.
            await page.click('#smelt-prop-outline');
            assert.ok(await page.locator('[data-smelt-replay-id="e3"]')
                .evaluate(node => node.classList.contains('smelt-proposal-outline')));
            assert.equal(await page.locator('#smelt-selection').textContent(), '');

            await page.click('#smelt-prop-outline');
            assert.ok(!(await page.locator('[data-smelt-replay-id="e3"]')
                .evaluate(node => node.classList.contains('smelt-proposal-outline'))));

            // The copied record is the reviewer's own: no selection, no
            // proposal fields, a clean negative.
            const label = await copiedLabel(page);
            assert.equal(label.has_banner, false);
            assert.deepEqual(label.acceptable_roots, []);
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: clicks on the bar and the JSON box never select behind them',
    {skip: !playwright}, async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu');
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            // The JSON box is fixed over the page content once visible.
            // elementsFromPoint lists the replayed elements behind it, so
            // a click inside the box (the reviewer selects the JSON text
            // to copy it by hand) is the regression probe.
            await page.click('#smelt-copy');
            const overlap = await page.evaluate(() => {
                const box = document.getElementById('smelt-json')
                    .getBoundingClientRect();
                const main = document.querySelector('[data-smelt-replay-id="e2"]')
                    .getBoundingClientRect();
                return box.top < main.bottom && box.bottom > main.top;
            });
            assert.equal(overlap, true);

            await page.click('#smelt-json', {position: {x: 40, y: 12}});
            await page.click('#smelt-kind');
            await page.mouse.move(300, 130);
            const hoverShown = await page.evaluate(() =>
                document.getElementById('smelt-hover').style.display);

            assert.equal(await page.locator('#smelt-selection').textContent(), '');
            assert.equal(hoverShown, 'none');
            await page.click('#smelt-copy');
            const label = JSON.parse(
                await page.locator('#smelt-json-text').textContent());
            assert.deepEqual(label.acceptable_roots, []);
            assert.deepEqual(validateConsentLabels(datasetFor(label)), []);
        } finally {
            await browser.close();
            await cleanup();
        }
    });

test('browser: the JSON box closes and the covered element is clickable again',
    {skip: !playwright}, async t => {
        const {pagePath, cleanup} = await writeViewerPage('example-com-eu');
        const browser = await launchBrowser(t);
        if (!browser) return void await cleanup();
        try {
            const page = await browser.newPage();
            await page.goto(`file://${pagePath}`);
            const boxHidden = () => page.evaluate(() =>
                document.getElementById('smelt-json').hidden);
            const selection = () => page.locator('#smelt-selection').textContent();

            // Copy shows the box over the replayed content. A click at a
            // point the box covers selects nothing while it is shown.
            await page.click('#smelt-copy');
            assert.equal(await boxHidden(), false);
            const point = await page.evaluate(() => {
                const box = document.getElementById('smelt-json')
                    .getBoundingClientRect();
                const main = document.querySelector('[data-smelt-replay-id="e2"]')
                    .getBoundingClientRect();
                const top = Math.max(box.top, main.top);
                const bottom = Math.min(box.bottom, main.bottom);
                if (bottom <= top) return null;
                return {x: Math.round(Math.max(box.left, main.left) + 40),
                    y: Math.round((top + bottom) / 2)};
            });
            assert.ok(point, 'the JSON box overlaps the replayed content');
            await page.mouse.click(point.x, point.y);
            assert.equal(await selection(), '');

            // Esc hides the box; the same click now reaches the element.
            await page.keyboard.press('Escape');
            assert.equal(await boxHidden(), true);
            await page.mouse.click(point.x, point.y);
            assert.equal(await selection(), ' roots: [e2]');

            // Copy shows it again, and the close button hides it too.
            await page.click('#smelt-copy');
            assert.equal(await boxHidden(), false);
            const label = JSON.parse(
                await page.locator('#smelt-json-text').textContent());
            assert.deepEqual(label.acceptable_roots, ['e2']);
            await page.click('#smelt-json-close');
            assert.equal(await boxHidden(), true);
            // The toggle click now reaches e2 again and removes it; a box
            // that stayed shown would have left the selection untouched.
            await page.mouse.click(point.x, point.y);
            assert.equal(await selection(), ' roots: []');
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
