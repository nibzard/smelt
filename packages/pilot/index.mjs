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
