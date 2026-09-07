/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';

import {ModelArtifactError, SmeltError, UnsupportedInputError, detect} from '../index.mjs';

const viewport = {width: 1200, height: 900};

function parse(html) {
    return parseHTML(html, {url: 'https://example.test/'}).document;
}

function layout(rect, position = 'static', zIndex = 'auto', display = 'block') {
    return {
        rect: {
            x: rect.x,
            y: rect.y,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
            left: rect.x,
            width: rect.width,
            height: rect.height
        },
        style: {display, visibility: 'visible', opacity: '1', position, zIndex}
    };
}

function installLayout(doc, byId) {
    const fallback = layout({x: 0, y: 0, width: 640, height: 160});
    for (const element of doc.querySelectorAll('*')) {
        const data = byId.get(element.id) ?? fallback;
        Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => data.rect
        });
    }
    doc.defaultView.getComputedStyle = element => (byId.get(element.id) ?? fallback).style;
    Object.defineProperty(doc.defaultView, 'innerWidth', {configurable: true, value: viewport.width});
    Object.defineProperty(doc.defaultView, 'innerHeight', {configurable: true, value: viewport.height});
}

test('detects a visible consent banner in a Document', async () => {
    const doc = parse(`
        <html><body>
            <main id="content"><h1>Example shop</h1></main>
            <section id="consent" role="dialog" aria-modal="true">
                <p>We use cookies for analytics and advertising.</p>
                <button>Accept all</button>
                <button>Manage choices</button>
            </section>
        </body></html>
    `);
    installLayout(doc, new Map([
        ['content', layout({x: 80, y: 80, width: 720, height: 420})],
        ['consent', layout({x: 0, y: 650, width: 1200, height: 250}, 'fixed', '2147483647')]
    ]));

    const result = await detect(doc);

    assert.equal(result.found?.[0].id, 'consent');
    assert.equal(result.banner.kind, 'dialog');
    assert.ok(result.banner.evidence.includes('banner-text'));
    assert.equal(result.degraded.length, 0);
    assert.equal(result.stats.truncated, false);
    assert.equal(result.stats.tier, 0);
    assert.equal(typeof result.stats.ms, 'number');
});

test('detects a consent banner from an HTML string', async () => {
    const result = await detect(`
        <html><body>
            <aside id="cookie">
                <p>This site uses cookies to improve privacy preferences.</p>
                <button>Accept</button>
            </aside>
        </body></html>
    `);

    assert.equal(result.found?.[0].id, 'cookie');
    assert.equal(result.banner.kind, 'banner');
    assert.equal(result.degraded.length, 0);
});

test('returns no banner for a newsletter dialog', async () => {
    const doc = parse(`
        <html><body>
            <div id="newsletter" role="dialog">
                <p>Subscribe to our newsletter.</p>
                <button>Sign up</button>
            </div>
        </body></html>
    `);
    installLayout(doc, new Map([
        ['newsletter', layout({x: 320, y: 180, width: 430, height: 230}, 'fixed', '1001')]
    ]));

    const result = await detect(doc);

    assert.equal(result.found, null);
    assert.equal(result.banner, null);
    assert.equal(result.degraded.length, 0);
});

test('rejects unsupported input with a typed error', async () => {
    await assert.rejects(() => detect({}), error => {
        assert.ok(error instanceof UnsupportedInputError);
        assert.ok(error instanceof SmeltError);
        return true;
    });
    assert.equal(ModelArtifactError.prototype instanceof SmeltError, true);
});

test('returns structured failure for a malformed document', async () => {
    const result = await detect({documentElement: {}});

    assert.equal(result.found, null);
    assert.equal(result.banner, null);
    assert.deepEqual(result.degraded, ['rule-evaluation-failed']);
    assert.equal(result.stats.truncated, false);
    assert.match(result.stats.error, /querySelectorAll|defaultView/);
});

test('reports truncation through stats and degraded', async () => {
    const doc = parse(`
        <html><body>
            <section id="consent" role="dialog" aria-modal="true">
                <p>We use cookies for analytics and advertising.</p>
                <button>Accept all</button>
                <button>Manage choices</button>
            </section>
        </body></html>
    `);
    installLayout(doc, new Map([
        ['consent', layout({x: 0, y: 650, width: 1200, height: 250}, 'fixed', '2147483647')]
    ]));

    const body = doc.body;
    for (let index = 0; index < 20050; index++) {
        body.appendChild(doc.createElement('div'));
    }

    const result = await detect(doc);

    assert.equal(result.stats.truncated, true);
    assert.ok(result.degraded.includes('element-budget-exceeded'));
});
