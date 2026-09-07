/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {sigmoid} from './utils.mjs';

export const MODEL_ARTIFACT_SCHEMA_VERSION = 1;
export const MODEL_ABI = 'smelt-model-v1';

const MAGIC = [0x53, 0x4d, 0x46, 0x31];
const HEADER_BYTES = 8;
const LEAF_SENTINEL = 255;

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function align(value, boundary) {
    return Math.ceil(value / boundary) * boundary;
}

function halfToFloat(value) {
    const sign = (value & 0x8000) ? -1 : 1;
    const exponent = (value >>> 10) & 0x1f;
    const mantissa = value & 0x03ff;
    if (exponent === 0) return mantissa === 0 ? sign * 0 : sign * 2 ** -14 * (mantissa / 1024);
    if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

function bytesFromBase64(value) {
    if (typeof atob === 'function') {
        return Uint8Array.from(atob(value), char => char.charCodeAt(0));
    }
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(value, 'base64'));
    }
    throw new TypeError('No base64 decoder is available.');
}

function readUint16Array(view, offset, length) {
    return Array.from({length}, (_, index) => view.getUint16(offset + index * 2, true));
}

function readFloat32Array(view, offset, length) {
    return Array.from({length}, (_, index) => view.getFloat32(offset + index * 4, true));
}

function packedOffsets(treeCount, nodeCount) {
    const roots = HEADER_BYTES;
    const features = align(roots + treeCount * 2, 4);
    const thresholds = align(features + nodeCount, 2);
    const left = thresholds + nodeCount * 2;
    const right = left + nodeCount * 2;
    const leaves = align(right + nodeCount * 2, 4);
    return {roots, features, thresholds, left, right, leaves, bytes: leaves + nodeCount * 4};
}

function now() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function') ?
        performance.now() :
        Date.now();
}

function defaultRootSize(candidate) {
    const root = candidate?.element ?? candidate?.root ?? candidate;
    return root?.querySelectorAll === undefined ? 0 : root.querySelectorAll('*').length + 1;
}

function compareDocumentOrder(a, b) {
    const left = a?.element ?? a?.root ?? a;
    const right = b?.element ?? b?.root ?? b;
    if (left?.compareDocumentPosition === undefined || right === undefined) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & left.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & left.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
}

/** Decode the packed forest column from a model artifact. */
export function unpackForest(packedForest) {
    requireValue(typeof packedForest === 'string' && packedForest.length > 0,
        'Expected packedForest base64 string.');
    const bytes = bytesFromBase64(packedForest);
    requireValue(bytes.length >= HEADER_BYTES, 'Packed forest is too short.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    MAGIC.forEach((byte, index) => requireValue(view.getUint8(index) === byte,
        'Packed forest magic does not match.'));
    const treeCount = view.getUint16(4, true);
    const nodeCount = view.getUint16(6, true);
    const offsets = packedOffsets(treeCount, nodeCount);
    requireValue(bytes.length === offsets.bytes, 'Packed forest length does not match header.');
    return {
        treeCount,
        nodeCount,
        roots: readUint16Array(view, offsets.roots, treeCount),
        featureIndex: Array.from(bytes.slice(offsets.features, offsets.features + nodeCount)),
        threshold: readUint16Array(view, offsets.thresholds, nodeCount).map(halfToFloat),
        left: readUint16Array(view, offsets.left, nodeCount),
        right: readUint16Array(view, offsets.right, nodeCount),
        leafValue: readFloat32Array(view, offsets.leaves, nodeCount)
    };
}

/** Read and validate a model.smelt.json artifact for runtime scoring. */
export function readModelArtifact(input) {
    const artifact = typeof input === 'string' ? JSON.parse(input) : input;
    requireValue(artifact?.schemaVersion === MODEL_ARTIFACT_SCHEMA_VERSION,
        'Expected model artifact schemaVersion 1.');
    requireValue(artifact.abi === MODEL_ABI, `Expected model ABI ${MODEL_ABI}.`);
    requireValue(Array.isArray(artifact.featureNames) && artifact.featureNames.length > 0,
        'Expected nonempty featureNames.');
    requireValue(artifact.forest?.encoding === 'base64', 'Expected base64 forest encoding.');
    requireValue(artifact.forest?.byteOrder === 'little-endian', 'Expected little-endian forest.');
    const decodedForest = unpackForest(artifact.forest.packed);
    decodedForest.featureNames = artifact.featureNames;
    return {...artifact, decodedForest};
}

/** Score one feature vector with a decoded forest. */
export function scorePackedForest(forest, vector) {
    const values = Array.isArray(vector) ? vector : forest.featureNames.map(name => Number(vector[name] ?? 0));
    let score = 0;
    for (const root of forest.roots) {
        let node = root;
        while (forest.featureIndex[node] !== LEAF_SENTINEL) {
            const featureValue = Number(values[forest.featureIndex[node]] ?? 0);
            node = featureValue <= forest.threshold[node] ? forest.left[node] : forest.right[node];
        }
        score += forest.leafValue[node];
    }
    return sigmoid(score);
}

/** Score candidates, apply the calibrated threshold, and choose one root. */
export function scoreCandidates(model, candidates, vectorForCandidate, options = {}) {
    const artifact = model.decodedForest === undefined ? readModelArtifact(model) : model;
    const forest = artifact.decodedForest;
    const threshold = Number(options.threshold ?? artifact.calibration?.threshold ?? 0.5);
    const rootSize = options.rootSize ?? defaultRootSize;
    const vectorFor = vectorForCandidate ?? (candidate => candidate.vector ?? candidate);
    const start = now();
    const scored = Array.from(candidates, candidate => ({
        candidate,
        score: scorePackedForest(forest, vectorFor(candidate))
    }));
    scored.sort((a, b) => b.score - a.score ||
        rootSize(a.candidate) - rootSize(b.candidate) ||
        compareDocumentOrder(a.candidate, b.candidate));
    return {
        best: scored[0]?.score >= threshold ? scored[0].candidate : null,
        scored,
        threshold,
        stats: {ms: now() - start, candidates: scored.length}
    };
}
