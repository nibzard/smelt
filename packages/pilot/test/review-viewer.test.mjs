/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {test} from 'node:test';

import {buildReviewViewer} from '../review-viewer.mjs';

function snapshot() {
    return {
        schemaVersion: 1,
        rootElementId: 'e0',
        frames: [{id: 'f0', accessible: true}],
        elements: [
            {id: 'e0', tagName: 'html', textSample: '', attributes: {}, children: ['e1']},
            {id: 'e1', tagName: 'body', textSample: '', attributes: {}, children: ['e2', 'e3']},
            {id: 'e2', tagName: 'main', textSample: 'Article', attributes: {id: 'content'},
                children: []},
            {id: 'e3', tagName: 'div', textSample: 'We use cookies', attributes: {id: 'banner'},
                children: []}
        ]
    };
}

function features() {
    const rect = (x, y, width, height) => ({
        rect: {x, y, top: y, right: x + width, bottom: y + height, left: x, width, height},
        display: 'block', visibility: 'visible', opacity: 1, position: 'static', zIndex: null
    });
    return {
        schemaVersion: 1,
        viewport: {width: 1200, height: 900, deviceScaleFactor: 1},
        elements: [
            {id: 'e0', layout: rect(0, 0, 1200, 900)},
            {id: 'e1', layout: rect(0, 0, 1200, 900)},
            {id: 'e2', layout: rect(0, 0, 700, 500)},
            {id: 'e3', layout: {rect: rect(0, 650, 1200, 250).rect, display: 'block',
                visibility: 'visible', opacity: 1, position: 'fixed', zIndex: 2147483647}}
        ]
    };
}

async function writeCapture(dir, id, group, reason, metadata) {
    await writeFile(resolve(dir, `${id}.snapshot.json`), JSON.stringify(snapshot()));
    await writeFile(resolve(dir, `${id}.features.json`), JSON.stringify(features()));
    if (metadata !== undefined) {
        await writeFile(resolve(dir, `${id}.metadata.json`), JSON.stringify(metadata));
    }
}

test('writes one positioned page per capture plus an index', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-in-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-out-'));
    try {
        await writeCapture(capturesDir, 'example-com-eu', 'example.com',
            'initial label', {url: 'https://example.com/'});
        await writeCapture(capturesDir, 'other-org-us', 'other.org',
            'reason with <tags> & "quotes"', undefined);

        const result = await buildReviewViewer({
            items: [
                {capture_id: 'example-com-eu', group: 'example.com', reason: 'initial label'},
                {capture_id: 'other-org-us', group: 'other.org',
                    reason: 'reason with <tags> & "quotes"'}
            ],
            capturesDir,
            outDir
        });

        assert.equal(result.pages, 2);

        const page = await readFile(resolve(outDir, 'example-com-eu.html'), 'utf8');
        // The rendered DOM keeps the snapshot markers the reviewer clicks.
        assert.ok(page.includes('data-smelt-replay-id="e3"'));
        assert.ok(page.includes('We use cookies'));
        // The captured layout reaches the page as JSON.
        assert.ok(page.includes('"z":2147483647'));
        assert.ok(page.includes('id="smelt-bar"'));
        assert.ok(page.includes('id="smelt-copy"'));
        // Metadata appears and stays escaped.
        assert.ok(page.includes('https://example.com/'));

        const plain = await readFile(resolve(outDir, 'other-org-us.html'), 'utf8');
        assert.ok(!plain.includes('<tags>'));

        const index = await readFile(resolve(outDir, 'index.html'), 'utf8');
        assert.ok(index.includes('href="example-com-eu.html"'));
        assert.ok(index.includes('href="other-org-us.html"'));
        assert.ok(index.includes('&lt;tags&gt;'));
        assert.ok(index.includes('2 captures'));
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
    }
});

test('rejects duplicate queue captures and missing inputs', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-err-'));
    try {
        await writeCapture(dir, 'example-com-eu', 'example.com', 'initial label');
        await assert.rejects(buildReviewViewer({
            items: [
                {capture_id: 'example-com-eu'},
                {capture_id: 'example-com-eu'}
            ],
            capturesDir: dir,
            outDir: resolve(dir, 'out')
        }), /Duplicate queue capture/);
        await assert.rejects(buildReviewViewer({
            items: [],
            capturesDir: dir,
            outDir: resolve(dir, 'out')
        }), /review queue items/);
        await assert.rejects(buildReviewViewer({
            items: [{capture_id: 'missing-page'}],
            capturesDir: dir,
            outDir: resolve(dir, 'out')
        }), /ENOENT/);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
