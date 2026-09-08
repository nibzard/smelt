/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The proposals contract across packages: runTeacherBatch writes the
// JSONL file, and buildReviewViewer renders it. Each side has its own
// tests, but nothing else pins the two shapes together — a field rename
// in the teacher record would render every panel silently empty while
// both suites stayed green. This test feeds one real batch output file
// straight into the viewer.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {runTeacherBatch} from '../../consent-banners/teacher-labels.mjs';
import {buildReviewViewer} from '../review-viewer.mjs';

// One fixed banner, valid for the teacher serializer and the verifier,
// and readable by the viewer replay (children lists plus layout rects).
function bannerCapture() {
    const rect = (x, y, width, height) => ({
        x, y, top: y, right: x + width, bottom: y + height, left: x, width, height});
    const elements = [
        {id: 'e0', frameId: 'f0', parentId: null, tagName: 'html',
            textSample: '', children: ['e1']},
        {id: 'e1', frameId: 'f0', parentId: 'e0', tagName: 'body',
            textSample: '', children: ['e4']},
        {id: 'e4', frameId: 'f0', parentId: 'e1', tagName: 'div',
            textSample: 'We value your privacy', children: ['e5'],
            attributes: {class: 'cookie-banner', role: 'dialog'}},
        {id: 'e5', frameId: 'f0', parentId: 'e4', tagName: 'button',
            textSample: 'Accept', children: [], attributes: {}}
    ];
    const layout = (id, r, extra = {}) => ({id, frameId: 'f0', layout: {
        rect: r, zIndex: null, position: 'static', isFixed: false, isSticky: false,
        display: 'block', visibility: 'visible', opacity: 1, ...extra
    }, intrinsic: {
        tagName: elements.find(e => e.id === id).tagName, role: null,
        classTokens: [], textLength: 0, descendantTextLength: 40,
        descendantElementCount: 0
    }});
    return {
        snapshot: {schemaVersion: 1, rootElementId: 'e0',
            frames: [{id: 'f0', url: 'https://example.test/', title: 'Example',
                parentFrameId: null, parentElementId: null, accessible: true}],
            elements},
        features: {schemaVersion: 1, viewport: {width: 1280, height: 720,
            deviceScaleFactor: 1}, elements: [
            layout('e0', rect(0, 0, 1280, 720)),
            layout('e1', rect(0, 0, 1280, 720)),
            layout('e4', rect(0, 600, 1280, 120), {position: 'fixed', isFixed: true}),
            layout('e5', rect(20, 640, 100, 40))
        ]}
    };
}

function adapter() {
    return {
        id: 'fake-teacher',
        vendor: 'test', model: 'fake-1', paidTierOnly: true,
        termsVersion: 'test-terms',
        prices: {inputPerMillionUsd: 1, outputPerMillionUsd: 5, checkedAt: '2026-09-08'},
        rationale: 'test',
        buildRequest: () => ({url: 'https://teacher.test/label', headers: {}, body: '{}'}),
        parseResponse: payload => payload
    };
}

const POSITIVE = {has_banner: true, banner_root: 'e4', banner_kind: 'dialog',
    jurisdiction: 'eea', confidence: 0.9,
    evidence: [{kind: 'text', value: 'We value your privacy', element_id: 'e4'}]};
const NEGATIVE = {has_banner: false, banner_root: null, banner_kind: 'unknown',
    jurisdiction: 'eea', confidence: 0.8, evidence: []};
const UNAVAILABLE = {ok: false, status: 503, text: async () => 'unavailable'};

async function writeCaptures(dir, ids) {
    for (const id of ids) {
        const capture = bannerCapture();
        await writeFile(path.join(dir, `${id}.snapshot.json`), JSON.stringify(capture.snapshot));
        await writeFile(path.join(dir, `${id}.features.json`), JSON.stringify(capture.features));
    }
}

async function renderPages(capturesDir, proposalsPath, ids) {
    const outDir = await mkdtemp(path.join(tmpdir(), 'smelt-roundtrip-out-'));
    await buildReviewViewer({
        items: ids.map(capture_id => ({capture_id, group: 'example.test',
            reason: 'initial label'})),
        capturesDir, outDir, proposalsPath
    });
    const pages = {};
    for (const id of ids) {
        pages[id] = await readFile(path.join(outDir, `${id}.html`), 'utf8');
    }
    await rm(outDir, {recursive: true, force: true});
    return pages;
}

test('a real teacher batch file renders advisory panels in the viewer', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-roundtrip-'));
    try {
        const ids = ['pos-example', 'neg-example', 'err-example'];
        await writeCaptures(dir, ids);
        const outPath = path.join(dir, 'proposals.jsonl');

        // A first run where the endpoint is down writes one error record
        // per capture; none carries labels, so nothing is done.
        const down = await runTeacherBatch({adapter: adapter(), capturesDir: dir,
            items: ids.map(capture_id => ({capture_id})), outPath, delayMs: 0,
            fetchImpl: async () => UNAVAILABLE});
        assert.equal(down.failed, 3);
        assert.equal(down.labeled, 0);

        // The retry answers in call order: positive, negative, and a
        // page the endpoint still cannot label. The successes land after
        // the error lines in the same file.
        const answers = [
            {ok: true, json: async () => ({text: JSON.stringify(POSITIVE),
                usage: {inputTokens: 1000, outputTokens: 100}})},
            {ok: true, json: async () => ({text: JSON.stringify(NEGATIVE),
                usage: {inputTokens: 1000, outputTokens: 100}})},
            UNAVAILABLE
        ];
        const retry = await runTeacherBatch({adapter: adapter(), capturesDir: dir,
            items: ids.map(capture_id => ({capture_id})), outPath, delayMs: 0,
            fetchImpl: async () => answers.shift()});
        assert.equal(retry.labeled, 2);
        assert.equal(retry.failed, 1);

        const pages = await renderPages(dir, outPath, ids);
        // The positive proposal names the teacher's root and the adapter,
        // even though an error record for the same page sits above it.
        assert.ok(pages['pos-example'].includes('<details id="smelt-proposal">'));
        assert.ok(pages['pos-example'].includes('data-smelt-root="e4"'));
        assert.ok(pages['pos-example'].includes('fake-teacher'));
        assert.ok(pages['pos-example'].includes('proposed root e4'));
        // The negative proposal renders its answer and no outline button.
        assert.ok(pages['neg-example'].includes('no banner on this page'));
        assert.ok(!pages['neg-example'].includes('data-smelt-root='));
        // A page with failure records only renders no panel at all.
        assert.ok(!pages['err-example'].includes('<details id="smelt-proposal">'));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
