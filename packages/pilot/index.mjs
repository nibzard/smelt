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

/**
 * Score one complete prediction set against human-reviewed root references.
 * Root IDs refer to a specific captured page, not live selectors.
 * @param {object} dataset Versioned labels for one evaluation split.
 * @param {object[]} predictions One {id, roots} record for every labeled page.
 * @returns {object} Detection and page-presence metrics with per-page outcomes.
 */
export function evaluate(dataset, predictions) {
    if (dataset?.schema_version === 1) dataset = toEvaluationDataset(dataset);
    requireValue(dataset?.schemaVersion === 1, 'Expected dataset schemaVersion 1.');
    requireValue(['train', 'development', 'test'].includes(dataset.split), 'Invalid dataset split.');
    requireValue(Array.isArray(dataset.pages) && dataset.pages.length > 0, 'Expected nonempty pages.');
    requireValue(Array.isArray(predictions), 'Expected a predictions array.');

    const labels = new Map();
    for (const page of dataset.pages) {
        requireValue(isId(page?.id) && !labels.has(page.id), 'Page IDs must be unique nonempty strings.');
        requireValue(isId(page.group), `Missing domain/template group: ${page.id}`);
        requireValue(typeof page.hasBanner === 'boolean', `Invalid hasBanner: ${page.id}`);
        requireValue(Array.isArray(page.acceptableRoots) && page.acceptableRoots.every(isId), `Invalid acceptableRoots: ${page.id}`);
        requireValue(new Set(page.acceptableRoots).size === page.acceptableRoots.length, `Duplicate acceptable root: ${page.id}`);
        requireValue(page.hasBanner === (page.acceptableRoots.length > 0), `Label and roots disagree: ${page.id}`);
        labels.set(page.id, page);
    }

    const predicted = new Map();
    for (const prediction of predictions) {
        requireValue(labels.has(prediction?.id) && !predicted.has(prediction.id), 'Unknown or duplicate prediction ID.');
        requireValue(Array.isArray(prediction.roots) && prediction.roots.every(isId), `Invalid prediction roots: ${prediction.id}`);
        requireValue(new Set(prediction.roots).size === prediction.roots.length, `Duplicate prediction root: ${prediction.id}`);
        predicted.set(prediction.id, prediction.roots);
    }
    requireValue(predicted.size === labels.size, 'Every page needs a prediction; use roots: [] for no detection.');

    let tp = 0, fp = 0, fn = 0, presenceTp = 0, trueNegatives = 0, extraRoots = 0;
    const outcomes = [];
    for (const page of labels.values()) {
        const roots = predicted.get(page.id);
        const selected = roots[0] ?? null;
        const correct = selected !== null && page.acceptableRoots.includes(selected);
        extraRoots += Math.max(0, roots.length - 1);
        if (correct) tp++;
        if (selected !== null && !correct) fp++;
        if (page.hasBanner && !correct) fn++;
        if (page.hasBanner && selected !== null) presenceTp++;
        if (!page.hasBanner && selected === null) trueNegatives++;
        outcomes.push({id: page.id, selected, outcome: correct ? 'correct-root' :
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
        detection: metrics(tp, fp, fn),
        presence: metrics(presenceTp, negativeDetections, positivePages - presenceTp),
        outcomes
    };
}
