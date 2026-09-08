/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {
    assignGroupsToSplits,
    buildCorpusArtifacts,
    isHumanTouched,
    mergeCorpusLabels,
    mergeReviewQueue,
    prepareCorpus,
    reviewItems
} from '../prepare-corpus.mjs';

const labelsSchemaPath = new URL('../../../tasks/consent-banners/labels.schema.json',
    import.meta.url).pathname;
const queueSchemaPath = new URL('../../../tasks/consent-banners/review-queue.schema.json',
    import.meta.url).pathname;

function captureMetadata(overrides = {}) {
    return {
        schemaVersion: 1,
        captureId: 'example-eu',
        url: 'https://example.test/',
        group: 'example.test',
        backend: 'steel',
        browserName: 'chromium',
        browserVersion: '150.0.0',
        egressLocation: 'eu-de-residential',
        storageState: null,
        viewport: {width: 1280, height: 720, deviceScaleFactor: 1},
        observationMs: 2500,
        capturedAt: '2026-09-08T07:00:00Z',
        targetMetadata: {expect: 'banner', jurisdiction: 'eea'},
        ...overrides
    };
}

function snapshotBody(frames) {
    return {schemaVersion: 1, frames, elements: [{id: 'e0'}], rootFrameId: 'f0'};
}

async function writeCapture(dir, id, {group = 'example.test', frames, expect}) {
    const metadata = captureMetadata({
        captureId: id,
        group,
        targetMetadata: {expect: expect ?? 'banner', jurisdiction: 'eea'}
    });
    await writeFile(path.join(dir, `${id}.metadata.json`), JSON.stringify(metadata));
    await writeFile(path.join(dir, `${id}.snapshot.json`),
        JSON.stringify(snapshotBody(frames ?? [{id: 'f0', accessible: true}])));
    await writeFile(path.join(dir, `${id}.features.json`),
        JSON.stringify({schemaVersion: 1, elements: []}));
}

async function makeCorpus(entries) {
    const root = await mkdtemp(path.join(tmpdir(), 'smelt-prepare-'));
    const capturesDir = path.join(root, 'captures');
    const sessionsDir = path.join(root, 'sessions');
    await mkdir(capturesDir, {recursive: true});
    await mkdir(sessionsDir, {recursive: true});
    for (const entry of entries) {
        await writeCapture(capturesDir, entry.id, entry);
    }
    await writeFile(path.join(sessionsDir, 'crawl-test.json'), JSON.stringify({
        captured: entries.length,
        failed: 0,
        skipped: 1,
        sessions: [{creditsUsed: 2, proxyBytesUsed: 1000, durationMs: 5000}]
    }));
    return {root, capturesDir, sessionsDir};
}

test('assignGroupsToSplits is deterministic and separates groups', () => {
    const groups = ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'];
    const first = assignGroupsToSplits(groups);
    const second = assignGroupsToSplits([...groups].reverse());
    assert.deepEqual(first, second);
    // Every group lands in a split, and the ratios hold roughly.
    const values = Object.values(first);
    assert.ok(values.every(value => ['train', 'development', 'test'].includes(value)));
    assert.equal(new Set(Object.keys(first)).size, groups.length);
    const trainShare = values.filter(value => value === 'train').length / groups.length;
    assert.ok(trainShare >= 0.4 && trainShare <= 0.8);
});

test('buildCorpusArtifacts keeps one group in one split', () => {
    const captures = [
        {id: 'a-eu', group: 'a.test', egressLocation: 'eu', expected: 'banner',
            frames: [{accessible: true}], elementCount: 10,
            paths: {snapshot: 'corpus/captures/a-eu.snapshot.json',
                features: 'corpus/captures/a-eu.features.json',
                metadata: 'corpus/captures/a-eu.metadata.json'}},
        {id: 'a-us', group: 'a.test', egressLocation: 'us', expected: 'none',
            frames: [{accessible: true}, {accessible: false}], elementCount: 12,
            paths: {snapshot: 'corpus/captures/a-us.snapshot.json',
                features: 'corpus/captures/a-us.features.json',
                metadata: 'corpus/captures/a-us.metadata.json'}},
        {id: 'b-eu', group: 'b.test', egressLocation: 'eu', expected: 'none',
            frames: [{accessible: true}], elementCount: 8,
            paths: {snapshot: 'corpus/captures/b-eu.snapshot.json',
                features: 'corpus/captures/b-eu.features.json',
                metadata: 'corpus/captures/b-eu.metadata.json'}}
    ];
    const {manifest, labels, stats} = buildCorpusArtifacts(captures, [{
        captured: 3, failed: 0, skipped: 0,
        sessions: [{creditsUsed: 1, proxyBytesUsed: 5, durationMs: 10}]
    }]);

    const splitOf = {};
    for (const [split, pages] of Object.entries(manifest.splits)) {
        for (const page of pages) {
            assert.ok(!(page.group in splitOf) || splitOf[page.group] === split,
                `group ${page.group} appears in ${splitOf[page.group]} and ${split}`);
            splitOf[page.group] = split;
        }
    }
    // The paired captures of group a.test share one split.
    const aSplit = splitOf['a.test'];
    const aPages = manifest.splits[aSplit].filter(page => page.group === 'a.test');
    assert.equal(aPages.length, 2);

    assert.equal(stats.captures, 3);
    assert.equal(stats.groups, 2);
    assert.equal(stats.inaccessibleFrames, 1);
    assert.equal(stats.inaccessibleFrameCaptures, 1);
    assert.deepEqual(stats.labelStatus, {reviewed: 0, unresolved: 3});
    assert.equal(stats.teacherLabels, 0);
    assert.deepEqual(stats.browser,
        {sessions: 1, captured: 3, failed: 0, skipped: 0,
            creditsUsed: 1, proxyBytesUsed: 5, browserMs: 10});

    const stub = labels[aSplit].find(page => page.id === 'a-eu');
    assert.equal(stub.label_status, 'unresolved');
    assert.equal(stub.has_banner, null);
    assert.deepEqual(stub.acceptable_roots, []);
    assert.ok(stub.review_notes.includes('expected banner'));
});

test('reviewItems mark inaccessible-frame captures distinctly', () => {
    const items = reviewItems([
        {id: 'open', group: 'a.test', expected: 'banner', egressLocation: 'eu',
            frames: [{accessible: true}], elementCount: 5, note: null,
            paths: {snapshot: 'corpus/captures/open.snapshot.json'}},
        {id: 'framed', group: 'b.test', expected: 'none', egressLocation: 'us',
            frames: [{accessible: true}, {accessible: false}], elementCount: 5, note: null,
            paths: {snapshot: 'corpus/captures/framed.snapshot.json'}}
    ]);
    assert.equal(items[0].source, 'human_flag');
    assert.equal(items[1].source, 'frame_inaccessible');
    assert.match(items[1].reason, /inaccessible frames/);
    assert.match(items[1].notes, /1 inaccessible frame\(s\)/);
});

test('mergeReviewQueue refreshes derived fields and keeps unknown items', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-queue-'));
    const queuePath = path.join(dir, 'review-queue.json');
    await writeFile(queuePath, JSON.stringify({
        schema_version: 1,
        generated_at: '2026-09-07T00:00:00Z',
        items: [
            {capture_id: 'existing', group: 'stale.test',
                reason: 'kept', source: 'human_flag'},
            {capture_id: 'retired', group: 'z.test',
                reason: 'capture was re-taken', source: 'human_flag'}
        ]
    }));
    const items = [
        {capture_id: 'existing', group: 'fresh.test', reason: 'initial label',
            source: 'human_flag', snapshot_path: 'a'},
        {capture_id: 'fresh', group: 'y.test', reason: 'initial label',
            source: 'human_flag', snapshot_path: 'b'}
    ];
    try {
        const first = await mergeReviewQueue(queuePath, items);
        assert.deepEqual(first, {added: 1, updated: 1, total: 3});
        const second = await mergeReviewQueue(queuePath, items);
        assert.deepEqual(second, {added: 0, updated: 2, total: 3});
        const queue = JSON.parse(await readFile(queuePath, 'utf8'));
        const byId = new Map(queue.items.map(item => [item.capture_id, item]));
        // The queue is derived data: a stale group from an older capture
        // metadata must not survive a re-run.
        assert.equal(byId.get('existing').group, 'fresh.test');
        assert.equal(byId.get('retired').reason, 'capture was re-taken');
        assert.ok(byId.get('fresh'));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('prepareCorpus writes manifests, labels, stats, and the queue', async () => {
    const {root, capturesDir, sessionsDir} = await makeCorpus([
        {id: 'a-eu', group: 'a.test', expect: 'banner'},
        {id: 'a-us', group: 'a.test', expect: 'none'},
        {id: 'b-eu', group: 'b.test', expect: 'none'}
    ]);
    const queuePath = path.join(root, 'review-queue.json');
    await writeFile(queuePath, JSON.stringify({
        schema_version: 1, generated_at: '2026-09-07T00:00:00Z', items: []
    }));
    try {
        const result = await prepareCorpus({
            capturesDir, sessionsDir, outDir: root, queuePath,
            labelsSchemaPath, queueSchemaPath
        });
        assert.equal(result.stats.captures, 3);

        const manifest = JSON.parse(await readFile(
            path.join(root, 'manifests', 'splits.json'), 'utf8'));
        const pages = Object.values(manifest.splits).flat();
        assert.equal(pages.length, 3);

        for (const split of ['train', 'development', 'test']) {
            const filename = path.join(root, 'manifests', 'labels', `${split}.labels.json`);
            if (manifest.splits[split].length === 0) {
                await assert.rejects(() => readFile(filename), /ENOENT/);
                continue;
            }
            const labels = JSON.parse(await readFile(filename, 'utf8'));
            assert.equal(labels.split, split);
            assert.ok(labels.pages.length > 0);
            for (const page of labels.pages) {
                assert.equal(page.label_status, 'unresolved');
                assert.ok(typeof page.review_notes === 'string' && page.review_notes);
            }
        }
        const stats = JSON.parse(await readFile(
            path.join(root, 'stats', 'pilot-corpus-stats.json'), 'utf8'));
        assert.equal(stats.captures, 3);
        assert.equal(stats.browser.skipped, 1);
        const queue = JSON.parse(await readFile(queuePath, 'utf8'));
        assert.equal(queue.items.length, 3);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});

test('prepareCorpus fails on an empty captures directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'smelt-prepare-empty-'));
    try {
        await assert.rejects(() => prepareCorpus({
            capturesDir: root, sessionsDir: root, outDir: root,
            queuePath: path.join(root, 'queue.json')
        }), /no captures found/);
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});

function reviewedPage(id, group) {
    return {
        id, group, label_status: 'reviewed', has_banner: true,
        acceptable_roots: ['e0'], banner_root: 'e0', banner_kind: 'banner',
        jurisdiction: 'eea',
        frame: {state: 'top', frame_id: null, element_id: null},
        evidence: [{kind: 'geometry', value: 'human review', element_id: 'e0'}],
        confidence: 1, review_notes: 'checked by hand'
    };
}

test('isHumanTouched separates generated stubs from human work', () => {
    assert.equal(isHumanTouched(reviewedPage('a', 'a.test')), true);
    assert.equal(isHumanTouched({label_status: 'unresolved',
        review_notes: 'banner appears after a delay; needs a second look'}), true);
    assert.equal(isHumanTouched({label_status: 'unresolved',
        review_notes: 'awaiting initial human label; expected banner'}), false);
    assert.equal(isHumanTouched({label_status: 'unresolved', review_notes: ''}), false);
    assert.equal(isHumanTouched({label_status: 'unresolved'}), false);
    assert.equal(isHumanTouched(null), false);
});

test('mergeCorpusLabels preserves human records and reports moves and drops', () => {
    const stub = id => ({id, group: 'a.test', label_status: 'unresolved',
        has_banner: null, acceptable_roots: [], banner_root: null,
        banner_kind: null, jurisdiction: null,
        frame: {state: 'unknown', frame_id: null, element_id: null},
        evidence: [], confidence: null,
        review_notes: 'awaiting initial human label; expected banner'});
    const fresh = {train: [stub('a'), stub('b'), stub('c')],
        development: [], test: []};
    const existing = {
        train: new Map([['a', reviewedPage('a', 'a.test')], ['b', stub('b')]]),
        // A reviewed record pasted into the wrong split file still belongs
        // to its capture; the merge moves it back.
        development: new Map([['c', reviewedPage('c', 'a.test')]]),
        test: new Map([['gone', reviewedPage('gone', 'z.test')]])
    };
    const {labels, report} = mergeCorpusLabels(fresh, existing);

    const trainById = new Map(labels.train.map(page => [page.id, page]));
    assert.equal(trainById.get('a').label_status, 'reviewed');
    assert.equal(trainById.get('a').review_notes, 'checked by hand');
    assert.equal(trainById.get('b').label_status, 'unresolved');
    assert.equal(trainById.get('c').label_status, 'reviewed');
    assert.equal(labels.development.length, 0);
    assert.equal(report.preservedReviewed, 2);
    assert.equal(report.preservedUnresolved, 0);
    assert.deepEqual(report.moved, [{id: 'c', from: 'development', to: 'train'}]);
    assert.deepEqual(report.dropped, ['gone']);
});

test('mergeCorpusLabels rejects a page id in two existing files', () => {
    const fresh = {train: [], development: [], test: []};
    const existing = {
        train: new Map([['a', reviewedPage('a', 'a.test')]]),
        development: new Map([['a', reviewedPage('a', 'a.test')]]),
        test: new Map()
    };
    assert.throws(() => mergeCorpusLabels(fresh, existing), /duplicate page id a/);
});

test('prepareCorpus keeps pasted human labels across a re-run', async () => {
    const {root, capturesDir, sessionsDir} = await makeCorpus([
        {id: 'a-eu', group: 'a.test', expect: 'banner'},
        {id: 'a-us', group: 'a.test', expect: 'none'},
        {id: 'b-eu', group: 'b.test', expect: 'none'}
    ]);
    const queuePath = path.join(root, 'review-queue.json');
    await writeFile(queuePath, JSON.stringify({
        schema_version: 1, generated_at: '2026-09-07T00:00:00Z', items: []
    }));
    const labelsDir = path.join(root, 'manifests', 'labels');
    try {
        const first = await prepareCorpus({
            capturesDir, sessionsDir, outDir: root, queuePath,
            labelsSchemaPath, queueSchemaPath
        });
        assert.equal(first.labelMerge.preservedReviewed, 0);

        // Simulate the reviewer: one pasted reviewed record, one
        // unresolved record with a hand-written note, one untouched stub.
        const files = {};
        const pages = [];
        for (const split of ['train', 'development', 'test']) {
            const file = path.join(labelsDir, `${split}.labels.json`);
            if (!await readFile(file).then(() => true, () => false)) continue;
            files[split] = JSON.parse(await readFile(file, 'utf8'));
            pages.push(...files[split].pages);
        }
        const [firstPage, secondPage, thirdPage] = pages;
        const replacePage = (page, next) => {
            const dataset = Object.values(files)
                .find(doc => doc.pages.includes(page));
            dataset.pages[dataset.pages.indexOf(page)] = next;
        };
        replacePage(firstPage, reviewedPage(firstPage.id, firstPage.group));
        replacePage(secondPage, {...secondPage,
            review_notes: 'banner appears after a delay; needs a second look'});
        for (const split of Object.keys(files)) {
            await writeFile(path.join(labelsDir, `${split}.labels.json`),
                `${JSON.stringify(files[split], null, 2)}\n`);
        }

        const second = await prepareCorpus({
            capturesDir, sessionsDir, outDir: root, queuePath,
            labelsSchemaPath, queueSchemaPath
        });
        assert.equal(second.labelMerge.preservedReviewed, 1);
        assert.equal(second.labelMerge.preservedUnresolved, 1);
        assert.equal(second.stats.labelStatus.reviewed, 1);
        assert.equal(second.stats.labelStatus.unresolved, 2);

        const mergedPages = [];
        for (const split of ['train', 'development', 'test']) {
            const file = path.join(labelsDir, `${split}.labels.json`);
            const exists = await readFile(file).then(() => true, () => false);
            if (!exists) continue;
            const dataset = JSON.parse(await readFile(file, 'utf8'));
            assert.equal(dataset.pages.length,
                first.manifest.splits[dataset.split].length);
            mergedPages.push(...dataset.pages);
        }
        const byId = new Map(mergedPages.map(page => [page.id, page]));
        assert.equal(byId.get(firstPage.id).label_status, 'reviewed');
        assert.equal(byId.get(firstPage.id).review_notes, 'checked by hand');
        assert.equal(byId.get(secondPage.id).review_notes,
            'banner appears after a delay; needs a second look');
        assert.ok(byId.get(thirdPage.id).review_notes
            .startsWith('awaiting initial human label'));
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});
