/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Real-browser coverage for watch() (IDEA.md 3.4.6): a single-page-app
// route change injects a consent banner after load, and watch must
// re-detect it through a genuine MutationObserver, real layout, and the
// browser's requestIdleCallback. The file skips wherever Chromium is not
// available; the fake-observer suite in watch.test.mjs carries the logic.

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

let playwright = null;
try {
    playwright = await import('playwright');
} catch {
    // Optional here on purpose: CI has no browser. The bundle still gets
    // built below, so the browser shape of watch.mjs is always checked.
}

// Bundle watch.mjs with its static graph into one browser module. The
// linkedom fallback stays external: a browser never loads it, because a
// real Document skips the string-parsing path entirely.
async function bundleAsDataUrl() {
    const result = await build({
        entryPoints: [fileURLToPath(new URL('../watch.mjs', import.meta.url))],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        external: ['linkedom'],
        minify: true,
        write: false
    });
    const text = result.outputFiles[0].text;
    assert.equal(result.outputFiles.length, 1);
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(text)}`;
}

test('watch retriggers detection on single-page-app mutations', async t => {
    // Build the bundle before any skip, so the browser shape of watch.mjs
    // (no Node-only modules in its static graph) is checked even where
    // playwright or Chromium is unavailable.
    const dataUrl = await bundleAsDataUrl();
    if (playwright === null) return t.skip('playwright is not installed');
    let browser;
    try {
        browser = await playwright.chromium.launch();
    } catch (error) {
        return t.skip(
            `chromium is not available: ${error.message.split('\n')[0]}`);
    }
    const pageErrors = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(String(error)));
        await page.setContent(`<!doctype html><html><body>
            <main id="content"><h1>Example shop</h1></main>
        </body></html>`);
        await page.evaluate(async url => {
            const mod = await import(url);
            window.__events = [];
            window.__handle = mod.watch(document, (result, event) => {
                window.__events.push({
                    found: result.banner !== null,
                    cause: event.cause
                });
            }, {debounceMs: 60});
        }, dataUrl);
        await page.waitForTimeout(300);
        assert.deepEqual(await page.evaluate(() => window.__events),
            [{found: false, cause: 'initial'}]);

        // A route change injects the banner after first paint.
        await page.evaluate(() => {
            document.body.insertAdjacentHTML('beforeend', `
                <aside id="cookie"
                    style="position:fixed;bottom:0;left:0;right:0;z-index:9999">
                    <p>This site uses cookies to improve privacy preferences.</p>
                    <button>Accept</button>
                </aside>
            `);
        });
        await page.waitForTimeout(600);
        assert.deepEqual(await page.evaluate(() => window.__events), [
            {found: false, cause: 'initial'},
            {found: true, cause: 'mutation'}
        ]);

        // After cancel, further changes deliver nothing.
        await page.evaluate(() => window.__handle.cancel());
        await page.evaluate(() => {
            document.body.insertAdjacentHTML('beforeend',
                '<div id="promo">Sale</div>');
        });
        await page.waitForTimeout(600);
        assert.equal((await page.evaluate(() => window.__events)).length, 2);
        assert.deepEqual(pageErrors, []);
    } finally {
        await browser.close();
    }
}, {timeout: 120000});
