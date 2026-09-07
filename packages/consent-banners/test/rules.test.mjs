/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';

import {captureFrozenSnapshot} from '@smelt-oss/capture';
import {runFrozenSnapshot} from '@smelt-oss/capture/replay';
import {type} from '@smelt-oss/runtime';
import {CANDIDATE_TYPE, consentRules, vectorForConsentCandidate} from '../rules.mjs';

const viewport = {width: 1200, height: 900, deviceScaleFactor: 1};

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
    const fallback = layout({x: 0, y: 0, width: 600, height: 120});
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

function snapshotRun(doc, captureId) {
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId,
        capturedAt: '2026-09-07T23:00:00Z',
        viewport
    });
    return runFrozenSnapshot(consentRules(), snapshot, features);
}

function vectorByDomId(replay, domId) {
    const snapshotElement = Array.from(replay.elementsById.entries())
        .find(([, element]) => element.getAttribute('id') === domId);
    assert.ok(snapshotElement, `missing element with id ${domId}`);
    return vectorForConsentCandidate(replay.run.get(snapshotElement[1]));
}

test('vectors a visible consent dialog with text, position, size, and controls', () => {
    const doc = parse(`
        <html><body>
            <main id="content"><h1>Example shop</h1></main>
            <section id="consent" role="dialog" aria-modal="true" class="cookie banner">
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

    const replay = snapshotRun(doc, 'positive-consent');
    const vector = vectorByDomId(replay, 'consent');

    assert.deepEqual(vector, {
        candidate: 0,
        'banner-text': 3,
        role: 2,
        position: 4,
        size: 2,
        visibility: 1,
        controls: 3,
        'hard-negative': 0
    });
    assert.equal(replay.run.get(type(CANDIDATE_TYPE)).length, 1);
});

test('vectors a footer cookie policy as a hard negative', () => {
    const doc = parse(`
        <html><body>
            <main id="content"><h1>Example shop</h1></main>
            <footer id="footer"><a href="/cookies">Cookie policy</a></footer>
        </body></html>
    `);
    installLayout(doc, new Map([
        ['content', layout({x: 80, y: 80, width: 720, height: 420})],
        ['footer', layout({x: 0, y: 820, width: 1200, height: 80})]
    ]));

    const vector = vectorByDomId(snapshotRun(doc, 'policy-only'), 'footer');

    assert.equal(vector['banner-text'], 3);
    assert.equal(vector.controls, 1);
    assert.equal(vector['hard-negative'], -5);
});

test('vectors newsletter and sign-in dialogs as hard negatives', () => {
    const doc = parse(`
        <html><body>
            <div id="newsletter" role="dialog">
                <p>Subscribe to our newsletter.</p>
                <button>Sign up</button>
            </div>
            <form id="signin" role="dialog">
                <p>Sign in to continue.</p>
                <button>Log in</button>
            </form>
        </body></html>
    `);
    installLayout(doc, new Map([
        ['newsletter', layout({x: 300, y: 200, width: 420, height: 260}, 'fixed', '1001')],
        ['signin', layout({x: 340, y: 260, width: 380, height: 220}, 'fixed', '1001')]
    ]));

    const replay = snapshotRun(doc, 'hard-negatives');

    assert.equal(vectorByDomId(replay, 'newsletter')['hard-negative'], -5);
    assert.equal(vectorByDomId(replay, 'signin')['hard-negative'], -5);
});

test('vectors hidden consent notices as not visible', () => {
    const doc = parse(`
        <html><body>
            <aside id="hidden" role="dialog">
                <p>We use cookies.</p>
                <button>Accept</button>
            </aside>
        </body></html>
    `);
    installLayout(doc, new Map([
        ['hidden', layout({x: 0, y: 650, width: 1200, height: 250}, 'fixed', '1001', 'none')]
    ]));

    const vector = vectorByDomId(snapshotRun(doc, 'hidden-consent'), 'hidden');

    assert.equal(vector['banner-text'], 3);
    assert.equal(vector.visibility, -4);
});
