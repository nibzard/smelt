/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {readModelArtifact, scoreCandidates, scorePackedForest} from '../index.mjs';
import {staticDom} from './helpers.mjs';

const packed = 'U01GMQIABgAAAAMAAP//Af//ADwAAAAAALwAAAAAAQD/////BAD/////AgD/////BQD/////AAAAAAAAAAAAwAAAAEAAAAAAAAAAvwAAAD8=';
const artifact = Object.freeze({
    schemaVersion: 1,
    abi: 'smelt-model-v1',
    featureNames: ['a', 'b'],
    calibration: {method: 'development-threshold', threshold: 0.6, score: 'probability'},
    forest: {
        encoding: 'base64',
        byteOrder: 'little-endian',
        alignmentBytes: 4,
        nodeLayout: ['featureIndex:u8', 'threshold:f16', 'left:u16', 'right:u16', 'leafValue:f32'],
        leafFeatureIndex: 255,
        packed
    }
});

test('reads and scores packed model artifacts', () => {
    const model = readModelArtifact(JSON.stringify(artifact));
    assert.equal(model.decodedForest.treeCount, 2);
    assert.equal(model.decodedForest.nodeCount, 6);
    assert.ok(scorePackedForest(model.decodedForest, {a: 0, b: -2}) < 0.1);
    assert.ok(scorePackedForest(model.decodedForest, {a: 2, b: 0}) > 0.9);
});

test('scores candidates with calibration and smaller-root tie-breaks', () => {
    const doc = staticDom('<main><section id="large"><button></button></section><section id="small"></section></main>');
    const large = doc.querySelector('#large');
    const small = doc.querySelector('#small');
    const model = readModelArtifact(artifact);
    const result = scoreCandidates(model, [
        {element: large, vector: {a: 2, b: 0}},
        {element: small, vector: {a: 2, b: 0}}
    ]);

    assert.equal(result.best.element, small);
    assert.equal(result.threshold, 0.6);
    assert.equal(result.scored.length, 2);
    assert.equal(result.stats.candidates, 2);
    assert.equal(typeof result.stats.ms, 'number');
});

test('returns no best candidate below the calibrated threshold', () => {
    const result = scoreCandidates(artifact, [{vector: {a: 0, b: -2}}]);
    assert.equal(result.best, null);
});
