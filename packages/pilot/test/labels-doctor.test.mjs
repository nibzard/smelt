/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Coverage for the label consistency checks. Every test builds a small
// world of captures, a manifest, label files, and a queue, then breaks
// exactly one thing a reviewer paste can break.

import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

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

async function buildWorld() {
    const root = await mkdtemp(path.join(tmpdir(), 'smelt-doctor-'));
    const capturesDir = path.join(root, 'captures');
    const labelsDir = path.join(root, 'labels');
    await mkdir(capturesDir, {recursive: true});
    await mkdir(labelsDir, {recursive: true});

    const captures = [
        {id: 'a-eu', group: 'a.test', split: 'train'},
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
    // Both pages live in their manifest split by default.
    const pages = {train: [stubPage('a-eu', 'a.test')],
        development: [stubPage('b-eu', 'b.test')], test: []};
    return {root, capturesDir, labelsDir, manifestPath, queuePath, pages, captures};
}

async function writeLabels(world, pages) {
    for (const split of ['train', 'development', 'test']) {
        if ((pages[split] ?? []).length === 0) continue;
        await writeFile(path.join(world.labelsDir, `${split}.labels.json`),
            JSON.stringify({schema_version: 1, split, pages: pages[split]}));
    }
}

async function runDoctor(world, pages) {
    await writeLabels(world, pages);
    return checkLabels({
        labelsDir: world.labelsDir,
        manifestPath: world.manifestPath,
        queuePath: world.queuePath,
        capturesDir: world.capturesDir,
        labelsSchemaPath
    });
}

function codes(problems) {
    return problems.map(item => item.code).sort();
}

test('a consistent world passes with no problems', async () => {
    const world = await buildWorld();
    try {
        const {problems, stats} = await runDoctor(world, world.pages);
        assert.deepEqual(problems, []);
        assert.equal(stats.labelPages, 2);
        assert.equal(stats.manifestCaptures, 2);
        assert.equal(stats.reviewed, 0);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a paste into the wrong split file is flagged', async () => {
    const world = await buildWorld();
    try {
        // The reviewer pasted the b-eu record into the train file and
        // removed its stub from development, so the development file is
        // also gone.
        const pages = {train: [world.pages.train[0], world.pages.development[0]],
            development: [], test: []};
        const {problems} = await runDoctor(world, pages);
        assert.deepEqual(codes(problems), ['labels-file-missing', 'labels-wrong-split']);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a paste below the stub is flagged as a duplicate id', async () => {
    const world = await buildWorld();
    try {
        const duplicate = {...world.pages.train[0], review_notes: 'pasted twice'};
        const pages = {...world.pages, train: [world.pages.train[0], duplicate]};
        const {problems} = await runDoctor(world, pages);
        // The semantic label check reports the duplicate too.
        assert.ok(codes(problems).includes('labels-duplicate-id'));
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a record for an unknown capture is flagged', async () => {
    const world = await buildWorld();
    try {
        const pages = {...world.pages,
            train: [...world.pages.train, stubPage('ghost-page', 'ghost.test')]};
        const {problems} = await runDoctor(world, pages);
        assert.ok(codes(problems).includes('labels-unknown-capture'));
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a group disagreement across label, manifest, and queue is flagged', async () => {
    const world = await buildWorld();
    try {
        const pages = {...world.pages,
            train: [stubPage('a-eu', 'typo.test')]};
        const {problems} = await runDoctor(world, pages);
        assert.deepEqual(codes(problems), ['group-mismatch']);
        assert.match(problems[0].detail, /manifest a\.test vs label typo\.test/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a deleted capture file and an unprepared capture are flagged', async () => {
    const world = await buildWorld();
    try {
        await rm(path.join(world.capturesDir, 'a-eu.features.json'));
        await writeFile(path.join(world.capturesDir, 'fresh-eu.metadata.json'),
            JSON.stringify({schemaVersion: 1}));
        const {problems} = await runDoctor(world, world.pages);
        assert.deepEqual(codes(problems), ['capture-file-missing', 'capture-not-in-manifest']);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a missing labels page for a manifest capture is flagged', async () => {
    const world = await buildWorld();
    try {
        const pages = {...world.pages, train: []};
        const {problems} = await runDoctor(world, pages);
        assert.ok(codes(problems).includes('labels-missing-page'));
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('inputs are required', async () => {
    await assert.rejects(() => checkLabels({}), /Expected a labels directory/);
});

test('malformed page and queue entries become problems, not crashes', async () => {
    const world = await buildWorld();
    try {
        // A hand edit can leave a null page beside the real one, a pages
        // field that is not an array, and a queue entry that is not an
        // item object. Every check must run to the end and report each
        // shape, instead of throwing on the first one and discarding the
        // whole problem list.
        await writeFile(path.join(world.labelsDir, 'train.labels.json'),
            JSON.stringify({schema_version: 1, split: 'train',
                pages: [null, stubPage('a-eu', 'a.test')]}));
        await writeFile(path.join(world.labelsDir, 'development.labels.json'),
            JSON.stringify({schema_version: 1, split: 'development',
                pages: {oops: 'not an array'}}));
        const queueItem = id => ({
            capture_id: id, group: `${id.split('-')[1]}.test`,
            reason: 'initial label', source: 'human_flag',
            snapshot_path: `${path.join(world.capturesDir, id)}.snapshot.json`,
            notes: 'queued'
        });
        await writeFile(world.queuePath, JSON.stringify({
            schema_version: 1, generated_at: '2026-09-08T00:00:00Z',
            items: [null, queueItem('a-eu'), queueItem('b-eu')]
        }));

        const {problems, stats} = await checkLabels({
            labelsDir: world.labelsDir,
            manifestPath: world.manifestPath,
            queuePath: world.queuePath,
            capturesDir: world.capturesDir,
            labelsSchemaPath
        });
        const codes = new Set(problems.map(item => item.code));
        assert.ok(codes.has('queue-item-shape'), 'the null queue entry is named');
        assert.ok(codes.has('labels-schema'), 'the null page and the non-array pages are named');
        assert.ok(codes.has('labels-missing-page'), 'b-eu still gets its missing-page check');
        // Only the object page with an id counts; the queue counts its
        // two real items.
        assert.equal(stats.labelPages, 1);
        assert.equal(stats.queueItems, 2);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});
