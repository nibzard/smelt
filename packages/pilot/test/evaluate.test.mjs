/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compareWorkflows, evaluate, evaluateGroupedSplits, reviewQueueFromLabels} from '../index.mjs';

const page = (id, hasBanner = true) => ({
    id, group: id, hasBanner, acceptableRoots: hasBanner ? ['banner', 'wrapper'] : []
});
const dataset = (...pages) => ({schemaVersion: 1, split: 'development', pages});
const agent = {
    model: 'steel-agent-model',
    promptHash: 'sha256-prompt',
    actionPolicyHash: 'sha256-policy'
};

function workflowRecord(caseId, variant, overrides = {}) {
    return {
        schemaVersion: 1,
        task: 'consent-banners',
        caseId,
        variant,
        fixedAgent: overrides.fixedAgent ?? agent,
        metrics: {
            taskCompleted: true,
            modelCalls: 4,
            totalWorkflowCostUsd: 0.04,
            browserMs: 1000,
            workflowMs: 1200,
            ...overrides.metrics
        },
        workflow: {
            metadata: overrides.metadata ?? {}
        }
    };
}

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
    assert.equal(report.exactRootAccuracy, 0);
});

test('reports exact-root accuracy from canonical roots', () => {
    const report = evaluate(dataset(
        {...page('a'), exactRoot: 'banner'},
        {...page('b'), exactRoot: 'banner'}
    ), [
        {id: 'a', roots: ['wrapper']},
        {id: 'b', roots: ['banner']}
    ]);
    assert.equal(report.detection.f1, 1);
    assert.equal(report.exactRootAccuracy, 1 / 2);
    assert.equal(report.outcomes[0].exactRoot, 'banner');
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
    assert.throws(() => evaluate(dataset({...page('a'), exactRoot: 'body'}), []), /exactRoot must be acceptable/);
    assert.throws(() => evaluate(dataset({...page('a', false), exactRoot: 'banner'}), []), /must not have exactRoot/);
    assert.throws(() => evaluate(dataset({...page('a'), group: ''}), []), /group/);
    assert.throws(() => evaluate({schemaVersion: 2}, []), /schemaVersion/);
    assert.throws(() => evaluate({...dataset(page('a')), split: 'unknown'}, []), /split/);
});

test('scores grouped splits and rejects groups crossing splits', () => {
    const train = {schemaVersion: 1, split: 'train', pages: [
        {...page('a'), group: 'template-a'},
        {...page('b', false), group: 'template-a'}
    ]};
    const development = {schemaVersion: 1, split: 'development', pages: [
        {...page('c'), group: 'template-b'}
    ]};
    const report = evaluateGroupedSplits({schemaVersion: 1, splits: [train, development]}, {
        train: [{id: 'a', roots: ['banner']}, {id: 'b', roots: []}],
        development: [{id: 'c', roots: []}]
    });
    assert.equal(report.splitCount, 2);
    assert.equal(report.pages, 3);
    assert.equal(report.groups, 2);
    assert.equal(report.splits.train.detection.f1, 1);
    assert.equal(report.splits.development.detection.falseNegatives, 1);

    assert.throws(() => evaluateGroupedSplits([train, {
        schemaVersion: 1, split: 'test', pages: [{...page('d'), group: 'template-a'}]
    }], {
        train: [{id: 'a', roots: []}, {id: 'b', roots: []}],
        test: [{id: 'd', roots: []}]
    }), /appears in both train and test/);
    assert.throws(() => evaluateGroupedSplits([train, {...train}], {
        train: [{id: 'a', roots: []}, {id: 'b', roots: []}]
    }), /Duplicate split/);
    assert.throws(() => evaluateGroupedSplits([development], {}), /Missing predictions/);
});

test('compares matched Steel workflows and applies cost gates', () => {
    const baseline = [
        workflowRecord('case-a', 'baseline', {metrics: {totalWorkflowCostUsd: 0.1, workflowMs: 2000}}),
        workflowRecord('case-b', 'baseline', {metrics: {totalWorkflowCostUsd: 0.1, workflowMs: 1800}}),
        workflowRecord('case-c', 'baseline', {
            metrics: {taskCompleted: false, totalWorkflowCostUsd: 0.1, workflowMs: 1900},
            metadata: {failureSlice: 'missed-consent-banner'}
        })
    ];
    const smelt = [
        workflowRecord('case-a', 'smelt-assisted', {
            metrics: {totalWorkflowCostUsd: 0.05, modelCalls: 2, addedLatencyMs: 40, detectionMs: 4, workflowMs: 1700}
        }),
        workflowRecord('case-b', 'smelt-assisted', {
            metrics: {totalWorkflowCostUsd: 0.05, modelCalls: 2, addedLatencyMs: 35, detectionMs: 3, workflowMs: 1600}
        }),
        workflowRecord('case-c', 'smelt-assisted', {
            metrics: {taskCompleted: true, totalWorkflowCostUsd: 0.05, modelCalls: 2,
                addedLatencyMs: 30, detectionMs: 3, workflowMs: 1650}
        })
    ];

    const report = compareWorkflows({baseline, smelt}, {bootstrapIterations: 200, seed: 7});
    assert.equal(report.matchedCases, 3);
    assert.equal(report.baseline.successfulCompletions, 2);
    assert.equal(report.smelt.successfulCompletions, 3);
    assert.equal(report.deltas.costPerCompletedTaskRatio, -0.666667);
    assert.equal(report.gates.primary.status, 'pass');
    assert.equal(report.gates.completionRegression.status, 'pass');
    assert.equal(report.gates.latencyRegression.status, 'pass');
    assert.deepEqual(report.failureSlices.baseline, {'missed-consent-banner': 1});
    assert.deepEqual(report.failureSlices.smelt, {});
});

test('uses completion as the primary gate for low baseline completion', () => {
    const baseline = [
        workflowRecord('case-a', 'baseline', {metrics: {taskCompleted: false, totalWorkflowCostUsd: 0.04}}),
        workflowRecord('case-b', 'baseline', {metrics: {taskCompleted: false, totalWorkflowCostUsd: 0.04}}),
        workflowRecord('case-c', 'baseline', {metrics: {taskCompleted: true, totalWorkflowCostUsd: 0.04}})
    ];
    const smelt = [
        workflowRecord('case-a', 'smelt-assisted', {metrics: {taskCompleted: true, totalWorkflowCostUsd: 0.04, addedLatencyMs: 20, workflowMs: 1000}}),
        workflowRecord('case-b', 'smelt-assisted', {metrics: {taskCompleted: false, totalWorkflowCostUsd: 0.04, addedLatencyMs: 20, workflowMs: 1000}}),
        workflowRecord('case-c', 'smelt-assisted', {metrics: {taskCompleted: true, totalWorkflowCostUsd: 0.04, addedLatencyMs: 20, workflowMs: 1000}})
    ];

    const report = compareWorkflows({baseline, smelt}, {bootstrapIterations: 100, seed: 3});
    assert.equal(report.gates.primary.metric, 'completion_rate');
    assert.equal(report.gates.primary.status, 'pass');
    assert.equal(report.deltas.completionRate, 0.333333);
});

test('rejects workflow comparisons that are not matched', () => {
    assert.throws(() => compareWorkflows({
        baseline: [workflowRecord('case-a', 'baseline')],
        smelt: [workflowRecord('case-b', 'smelt-assisted')]
    }), /Missing Smelt record/);

    assert.throws(() => compareWorkflows({
        baseline: [workflowRecord('case-a', 'baseline')],
        smelt: [workflowRecord('case-a', 'smelt-assisted', {
            fixedAgent: {...agent, promptHash: 'different'}
        })]
    }), /Fixed agent differs/);
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
    assert.equal(report.exactRootAccuracy, 0);
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
