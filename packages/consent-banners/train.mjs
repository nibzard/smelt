/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

import {runFrozenSnapshot} from '@smelt-oss/capture/replay';
import {evaluate} from '@smelt-oss/pilot';
import {type} from '@smelt-oss/runtime';
import {createModelArtifact, readModelArtifact, rulesHash, scorePackedForest} from './model.mjs';
import {
    CANDIDATE_TYPE,
    RULE_NAMES,
    consentRules,
    vectorForConsentCandidate
} from './rules.mjs';

const BASELINE_NAMES = Object.freeze(['rules', 'linear', 'lightgbm']);
function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function now() {
    return performance.now();
}

function sigmoid(value) {
    return 1 / (1 + Math.exp(-value));
}

function compactNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function isoNow() {
    return new Date().toISOString();
}

function rowKey(row) {
    return `${row.pageId}:${row.elementId}`;
}

function validateDataset(dataset, split) {
    requireValue(dataset?.schemaVersion === 1, `Expected ${split} labels schemaVersion 1.`);
    requireValue(dataset.split === split, `Expected ${split} labels.`);
    requireValue(Array.isArray(dataset.pages) && dataset.pages.length > 0,
        `Expected nonempty ${split} pages.`);
    const pages = new Map();
    for (const page of dataset.pages) {
        requireValue(typeof page.id === 'string' && page.id.length > 0,
            `Invalid page id in ${split}.`);
        requireValue(!pages.has(page.id), `Duplicate page id: ${page.id}`);
        requireValue(typeof page.hasBanner === 'boolean', `Invalid hasBanner: ${page.id}`);
        requireValue(Array.isArray(page.acceptableRoots), `Invalid acceptableRoots: ${page.id}`);
        pages.set(page.id, page);
    }
    return pages;
}

function validateCaptures(captures, split) {
    requireValue(Array.isArray(captures) && captures.length > 0,
        `Expected nonempty ${split} captures.`);
    const byId = new Map();
    for (const capture of captures) {
        requireValue(typeof capture?.id === 'string' && capture.id.length > 0,
            `Invalid capture id in ${split}.`);
        requireValue(!byId.has(capture.id), `Duplicate capture id: ${capture.id}`);
        requireValue(capture.snapshot?.schemaVersion === 1, `Invalid snapshot: ${capture.id}`);
        requireValue(capture.features?.schemaVersion === 1, `Invalid features: ${capture.id}`);
        byId.set(capture.id, capture);
    }
    return byId;
}

function rootPredictionRows(rows, scores, threshold) {
    const bestByPage = new Map();
    for (const row of rows) {
        const score = scores.get(rowKey(row)) ?? -Infinity;
        const current = bestByPage.get(row.pageId);
        if (current === undefined ||
            score > current.score ||
            (score === current.score && row.elementId < current.elementId)) {
            bestByPage.set(row.pageId, {elementId: row.elementId, score});
        }
    }
    return bestByPage;
}

function predictionsFor(dataset, rows, scores, threshold) {
    const bestByPage = rootPredictionRows(rows, scores, threshold);
    return dataset.pages.map(page => {
        const best = bestByPage.get(page.id);
        return {
            id: page.id,
            roots: best !== undefined && best.score >= threshold ? [best.elementId] : []
        };
    });
}

function evaluateScores(dataset, rows, scores, threshold) {
    const report = evaluate(dataset, predictionsFor(dataset, rows, scores, threshold));
    return {
        detectionF1: compactNumber(report.detection.f1),
        precision: compactNumber(report.detection.precision),
        recall: compactNumber(report.detection.recall),
        pagePresenceF1: compactNumber(report.presence.f1),
        exactRootAccuracy: compactNumber(report.exactRootAccuracy),
        extraRoots: report.extraRoots,
        pages: report.pages,
        groups: report.groups
    };
}

function candidateLabel(page, elementId) {
    return page.acceptableRoots.includes(elementId) ? 1 : 0;
}

function vectorizeSplit(dataset, captures) {
    const labels = validateDataset(dataset, dataset.split);
    const captureById = validateCaptures(captures, dataset.split);
    requireValue(captureById.size === labels.size,
        `Capture count does not match ${dataset.split} label count.`);

    const rows = [];
    let vectorizeMs = 0;
    let ruleRunMs = 0;
    let truncatedPages = 0;
    for (const page of labels.values()) {
        const capture = captureById.get(page.id);
        requireValue(capture !== undefined, `Missing capture for page: ${page.id}`);
        const start = now();
        const replay = runFrozenSnapshot(consentRules(), capture.snapshot, capture.features);
        vectorizeMs += now() - start;
        ruleRunMs += replay.run.stats.ms;
        if (replay.run.stats.truncated) truncatedPages++;
        const candidates = replay.run.get(type(CANDIDATE_TYPE));
        for (const fnode of candidates) {
            const elementId = [...replay.elementsById.entries()]
                .find(([, element]) => element === fnode.element)?.[0];
            requireValue(elementId !== undefined, `Candidate element was not in snapshot: ${page.id}`);
            const vector = vectorForConsentCandidate(fnode);
            rows.push({
                split: dataset.split,
                pageId: page.id,
                group: page.group,
                elementId,
                label: candidateLabel(page, elementId),
                vector
            });
        }
    }
    requireValue(rows.length > 0, `No candidate rows in ${dataset.split} split.`);
    return {
        rows,
        stats: {
            pages: labels.size,
            candidates: rows.length,
            truncatedPages,
            vectorizeMs: compactNumber(vectorizeMs),
            ruleRunMs: compactNumber(ruleRunMs)
        }
    };
}

function scoreRules(rows) {
    const scores = new Map();
    for (const row of rows) {
        scores.set(rowKey(row), RULE_NAMES.reduce((sum, name) => sum + row.vector[name], 0));
    }
    return scores;
}

function thresholdsFrom(scores, rows) {
    const values = [...new Set(rows.map(row => scores.get(rowKey(row)) ?? 0))]
        .sort((a, b) => a - b);
    return [values[0] - 1, ...values, values[values.length - 1] + 1];
}

function selectThreshold(dataset, rows, scores) {
    let best = {threshold: 0, f1: -1};
    for (const threshold of thresholdsFrom(scores, rows)) {
        const report = evaluate(dataset, predictionsFor(dataset, rows, scores, threshold));
        const f1 = report.detection.f1 ?? -1;
        if (f1 > best.f1 || (f1 === best.f1 && threshold > best.threshold)) {
            best = {threshold, f1};
        }
    }
    return best.threshold;
}

function matrix(rows) {
    return rows.map(row => RULE_NAMES.map(name => Number(row.vector[name] ?? 0)));
}

function trainLinear(rows, options = {}) {
    const start = now();
    const x = matrix(rows);
    const y = rows.map(row => row.label);
    const weights = Array(RULE_NAMES.length).fill(0);
    let bias = 0;
    const iterations = options.iterations ?? 500;
    const learningRate = options.learningRate ?? 0.05;
    const l2 = options.l2 ?? 0.001;

    for (let step = 0; step < iterations; step++) {
        const gradients = Array(weights.length).fill(0);
        let biasGradient = 0;
        for (let i = 0; i < x.length; i++) {
            const z = bias + weights.reduce((sum, weight, j) => sum + weight * x[i][j], 0);
            const error = sigmoid(z) - y[i];
            biasGradient += error;
            for (let j = 0; j < weights.length; j++) gradients[j] += error * x[i][j];
        }
        bias -= learningRate * biasGradient / x.length;
        for (let j = 0; j < weights.length; j++) {
            const gradient = gradients[j] / x.length + l2 * weights[j];
            weights[j] -= learningRate * gradient;
        }
    }
    return {
        model: {bias, weights},
        trainMs: compactNumber(now() - start)
    };
}

function scoreLinear(rows, model) {
    const scores = new Map();
    for (const row of rows) {
        const x = RULE_NAMES.map(name => Number(row.vector[name] ?? 0));
        const z = model.bias + model.weights.reduce((sum, weight, i) => sum + weight * x[i], 0);
        scores.set(rowKey(row), sigmoid(z));
    }
    return scores;
}

function scoreArtifact(rows, artifact) {
    const {decodedForest} = readModelArtifact(artifact);
    const scores = new Map();
    for (const row of rows) {
        scores.set(rowKey(row), scorePackedForest(decodedForest, row.vector));
    }
    return scores;
}

function agreementReport(expectedScores, actualScores, rows, threshold = 0.5) {
    let matches = 0;
    let maxProbabilityDelta = 0;
    for (const row of rows) {
        const key = rowKey(row);
        const expected = expectedScores.get(key);
        const actual = actualScores.get(key);
        if ((expected >= threshold) === (actual >= threshold)) matches++;
        maxProbabilityDelta = Math.max(maxProbabilityDelta, Math.abs(expected - actual));
    }
    return {
        threshold,
        rows: rows.length,
        signAgreement: compactNumber(matches / rows.length),
        maxProbabilityDelta: compactNumber(maxProbabilityDelta)
    };
}

function lightgbmScript() {
    return String.raw`
import json
import sys
import lightgbm as lgb
import numpy as np

payload = json.load(sys.stdin)
params = {
    "objective": "binary",
    "metric": "binary_logloss",
    "num_leaves": 15,
    "max_depth": 5,
    "learning_rate": 0.08,
    "num_threads": 1,
    "verbosity": -1,
    "seed": 7,
    "feature_fraction_seed": 7,
    "bagging_seed": 7,
    "data_random_seed": 7,
    "deterministic": True,
    "force_col_wise": True,
}
train_x = np.asarray(payload["trainX"], dtype=np.float32)
train_y = np.asarray(payload["trainY"], dtype=np.float32)
predict_x = np.asarray(payload["predictX"], dtype=np.float32)
dataset = lgb.Dataset(train_x, label=train_y, feature_name=payload["featureNames"])
booster = lgb.train(params, dataset, num_boost_round=40)
predictions = booster.predict(predict_x).tolist()
print(json.dumps({"predictions": predictions, "model": booster.dump_model()}))
`;
}

function trainLightGbm(trainRows, predictRows) {
    const start = now();
    // Windows virtual environments expose python.exe, not python3.
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawnSync(python, ['-c', lightgbmScript()], {
        input: JSON.stringify({
            featureNames: RULE_NAMES,
            trainX: matrix(trainRows),
            trainY: trainRows.map(row => row.label),
            predictX: matrix(predictRows)
        }),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 20
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
        throw new Error(`LightGBM training failed: ${child.stderr.trim()}`);
    }
    const output = JSON.parse(child.stdout);
    const scores = new Map();
    predictRows.forEach((row, index) => scores.set(rowKey(row), output.predictions[index]));
    return {
        scores,
        model: output.model,
        trainMs: compactNumber(now() - start)
    };
}

function baselineReport(name, dataset, developmentRows, developmentScores, trainMs, scoreMs) {
    const threshold = selectThreshold(dataset.development, developmentRows, developmentScores);
    return {
        name,
        threshold: compactNumber(threshold),
        accuracy: evaluateScores(dataset.development, developmentRows, developmentScores, threshold),
        effort: {
            humanHours: name === 'rules' ? dataset.humanEffortHours : 0,
            machineTrainingMs: trainMs
        },
        cost: {
            teacherUsd: compactNumber(dataset.costs.teacherUsd ?? 0),
            humanReviewUsd: compactNumber(dataset.costs.humanReviewUsd ?? 0),
            trainingUsd: 0,
            browserUsd: compactNumber(dataset.costs.browserUsd ?? 0)
        },
        latency: {
            vectorizeMs: dataset.developmentStats.vectorizeMs,
            scoreMs: compactNumber(scoreMs)
        }
    };
}

function assertTrainable(rows, name) {
    const labels = new Set(rows.map(row => row.label));
    requireValue(labels.has(0) && labels.has(1), `${name} needs positive and negative candidate rows.`);
}

/**
 * Train and compare consent-banner baselines on the same development data.
 *
 * @param {object} input Training manifest with train and development splits.
 * @returns {object} A JSON-stable comparison report.
 */
export function trainConsentBaselines(input) {
    requireValue(input?.schemaVersion === 1, 'Expected training manifest schemaVersion 1.');
    requireValue(input.train?.labels && input.development?.labels,
        'Expected train and development labels.');
    requireValue(input.train?.captures && input.development?.captures,
        'Expected train and development captures.');

    const train = vectorizeSplit(input.train.labels, input.train.captures);
    const development = vectorizeSplit(input.development.labels, input.development.captures);
    assertTrainable(train.rows, 'Linear and LightGBM training');
    const dataset = {
        development: input.development.labels,
        costs: input.costs ?? {},
        humanEffortHours: Number(input.humanEffortHours ?? 0),
        developmentStats: development.stats
    };

    const reports = [];
    let start = now();
    const developmentRuleScores = scoreRules(development.rows);
    reports.push(baselineReport('rules', dataset, development.rows,
        developmentRuleScores, 0, now() - start));

    const linear = trainLinear(train.rows, input.linear);
    start = now();
    const developmentLinearScores = scoreLinear(development.rows, linear.model);
    reports.push(baselineReport('linear', dataset, development.rows,
        developmentLinearScores, linear.trainMs, now() - start));

    const treeRows = [...train.rows, ...development.rows];
    const tree = trainLightGbm(train.rows, treeRows);
    const treeDevelopmentScores = new Map(development.rows.map(row => [rowKey(row), tree.scores.get(rowKey(row))]));
    const treeReport = baselineReport('lightgbm', dataset, development.rows,
        treeDevelopmentScores, tree.trainMs, 0);
    reports.push(treeReport);
    const modelArtifact = createModelArtifact({
        lightGbmModel: tree.model,
        featureNames: RULE_NAMES,
        modelVersion: input.modelVersion ?? '0.0.0',
        trainedAt: input.trainedAt ?? isoNow(),
        corpus: input.corpus,
        rulesHash: input.rulesHash ?? rulesHash(readFileSync(new URL('./rules.mjs', import.meta.url), 'utf8')),
        calibration: {
            method: 'development-threshold',
            threshold: treeReport.threshold,
            score: 'probability'
        }
    });
    const artifactScores = scoreArtifact(treeRows, modelArtifact);

    return {
        schemaVersion: 1,
        task: 'consent-banners',
        featureNames: RULE_NAMES,
        modelArtifact,
        modelArtifactChecks: {
            lightgbm: agreementReport(tree.scores, artifactScores, treeRows)
        },
        baselines: reports.filter(report => BASELINE_NAMES.includes(report.name)),
        splits: {
            train: train.stats,
            development: development.stats
        }
    };
}
