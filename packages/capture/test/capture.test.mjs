/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';
import {captureFrozenSnapshot} from '../index.mjs';

async function fixture(name) {
    return readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

function parse(html, url = 'https://example.test/') {
    return parseHTML(html, {url}).document;
}

function stubLayout(doc) {
    const values = new Map();
    for (const [index, element] of Array.from(doc.querySelectorAll('*')).entries()) {
        values.set(element, {
            rect: {x: index, y: index + 1, top: index + 1, right: index + 20,
                bottom: index + 30, left: index, width: 20, height: 29},
            style: {display: 'block', visibility: 'visible', opacity: '1',
                position: element.id === 'consent' ? 'fixed' : 'static',
                zIndex: element.id === 'consent' ? '2147483647' : 'auto'}
        });
        element.getBoundingClientRect = () => values.get(element).rect;
    }
    doc.defaultView.getComputedStyle = element => values.get(element)?.style ?? {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position: 'static',
        zIndex: 'auto'
    };
}

test('captureFrozenSnapshot assigns stable pre-order element IDs', async () => {
    const doc = parse(await fixture('positive.html'));
    const first = captureFrozenSnapshot(doc, {
        captureId: 'positive',
        capturedAt: '2026-09-07T21:45:00Z',
        viewport: {width: 1280, height: 720}
    });
    const second = captureFrozenSnapshot(doc, {
        captureId: 'positive',
        capturedAt: '2026-09-07T21:45:00Z',
        viewport: {width: 1280, height: 720}
    });

    assert.deepEqual(first.snapshot.elements.map(element => element.id),
        second.snapshot.elements.map(element => element.id));
    assert.deepEqual(first.snapshot.elements.slice(0, 4).map(element => element.tagName),
        ['html', 'head', 'body', 'main']);
    assert.equal(first.snapshot.rootElementId, 'e0');
});

test('captureFrozenSnapshot records layout and intrinsic features', async () => {
    const doc = parse(await fixture('positive.html'));
    stubLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'positive',
        capturedAt: '2026-09-07T21:45:00Z',
        backend: 'steel',
        browserName: 'chromium',
        browserVersion: '128.0.0',
        egressLocation: 'eu-west',
        viewport: {width: 1280, height: 720, deviceScaleFactor: 1}
    });
    const consent = snapshot.elements.find(element => element.attributes.id === 'consent');
    const feature = features.elements.find(element => element.id === consent.id);

    assert.equal(consent.id, 'e5');
    assert.equal(feature.layout.isFixed, true);
    assert.equal(feature.layout.zIndex, 2147483647);
    assert.equal(feature.layout.rect.width, 20);
    assert.equal(feature.intrinsic.role, 'dialog');
    assert.equal(feature.intrinsic.hasAriaModal, true);
    assert.equal(feature.intrinsic.hasClickableControl, true);
    assert.deepEqual(feature.intrinsic.classTokens, ['banner', 'cookie']);
});

test('captureFrozenSnapshot records negative and delayed cases', async () => {
    const negative = captureFrozenSnapshot(parse(await fixture('negative.html')), {
        captureId: 'negative',
        capturedAt: '2026-09-07T21:46:00Z'
    });
    const delayed = captureFrozenSnapshot(parse(await fixture('delayed.html')), {
        captureId: 'delayed',
        capturedAt: '2026-09-07T21:47:00Z',
        observationMs: 1500
    });

    assert.ok(negative.features.elements.some(element => element.intrinsic.tagName === 'footer'));
    assert.equal(delayed.snapshot.metadata.observationMs, 1500);
    assert.ok(delayed.snapshot.elements.some(element => element.attributes.id === 'late-consent'));
});

test('captureFrozenSnapshot records same-origin frame boundaries', async () => {
    const doc = parse(await fixture('frame.html'));
    const iframe = doc.querySelector('iframe');
    const frameDoc = parse('<!doctype html><html><body><div id="inner" role="dialog"><button>Accept</button></div></body></html>',
        'https://cmp.example.test/frame');
    Object.defineProperty(iframe, 'contentDocument', {value: frameDoc});

    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'frame',
        capturedAt: '2026-09-07T21:48:00Z'
    });

    assert.equal(snapshot.frames.length, 2);
    assert.deepEqual(snapshot.frames[1], {
        id: 'f1',
        url: 'https://cmp.example.test/frame',
        title: '',
        parentFrameId: 'f0',
        parentElementId: 'e3',
        accessible: true
    });
    assert.ok(snapshot.elements.some(element => element.frameId === 'f1' &&
        element.attributes.id === 'inner'));
    assert.ok(features.elements.some(element => element.frameId === 'f1' &&
        element.intrinsic.hasClickableControl));
});
