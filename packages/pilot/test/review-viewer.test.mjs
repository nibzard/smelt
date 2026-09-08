/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {test} from 'node:test';

import {buildReviewViewer, egressJurisdiction} from '../review-viewer.mjs';

const exec = promisify(execFile);

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
        // with a clipboard fallback, the JSON on the page, and a way to
        // dismiss the JSON box again.
        for (const field of ['smelt-kind', 'smelt-jurisdiction', 'smelt-confidence',
            'smelt-notes', 'smelt-json', 'smelt-json-text', 'smelt-json-close']) {
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

test('index shows an unknown label status as itself, never as unresolved', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-status-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-status-out-'));
    const labelsDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-status-labels-'));
    try {
        await writeCapture(capturesDir, 'odd-eu', 'odd.test', 'initial label');
        // A status outside the schema's two values must not be rendered
        // as an invented "unresolved"; it shows as itself, pending.
        await writeFile(resolve(labelsDir, 'development.labels.json'), JSON.stringify({
            schema_version: 1, split: 'development',
            pages: [{id: 'odd-eu', group: 'odd.test', label_status: 'reviwed',
                has_banner: null, acceptable_roots: [], banner_root: null,
                banner_kind: null, jurisdiction: null,
                frame: {state: 'unknown', frame_id: null, element_id: null},
                evidence: [], confidence: null, review_notes: 'typo in the file'}]
        }));
        await buildReviewViewer({
            items: [{capture_id: 'odd-eu', group: 'odd.test', reason: 'initial label'}],
            capturesDir,
            outDir,
            labelsDir
        });

        const index = await readFile(resolve(outDir, 'index.html'), 'utf8');
        assert.ok(index.includes('1 captures, 0 reviewed, 1 remaining.'));
        const row = index.slice(index.indexOf('href="odd-eu.html"'),
            index.indexOf('</li>', index.indexOf('href="odd-eu.html"')));
        assert.ok(row.includes('>reviwed<'), 'the literal status displays');
        assert.ok(!row.includes('>unresolved<'), 'no invented status');
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

test('pages link to their neighbors and the index', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-nav-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-nav-out-'));
    try {
        for (const id of ['first-page', 'middle-page', 'last-page']) {
            await writeCapture(capturesDir, id, 'example.com', 'initial label');
        }
        await buildReviewViewer({
            items: ['first-page', 'middle-page', 'last-page']
                .map(capture_id => ({capture_id, group: 'example.com'})),
            capturesDir,
            outDir
        });

        const read = async id => readFile(resolve(outDir, `${id}.html`), 'utf8');
        const first = await read('first-page');
        const middle = await read('middle-page');
        const last = await read('last-page');
        assert.ok(first.includes('href="middle-page.html"'));
        assert.ok(!first.includes('lsaquo; prev'));
        assert.ok(middle.includes('href="first-page.html"'));
        assert.ok(middle.includes('href="last-page.html"'));
        assert.ok(last.includes('href="middle-page.html"'));
        assert.ok(!last.includes('next &rsaquo;'));
        for (const page of [first, middle, last]) {
            assert.ok(page.includes('href="index.html"'));
        }
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
    }
});

test('a proposals file renders a collapsed advisory panel', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-prop-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-prop-out-'));
    try {
        for (const id of ['pos-page', 'neg-page', 'none-page']) {
            await writeCapture(capturesDir, id, 'example.com', 'initial label');
        }
        const proposalsPath = resolve(capturesDir, '..', 'proposals.jsonl');
        await writeFile(resolve(outDir, '..', 'proposals.jsonl'), [
            JSON.stringify({capture_id: 'pos-page',
                adapter: {id: 'fake-teacher <lab>'},
                labels: {has_banner: true, banner_root: 'e3', banner_kind: 'dialog',
                    jurisdiction: 'eea', confidence: 0.9, evidence: []},
                verification: {status: 'flag',
                    issues: [{code: 'root-below-viewport'}, {code: 'truncated-input'}]}}),
            JSON.stringify({capture_id: 'neg-page', adapter: {id: 'fake-teacher'},
                labels: {has_banner: false, banner_root: null, banner_kind: 'unknown',
                    jurisdiction: 'unknown', confidence: 0.8, evidence: []},
                verification: {status: 'pass', issues: []}}),
            // A failed batch record carries no proposal and must be skipped.
            JSON.stringify({capture_id: 'none-page', adapterId: 'fake-teacher',
                error: 'HTTP 503'}),
            ''
        ].join('\n'));
        await buildReviewViewer({
            items: ['pos-page', 'neg-page', 'none-page']
                .map(capture_id => ({capture_id, group: 'example.com'})),
            capturesDir,
            outDir,
            proposalsPath
        });

        const read = async id => readFile(resolve(outDir, `${id}.html`), 'utf8');
        const positive = await read('pos-page');
        assert.ok(positive.includes('<details id="smelt-proposal">'));
        assert.ok(positive.includes('Teacher proposal available'));
        assert.ok(positive.includes('data-smelt-root="e3"'));
        assert.ok(positive.includes('root-below-viewport, truncated-input'));
        // Proposal values are page-external strings and stay escaped.
        assert.ok(!positive.includes('<lab>'));
        assert.ok(positive.includes('&lt;lab&gt;'));

        const negative = await read('neg-page');
        assert.ok(negative.includes('no banner on this page'));
        assert.ok(!negative.includes('data-smelt-root='));

        const absent = await read('none-page');
        assert.ok(!absent.includes('<details id="smelt-proposal">'));
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(resolve(outDir, '..', 'proposals.jsonl'), {force: true});
    }
});

test('torn and corrupt proposals lines do not sink the build', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-torn-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-torn-out-'));
    try {
        await writeCapture(capturesDir, 'crash-page', 'example.com', 'initial label');
        // The exact file a crash and resume leave behind: an older valid
        // record, a corrupt middle line the batch refuses to rewrite, the
        // fresh valid record, and a torn final line with no newline.
        const proposalsPath = resolve(outDir, '..', 'torn-proposals.jsonl');
        await writeFile(proposalsPath, [
            JSON.stringify({capture_id: 'crash-page', adapter: {id: 'fake-teacher'},
                labels: {has_banner: false, banner_root: null, banner_kind: 'unknown',
                    jurisdiction: 'unknown', confidence: 0.6, evidence: []},
                verification: {status: 'pass', issues: []}}),
            '{"capture_id": "crash-p',
            JSON.stringify({capture_id: 'crash-page', adapter: {id: 'fake-teacher'},
                labels: {has_banner: true, banner_root: 'e3', banner_kind: 'dialog',
                    jurisdiction: 'eea', confidence: 0.9, evidence: []},
                verification: {status: 'pass', issues: []}}),
            '{"capture_id": "crash-page", "labels'
        ].join('\n'));
        const result = await buildReviewViewer({
            items: [{capture_id: 'crash-page', group: 'example.com'}],
            capturesDir,
            outDir,
            proposalsPath
        });

        // The last valid record wins: the positive resume answer, not the
        // older negative. Both unreadable lines are counted for the CLI
        // warning; the build still succeeds.
        const page = await readFile(resolve(outDir, 'crash-page.html'), 'utf8');
        assert.ok(page.includes('<details id="smelt-proposal">'));
        assert.ok(page.includes('data-smelt-root="e3"'));
        assert.ok(!page.includes('no banner on this page'));
        assert.deepEqual(result.proposals, {records: 1, unreadableLines: 2});
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(resolve(outDir, '..', 'torn-proposals.jsonl'), {force: true});
    }
});

test('a proposals file with no readable records reports zero, not silence', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-pp-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-pp-out-'));
    const proposalsPath = resolve(outDir, '..', 'pretty-proposals.json');
    try {
        await writeCapture(capturesDir, 'pretty-page', 'example.com', 'initial label');
        // A pretty-printed JSON document parses to nothing line by line,
        // so every advisory panel goes missing. The build still succeeds,
        // but the result names the zero-record state, so the CLI warns
        // instead of rendering a silent no-panel set.
        await writeFile(proposalsPath, JSON.stringify({
            capture_id: 'pretty-page',
            labels: {has_banner: true, banner_root: 'e3', banner_kind: 'dialog',
                jurisdiction: 'eea', confidence: 0.9, evidence: []},
            verification: {status: 'pass', issues: []}
        }, null, 2));
        const result = await buildReviewViewer({
            items: [{capture_id: 'pretty-page', group: 'example.com'}],
            capturesDir,
            outDir,
            proposalsPath
        });

        const page = await readFile(resolve(outDir, 'pretty-page.html'), 'utf8');
        assert.ok(!page.includes('<details id="smelt-proposal">'));
        assert.equal(result.proposals.records, 0);
        assert.ok(result.proposals.unreadableLines > 0, 'junk lines are counted');
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(proposalsPath, {force: true});
    }
});

test('a missing proposals file fails the build', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-prop-err-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-prop-err-out-'));
    try {
        await writeCapture(capturesDir, 'example-com-eu', 'example.com', 'initial label');
        await assert.rejects(buildReviewViewer({
            items: [{capture_id: 'example-com-eu', group: 'example.com'}],
            capturesDir,
            outDir,
            proposalsPath: resolve(capturesDir, 'missing-proposals.jsonl')
        }), /ENOENT/);
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
    }
});

test('the CLI warns when a proposals file is unusable', async () => {
    const capturesDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-cli-'));
    const outDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-cli-out-'));
    const labelsDir = await mkdtemp(resolve(tmpdir(), 'smelt-viewer-cli-labels-'));
    try {
        await writeCapture(capturesDir, 'junk-page', 'example.com', 'initial label');
        const queuePath = resolve(capturesDir, 'queue.json');
        await writeFile(queuePath, JSON.stringify({schemaVersion: 1,
            items: [{capture_id: 'junk-page', group: 'example.com'}]}));
        const cli = new URL('../review-viewer-cli.mjs', import.meta.url).pathname;
        const run = proposalsPath => exec(process.execPath,
            [cli, '--queue', queuePath, '--captures', capturesDir,
             '--labels', labelsDir, '--out', outDir, '--proposals', proposalsPath]);
        const validRecord = () => JSON.stringify({capture_id: 'junk-page',
            adapter: {id: 'fake-teacher'},
            labels: {has_banner: false, banner_root: null, banner_kind: 'unknown',
                jurisdiction: 'unknown', confidence: 0.6, evidence: []},
            verification: {status: 'pass', issues: []}});

        // A clean file prints no warning.
        const cleanPath = resolve(capturesDir, 'clean.jsonl');
        await writeFile(cleanPath, `${validRecord()}\n`);
        const clean = await run(cleanPath);
        assert.equal(clean.stderr, '');

        // One corrupt line among valid records is named in the warning.
        const mixedPath = resolve(capturesDir, 'mixed.jsonl');
        await writeFile(mixedPath, `{"capture_id": "junk-p\n${validRecord()}\n`);
        const mixed = await run(mixedPath);
        assert.match(mixed.stderr, /skipped 1 unreadable proposals line/);

        // A pretty-printed document holds no readable record at all; the
        // warning names that state, so the build cannot pass for a
        // normal no-proposal run.
        const prettyPath = resolve(capturesDir, 'pretty.json');
        await writeFile(prettyPath,
            JSON.stringify({capture_id: 'junk-page'}, null, 2));
        const pretty = await run(prettyPath);
        assert.match(pretty.stderr, /no readable proposals records/);
    } finally {
        await rm(capturesDir, {recursive: true, force: true});
        await rm(outDir, {recursive: true, force: true});
        await rm(labelsDir, {recursive: true, force: true});
    }
});
