/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Coverage for the training manifest builder. The builder is the
// structural guard for IDEA.md 3.2.4: it reads the train and development
// splits only, refuses any unresolved page, and never emits a quiet
// subset of a split.

import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {buildTrainingManifest} from '../training-manifest.mjs';

function reviewedPage(id, group) {
    return {
        id, group, label_status: 'reviewed', has_banner: true,
        acceptable_roots: ['e3'], banner_root: 'e3', banner_kind: 'banner',
        jurisdiction: 'eea',
        frame: {state: 'top', frame_id: null, element_id: null},
        evidence: [{kind: 'geometry', value: 'human review', element_id: 'e3'}],
        confidence: 0.9, review_notes: 'reviewed'
    };
}

function unresolvedPage(id, group) {
    return {...reviewedPage(id, group), label_status: 'unresolved',
        has_banner: null, acceptable_roots: [], banner_root: null,
        banner_kind: null, jurisdiction: null, confidence: null,
        review_notes: 'awaiting initial human label; expected banner'};
}

// A world shaped like the real corpus: a split manifest with capture
// paths, and one labels file per split.
async function buildWorld({trainPages, developmentPages, testPages = []}) {
    const root = await mkdtemp(path.join(tmpdir(), 'smelt-tman-'));
    const capturesDir = path.join(root, 'captures');
    const labelsDir = path.join(root, 'manifests', 'labels');
    await mkdir(capturesDir, {recursive: true});
    await mkdir(labelsDir, {recursive: true});

    const splits = {train: [], development: [], test: []};
    const pages = {train: trainPages, development: developmentPages, test: testPages};
    for (const split of ['train', 'development', 'test']) {
        for (const page of pages[split] ?? []) {
            const snapshot = path.join(capturesDir, `${page.id}.snapshot.json`);
            const features = path.join(capturesDir, `${page.id}.features.json`);
            await writeFile(snapshot, JSON.stringify({schemaVersion: 1}));
            await writeFile(features, JSON.stringify({schemaVersion: 1}));
            splits[split].push({id: page.id, group: page.group, snapshot, features});
        }
        await writeFile(path.join(labelsDir, `${split}.labels.json`),
            JSON.stringify({schema_version: 1, split, pages: pages[split] ?? []}));
    }
    const manifestPath = path.join(root, 'manifests', 'splits.json');
    await writeFile(manifestPath, JSON.stringify({schemaVersion: 1, splits}));
    const outPath = path.join(root, 'training', 'manifest.json');
    await mkdir(path.dirname(outPath), {recursive: true});
    return {root, labelsDir, manifestPath, outPath, splits};
}

test('builds a manifest from reviewed labels and never touches test', async () => {
    const world = await buildWorld({
        trainPages: [reviewedPage('a-eu', 'a.test')],
        developmentPages: [reviewedPage('b-eu', 'b.test')],
        testPages: [reviewedPage('frozen-eu', 'frozen.test')]
    });
    try {
        const {manifest, files} = await buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: world.outPath});

        assert.equal(manifest.schemaVersion, 1);
        assert.deepEqual(Object.keys(manifest).sort(),
            ['development', 'generatedAt', 'schemaVersion', 'train']);
        // The test split is structurally absent: no role, no page id, and
        // no group from the test labels reaches the output.
        const serialized = JSON.stringify(manifest) + JSON.stringify(files)
            + await readFile(world.outPath, 'utf8');
        assert.ok(!serialized.includes('frozen-eu'));
        assert.ok(!serialized.includes('frozen.test'));

        assert.equal(manifest.train.labels, 'train.labels.json');
        assert.deepEqual(manifest.train.captures, [{
            id: 'a-eu',
            snapshot: path.resolve(world.splits.train[0].snapshot),
            features: path.resolve(world.splits.train[0].features)
        }]);
        const compact = JSON.parse(await readFile(
            path.join(path.dirname(world.outPath), 'train.labels.json'), 'utf8'));
        assert.deepEqual(compact, {schemaVersion: 1, split: 'train',
            pages: [{id: 'a-eu', group: 'a.test', hasBanner: true,
                acceptableRoots: ['e3'], exactRoot: 'e3'}]});
        assert.equal(files.length, 3);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('one unresolved page refuses the whole build', async () => {
    const world = await buildWorld({
        trainPages: [reviewedPage('a-eu', 'a.test'), unresolvedPage('a2-eu', 'a.test')],
        developmentPages: [reviewedPage('b-eu', 'b.test')]
    });
    try {
        await assert.rejects(buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: world.outPath}), /train still holds 1 unresolved page\(s\): a2-eu/);
        // Nothing was written.
        await assert.rejects(readFile(world.outPath), /ENOENT/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('labels and manifest captures must agree exactly', async () => {
    // The manifest lists a capture the labels do not carry.
    const world = await buildWorld({
        trainPages: [reviewedPage('a-eu', 'a.test')],
        developmentPages: [reviewedPage('b-eu', 'b.test')]
    });
    try {
        const stale = JSON.parse(await readFile(world.manifestPath, 'utf8'));
        stale.splits.development.push({...stale.splits.development[0],
            id: 'ghost-eu', group: 'ghost.test'});
        await writeFile(world.manifestPath, JSON.stringify(stale));
        await assert.rejects(buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: world.outPath}), /development manifest lists captures with no reviewed label: ghost-eu/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a group spanning train and development is refused', async () => {
    const world = await buildWorld({
        trainPages: [reviewedPage('a-eu', 'shared.test')],
        developmentPages: [reviewedPage('b-eu', 'shared.test')]
    });
    try {
        await assert.rejects(buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: world.outPath}), /Group shared\.test appears in train and development/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a group with several pages inside one split builds fine', async () => {
    // Real corpora pair locations: apple.com EU and US captures share a
    // group and land in the same split. Only spanning two splits is a
    // violation.
    const world = await buildWorld({
        trainPages: [reviewedPage('apple-eu', 'apple.com'),
            {...reviewedPage('apple-us', 'apple.com'), has_banner: false,
                acceptable_roots: [], banner_root: null, banner_kind: 'unknown'}],
        developmentPages: [reviewedPage('b-eu', 'b.test')]
    });
    try {
        const {manifest} = await buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: world.outPath});
        assert.equal(manifest.train.captures.length, 2);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('writing into the labels directory is refused', async () => {
    const world = await buildWorld({
        trainPages: [reviewedPage('a-eu', 'a.test')],
        developmentPages: [reviewedPage('b-eu', 'b.test')]
    });
    try {
        await assert.rejects(buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: path.join(world.labelsDir, 'manifest.json')}),
            /compact files would overwrite the reviewed labels/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('an output path aliased to the labels directory is refused', async () => {
    // A ".." spelling of the same directory. A lexical path.resolve
    // collapses it, but only a real-path comparison catches every alias.
    const world = await buildWorld({
        trainPages: [reviewedPage('a-eu', 'a.test')],
        developmentPages: [reviewedPage('b-eu', 'b.test')]
    });
    try {
        await assert.rejects(buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: `${world.labelsDir}/../labels/manifest.json`}),
            /compact files would overwrite the reviewed labels/);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('a symlinked output directory is refused',
    {skip: process.platform === 'win32'}, async () => {
        const world = await buildWorld({
            trainPages: [reviewedPage('a-eu', 'a.test')],
            developmentPages: [reviewedPage('b-eu', 'b.test')]
        });
        try {
            const link = path.join(world.root, 'link-to-labels');
            await symlink(world.labelsDir, link);
            await assert.rejects(buildTrainingManifest({
                manifestPath: world.manifestPath, labelsDir: world.labelsDir,
                outPath: path.join(link, 'manifest.json')}),
                /compact files would overwrite the reviewed labels/);
        } finally {
            await rm(world.root, {recursive: true, force: true});
        }
    });

test('writing over the input split manifest is refused', async () => {
    const world = await buildWorld({
        trainPages: [reviewedPage('a-eu', 'a.test')],
        developmentPages: [reviewedPage('b-eu', 'b.test')]
    });
    try {
        const before = await readFile(world.manifestPath, 'utf8');
        await assert.rejects(buildTrainingManifest({
            manifestPath: world.manifestPath, labelsDir: world.labelsDir,
            outPath: world.manifestPath}),
            /must differ from the split manifest path/);
        assert.equal(await readFile(world.manifestPath, 'utf8'), before);
    } finally {
        await rm(world.root, {recursive: true, force: true});
    }
});

test('an output basename colliding with a compact labels file is refused',
    async () => {
        const world = await buildWorld({
            trainPages: [reviewedPage('a-eu', 'a.test')],
            developmentPages: [reviewedPage('b-eu', 'b.test')]
        });
        try {
            await assert.rejects(buildTrainingManifest({
                manifestPath: world.manifestPath, labelsDir: world.labelsDir,
                outPath: path.join(path.dirname(world.outPath), 'train.labels.json')}),
                /must not be train\.labels\.json or development\.labels\.json/);
        } finally {
            await rm(world.root, {recursive: true, force: true});
        }
    });

test('inputs are required', async () => {
    await assert.rejects(buildTrainingManifest({}), /Expected a split manifest path/);
    await assert.rejects(buildTrainingManifest({manifestPath: 'x'}),
        /Expected a labels directory/);
    await assert.rejects(buildTrainingManifest({manifestPath: 'x', labelsDir: 'y'}),
        /Expected an output manifest path/);
});
