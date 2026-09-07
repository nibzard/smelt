/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {trainConsentBaselines} from './train.mjs';

async function readJson(filename) {
    return JSON.parse(await readFile(filename, 'utf8'));
}

async function loadCaptures(records, baseDir) {
    return Promise.all(records.map(async record => ({
        id: record.id,
        snapshot: await readJson(path.resolve(baseDir, record.snapshot)),
        features: await readJson(path.resolve(baseDir, record.features))
    })));
}

async function loadSplit(split, baseDir) {
    return {
        labels: await readJson(path.resolve(baseDir, split.labels)),
        captures: await loadCaptures(split.captures, baseDir)
    };
}

async function loadManifest(filename) {
    const baseDir = path.dirname(path.resolve(filename));
    const manifest = await readJson(filename);
    return {
        schemaVersion: manifest.schemaVersion,
        humanEffortHours: manifest.humanEffortHours,
        costs: manifest.costs,
        linear: manifest.linear,
        train: await loadSplit(manifest.train, baseDir),
        development: await loadSplit(manifest.development, baseDir)
    };
}

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
    console.error('Usage: node packages/consent-banners/train-cli.mjs <manifest.json> [report.json]');
    process.exitCode = 1;
} else {
    try {
        const report = trainConsentBaselines(await loadManifest(args[0]));
        const output = `${JSON.stringify(report, null, 2)}\n`;
        if (args[1]) await writeFile(args[1], output);
        else process.stdout.write(output);
    } catch (error) {
        console.error(`Training failed: ${error.message}`);
        process.exitCode = 1;
    }
}
