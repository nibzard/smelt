/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Consistency checks for the human label files (task T010). A reviewer
// pastes one record per page into the split label files by hand, so the
// files need a gate that catches paste accidents before the labels feed
// any scoring: the wrong file, a paste below the stub instead of over it,
// a renamed capture, or a group that disagrees with the manifests. The
// checks read local files only and change nothing.

import {access, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {validateConsentLabels} from './labels.mjs';
import {validateSchema} from './schema-check.mjs';
import {SPLITS} from './prepare-corpus.mjs';

function problem(code, detail) {
    return {code, detail};
}

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}

async function fileExists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check label files against the split manifest, review queue, and captures.
 *
 * @param {object} input {labelsDir, manifestPath, queuePath, capturesDir}.
 * @returns {Promise<object>} {problems, stats}. An empty problems array
 * means every check passed.
 */
export async function checkLabels(input) {
    const labelsDir = input?.labelsDir;
    const manifestPath = input?.manifestPath;
    const queuePath = input?.queuePath;
    const capturesDir = input?.capturesDir;
    const problems = [];
    const requireInput = (value, name) => {
        if (typeof value !== 'string' || value.length === 0) {
            throw new TypeError(`Expected ${name}.`);
        }
    };
    requireInput(labelsDir, 'a labels directory');
    requireInput(manifestPath, 'a split manifest path');
    requireInput(queuePath, 'a review queue path');
    requireInput(capturesDir, 'a captures directory');

    const labelsSchema = JSON.parse(await readFile(
        input.labelsSchemaPath ?? 'tasks/consent-banners/labels.schema.json', 'utf8'));

    const manifest = await readJson(manifestPath);
    const manifestById = new Map();
    for (const split of SPLITS) {
        for (const entry of manifest.splits?.[split] ?? []) {
            if (manifestById.has(entry.id)) {
                problems.push(problem('manifest-duplicate-id',
                    `manifest lists ${entry.id} in ${manifestById.get(entry.id).split} and ${split}`));
            } else {
                manifestById.set(entry.id, {...entry, split});
            }
        }
    }

    // 1. Each split file parses, satisfies the canonical schema, and passes
    //    the semantic label checks. An empty manifest split needs no file.
    const datasets = {};
    const seenInFile = new Map();
    for (const split of SPLITS) {
        const file = path.join(labelsDir, `${split}.labels.json`);
        const splitEmpty = (manifest.splits?.[split] ?? []).length === 0;
        if (!await fileExists(file)) {
            if (!splitEmpty) {
                problems.push(problem('labels-file-missing', `${file} does not exist`));
            }
            continue;
        }
        let dataset;
        try {
            dataset = await readJson(file);
        } catch (error) {
            problems.push(problem('labels-file-unreadable', `${file}: ${error.message}`));
            continue;
        }
        if (dataset.split !== split) {
            problems.push(problem('labels-split-mismatch',
                `${file} declares split ${dataset.split}, expected ${split}`));
        }
        for (const schemaError of validateSchema(dataset, labelsSchema)) {
            problems.push(problem('labels-schema', `${file}: ${schemaError}`));
        }
        try {
            validateConsentLabels(dataset);
        } catch (error) {
            problems.push(problem('labels-semantic', `${file}: ${error.message}`));
        }
        datasets[split] = dataset;
        for (const page of dataset.pages ?? []) {
            if (seenInFile.has(page.id)) {
                problems.push(problem('labels-duplicate-id',
                    `page ${page.id} appears in ${seenInFile.get(page.id)} and ${split}`));
            } else {
                seenInFile.set(page.id, split);
            }
        }
    }

    // 2. Every labels page id exists in the split manifest, and every
    //    manifest capture has a labels page. The manifest is keyed by the
    //    captures directory, so a paste into the wrong split file shows up
    //    as a split disagreement here.
    const queue = await readJson(queuePath);
    const queueById = new Map((queue.items ?? []).map(item => [item.capture_id, item]));

    const groupsFor = {};
    for (const split of SPLITS) {
        for (const page of datasets[split]?.pages ?? []) {
            const entry = manifestById.get(page.id);
            if (!entry) {
                problems.push(problem('labels-unknown-capture',
                    `page ${page.id} in ${split} has no capture in the manifest`));
                continue;
            }
            if (manifestById.get(page.id).split !== split) {
                problems.push(problem('labels-wrong-split',
                    `page ${page.id} sits in ${split} but its group was assigned `
                        + `to ${manifestById.get(page.id).split}`));
            }
            const queueItem = queueById.get(page.id);
            if (!queueItem) {
                problems.push(problem('labels-not-in-queue',
                    `page ${page.id} is not in the review queue`));
            }
            // The group must agree across the label record, the manifest,
            // and the queue item, or a pasted record would silently
            // rewrite the group that split the corpus.
            const disagree = [];
            if (entry.group !== page.group) {
                disagree.push(`manifest ${entry.group} vs label ${page.group}`);
            }
            if (queueItem && queueItem.group !== page.group) {
                disagree.push(`queue ${queueItem.group} vs label ${page.group}`);
            }
            if (disagree.length > 0) {
                problems.push(problem('group-mismatch',
                    `page ${page.id}: ${disagree.join('; ')}`));
            }
            groupsFor[page.id] = page.group;
        }
    }
    for (const [id, entry] of manifestById) {
        if (!seenInFile.has(id)) {
            problems.push(problem('labels-missing-page',
                `capture ${id} (${entry.split}) has no labels page`));
        }
    }

    // 3. Every manifest capture still has its capture files on disk, and
    //    every capture file on disk has a manifest entry. A crawl run after
    //    the last prepare leaves captures that no label file can hold.
    for (const [id, entry] of manifestById) {
        for (const key of ['snapshot', 'features', 'metadata']) {
            const file = entry[key];
            if (!file) {
                problems.push(problem('manifest-path-missing',
                    `capture ${id} has no ${key} path in the manifest`));
                continue;
            }
            if (!await fileExists(file)) {
                problems.push(problem('capture-file-missing',
                    `capture ${id}: ${file} does not exist`));
            }
        }
    }
    const captureFiles = (await readdir(capturesDir))
        .filter(file => file.endsWith('.metadata.json'))
        .map(file => file.slice(0, -'.metadata.json'.length));
    for (const id of captureFiles) {
        if (!manifestById.has(id)) {
            problems.push(problem('capture-not-in-manifest',
                `capture ${id} exists in ${capturesDir} but not in the manifest; `
                    + 'run prepare:corpus again'));
        }
    }

    // The captures directory names ids by their metadata files; a capture
    // without any labels page is invisible to check 2 only when the
    // manifest itself is stale.
    const stats = {
        labelPages: seenInFile.size,
        manifestCaptures: manifestById.size,
        queueItems: queueById.size,
        reviewed: SPLITS.reduce((sum, split) =>
            sum + (datasets[split]?.pages ?? []).filter(page =>
                page.label_status === 'reviewed').length, 0)
    };
    return {problems, stats};
}

// CLI entry: node labels-doctor.mjs --labels corpus/manifests/labels
//   --manifest corpus/manifests/splits.json
//   --queue tasks/consent-banners/review-queue.json
//   --captures corpus/captures
function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    try {
        const {problems, stats} = await checkLabels({
            labelsDir: option('labels', 'corpus/manifests/labels'),
            manifestPath: option('manifest', 'corpus/manifests/splits.json'),
            queuePath: option('queue', 'tasks/consent-banners/review-queue.json'),
            capturesDir: option('captures', 'corpus/captures')
        });
        for (const item of problems) {
            console.error(`${item.code}: ${item.detail}`);
        }
        console.log(`label pages: ${stats.labelPages} (reviewed: ${stats.reviewed}), `
            + `manifest captures: ${stats.manifestCaptures}, `
            + `queue items: ${stats.queueItems}, problems: ${problems.length}`);
        process.exitCode = problems.length > 0 ? 1 : 0;
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
