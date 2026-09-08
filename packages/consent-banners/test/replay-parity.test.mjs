/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {replayableElements as captureReplayable, snapshotToHtml as captureSnapshotToHtml}
    from '@smelt-oss/capture/replay';
import {replayableElements, snapshotToHtml} from '../bench.mjs';

// The bench duplicates the capture replay helpers because it ships in the
// published package, where @smelt-oss/capture is only a devDependency. This
// test runs both copies over the same fixtures, so they cannot drift.

const FIXTURES = [
    {
        name: 'void elements carry no children and no closing tag',
        snapshot: {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [{id: 'f0', accessible: true}],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {},
                    children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: ['e2', 'e3']},
                {id: 'e2', tagName: 'br', textSample: '', attributes: {}, children: []},
                {id: 'e3', tagName: 'img', textSample: '', attributes: {src: '/a.png'},
                    children: ['e4']},
                {id: 'e4', tagName: 'div', textSample: 'unreachable', attributes: {},
                    children: []}
            ]
        }
    },
    {
        name: 'skipped tags stay out of the serialized document',
        snapshot: {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [{id: 'f0', accessible: true}],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {},
                    children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: ['e2', 'e3']},
                {id: 'e2', tagName: 'script', textSample: 'alert(1)', attributes: {},
                    children: ['e5']},
                {id: 'e5', tagName: 'div', textSample: 'inside script', attributes: {},
                    children: []},
                {id: 'e3', tagName: 'template', textSample: '', attributes: {},
                    children: []}
            ]
        }
    },
    {
        name: 'other frame documents are never serialized',
        snapshot: {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [
                {id: 'f0', accessible: true},
                {id: 'f1', accessible: true},
                {id: 'f2', accessible: false}
            ],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {},
                    children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: ['e2']},
                {id: 'e2', tagName: 'div', textSample: 'top', attributes: {}, children: []},
                {id: 'e3', tagName: 'html', textSample: '', attributes: {},
                    children: ['e4']},
                {id: 'e4', tagName: 'body', textSample: 'frame', attributes: {},
                    children: []}
            ]
        }
    },
    {
        name: 'attribute and text values are escaped',
        snapshot: {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [{id: 'f0', accessible: true}],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {},
                    children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: ['e2']},
                {id: 'e2', tagName: 'div', textSample: 'a<b & c>"d"',
                    attributes: {title: 'x="y" & <z>', class: 'banner bar',
                        'data-smelt-replay-id': 'stray'},
                    children: []}
            ]
        }
    },
    {
        name: 'a page-supplied marker value never shadows the snapshot ID',
        snapshot: {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [{id: 'f0', accessible: true}],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {'data-smelt-replay-id': 'e9'},
                    children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: []}
            ]
        }
    },
    {
        name: 'parent text before a child element gains a separator space',
        snapshot: {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [{id: 'f0', accessible: true}],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {},
                    children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: ['e2', 'e4']},
                {id: 'e2', tagName: 'div', textSample: 'We use cookies',
                    attributes: {class: 'banner'}, children: ['e3']},
                {id: 'e3', tagName: 'button', textSample: 'Accept', attributes: {},
                    children: []},
                {id: 'e4', tagName: 'div', textSample: 'no children', attributes: {},
                    children: []}
            ]
        }
    },
    {
        name: 'raw-text elements serialize their text but no element children',
        snapshot: {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [{id: 'f0', accessible: true}],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {},
                    children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: ['e2', 'e4']},
                {id: 'e2', tagName: 'textarea', textSample: 'We use cookies',
                    attributes: {}, children: ['e5']},
                {id: 'e5', tagName: 'span', textSample: 'script-moved', attributes: {},
                    children: []},
                {id: 'e4', tagName: 'iframe', textSample: '', attributes: {src: '/f'},
                    children: ['e6']},
                {id: 'e6', tagName: 'div', textSample: 'frame fallback', attributes: {},
                    children: []}
            ]
        }
    }
];

for (const fixture of FIXTURES) {
    test(`capture and bench replay helpers agree: ${fixture.name}`, () => {
        const captureOrdered = captureReplayable(fixture.snapshot);
        const benchOrdered = replayableElements(fixture.snapshot);
        assert.deepEqual(benchOrdered.map(element => element.id),
            captureOrdered.map(element => element.id));
        assert.equal(snapshotToHtml(fixture.snapshot), captureSnapshotToHtml(fixture.snapshot));
    });
}

test('both copies skip the children of void elements', () => {
    const voidFixture = FIXTURES[0];
    // e4 sits under the <img> void element, so no replay can reach it.
    assert.deepEqual(replayableElements(voidFixture.snapshot).map(element => element.id),
        ['e0', 'e1', 'e2', 'e3']);
    assert.ok(!snapshotToHtml(voidFixture.snapshot).includes('unreachable'));
});

test('parent text and child elements stay separate words in replay', () => {
    const separatorFixture = FIXTURES.find(
        fixture => fixture.name.startsWith('parent text'));
    const html = snapshotToHtml(separatorFixture.snapshot);
    // One separator space keeps "cookies" and "Accept" as separate words;
    // without it, word-boundary rules such as \bcookies\b would score the
    // replay differently from the browser that was captured.
    assert.ok(html.includes('>We use cookies <button'));
    // Text-only elements serialize without any added space.
    assert.ok(html.includes('>no children<'));
});

test('both copies skip the element children of raw-text elements', () => {
    const rawtextFixture = FIXTURES.find(
        fixture => fixture.name.startsWith('raw-text'));
    // The parser reads textarea and iframe content as raw text, so element
    // children under them can never replay in either copy.
    assert.deepEqual(replayableElements(rawtextFixture.snapshot).map(element => element.id),
        ['e0', 'e1', 'e2', 'e4']);
    const html = snapshotToHtml(rawtextFixture.snapshot);
    assert.ok(html.includes('>We use cookies</textarea>'));
    assert.ok(!html.includes('script-moved'));
    assert.ok(!html.includes('frame fallback'));
});

test('both replayableElements copies reject a missing element', () => {
    const snapshot = {
        schemaVersion: 1,
        rootElementId: 'e0',
        frames: [{id: 'f0', accessible: true}],
        elements: [
            {id: 'e0', tagName: 'html', textSample: '', attributes: {}, children: ['e9']}
        ]
    };
    assert.throws(() => replayableElements(snapshot), /Snapshot element "e9" is missing/);
    assert.throws(() => captureReplayable(snapshot), /Snapshot element "e9" is missing/);
});
