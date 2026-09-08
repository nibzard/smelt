/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {test} from 'node:test';

import {buildReviewViewer, egressJurisdiction} from '../review-viewer.mjs';

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
        // The copy button offers every field a reviewed label must carry,
        // with a clipboard fallback and the JSON on the page.
        for (const field of ['smelt-kind', 'smelt-jurisdiction', 'smelt-confidence',
            'smelt-notes', 'smelt-json']) {
            assert.ok(page.includes(`id="${field}"`), field);
        }
        assert.ok(page.includes('execCommand'));
        // The label data rides in JSON string literals, so a "<" in any
        // value cannot close the script element.
        assert.ok(page.includes('captureId = "example-com-eu";'));
        assert.ok(page.includes('group = "example.com";'));
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

test('egressJurisdiction maps capture locations to label jurisdictions', () => {
    assert.equal(egressJurisdiction('eu-de-residential'), 'eea');
    assert.equal(egressJurisdiction('us-iad-datacenter'), 'us');
    assert.equal(egressJurisdiction('ap-jp-datacenter'), 'unknown');
    assert.equal(egressJurisdiction(null), 'unknown');
});

test('prefills jurisdiction from the recipe, then the egress location', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-jur-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-jur-out-'));
    try {
        await writeCapture(capturesDir, 'recipe-wins', 'example.com', 'initial label',
            {egressLocation: 'eu-de-residential',
                targetMetadata: {expect: 'banner', jurisdiction: 'us'}});
        await writeCapture(capturesDir, 'egress-fallback', 'example.com', 'initial label',
            {egressLocation: 'eu-de-residential'});
        await writeCapture(capturesDir, 'no-metadata', 'example.com', 'initial label');
        await buildReviewViewer({
            items: [
                {capture_id: 'recipe-wins', group: 'example.com'},
                {capture_id: 'egress-fallback', group: 'example.com'},
                {capture_id: 'no-metadata', group: 'example.com'}
            ],
            capturesDir,
            outDir
        });

        const read = async id => (await readFile(resolve(outDir, `${id}.html`), 'utf8'));
        assert.ok((await read('recipe-wins')).includes('jurisdiction.value = "us";'));
        assert.ok((await read('egress-fallback')).includes('jurisdiction.value = "eea";'));
        assert.ok((await read('no-metadata')).includes('jurisdiction.value = "unknown";'));
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
    }
});

test('prefills notes and group from the labels file, not the queue', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-stub-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-stub-out-'));
    const labelsDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-stub-labels-'));
    try {
        await writeCapture(capturesDir, 'example-com-eu', 'queue-group', 'initial label',
            {url: 'https://example.com/'});
        await writeFile(resolve(labelsDir, 'development.labels.json'), JSON.stringify({
            schema_version: 1,
            split: 'development',
            pages: [{id: 'example-com-eu', group: 'labels-group',
                label_status: 'unresolved', has_banner: null, acceptable_roots: [],
                banner_root: null, banner_kind: null, jurisdiction: null,
                frame: {state: 'unknown', frame_id: null, element_id: null},
                evidence: [], confidence: null,
                review_notes: 'banner appears after a delay'}]
        }));

        await buildReviewViewer({
            items: [{capture_id: 'example-com-eu', group: 'queue-group'}],
            capturesDir,
            outDir,
            labelsDir
        });

        const page = await readFile(resolve(outDir, 'example-com-eu.html'), 'utf8');
        assert.ok(page.includes('notes.value = "banner appears after a delay";'));
        // The labels file owns the group: a queue disagreement must not
        // leak into the record the reviewer copies.
        assert.ok(page.includes('group = "labels-group";'));
        assert.ok(!page.includes('group = "queue-group";'));
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(labelsDir, {recursive: true, force: true});
    }
});

test('index keeps the first split for a duplicated page id and warns', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-dup-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-dup-out-'));
    const labelsDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-dup-labels-'));
    try {
        await writeCapture(capturesDir, 'done-eu', 'done.test', 'initial label');
        await writeCapture(capturesDir, 'open-eu', 'open.test', 'initial label');
        const stub = (id, group, status) => ({id, group, label_status: status,
            has_banner: null, acceptable_roots: [], banner_root: null,
            banner_kind: null, jurisdiction: null,
            frame: {state: 'unknown', frame_id: null, element_id: null},
            evidence: [], confidence: null,
            review_notes: 'awaiting initial human label'});
        // train says open-eu is unresolved; development carries a stale
        // reviewed copy of the same id. The first split wins, and the
        // index says so instead of silently reporting false progress.
        await writeFile(resolve(labelsDir, 'train.labels.json'), JSON.stringify({
            schema_version: 1, split: 'train',
            pages: [stub('done-eu', 'done.test', 'reviewed'),
                stub('open-eu', 'open.test', 'unresolved')]
        }));
        await writeFile(resolve(labelsDir, 'development.labels.json'), JSON.stringify({
            schema_version: 1, split: 'development',
            pages: [stub('open-eu', 'open.test', 'reviewed')]
        }));

        await buildReviewViewer({
            items: [
                {capture_id: 'done-eu', group: 'done.test', reason: 'initial label'},
                {capture_id: 'open-eu', group: 'open.test', reason: 'initial label'}
            ],
            capturesDir,
            outDir,
            labelsDir
        });

        const index = await readFile(resolve(outDir, 'index.html'), 'utf8');
        assert.ok(index.includes('2 captures, 1 reviewed, 1 remaining.'));
        assert.ok(index.includes('page id open-eu appears in more than one split file'));
        const openRow = index.slice(index.indexOf('href="open-eu.html"'));
        assert.ok(openRow.includes('>unresolved<'), 'the first split wins');
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(labelsDir, {recursive: true, force: true});
    }
});

test('index warns when a split labels file is unreadable', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-torn-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-torn-out-'));
    const labelsDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-torn-labels-'));
    try {
        await writeCapture(capturesDir, 'open-eu', 'open.test', 'initial label');
        // A torn write of train.labels.json must surface, not silently
        // count as no stubs while other splits load.
        await writeFile(resolve(labelsDir, 'train.labels.json'), '{"pages": [');
        await buildReviewViewer({
            items: [{capture_id: 'open-eu', group: 'open.test', reason: 'initial label'}],
            capturesDir,
            outDir,
            labelsDir
        });

        const index = await readFile(resolve(outDir, 'index.html'), 'utf8');
        assert.ok(index.includes('Warning:'));
        assert.ok(index.includes('train.labels.json is unreadable and was skipped'));
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(labelsDir, {recursive: true, force: true});
    }
});

test('index counts review progress and lists pending captures first', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-idx-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-idx-out-'));
    const labelsDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-idx-labels-'));
    try {
        await writeCapture(capturesDir, 'done-eu', 'done.test', 'initial label');
        await writeCapture(capturesDir, 'open-eu', 'open.test', 'initial label');
        await writeCapture(capturesDir, 'absent-eu', 'absent.test', 'initial label');
        const stub = (id, group, status) => ({id, group, label_status: status,
            has_banner: null, acceptable_roots: [], banner_root: null,
            banner_kind: null, jurisdiction: null,
            frame: {state: 'unknown', frame_id: null, element_id: null},
            evidence: [], confidence: null,
            review_notes: 'awaiting initial human label'});
        await writeFile(resolve(labelsDir, 'development.labels.json'), JSON.stringify({
            schema_version: 1, split: 'development',
            pages: [stub('done-eu', 'done.test', 'reviewed'),
                stub('open-eu', 'open.test', 'unresolved')]
        }));

        await buildReviewViewer({
            // The reviewed capture sits first in the queue; the index must
            // still list the two pending captures before it.
            items: [
                {capture_id: 'done-eu', group: 'done.test', reason: 'initial label'},
                {capture_id: 'open-eu', group: 'open.test', reason: 'initial label'},
                {capture_id: 'absent-eu', group: 'absent.test', reason: 'initial label'}
            ],
            capturesDir,
            outDir,
            labelsDir
        });

        const index = await readFile(resolve(outDir, 'index.html'), 'utf8');
        assert.ok(index.includes('3 captures, 1 reviewed, 2 remaining.'));
        const openAt = index.indexOf('href="open-eu.html"');
        const absentAt = index.indexOf('href="absent-eu.html"');
        const doneAt = index.indexOf('href="done-eu.html"');
        assert.ok(openAt !== -1 && absentAt !== -1 && doneAt !== -1);
        assert.ok(openAt < doneAt && absentAt < doneAt, 'pending captures come first');
        const doneRow = index.slice(doneAt, index.indexOf('</li>', doneAt));
        assert.ok(doneRow.includes('>reviewed<'));
        const openRow = index.slice(openAt, index.indexOf('</li>', openAt));
        assert.ok(openRow.includes('>unresolved<'));
        // A capture with no labels stub counts as pending but shows no
        // status it cannot know.
        const absentRow = index.slice(absentAt, index.indexOf('</li>', absentAt));
        assert.ok(!absentRow.includes('unresolved'));
        assert.ok(!absentRow.includes('reviewed'));
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(labelsDir, {recursive: true, force: true});
    }
});

test('remote-loading URLs never reach the generated page', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-frame-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-frame-out-'));
    try {
        const framed = {
            schemaVersion: 1,
            rootElementId: 'e0',
            frames: [{id: 'f0', accessible: true}],
            elements: [
                {id: 'e0', tagName: 'html', textSample: '', attributes: {}, children: ['e1']},
                {id: 'e1', tagName: 'body', textSample: '', attributes: {},
                    children: ['e4', 'e5', 'e6', 'e7', 'e8']},
                {id: 'e4', tagName: 'iframe', textSample: '',
                    attributes: {src: 'https://tracker.example/pixel?id=1',
                        srcdoc: '<p>we use cookies</p>'}, children: []},
                {id: 'e5', tagName: 'link', textSample: '',
                    attributes: {rel: 'stylesheet',
                        href: 'https://cdn.example/site.css'}, children: []},
                {id: 'e6', tagName: 'img', textSample: '',
                    attributes: {src: 'https://cdn.example/logo.png',
                        srcset: 'https://cdn.example/logo2x.png 2x'}, children: []},
                {id: 'e7', tagName: 'div', textSample: '',
                    attributes: {style: 'color: red; background: url(https://cdn.example/bg.png)'},
                    children: []},
                {id: 'e8', tagName: 'a', textSample: 'continue reading',
                    attributes: {href: 'https://example.com/page'}, children: []}
            ]
        };
        await writeFile(resolve(capturesDir, 'framed-page.snapshot.json'),
            JSON.stringify(framed));
        await writeFile(resolve(capturesDir, 'framed-page.features.json'),
            JSON.stringify(features()));
        await buildReviewViewer({
            items: [{capture_id: 'framed-page', group: 'example.com'}],
            capturesDir,
            outDir
        });
        const page = await readFile(resolve(outDir, 'framed-page.html'), 'utf8');
        assert.ok(!page.includes('tracker.example'));
        assert.ok(!page.includes('we use cookies'));
        assert.ok(!page.includes('cdn.example'));
        // The neutral style survives; only the url() load is removed.
        assert.ok(page.includes('color: red'));
        assert.ok(!page.includes('url('));
        // Anchors keep their href: they load nothing and the overlay
        // blocks their navigation.
        assert.ok(page.includes('href="https://example.com/page"'));
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
    }
});

test('label values cannot close the overlay script element', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-esc-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-esc-out-'));
    const labelsDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-esc-labels-'));
    try {
        await writeCapture(capturesDir, 'hostile-page', 'queue-group', 'initial label');
        await writeFile(resolve(labelsDir, 'development.labels.json'), JSON.stringify({
            schema_version: 1,
            split: 'development',
            pages: [{id: 'hostile-page', group: '</script><b>x',
                label_status: 'unresolved', has_banner: null, acceptable_roots: [],
                banner_root: null, banner_kind: null, jurisdiction: null,
                frame: {state: 'unknown', frame_id: null, element_id: null},
                evidence: [], confidence: null, review_notes: '</script>y'}]
        }));
        await buildReviewViewer({
            items: [{capture_id: 'hostile-page', group: 'queue-group'}],
            capturesDir,
            outDir,
            labelsDir
        });
        const page = await readFile(resolve(outDir, 'hostile-page.html'), 'utf8');
        // Every "<" in an interpolated value arrives as a JS escape, so the
        // overlay script keeps exactly one closing tag: its own.
        assert.ok(page.includes('group = "\\u003c/script>\\u003cb>x";'));
        assert.ok(page.includes('notes.value = "\\u003c/script>y";'));
        assert.equal((page.match(/<\/script>/g) ?? []).length, 1);
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(labelsDir, {recursive: true, force: true});
    }
});
