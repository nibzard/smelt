/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {createHash} from 'node:crypto';

export const MODEL_ARTIFACT_SCHEMA_VERSION = 1;
export const MODEL_ABI = 'smelt-model-v1';

const MAGIC = [0x53, 0x4d, 0x46, 0x31];
const HEADER_BYTES = 8;
const LEAF_SENTINEL = 255;
const UINT16_MISSING = 65535;

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function align(value, boundary) {
    return Math.ceil(value / boundary) * boundary;
}

function sigmoid(value) {
    return 1 / (1 + Math.exp(-value));
}

function float32(value) {
    const array = new Float32Array(1);
    array[0] = Number(value);
    return array[0];
}

function floatToHalf(value) {
    const floatView = new Float32Array(1);
    const intView = new Uint32Array(floatView.buffer);
    floatView[0] = Number(value);
    const bits = intView[0];
    const sign = (bits >>> 16) & 0x8000;
    let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
    let mantissa = bits & 0x7fffff;

    if (exponent <= 0) {
        if (exponent < -10) return sign;
        mantissa = (mantissa | 0x800000) >>> (1 - exponent);
        return sign | ((mantissa + 0x1000) >>> 13);
    }
    if (exponent >= 31) {
        return sign | 0x7c00;
    }
    return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13);
}

function halfToFloat(value) {
    const sign = (value & 0x8000) ? -1 : 1;
    const exponent = (value >>> 10) & 0x1f;
    const mantissa = value & 0x03ff;
    if (exponent === 0) {
        return mantissa === 0 ? sign * 0 : sign * 2 ** -14 * (mantissa / 1024);
    }
    if (exponent === 31) {
        return mantissa === 0 ? sign * Infinity : NaN;
    }
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

function walkTree(node, nodes, featureIndexByName) {
    const index = nodes.length;
    nodes.push(null);
    if (Object.hasOwn(node, 'leaf_value')) {
        nodes[index] = {
            featureIndex: LEAF_SENTINEL,
            threshold: 0,
            left: UINT16_MISSING,
            right: UINT16_MISSING,
            leafValue: float32(node.leaf_value)
        };
        return index;
    }

    requireValue(node.decision_type === '<=' || node.decision_type === undefined,
        `Unsupported LightGBM decision type: ${node.decision_type}`);
    requireValue(Number.isInteger(node.split_feature), 'Expected numeric split_feature.');
    requireValue(node.split_feature >= 0 && node.split_feature < featureIndexByName.length,
        `LightGBM split_feature out of range: ${node.split_feature}`);
    const left = walkTree(node.left_child, nodes, featureIndexByName);
    const right = walkTree(node.right_child, nodes, featureIndexByName);
    nodes[index] = {
        featureIndex: node.split_feature,
        threshold: floatToHalf(node.threshold),
        left,
        right,
        leafValue: 0
    };
    return index;
}

function forestFromLightGbm(model, featureNames) {
    requireValue(model && Array.isArray(model.tree_info), 'Expected a LightGBM model dump.');
    requireValue(Array.isArray(featureNames) && featureNames.length > 0,
        'Expected nonempty featureNames.');
    requireValue(featureNames.length < LEAF_SENTINEL, 'At most 254 features can be packed.');

    const nodes = [];
    const roots = [];
    for (const tree of model.tree_info) {
        requireValue(tree.tree_structure, 'Expected tree_structure in LightGBM tree.');
        roots.push(walkTree(tree.tree_structure, nodes, featureNames));
    }
    requireValue(nodes.length <= UINT16_MISSING, 'At most 65,535 forest nodes can be packed.');
    requireValue(roots.length <= UINT16_MISSING, 'At most 65,535 trees can be packed.');
    return {nodes, roots};
}

function writeUint16Array(view, offset, values) {
    values.forEach((value, index) => view.setUint16(offset + index * 2, value, true));
}

function writeFloat32Array(view, offset, values) {
    values.forEach((value, index) => view.setFloat32(offset + index * 4, value, true));
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
    const bytes = leaves + nodeCount * 4;
    return {roots, features, thresholds, left, right, leaves, bytes};
}

export function packForestFromLightGbm(model, featureNames) {
    const forest = forestFromLightGbm(model, featureNames);
    const offsets = packedOffsets(forest.roots.length, forest.nodes.length);
    const bytes = new Uint8Array(offsets.bytes);
    const view = new DataView(bytes.buffer);
    MAGIC.forEach((byte, index) => view.setUint8(index, byte));
    view.setUint16(4, forest.roots.length, true);
    view.setUint16(6, forest.nodes.length, true);
    writeUint16Array(view, offsets.roots, forest.roots);
    forest.nodes.forEach((node, index) => {
        view.setUint8(offsets.features + index, node.featureIndex);
    });
    writeUint16Array(view, offsets.thresholds, forest.nodes.map(node => node.threshold));
    writeUint16Array(view, offsets.left, forest.nodes.map(node => node.left));
    writeUint16Array(view, offsets.right, forest.nodes.map(node => node.right));
    writeFloat32Array(view, offsets.leaves, forest.nodes.map(node => node.leafValue));
    return Buffer.from(bytes).toString('base64');
}

export function unpackForest(packedForest) {
    requireValue(typeof packedForest === 'string' && packedForest.length > 0,
        'Expected packedForest base64 string.');
    const bytes = Buffer.from(packedForest, 'base64');
    requireValue(bytes.length >= HEADER_BYTES, 'Packed forest is too short.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    MAGIC.forEach((byte, index) => {
        requireValue(view.getUint8(index) === byte, 'Packed forest magic does not match.');
    });
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

export function rulesHash(source) {
    return `sha256-${createHash('sha256').update(source).digest('hex')}`;
}

export function createModelArtifact(options) {
    const featureNames = [...options.featureNames];
    const packedForest = options.packedForest ??
        packForestFromLightGbm(options.lightGbmModel, featureNames);
    return {
        schemaVersion: MODEL_ARTIFACT_SCHEMA_VERSION,
        abi: MODEL_ABI,
        modelVersion: String(options.modelVersion ?? '0.0.0'),
        task: String(options.task ?? 'consent-banners'),
        trainedAt: String(options.trainedAt),
        corpus: {
            id: String(options.corpus?.id ?? 'unknown'),
            revision: String(options.corpus?.revision ?? 'unknown')
        },
        rulesHash: String(options.rulesHash),
        featureNames,
        calibration: {
            method: String(options.calibration?.method ?? 'development-threshold'),
            threshold: Number(options.calibration?.threshold ?? 0.5),
            score: String(options.calibration?.score ?? 'probability')
        },
        forest: {
            encoding: 'base64',
            byteOrder: 'little-endian',
            alignmentBytes: 4,
            nodeLayout: ['featureIndex:u8', 'threshold:f16', 'left:u16', 'right:u16', 'leafValue:f32'],
            leafFeatureIndex: LEAF_SENTINEL,
            packed: packedForest
        }
    };
}

export function readModelArtifact(input) {
    const artifact = typeof input === 'string' ? JSON.parse(input) : input;
    requireValue(artifact?.schemaVersion === MODEL_ARTIFACT_SCHEMA_VERSION,
        'Expected model artifact schemaVersion 1.');
    requireValue(artifact.abi === MODEL_ABI, `Expected model ABI ${MODEL_ABI}.`);
    requireValue(Array.isArray(artifact.featureNames) && artifact.featureNames.length > 0,
        'Expected nonempty featureNames.');
    requireValue(artifact.forest?.encoding === 'base64', 'Expected base64 forest encoding.');
    requireValue(artifact.forest?.byteOrder === 'little-endian', 'Expected little-endian forest.');
    const forest = unpackForest(artifact.forest.packed);
    return {
        ...artifact,
        decodedForest: {
            ...forest,
            featureNames: artifact.featureNames
        }
    };
}
