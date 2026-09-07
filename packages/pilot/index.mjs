/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {toEvaluationDataset} from './labels.mjs';

export {reviewQueueFromLabels, toEvaluationDataset, validateConsentLabels} from './labels.mjs';

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function isId(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function metrics(tp, fp, fn) {
    // Undefined metrics remain null rather than reporting a perfect score.
    return {
        truePositives: tp,
        falsePositives: fp,
        falseNegatives: fn,
        precision: tp + fp ? tp / (tp + fp) : null,
        recall: tp + fn ? tp / (tp + fn) : null,
        f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null
    };
}

function validateDataset(dataset) {
    requireValue(dataset?.schemaVersion === 1, 'Expected dataset schemaVersion 1.');
    requireValue(['train', 'development', 'test'].includes(dataset.split), 'Invalid dataset split.');
    requireValue(Array.isArray(dataset.pages) && dataset.pages.length > 0, 'Expected nonempty pages.');

    const labels = new Map();
    for (const page of dataset.pages) {
        requireValue(isId(page?.id) && !labels.has(page.id), 'Page IDs must be unique nonempty strings.');
        requireValue(isId(page.group), `Missing domain/template group: ${page.id}`);
        requireValue(typeof page.hasBanner === 'boolean', `Invalid hasBanner: ${page.id}`);
        requireValue(Array.isArray(page.acceptableRoots) && page.acceptableRoots.every(isId), `Invalid acceptableRoots: ${page.id}`);
        requireValue(new Set(page.acceptableRoots).size === page.acceptableRoots.length, `Duplicate acceptable root: ${page.id}`);
        requireValue(page.exactRoot === undefined || page.exactRoot === null || isId(page.exactRoot), `Invalid exactRoot: ${page.id}`);
        requireValue(page.hasBanner === (page.acceptableRoots.length > 0), `Label and roots disagree: ${page.id}`);
        if (page.hasBanner) {
            requireValue(page.exactRoot === undefined || page.acceptableRoots.includes(page.exactRoot),
                `exactRoot must be acceptable: ${page.id}`);
        } else requireValue(page.exactRoot === undefined || page.exactRoot === null, `Negative labels must not have exactRoot: ${page.id}`);
        labels.set(page.id, page);
    }
    return labels;
}

function normalizeDataset(dataset) {
    return dataset?.schema_version === 1 ? toEvaluationDataset(dataset) : dataset;
}

function groupedDatasets(input) {
    if (Array.isArray(input)) return input;
    if (Array.isArray(input?.splits)) return input.splits;
    if (input?.splits && typeof input.splits === 'object') return Object.values(input.splits);
    return null;
}

function predictionsForSplit(predictions, split) {
    if (Array.isArray(predictions)) return predictions.filter(prediction =>
        prediction.split === undefined || prediction.split === split);
    if (Array.isArray(predictions?.[split])) return predictions[split];
    if (Array.isArray(predictions?.splits?.[split])) return predictions.splits[split];
    return null;
}

/**
 * Score one complete prediction set against human-reviewed root references.
 * Root IDs refer to a specific captured page, not live selectors.
 * @param {object} dataset Versioned labels for one evaluation split.
 * @param {object[]} predictions One {id, roots} record for every labeled page.
 * @returns {object} Detection and page-presence metrics with per-page outcomes.
 */
export function evaluate(dataset, predictions) {
    dataset = normalizeDataset(dataset);
    requireValue(Array.isArray(predictions), 'Expected a predictions array.');

    const labels = validateDataset(dataset);

    const predicted = new Map();
    for (const prediction of predictions) {
        requireValue(labels.has(prediction?.id) && !predicted.has(prediction.id), 'Unknown or duplicate prediction ID.');
        requireValue(Array.isArray(prediction.roots) && prediction.roots.every(isId), `Invalid prediction roots: ${prediction.id}`);
        requireValue(new Set(prediction.roots).size === prediction.roots.length, `Duplicate prediction root: ${prediction.id}`);
        predicted.set(prediction.id, prediction.roots);
    }
    requireValue(predicted.size === labels.size, 'Every page needs a prediction; use roots: [] for no detection.');

    let tp = 0, fp = 0, fn = 0, presenceTp = 0, trueNegatives = 0, extraRoots = 0, exactRoots = 0;
    const outcomes = [];
    for (const page of labels.values()) {
        const roots = predicted.get(page.id);
        const selected = roots[0] ?? null;
        const correct = selected !== null && page.acceptableRoots.includes(selected);
        const exactRoot = page.exactRoot ?? page.acceptableRoots[0] ?? null;
        extraRoots += Math.max(0, roots.length - 1);
        if (correct) tp++;
        if (selected !== null && !correct) fp++;
        if (page.hasBanner && !correct) fn++;
        if (page.hasBanner && selected !== null) presenceTp++;
        if (page.hasBanner && selected === exactRoot) exactRoots++;
        if (!page.hasBanner && selected === null) trueNegatives++;
        outcomes.push({id: page.id, group: page.group, selected, exactRoot, outcome: correct ? 'correct-root' :
            selected !== null ? (page.hasBanner ? 'wrong-root' : 'false-positive') :
            page.hasBanner ? 'missed-banner' : 'true-negative'});
    }
    const positivePages = dataset.pages.filter(page => page.hasBanner).length;
    const negativeDetections = dataset.pages.length - positivePages - trueNegatives;
    return {
        schemaVersion: 1,
        split: dataset.split,
        pages: labels.size,
        groups: new Set(dataset.pages.map(page => page.group)).size,
        positivePages,
        trueNegatives,
        extraRoots,
        exactRootAccuracy: positivePages ? exactRoots / positivePages : null,
        detection: metrics(tp, fp, fn),
        presence: metrics(presenceTp, negativeDetections, positivePages - presenceTp),
        outcomes
    };
}

/**
 * Score multiple splits and reject group overlap across split boundaries.
 * @param {object|object[]} datasets Split datasets or {splits} grouped input.
 * @param {object|object[]} predictions Prediction arrays keyed by split, or flat records with split.
 * @returns {object} Split reports and grouped-split summary.
 */
export function evaluateGroupedSplits(datasets, predictions) {
    const splitInputs = groupedDatasets(datasets);
    requireValue(Array.isArray(splitInputs) && splitInputs.length > 0, 'Expected grouped split datasets.');

    const groups = new Map();
    const reports = {};
    for (const input of splitInputs) {
        const dataset = normalizeDataset(input);
        validateDataset(dataset);
        requireValue(reports[dataset.split] === undefined, `Duplicate split: ${dataset.split}`);
        for (const page of dataset.pages) {
            const owner = groups.get(page.group);
            requireValue(owner === undefined || owner === dataset.split,
                `Group "${page.group}" appears in both ${owner} and ${dataset.split}.`);
            groups.set(page.group, dataset.split);
        }
        const splitPredictions = predictionsForSplit(predictions, dataset.split);
        requireValue(Array.isArray(splitPredictions), `Missing predictions for split: ${dataset.split}`);
        reports[dataset.split] = evaluate(dataset, splitPredictions);
    }

    return {
        schemaVersion: 1,
        splits: reports,
        splitCount: Object.keys(reports).length,
        pages: Object.values(reports).reduce((sum, report) => sum + report.pages, 0),
        groups: groups.size
    };
}

function finiteNumber(value, name) {
    const number = Number(value);
    requireValue(Number.isFinite(number) && number >= 0, `${name} must be a nonnegative number.`);
    return number;
}

function optionalFiniteNumber(value, name) {
    return value === undefined || value === null ? null : finiteNumber(value, name);
}

function bool(value, name) {
    requireValue(typeof value === 'boolean', `${name} must be a boolean.`);
    return value;
}

function compactNumber(value) {
    return value === null || value === undefined ? null : Number(value.toFixed(6));
}

function percentile(values, percentileRank) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function ratio(numerator, denominator) {
    return denominator === 0 ? null : numerator / denominator;
}

function normalizeWorkflowRecord(record, expectedVariant) {
    requireValue(record?.schemaVersion === 1, `Expected ${expectedVariant} workflow schemaVersion 1.`);
    requireValue(record.variant === expectedVariant, `Expected ${expectedVariant} workflow record.`);
    requireValue(isId(record.caseId), `Missing ${expectedVariant} caseId.`);
    const metrics = record.metrics ?? {};
    const fixedAgent = record.fixedAgent ?? {};
    requireValue(isId(fixedAgent.model), `Missing ${expectedVariant} fixedAgent.model: ${record.caseId}`);
    requireValue(isId(fixedAgent.promptHash), `Missing ${expectedVariant} fixedAgent.promptHash: ${record.caseId}`);
    requireValue(isId(fixedAgent.actionPolicyHash),
        `Missing ${expectedVariant} fixedAgent.actionPolicyHash: ${record.caseId}`);

    return {
        caseId: record.caseId,
        variant: expectedVariant,
        fixedAgent,
        completed: bool(metrics.taskCompleted, `metrics.taskCompleted: ${record.caseId}`),
        modelCalls: finiteNumber(metrics.modelCalls ?? 0, `metrics.modelCalls: ${record.caseId}`),
        totalCostUsd: finiteNumber(metrics.totalWorkflowCostUsd ?? metrics.totalCostUsd ?? 0,
            `metrics.totalWorkflowCostUsd: ${record.caseId}`),
        browserMs: optionalFiniteNumber(metrics.browserMs, `metrics.browserMs: ${record.caseId}`),
        workflowMs: optionalFiniteNumber(metrics.workflowMs, `metrics.workflowMs: ${record.caseId}`),
        addedLatencyMs: optionalFiniteNumber(metrics.addedLatencyMs, `metrics.addedLatencyMs: ${record.caseId}`),
        detectionMs: optionalFiniteNumber(metrics.detectionMs, `metrics.detectionMs: ${record.caseId}`),
        metadata: record.workflow?.metadata ?? record.metadata ?? {}
    };
}

function recordsByCase(records, expectedVariant) {
    requireValue(Array.isArray(records) && records.length > 0, `Expected nonempty ${expectedVariant} records.`);
    const byCase = new Map();
    for (const record of records.map(item => normalizeWorkflowRecord(item, expectedVariant))) {
        requireValue(!byCase.has(record.caseId), `Duplicate ${expectedVariant} caseId: ${record.caseId}`);
        byCase.set(record.caseId, record);
    }
    return byCase;
}

function summarizeWorkflow(records) {
    const completed = records.filter(record => record.completed).length;
    const totalCostUsd = records.reduce((sum, record) => sum + record.totalCostUsd, 0);
    const modelCalls = records.reduce((sum, record) => sum + record.modelCalls, 0);
    const browserValues = records.map(record => record.browserMs).filter(value => value !== null);
    const workflowValues = records.map(record => record.workflowMs).filter(value => value !== null);
    const addedValues = records.map(record => record.addedLatencyMs).filter(value => value !== null);
    const detectionValues = records.map(record => record.detectionMs).filter(value => value !== null);
    return {
        cases: records.length,
        successfulCompletions: completed,
        completionRate: compactNumber(completed / records.length),
        totalWorkflowCostUsd: compactNumber(totalCostUsd),
        costPerCompletedTaskUsd: compactNumber(ratio(totalCostUsd, completed)),
        totalModelCalls: compactNumber(modelCalls),
        modelCallsPerCompletedTask: compactNumber(ratio(modelCalls, completed)),
        browserMs: {
            sampleCount: browserValues.length,
            p95: compactNumber(percentile(browserValues, 95))
        },
        workflowMs: {
            sampleCount: workflowValues.length,
            p95: compactNumber(percentile(workflowValues, 95))
        },
        addedLatencyMs: {
            sampleCount: addedValues.length,
            p95: compactNumber(percentile(addedValues, 95))
        },
        detectionMs: {
            sampleCount: detectionValues.length,
            p95: compactNumber(percentile(detectionValues, 95))
        }
    };
}

function costPerCompleted(records) {
    const completed = records.filter(record => record.completed).length;
    return ratio(records.reduce((sum, record) => sum + record.totalCostUsd, 0), completed);
}

function completionRate(records) {
    return records.filter(record => record.completed).length / records.length;
}

function bootstrapInterval(pairs, measure, iterations, seed) {
    const random = seededRandom(seed);
    const values = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
        const sample = [];
        for (let index = 0; index < pairs.length; index++) {
            sample.push(pairs[Math.floor(random() * pairs.length)]);
        }
        const value = measure(sample);
        if (value !== null) values.push(value);
    }
    values.sort((a, b) => a - b);
    if (values.length === 0) return null;
    const low = values[Math.floor(0.05 * (values.length - 1))];
    const high = values[Math.ceil(0.95 * (values.length - 1))];
    return {level: 0.9, low: compactNumber(low), high: compactNumber(high)};
}

function failureSlices(records) {
    const slices = {};
    for (const record of records) {
        if (record.completed) continue;
        const reason = isId(record.metadata.failureSlice) ? record.metadata.failureSlice :
            isId(record.metadata.failureReason) ? record.metadata.failureReason : 'unspecified';
        slices[reason] = (slices[reason] ?? 0) + 1;
    }
    return slices;
}

function decisionStatus(condition, known = true) {
    if (!known) return 'unknown';
    return condition ? 'pass' : 'fail';
}

function normalizeComparisonInput(input) {
    const value = Array.isArray(input) ? {baseline: input.filter(record => record.variant === 'baseline'),
        smelt: input.filter(record => record.variant === 'smelt-assisted')} : input;
    requireValue(value && typeof value === 'object', 'Expected a workflow comparison object.');
    return value;
}

/**
 * Compare matched Steel workflow cases with and without Smelt.
 * @param {object|object[]} input Matched baseline and Smelt-assisted records.
 * @param {object} [options] Bootstrap options.
 * @returns {object} Workflow comparison metrics, uncertainty, and gate results.
 */
export function compareWorkflows(input, options = {}) {
    const value = normalizeComparisonInput(input);
    const baselineByCase = recordsByCase(value.baseline, 'baseline');
    const smeltByCase = recordsByCase(value.smelt, 'smelt-assisted');
    requireValue(baselineByCase.size === smeltByCase.size, 'Baseline and Smelt records must have the same case count.');

    const pairs = [];
    for (const [caseId, baseline] of baselineByCase) {
        const smelt = smeltByCase.get(caseId);
        requireValue(smelt !== undefined, `Missing Smelt record for case: ${caseId}`);
        requireValue(baseline.fixedAgent.model === smelt.fixedAgent.model &&
            baseline.fixedAgent.promptHash === smelt.fixedAgent.promptHash &&
            baseline.fixedAgent.actionPolicyHash === smelt.fixedAgent.actionPolicyHash,
        `Fixed agent differs for case: ${caseId}`);
        pairs.push({caseId, baseline, smelt});
    }
    for (const caseId of smeltByCase.keys()) {
        requireValue(baselineByCase.has(caseId), `Missing baseline record for case: ${caseId}`);
    }

    const baselineRecords = pairs.map(pair => pair.baseline);
    const smeltRecords = pairs.map(pair => pair.smelt);
    const baselineSummary = summarizeWorkflow(baselineRecords);
    const smeltSummary = summarizeWorkflow(smeltRecords);
    const baselineCost = costPerCompleted(baselineRecords);
    const smeltCost = costPerCompleted(smeltRecords);
    const costChangeRatio = baselineCost === null || smeltCost === null ? null : smeltCost / baselineCost - 1;
    const completionRateChange = completionRate(smeltRecords) - completionRate(baselineRecords);
    const baselineWorkflowP95 = baselineSummary.workflowMs.p95;
    const addedLatencyP95 = smeltSummary.addedLatencyMs.p95;
    const iterations = options.bootstrapIterations ?? 2000;
    const seed = options.seed ?? 0x5e17;

    const costChangeCi = bootstrapInterval(pairs, sample => {
        const base = costPerCompleted(sample.map(pair => pair.baseline));
        const assisted = costPerCompleted(sample.map(pair => pair.smelt));
        return base === null || assisted === null ? null : assisted / base - 1;
    }, iterations, seed);
    const completionRateChangeCi = bootstrapInterval(pairs, sample =>
        completionRate(sample.map(pair => pair.smelt)) -
        completionRate(sample.map(pair => pair.baseline)), iterations, seed ^ 0x9e3779b9);

    const costGateNeeded = baselineSummary.completionRate >= 0.5;
    const latencyRatio = baselineWorkflowP95 === null || addedLatencyP95 === null ? null :
        addedLatencyP95 / baselineWorkflowP95;
    const gates = {
        primary: costGateNeeded ? {
            metric: 'cost_per_completed_task',
            status: decisionStatus(costChangeRatio <= -0.1 && costChangeCi?.high <= 0,
                costChangeRatio !== null && costChangeCi !== null),
            observedChangeRatio: compactNumber(costChangeRatio),
            minimumImprovementRatio: -0.1,
            confidenceInterval: costChangeCi
        } : {
            metric: 'completion_rate',
            status: decisionStatus(completionRateChange >= 0.05),
            observedChange: compactNumber(completionRateChange),
            minimumImprovement: 0.05,
            confidenceInterval: completionRateChangeCi
        },
        completionRegression: {
            status: decisionStatus(completionRateChange >= -0.02),
            observedChange: compactNumber(completionRateChange),
            maximumRegression: -0.02,
            confidenceInterval: completionRateChangeCi
        },
        latencyRegression: {
            status: decisionStatus(addedLatencyP95 < 250 && latencyRatio < 0.05,
                addedLatencyP95 !== null && latencyRatio !== null),
            addedLatencyP95Ms: addedLatencyP95,
            baselineWorkflowP95Ms: baselineWorkflowP95,
            addedLatencyToBaselineRatio: compactNumber(latencyRatio),
            maximumAddedLatencyP95Ms: 250,
            maximumBaselineRatio: 0.05
        }
    };

    return {
        schemaVersion: 1,
        matchedCases: pairs.length,
        bootstrap: {iterations, seed, confidenceLevel: 0.9},
        baseline: baselineSummary,
        smelt: smeltSummary,
        deltas: {
            costPerCompletedTaskRatio: compactNumber(costChangeRatio),
            completionRate: compactNumber(completionRateChange),
            modelCallsPerCompletedTask: compactNumber(
                smeltSummary.modelCallsPerCompletedTask === null ||
                baselineSummary.modelCallsPerCompletedTask === null ? null :
                    smeltSummary.modelCallsPerCompletedTask - baselineSummary.modelCallsPerCompletedTask),
            workflowP95Ms: compactNumber(
                smeltSummary.workflowMs.p95 === null || baselineWorkflowP95 === null ? null :
                    smeltSummary.workflowMs.p95 - baselineWorkflowP95)
        },
        uncertainty: {
            costPerCompletedTaskRatio: costChangeCi,
            completionRate: completionRateChangeCi
        },
        gates,
        failureSlices: {
            baseline: failureSlices(baselineRecords),
            smelt: failureSlices(smeltRecords)
        }
    };
}
