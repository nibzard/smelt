/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {runTeacherBatch} from '../teacher-labels.mjs';
import {teacherCatalog} from '../teacher.mjs';

const exec = promisify(execFile);

// A small positive capture in the frozen schema: one fixed banner with a
// button, the same shape the teacher tests use.
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

async function writeCaptures(dir, ids) {
    for (const id of ids) {
        const capture = bannerCapture();
        await writeFile(path.join(dir, `${id}.snapshot.json`), JSON.stringify(capture.snapshot));
        await writeFile(path.join(dir, `${id}.features.json`), JSON.stringify(capture.features));
    }
}

function fakeAdapter(overrides = {}) {
    return {
        id: 'fake-teacher',
        vendor: 'test',
        model: 'fake-1',
        paidTierOnly: true,
        termsVersion: 'test-terms',
        prices: {inputPerMillionUsd: 1, outputPerMillionUsd: 5, checkedAt: '2026-09-08'},
        rationale: 'test',
        buildRequest() {
            return {url: 'https://teacher.test/label', headers: {}, body: '{}'};
        },
        parseResponse(payload) {
            return payload;
        },
        ...overrides
    };
}

const POSITIVE = {has_banner: true, banner_root: 'e4', banner_kind: 'dialog',
    jurisdiction: 'eea', confidence: 0.9,
    evidence: [{kind: 'text', value: 'We value your privacy', element_id: 'e4'}]};

function fetchReturning(labels, usage = {inputTokens: 1000, outputTokens: 100}) {
    return async () => ({ok: true, json: async () => ({
        text: JSON.stringify(labels), usage
    })});
}

function items(ids) {
    return ids.map(capture_id => ({capture_id}));
}

// Parsed records only: a resumed file may still hold the corrupt line a
// crash left behind, and the count of those is asserted through the
// summary instead.
async function linesOf(outPath) {
    const text = await readFile(outPath, 'utf8');
    return text.split('\n')
        .filter(line => line.trim() !== '')
        .flatMap(line => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
}

test('runTeacherBatch labels every capture and appends one line each', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example', 'b-example']);
        const outPath = path.join(dir, 'out', 'proposals.jsonl');
        const summary = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(['a-example', 'b-example']),
            outPath, fetchImpl: fetchReturning(POSITIVE), delayMs: 0});

        assert.equal(summary.labeled, 2);
        assert.equal(summary.failed, 0);
        assert.equal(summary.verification.pass, 2);
        // 1000 input tokens at $1 per million plus 100 output at $5.
        assert.equal(summary.spentUsd, 0.003);
        assert.equal(summary.stopped, null);
        const records = await linesOf(outPath);
        assert.deepEqual(records.map(record => record.capture_id),
            ['a-example', 'b-example']);
        assert.equal(records[0].labels.banner_root, 'e4');
        assert.equal(records[0].adapter.id, 'fake-teacher');
        assert.equal(records[0].promptVersion, 1);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('a second run resumes and labels nothing new', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example', 'b-example']);
        const outPath = path.join(dir, 'proposals.jsonl');
        const first = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(['a-example', 'b-example']),
            outPath, fetchImpl: fetchReturning(POSITIVE), delayMs: 0});
        const before = await readFile(outPath, 'utf8');
        const second = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(['a-example', 'b-example']),
            outPath, fetchImpl: fetchReturning(POSITIVE), delayMs: 0});

        assert.equal(second.labeled, 0);
        assert.equal(second.resumed, 2);
        assert.equal(second.spentUsd, 0);
        assert.equal(await readFile(outPath, 'utf8'), before);
        assert.equal(first.labeled, 2);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('the cost cap stops the batch once spending reaches it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example', 'b-example', 'c-example']);
        const outPath = path.join(dir, 'proposals.jsonl');
        // Each call costs 10 USD: 10 million input tokens at $1 per million.
        const summary = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(['a-example', 'b-example', 'c-example']),
            outPath, fetchImpl: fetchReturning(POSITIVE,
                {inputTokens: 10_000_000, outputTokens: 0}),
            maxCostUsd: 15, delayMs: 0});

        assert.equal(summary.labeled, 2);
        assert.equal(summary.spentUsd, 20);
        assert.equal(summary.stopped, 'cost');
        assert.equal((await linesOf(outPath)).length, 2);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('a teacher error is recorded and the batch continues', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example', 'b-example']);
        const outPath = path.join(dir, 'proposals.jsonl');
        let call = 0;
        const fetchImpl = async () => {
            call += 1;
            if (call === 1) return {ok: false, status: 503, text: async () => 'upstream'};
            return {ok: true, json: async () => ({
                text: JSON.stringify(POSITIVE), usage: {inputTokens: 1, outputTokens: 1}
            })};
        };
        const summary = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(['a-example', 'b-example']),
            outPath, fetchImpl, delayMs: 0});

        assert.equal(summary.labeled, 1);
        assert.equal(summary.failed, 1);
        assert.equal(summary.stopped, null);
        const records = await linesOf(outPath);
        assert.match(records[0].error, /HTTP 503/);
        assert.equal(records[0].capture_id, 'a-example');
        assert.equal(records[1].labels.banner_root, 'e4');
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('five consecutive failures stop the batch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        const ids = ['a-example', 'b-example', 'c-example', 'd-example',
            'e-example', 'f-example', 'g-example'];
        await writeCaptures(dir, ids);
        const outPath = path.join(dir, 'proposals.jsonl');
        const summary = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(ids), outPath,
            fetchImpl: async () => ({ok: false, status: 500, text: async () => 'down'}),
            delayMs: 0});

        assert.equal(summary.labeled, 0);
        assert.equal(summary.failed, 5);
        assert.equal(summary.stopped, 'errors');
        assert.equal((await linesOf(outPath)).length, 5);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('a torn final line is dropped and its capture re-labeled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example', 'b-example']);
        const outPath = path.join(dir, 'proposals.jsonl');
        // A crash mid-write left a torn line for a-example.
        await writeFile(outPath, '{"capture_id": "a-example", "labels');
        const summary = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(['a-example', 'b-example']),
            outPath, fetchImpl: fetchReturning(POSITIVE), delayMs: 0});

        assert.equal(summary.labeled, 2);
        assert.equal(summary.resumed, 0);
        assert.equal(summary.corruptLines, 1);
        const records = await linesOf(outPath);
        assert.equal(records.length, 2);
        assert.equal(records.filter(record => record.capture_id === 'a-example').length, 1);
        assert.ok(records.every(record => record.labels));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('excluded capture ids are skipped without a vendor call', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example', 'b-example']);
        const outPath = path.join(dir, 'proposals.jsonl');
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return fetchReturning(POSITIVE)();
        };
        const summary = await runTeacherBatch({adapter: fakeAdapter(),
            capturesDir: dir, items: items(['a-example', 'b-example']),
            outPath, fetchImpl, excludeIds: ['a-example'], delayMs: 0});

        assert.equal(summary.skippedExcluded, 1);
        assert.equal(summary.labeled, 1);
        assert.equal(calls, 1);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('dry run estimates both teachers without an adapter and writes nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example', 'b-example']);
        const summary = await runTeacherBatch({capturesDir: dir,
            items: items(['a-example', 'b-example']), dryRun: true,
            excludeIds: ['b-example']});

        assert.equal(summary.skippedExcluded, 1);
        assert.equal(summary.estimation.pages, 1);
        assert.ok(summary.estimation.totalBytes > 0);
        assert.equal(summary.estimation.bytesPerPage, summary.estimation.totalBytes);
        const ids = summary.estimation.teachers.map(teacher => teacher.id);
        assert.deepEqual(ids, teacherCatalog().map(meta => meta.id));
        const bytes = summary.estimation.totalBytes;
        const expectedInput = Math.ceil((bytes + 2048) / 4);
        const anthropic = summary.estimation.teachers[0];
        assert.equal(anthropic.inputTokens, expectedInput);
        assert.equal(anthropic.outputTokens, 150);
        assert.equal(anthropic.costUsd,
            Math.round((expectedInput * 1 + 150 * 5) / 1e6 * 1e6) / 1e6);
        // No output path was given, and the dry run writes nothing anyway.
        assert.equal(summary.labeled, 0);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('dry run honors the serialization caps and reports them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-batch-'));
    try {
        await writeCaptures(dir, ['a-example']);
        const summary = await runTeacherBatch({capturesDir: dir,
            items: items(['a-example']), dryRun: true, maxElements: 1});

        // The banner page holds more than one element, so the walk
        // truncates and the estimation says which caps were in force.
        assert.equal(summary.estimation.truncatedPages, 1);
        assert.deepEqual(summary.estimation.caps,
            {maxChars: undefined, maxElements: 1});
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('the CLI dry run reports the estimation and exits zero', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-cli-'));
    try {
        await writeCaptures(dir, ['a-example']);
        const queuePath = path.join(dir, 'queue.json');
        await writeFile(queuePath, JSON.stringify({schemaVersion: 1,
            items: [{capture_id: 'a-example', group: 'example.test'}]}));
        const cli = new URL('../teacher-labels-cli.mjs', import.meta.url).pathname;
        const {stdout} = await exec(process.execPath,
            [cli, '--captures', dir, '--queue', queuePath, '--dry-run']);

        const summary = JSON.parse(stdout.trim().split('\n').pop());
        assert.equal(summary.estimation.pages, 1);
        assert.equal(summary.estimation.teachers.length, 2);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('the CLI refuses an unknown teacher and a missing key', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-teacher-cli-'));
    try {
        const cli = new URL('../teacher-labels-cli.mjs', import.meta.url).pathname;
        const queuePath = path.join(dir, 'queue.json');
        await writeFile(queuePath, JSON.stringify({schemaVersion: 1, items: []}));
        await assert.rejects(exec(process.execPath,
            [cli, '--queue', queuePath, '--teacher', 'openai',
             '--out', path.join(dir, 'p.jsonl')]),
            /Unknown teacher/);
        await assert.rejects(exec(process.execPath,
            [cli, '--queue', queuePath, '--teacher', 'anthropic',
             '--out', path.join(dir, 'p.jsonl')],
            {env: {...process.env, ANTHROPIC_API_KEY: ''}}),
            /ANTHROPIC_API_KEY/);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
