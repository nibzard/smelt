/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluate, reviewQueueFromLabels} from '../index.mjs';

const page = (id, hasBanner = true) => ({
    id, group: id, hasBanner, acceptableRoots: hasBanner ? ['banner', 'wrapper'] : []
});
const dataset = (...pages) => ({schemaVersion: 1, split: 'development', pages});

test('a wrong root is both a false positive and a false negative', () => {
    const report = evaluate(dataset(page('a')), [{id: 'a', roots: ['body']}]);
    assert.deepEqual(report.detection, {
        truePositives: 0, falsePositives: 1, falseNegatives: 1,
        precision: 0, recall: 0, f1: 0
    });
    assert.equal(report.presence.f1, 1);
    assert.equal(report.outcomes[0].outcome, 'wrong-root');
});

test('scores mixed cases and only accepts the highest-ranked root', () => {
    const report = evaluate(dataset(page('a'), page('b'), page('c'), page('d', false), page('e', false)), [
        {id: 'e', roots: []},
        {id: 'b', roots: ['body', 'banner']},
        {id: 'a', roots: ['wrapper']},
        {id: 'c', roots: []},
        {id: 'd', roots: ['newsletter']}
    ]);
    assert.equal(report.detection.truePositives, 1);
    assert.equal(report.detection.falsePositives, 2);
    assert.equal(report.detection.falseNegatives, 2);
    assert.equal(report.detection.f1, 1 / 3);
    assert.equal(report.presence.f1, 2 / 3);
    assert.equal(report.trueNegatives, 1);
    assert.equal(report.extraRoots, 1);
});

test('does not invent a perfect score for an all-negative set', () => {
    const report = evaluate(dataset(page('a', false)), [{id: 'a', roots: []}]);
    assert.equal(report.detection.precision, null);
    assert.equal(report.detection.recall, null);
    assert.equal(report.detection.f1, null);
    assert.equal(report.trueNegatives, 1);
});

test('rejects missing, duplicate, and unknown predictions', () => {
    const labels = dataset(page('a'));
    assert.throws(() => evaluate(labels, []), /Every page/);
    assert.throws(() => evaluate(labels, [{id: 'a', roots: []}, {id: 'a', roots: []}]), /duplicate prediction/);
    assert.throws(() => evaluate(labels, [{id: 'b', roots: []}]), /Unknown/);
    assert.throws(() => evaluate(labels, [{id: 'a', roots: null}]), /Invalid prediction roots/);
    assert.throws(() => evaluate(labels, [{id: 'a', roots: ['banner', 'banner']}]), /Duplicate prediction root/);
});

test('rejects inconsistent labels and unsupported datasets', () => {
    assert.throws(() => evaluate(dataset(), []), /nonempty/);
    assert.throws(() => evaluate(dataset(page('a'), page('a')), []), /unique/);
    assert.throws(() => evaluate(dataset({...page('a'), acceptableRoots: []}), []), /disagree/);
    assert.throws(() => evaluate(dataset({...page('a'), group: ''}), []), /group/);
    assert.throws(() => evaluate({schemaVersion: 2}, []), /schemaVersion/);
    assert.throws(() => evaluate({...dataset(page('a')), split: 'unknown'}, []), /split/);
});

test('accepts reviewed consent labels and skips unresolved pages', () => {
    const labels = {
        schema_version: 1,
        split: 'development',
        pages: [{
            id: 'positive',
            group: 'template-a',
            label_status: 'reviewed',
            has_banner: true,
            acceptable_roots: ['e1', 'e2'],
            banner_root: 'e1',
            banner_kind: 'dialog',
            jurisdiction: 'eea',
            frame: {state: 'top', frame_id: 'f0', element_id: null},
            evidence: [{kind: 'text', value: 'We use cookies', element_id: 'e1'}],
            confidence: 0.96
        }, {
            id: 'negative',
            group: 'template-b',
            label_status: 'reviewed',
            has_banner: false,
            acceptable_roots: [],
            banner_root: null,
            banner_kind: 'unknown',
            jurisdiction: 'us',
            frame: {state: 'top', frame_id: 'f0', element_id: null},
            evidence: [],
            confidence: 0.91
        }, {
            id: 'needs-review',
            group: 'template-c',
            label_status: 'unresolved',
            has_banner: null,
            acceptable_roots: [],
            banner_root: null,
            banner_kind: null,
            jurisdiction: null,
            frame: {state: 'inaccessible', frame_id: 'f1', element_id: 'e5'},
            evidence: [{kind: 'verifier', value: 'cross-origin frame was not accessible'}],
            confidence: null,
            review_notes: 'Frame content needs human review.'
        }]
    };
    const report = evaluate(labels, [
        {id: 'positive', roots: ['e2']},
        {id: 'negative', roots: []}
    ]);
    assert.equal(report.pages, 2);
    assert.equal(report.detection.truePositives, 1);
    assert.equal(report.trueNegatives, 1);
    assert.deepEqual(reviewQueueFromLabels(labels, '2026-09-07T00:00:00Z'), {
        schema_version: 1,
        generated_at: '2026-09-07T00:00:00Z',
        items: [{
            capture_id: 'needs-review',
            group: 'template-c',
            reason: 'Frame content needs human review.',
            source: 'human_flag'
        }]
    });
});

test('rejects invalid consent-label invariants', () => {
    const valid = {
        schema_version: 1,
        split: 'development',
        pages: [{
            id: 'positive',
            group: 'template-a',
            label_status: 'reviewed',
            has_banner: true,
            acceptable_roots: ['e1'],
            banner_root: 'e1',
            banner_kind: 'banner',
            jurisdiction: 'eea',
            frame: {state: 'top', frame_id: 'f0', element_id: null},
            evidence: [{kind: 'text', value: 'Accept cookies'}],
            confidence: 0.9
        }]
    };
    assert.throws(() => evaluate({...valid, pages: [{...valid.pages[0], banner_root: 'e2'}]},
        [{id: 'positive', roots: []}]), /banner_root must be acceptable/);
    assert.throws(() => evaluate({...valid, pages: [{...valid.pages[0], label_status: 'unresolved'}]},
        [{id: 'positive', roots: []}]), /leave has_banner null/);
    assert.throws(() => evaluate({...valid, pages: [{...valid.pages[0], acceptable_roots: []}]},
        [{id: 'positive', roots: []}]), /disagree/);
});

test('CLI reports actionable usage and file errors', () => {
    const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
    const usage = spawnSync(process.execPath, [cli], {encoding: 'utf8'});
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Usage:/);
    const missing = spawnSync(process.execPath, [cli, 'missing-labels.json', 'missing-predictions.json'], {encoding: 'utf8'});
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Evaluation failed:/);
});
