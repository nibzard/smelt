/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Coverage for applying reviewed records to the split label files. Every
// test builds a small labels world, then breaks exactly one thing a
// reviewer's collected records can break. A rejected record must leave its
// target file byte-for-byte untouched.

import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {applyLabels, parseRecords} from '../labels-apply.mjs';
import {checkLabels} from '../labels-doctor.mjs';

const labelsSchemaPath = new URL('../../../tasks/consent-banners/labels.schema.json',
    import.meta.url).pathname;

function stubPage(id, group) {
    return {
        id, group, label_status: 'unresolved', has_banner: null,
        acceptable_roots: [], banner_root: null, banner_kind: null,
        jurisdiction: null,
        frame: {state: 'unknown', frame_id: null, element_id: null},
        evidence: [], confidence: null,
        review_notes: 'awaiting initial human label; expected banner'
    };
}

// The same shape the review viewer copies, so an applied record always
// matches what a real session produces.
function reviewedPage(id, group, notes = 'human reviewed') {
    return {
        id, group, label_status: 'reviewed', has_banner: true,
        acceptable_roots: ['e3'], banner_root: 'e3', banner_kind: 'banner',
        jurisdiction: 'eea',
        frame: {state: 'top', frame_id: null, element_id: null},
        evidence: [{kind: 'geometry',
            value: 'root selected by human review in the positioned viewer',
            element_id: 'e3'}],
        confidence: 0.9, review_notes: notes
    };
}

// The same world labels-doctor checks: captures, a manifest, a queue, and
// the split label files. Apply only reads the label files, but the doctor
// integration needs the rest.
async function buildWorld() {
    const root = await mkdtemp(path.join(tmpdir(), 'smelt-apply-'));
    const capturesDir = path.join(root, 'captures');
    const labelsDir = path.join(root, 'labels');
    await mkdir(capturesDir, {recursive: true});
    await mkdir(labelsDir, {recursive: true});

    const captures = [
        {id: 'a-eu', group: 'a.test', split: 'train'},
        {id: 'a2-eu', group: 'a.test', split: 'train'},
        {id: 'b-eu', group: 'b.test', split: 'development'}
    ];
    const manifest = {schemaVersion: 1, splits: {train: [], development: [], test: []}};
    for (const capture of captures) {
        const base = path.join(capturesDir, capture.id);
        await writeFile(`${base}.metadata.json`, JSON.stringify({
            schemaVersion: 1, captureId: capture.id, group: capture.group,
            url: `https://${capture.group}/`, egressLocation: 'eu-de-residential',
            targetMetadata: {expect: 'banner', jurisdiction: 'eea'}
        }));
        await writeFile(`${base}.snapshot.json`, JSON.stringify({schemaVersion: 1}));
        await writeFile(`${base}.features.json`, JSON.stringify({schemaVersion: 1}));
        manifest.splits[capture.split].push({
            id: capture.id, group: capture.group, egressLocation: 'eu-de-residential',
            expected: 'banner',
            snapshot: `${base}.snapshot.json`,
            features: `${base}.features.json`,
            metadata: `${base}.metadata.json`
        });
    }
    const manifestPath = path.join(root, 'splits.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const queuePath = path.join(root, 'review-queue.json');
    await writeFile(queuePath, JSON.stringify({
        schema_version: 1, generated_at: '2026-09-08T00:00:00Z',
        items: captures.map(capture => ({
            capture_id: capture.id, group: capture.group,
            reason: 'initial label', source: 'human_flag',
            snapshot_path: `${path.join(capturesDir, capture.id)}.snapshot.json`,
            notes: 'queued'
        }))
    }));

    const pages = {train: [stubPage('a-eu', 'a.test'), stubPage('a2-eu', 'a.test')],
        development: [stubPage('b-eu', 'b.test')], test: []};
    for (const split of ['train', 'development']) {
        await writeFile(path.join(labelsDir, `${split}.labels.json`),
            `${JSON.stringify({schema_version: 1, split, pages: pages[split]}, null, 2)}\n`);
    }
    return {root, capturesDir, labelsDir, manifestPath, queuePath, pages};
}

function trainFile(world) {
    return path.join(world.labelsDir, 'train.labels.json');
}

test('a reviewed record replaces its stub and the world stays doctor-clean',
    async () => {
        const world = await buildWorld();
        try {
            const record = reviewedPage('a-eu', 'a.test');
            const {applied, rejected, written} = await applyLabels({
                records: [record], labelsDir: world.labelsDir, labelsSchemaPath});

            assert.deepEqual(applied, ['a-eu']);
            assert.deepEqual(rejected, []);
            assert.equal(written.length, 1);

            const saved = JSON.parse(await readFile(trainFile(world), 'utf8'));
            assert.deepEqual(saved.pages[0], record);
            assert.deepEqual(saved.pages[1], world.pages.train[1]);
            assert.ok((await readFile(trainFile(world), 'utf8')).endsWith('\n'));

            const {problems, stats} = await checkLabels({
                labelsDir: world.labelsDir, manifestPath: world.manifestPath,
                queuePath: world.queuePath, capturesDir: world.capturesDir,
                labelsSchemaPath
            });
            assert.deepEqual(problems, []);
            assert.equal(stats.reviewed, 1);
        } finally {
            await rm(world.root, {recursive: true, force: true});
        }
    });

test('a record for an unknown page is rejected and the file is untouched',
    async () => {
        const world = await buildWorld();
        try {
            const before = await readFile(trainFile(world), 'utf8');
            const {applied, rejected, written} = await applyLabels({
                records: [reviewedPage('ghost-eu', 'a.test')],
                labelsDir: world.labelsDir, labelsSchemaPath});

            assert.deepEqual(applied, []);
            assert.deepEqual(written, []);
            assert.equal(rejected.length, 1);
            assert.equal(rejected[0].id, 'ghost-eu');
            assert.match(rejected[0].reason, /no split file holds a page/);
            assert.equal(await readFile(trainFile(world), 'utf8'), before);
        } finally {
            await rm(world.root, {recursive: true, force: true});
        }
    });

test('a record whose group disagrees with the labels file is rejected',
    async () => {
        const world = await buildWorld();
        try {
            const before = await readFile(trainFile(world), 'utf8');
            const {rejected} = await applyLabels({
                records: [reviewedPage('a-eu', 'typo.test')],
                labelsDir: world.labelsDir, labelsSchemaPath});

            assert.equal(rejected.length, 1);
            assert.match(rejected[0].reason,
                /record group typo\.test disagrees with the labels file group a\.test/);
            assert.equal(await readFile(trainFile(world), 'utf8'), before);
        } finally {
            await rm(world.root, {recursive: true, force: true});
        }
    });

test('a record that fails the label checks is rejected', async () => {
    const world = await buildWorld();
    try {
        const before = await readFile(trainFile(world), 'utf8');
        const negativeWithRoots = {...reviewedPage('a-eu', 'a.test'),
            has_banner: false, banner_root: 'e3'};
        const {applied, rejected} = await applyLabels({
            records: [negativeWithRoots], labelsDir: world.labelsDir, labelsSchemaPath});

        assert.deepEqual(applied, []);
        assert.equal(rejected.length, 1);
        assert.match(rejected[0].reason, /^(schema|semantic): /);
        assert.equal(await readFile(trainFile(world), 'utf8'), before);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('records apply across splits in one run', async () => {
    const world = await buildWorld();
    try {
        const unresolvedNoted = {...world.pages.train[1],
            review_notes: 'banner present but the root is unclear; needs a second opinion'};
        const {applied, rejected, written} = await applyLabels({
            records: [reviewedPage('a-eu', 'a.test'), unresolvedNoted,
                reviewedPage('b-eu', 'b.test')],
            labelsDir: world.labelsDir, labelsSchemaPath});

        assert.deepEqual([...applied].sort(), ['a-eu', 'a2-eu', 'b-eu']);
        assert.deepEqual(rejected, []);
        assert.equal(written.length, 2);

        const train = JSON.parse(await readFile(trainFile(world), 'utf8'));
        const development = JSON.parse(
            await readFile(path.join(world.labelsDir, 'development.labels.json'), 'utf8'));
        assert.equal(train.pages[0].label_status, 'reviewed');
        assert.equal(train.pages[1].review_notes, unresolvedNoted.review_notes);
        assert.equal(development.pages[0].label_status, 'reviewed');
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a duplicate id in the batch is applied once and rejected once', async () => {
    const world = await buildWorld();
    try {
        const {applied, rejected} = await applyLabels({
            records: [reviewedPage('a-eu', 'a.test', 'first pick'),
                reviewedPage('a-eu', 'a.test', 'second pick')],
            labelsDir: world.labelsDir, labelsSchemaPath});

        assert.deepEqual(applied, ['a-eu']);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].id, 'a-eu');
        assert.match(rejected[0].reason, /appears twice in this batch/);
        const train = JSON.parse(await readFile(trainFile(world), 'utf8'));
        assert.equal(train.pages[0].review_notes, 'first pick');
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a page duplicated inside the label files refuses the apply', async () => {
    const world = await buildWorld();
    try {
        // A paste-below-stub accident from an earlier manual session.
        const train = JSON.parse(await readFile(trainFile(world), 'utf8'));
        train.pages.push({...train.pages[0], review_notes: 'pasted twice'});
        await writeFile(trainFile(world), JSON.stringify(train, null, 2) + '\n');

        const {applied, rejected} = await applyLabels({
            records: [reviewedPage('a-eu', 'a.test')],
            labelsDir: world.labelsDir, labelsSchemaPath});
        assert.deepEqual(applied, []);
        assert.match(rejected[0].reason, /run labels:doctor first/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a split file that exists but does not parse stops the run', async () => {
    const world = await buildWorld();
    try {
        await writeFile(path.join(world.labelsDir, 'development.labels.json'), '{oops');
        await assert.rejects(() => applyLabels({
            records: [reviewedPage('a-eu', 'a.test')],
            labelsDir: world.labelsDir, labelsSchemaPath}), /not valid JSON/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('parseRecords accepts arrays and pages objects, and rejects junk', () => {
    const record = reviewedPage('a-eu', 'a.test');
    assert.equal(parseRecords(JSON.stringify([record])).length, 1);
    assert.equal(parseRecords(JSON.stringify({pages: [record, record]})).length, 2);
    assert.throws(() => parseRecords('{"split": "train"}'), /pages array/);
    assert.throws(() => parseRecords('[]'), /pages array/);
    assert.throws(() => parseRecords('{oops'), SyntaxError);
});

test('inputs are required', async () => {
    await assert.rejects(() => applyLabels({records: [], labelsDir: 'x'}),
        /Expected at least one label record/);
    await assert.rejects(() => applyLabels({records: [{}]}),
        /Expected a labels directory/);
});
