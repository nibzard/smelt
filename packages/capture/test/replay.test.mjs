/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';

import {captureFrozenSnapshot} from '../index.mjs';
import {compareFrozenReplay, runFrozenSnapshot} from '../replay.mjs';
import {dom, rule, ruleset, type, utils} from '../../runtime/index.mjs';

function parse(html) {
    return parseHTML(html, {url: 'https://example.test/'}).document;
}

function stubBrowserLayout(doc) {
    const layoutById = new Map([
        ['page', {
            rect: {x: 0, y: 0, top: 0, right: 1200, bottom: 900, left: 0, width: 1200, height: 900},
            style: {display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto'}
        }],
        ['content', {
            rect: {x: 80, y: 80, top: 80, right: 720, bottom: 420, left: 80, width: 640, height: 340},
            style: {display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto'}
        }],
        ['banner', {
            rect: {x: 0, y: 620, top: 620, right: 1200, bottom: 900, left: 0, width: 1200, height: 280},
            style: {display: 'block', visibility: 'visible', opacity: '1', position: 'fixed', zIndex: '2147483647'}
        }],
        ['accept', {
            rect: {x: 960, y: 760, top: 760, right: 1080, bottom: 812, left: 960, width: 120, height: 52},
            style: {display: 'inline-block', visibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto'}
        }]
    ]);
    const fallback = {
        rect: {x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0},
        style: {display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto'}
    };
    for (const element of doc.querySelectorAll('*')) {
        const layout = layoutById.get(element.id) ?? fallback;
        Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => layout.rect
        });
    }
    doc.defaultView.getComputedStyle = element => (layoutById.get(element.id) ?? fallback).style;
}

function geometryRules() {
    return ruleset([
        rule(dom('div, button'), type('candidate').score(fnode => {
            const rect = fnode.element.getBoundingClientRect();
            return Math.round(rect.width * rect.height / 1000);
        }), {name: 'area'}),
        rule(type('candidate'), type('candidate').score(fnode => {
            const style = fnode.element.ownerDocument.defaultView.getComputedStyle(fnode.element);
            return style.position === 'fixed' ? 10 : 0;
        }), {name: 'fixed'}),
        rule(type('candidate'), type('candidate').score(fnode =>
            utils.isVisible(fnode.element) ? 1 : 0), {name: 'visible'})
    ]);
}

function vectorFor(fnode) {
    const rect = fnode.element.getBoundingClientRect();
    const style = fnode.element.ownerDocument.defaultView.getComputedStyle(fnode.element);
    return {
        id: fnode.element.id,
        rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
        position: style.position,
        zIndex: style.zIndex,
        visible: utils.isVisible(fnode.element),
        scores: Object.fromEntries(fnode.scoresSoFarFor('candidate'))
    };
}

test('runFrozenSnapshot injects captured layout into Node DOM APIs', () => {
    const doc = parse(`
        <html><body>
            <main id="page">
                <div id="content">Article</div>
                <div id="banner" role="dialog">Cookies <button id="accept">Accept</button></div>
            </main>
        </body></html>
    `);
    stubBrowserLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'layout-parity',
        capturedAt: '2026-09-07T22:10:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });

    const replay = runFrozenSnapshot(geometryRules(), snapshot, features);
    const bannerId = snapshot.elements.find(element => element.attributes.id === 'banner').id;
    const banner = replay.elementsById.get(bannerId);
    const style = replay.document.defaultView.getComputedStyle(banner);

    assert.equal(banner.getBoundingClientRect().width, 1200);
    assert.equal(style.position, 'fixed');
    assert.equal(style.zIndex, '2147483647');
    assert.equal(replay.run.get(type('candidate')).length, 3);
});

test('compareFrozenReplay returns exact vectors for layout rules', () => {
    const doc = parse(`
        <html><body>
            <main id="page">
                <div id="content">Article</div>
                <div id="banner" role="dialog">Cookies <button id="accept">Accept</button></div>
            </main>
        </body></html>
    `);
    stubBrowserLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'layout-parity',
        capturedAt: '2026-09-07T22:10:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });
    const ids = snapshot.elements
        .filter(element => ['content', 'banner', 'accept'].includes(element.attributes.id))
        .map(element => element.id);

    const parity = compareFrozenReplay({
        ruleset: geometryRules(),
        browserDocument: doc,
        snapshot,
        features,
        ids,
        vector: vectorFor
    });

    assert.equal(parity.equal, true);
    assert.deepEqual(parity.node, parity.browser);
    assert.equal(parity.node[ids[1]].scores.fixed, 10);
});
