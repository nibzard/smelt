/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    createModelArtifact,
    packForestFromLightGbm,
    readModelArtifact,
    rulesHash,
    scorePackedForest
} from '../model.mjs';

const featureNames = Object.freeze(['a', 'b']);

const lightGbmModel = Object.freeze({
    tree_info: [
        {
            tree_structure: {
                split_feature: 0,
                threshold: 1,
                decision_type: '<=',
                left_child: {leaf_value: -2},
                right_child: {leaf_value: 2}
            }
        },
        {
            tree_structure: {
                split_feature: 1,
                threshold: -1,
                decision_type: '<=',
                left_child: {leaf_value: -0.5},
                right_child: {leaf_value: 0.5}
            }
        }
    ]
});

test('packs and reads the LightGBM forest with stable metadata', () => {
    const artifact = createModelArtifact({
        lightGbmModel,
        featureNames,
        modelVersion: '0.1.0',
        task: 'consent-banners',
        trainedAt: '2026-09-07T23:55:00Z',
        corpus: {id: 'synthetic', revision: 'fixture'},
        rulesHash: rulesHash('rules fixture'),
        calibration: {method: 'development-threshold', threshold: 0.6, score: 'probability'}
    });

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.abi, 'smelt-model-v1');
    assert.equal(artifact.forest.byteOrder, 'little-endian');
    assert.equal(artifact.forest.alignmentBytes, 4);
    assert.deepEqual(artifact.featureNames, featureNames);

    const read = readModelArtifact(JSON.stringify(artifact));
    assert.equal(read.decodedForest.treeCount, 2);
    assert.equal(read.decodedForest.nodeCount, 6);
    assert.deepEqual(read.decodedForest.roots, [0, 3]);
});

test('scores a packed forest after round trip', () => {
    const artifact = createModelArtifact({
        packedForest: packForestFromLightGbm(lightGbmModel, featureNames),
        featureNames,
        trainedAt: '2026-09-07T23:55:00Z',
        rulesHash: rulesHash('rules fixture')
    });
    const read = readModelArtifact(artifact);

    const negative = scorePackedForest(read.decodedForest, {a: 0, b: -2});
    const positive = scorePackedForest(read.decodedForest, {a: 2, b: 0});

    assert.ok(negative < 0.1);
    assert.ok(positive > 0.9);
});

test('rejects malformed packed forest data', () => {
    assert.throws(() => readModelArtifact({
        schemaVersion: 1,
        abi: 'smelt-model-v1',
        featureNames,
        forest: {
            encoding: 'base64',
            byteOrder: 'little-endian',
            packed: Buffer.from('bad').toString('base64')
        }
    }), /too short/);
});
