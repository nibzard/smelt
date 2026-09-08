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
                    attributes: {title: 'x="y" & <z>', 'data-smelt-replay-id': 'stray'},
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
