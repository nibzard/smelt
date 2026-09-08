/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';

import {captureFrozenSnapshot} from '../index.mjs';
import {
    compareFrozenReplay, replayableElements, REPLAY_ID_ATTRIBUTE, runFrozenSnapshot,
    snapshotToHtml
} from '../replay.mjs';
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
        tagName: fnode.element.tagName.toLowerCase(),
        // Capture keeps one trimmed text sample per element and drops
        // inter-element whitespace, so exact spacing is not recoverable.
        // Replay emits one separator space between parent text and child
        // elements, so words and their boundaries survive. Compare with
        // collapsed whitespace: merged words fail this comparison.
        textContent: fnode.element.textContent.replace(/\s+/g, ' ').trim(),
        className: fnode.element.getAttribute('class') ?? '',
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
                <div id="banner" class="banner bar" role="dialog">Cookies <button id="accept">Accept</button></div>
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

    // The browser side is the original document the capture saw, not a parse
    // of the replay serialization. Map snapshot IDs to its elements through
    // the DOM id attribute, so the comparison stays browser versus Node.
    const byDomId = new Map(Array.from(doc.querySelectorAll('[id]'), element => [element.id, element]));
    const browserElementsById = new Map();
    for (const element of snapshot.elements) {
        const domId = element.attributes?.id;
        if (domId !== undefined && byDomId.has(domId)) {
            browserElementsById.set(element.id, byDomId.get(domId));
        }
    }

    const parity = compareFrozenReplay({
        ruleset: geometryRules(),
        browserDocument: doc,
        snapshot,
        features,
        ids,
        vector: vectorFor,
        browserElementsById
    });

    assert.equal(parity.equal, true);
    assert.deepEqual(parity.node, parity.browser);
    assert.equal(parity.node[ids[1]].scores.fixed, 10);
    // The separator space between parent text and the button keeps the
    // word boundary: collapsed text must read as two words, not one.
    assert.equal(parity.node[ids[1]].textContent, 'Cookies Accept');
});

test('replay handles void elements without phantom duplicates', () => {
    const doc = parse(`
        <html><body>
            <main id="page">
                <p id="content">Read more<br>now</p>
                <img id="art" src="/art.png" alt="">
            </main>
        </body></html>
    `);
    stubBrowserLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'void-parity',
        capturedAt: '2026-09-08T10:30:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });

    const replay = runFrozenSnapshot(geometryRules(), snapshot, features);
    // One <br> and one <img> in the snapshot must stay one each in replay.
    assert.equal(replay.document.querySelectorAll('br').length, 1);
    assert.equal(replay.document.querySelectorAll('img').length, 1);
    assert.equal(replay.elementsById.size, replayableElements(snapshot).length);
});

test('replay drops a page-supplied marker attribute before writing its own', () => {
    // Snapshot IDs follow a deterministic traversal, so a probe capture
    // reveals the real IDs a second capture of the same shape will use.
    const probe = parse(`
        <html><body>
            <main id="page">
                <div id="content">Article</div>
                <div id="banner" role="dialog">Cookies <button id="accept">Accept</button></div>
            </main>
        </body></html>
    `);
    stubBrowserLayout(probe);
    const probeCapture = captureFrozenSnapshot(probe, {
        captureId: 'marker-collision-probe',
        capturedAt: '2026-09-08T11:00:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });
    const bannerSnapshotId = probeCapture.snapshot.elements
        .find(element => element.attributes.id === 'banner').id;
    const acceptSnapshotId = probeCapture.snapshot.elements
        .find(element => element.attributes.id === 'accept').id;

    // The page now cross-references real snapshot IDs: content claims the
    // banner's ID and the button claims its own. If the serializer kept a
    // page-supplied marker value, two elements would align to one ID.
    const doc = parse(`
        <html><body>
            <main id="page">
                <div id="content" data-smelt-replay-id="${bannerSnapshotId}">Article</div>
                <div id="banner" role="dialog" data-smelt-replay-id="stray">Cookies
                    <button id="accept" data-smelt-replay-id="${acceptSnapshotId}">Accept</button>
                </div>
            </main>
        </body></html>
    `);
    stubBrowserLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'marker-collision',
        capturedAt: '2026-09-08T11:00:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });

    const replay = runFrozenSnapshot(geometryRules(), snapshot, features);
    const contentId = snapshot.elements.find(element => element.attributes.id === 'content').id;
    const bannerId = snapshot.elements.find(element => element.attributes.id === 'banner').id;
    const acceptId = snapshot.elements.find(element => element.attributes.id === 'accept').id;
    // IDs match the probe: same traversal, same shape.
    assert.equal(bannerId, bannerSnapshotId);
    assert.equal(acceptId, acceptSnapshotId);
    // Every replayed element carries its own snapshot ID.
    assert.equal(replay.elementsById.get(contentId)
        .getAttribute(REPLAY_ID_ATTRIBUTE), contentId);
    assert.equal(replay.elementsById.get(bannerId)
        .getAttribute(REPLAY_ID_ATTRIBUTE), bannerId);
    assert.equal(replay.elementsById.get(acceptId)
        .getAttribute(REPLAY_ID_ATTRIBUTE), acceptId);
    assert.equal(replay.elementsById.size, replayableElements(snapshot).length);
    assert.ok(replay.elementsById.get(acceptId).textContent.includes('Accept'));
});

test('replay counts parser-inserted phantom elements', () => {
    const doc = parse('<html><body><main id="page"></main></body></html>');
    // A script-built, parser-illegal shape: a block element inside a <p>.
    const paragraph = doc.createElement('p');
    paragraph.id = 'content';
    const box = doc.createElement('div');
    box.id = 'box';
    box.textContent = 'Moved by script';
    paragraph.appendChild(box);
    doc.getElementById('page').appendChild(paragraph);
    stubBrowserLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'phantom-count',
        capturedAt: '2026-09-08T11:00:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });

    // The replayed <p> and <div> stay marked and aligned; the parser's
    // extra empty <p> is counted, not treated as a failure.
    const replay = runFrozenSnapshot(geometryRules(), snapshot, features);
    assert.equal(replay.phantomCount, 1);
    assert.equal(replay.document.querySelectorAll('p').length, 2);
});

test('compareFrozenReplay rejects ids from other frame documents', () => {
    const doc = parse(`
        <html><body>
            <main id="page">
                <div id="banner" role="dialog">Cookies</div>
            </main>
        </body></html>
    `);
    stubBrowserLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'frame-guard',
        capturedAt: '2026-09-08T11:00:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });
    const frameBanner = 'frame-element-banner';
    // Push real frame-document elements into the snapshot, as a multi-frame
    // capture would: a second html tree, unreachable from the top root.
    snapshot.elements.push(
        {id: 'frame-element-root', tagName: 'html', textSample: '', attributes: {},
            children: [frameBanner]},
        {id: frameBanner, tagName: 'div', textSample: 'Frame banner', attributes: {}, children: []}
    );
    features.elements.push(
        {id: 'frame-element-root', layout: {
            rect: {x: 0, y: 0, top: 0, right: 100, bottom: 100, left: 0, width: 100, height: 100},
            display: 'block', visibility: 'visible', opacity: 1, position: 'fixed', zIndex: 5
        }},
        {id: frameBanner, layout: {
            rect: {x: 0, y: 0, top: 0, right: 100, bottom: 100, left: 0, width: 100, height: 100},
            display: 'block', visibility: 'visible', opacity: 1, position: 'fixed', zIndex: 5
        }}
    );
    const browserDocument = parseHTML(snapshotToHtml(snapshot)).document;
    stubBrowserLayout(browserDocument);

    assert.throws(() => compareFrozenReplay({
        ruleset: geometryRules(),
        browserDocument,
        snapshot,
        features,
        ids: [frameBanner],
        vector: vectorFor
    }), new RegExp(`Element "${frameBanner}" is not in the replayable top frame`));
});

test('replay ignores other frame documents in the snapshot', () => {
    const doc = parse(`
        <html><body>
            <main id="page">
                <div id="banner" role="dialog">Cookies</div>
            </main>
        </body></html>
    `);
    stubBrowserLayout(doc);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: 'frame-parity',
        capturedAt: '2026-09-08T10:30:00Z',
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1}
    });

    // Simulate a second accessible frame document: its own html tree, not
    // reachable from the top-frame root.
    const frameRoot = 'frame-element-root';
    const frameBody = 'frame-element-body';
    const frameBanner = 'frame-element-banner';
    snapshot.elements.push(
        {id: frameRoot, tagName: 'html', textSample: '', attributes: {}, children: [frameBody]},
        {id: frameBody, tagName: 'body', textSample: '', attributes: {}, children: [frameBanner]},
        {id: frameBanner, tagName: 'div', textSample: 'Frame banner', attributes: {}, children: []}
    );
    for (const id of [frameRoot, frameBody, frameBanner]) {
        features.elements.push({id, layout: {
            rect: {x: 0, y: 0, top: 0, right: 100, bottom: 100, left: 0, width: 100, height: 100},
            display: 'block', visibility: 'visible', opacity: 1,
            position: 'fixed', zIndex: 5
        }});
    }

    const replay = runFrozenSnapshot(geometryRules(), snapshot, features);
    assert.equal(replay.elementsById.has(frameBanner), false);
    assert.equal(replay.elementsById.size, replayableElements(snapshot).length);
    assert.ok(replay.elementsById.size < snapshot.elements.length);
});
