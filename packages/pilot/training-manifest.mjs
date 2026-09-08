/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Build the manifest the trainer and the rules loop consume, from the
// corpus artifacts prepare-corpus wrote (task T010). The frozen test set
// is excluded structurally: this file reads the train and development
// splits only and never opens the test labels file (IDEA.md 3.2.4). The
// build is all-or-nothing — one unresolved page refuses the whole run —
// because the compact conversion drops unresolved pages, and a quiet
// subset would under-train without anyone noticing.

import {mkdir, readFile, realpath, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {toEvaluationDataset} from './labels.mjs';
import {SPLITS} from './prepare-corpus.mjs';

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

// Two paths name the same file when their real paths match. A lexical
// resolve is not enough: a symlinked checkout or a ".." spelling can
// hide the identity of the directory or file being written.
async function realPath(file) {
    try {
        return await realpath(file);
    } catch {
        return path.resolve(file);
    }
}

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Build a trainer and loop manifest from reviewed corpus labels.
 *
 * @param {object} input {manifestPath, labelsDir, outPath}.
 * @returns {Promise<object>} {manifest, files}: the manifest object and
 *   every file written, the manifest last.
 */
export async function buildTrainingManifest(input) {
    const manifestPath = input?.manifestPath;
    const labelsDir = input?.labelsDir;
    const outPath = input?.outPath;
    requireValue(typeof manifestPath === 'string' && manifestPath.length > 0,
        'Expected a split manifest path.');
    requireValue(typeof labelsDir === 'string' && labelsDir.length > 0,
        'Expected a labels directory.');
    requireValue(typeof outPath === 'string' && outPath.length > 0,
        'Expected an output manifest path.');

    const corpusManifest = await readJson(manifestPath);
    requireValue(corpusManifest?.schemaVersion === 1,
        'Expected split manifest schemaVersion 1.');

    // Only the two non-test roles are ever read.
    const roles = {};
    const seenGroups = new Map();
    for (const split of SPLITS.filter(name => name !== 'test')) {
        const entries = corpusManifest.splits?.[split] ?? [];
        // Every manifest entry needs an id and capture paths before any
        // comparison runs, and a capture listed twice would double its
        // weight in training without failing an agreement check.
        const seenIds = new Set();
        for (const entry of entries) {
            requireValue(typeof entry?.id === 'string' && entry.id.length > 0,
                `${split} manifest holds an entry without an id.`);
            requireValue(!seenIds.has(entry.id), `${split} manifest lists capture `
                + `${entry.id} more than once. Run prepare:corpus again.`);
            seenIds.add(entry.id);
            requireValue(typeof entry.snapshot === 'string' && entry.snapshot.length > 0,
                `${split} manifest entry ${entry.id} has no snapshot path.`);
            requireValue(typeof entry.features === 'string' && entry.features.length > 0,
                `${split} manifest entry ${entry.id} has no features path.`);
        }
        const labelsFile = path.join(labelsDir, `${split}.labels.json`);
        let dataset;
        try {
            dataset = await readJson(labelsFile);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            throw new Error(`${labelsFile} is missing. Run prepare:corpus first.`);
        }
        requireValue(dataset?.split === split,
            `${labelsFile} declares split ${dataset?.split}, expected ${split}.`);
        const unresolved = (dataset.pages ?? [])
            .filter(page => page.label_status !== 'reviewed');
        requireValue(unresolved.length === 0,
            `${split} still holds ${unresolved.length} unresolved page(s): `
                + `${unresolved.slice(0, 5).map(page => page.id).join(', ')}. `
                + 'Finish human review before building a training manifest.');
        // The compact conversion validates every record and keeps the
        // split declaration, so the trainer role pinning accepts it.
        const compact = toEvaluationDataset(dataset);

        const captureById = new Map(entries.map(entry => [entry.id, entry]));
        const missingCaptures = compact.pages
            .filter(page => !captureById.has(page.id)).map(page => page.id);
        requireValue(missingCaptures.length === 0,
            `${split} labels hold pages the manifest does not list: `
                + `${missingCaptures.slice(0, 5).join(', ')}. Run prepare:corpus again.`);
        const missingPages = entries
            .filter(entry => !compact.pages.some(page => page.id === entry.id))
            .map(entry => entry.id);
        requireValue(missingPages.length === 0,
            `${split} manifest lists captures with no reviewed label: `
                + `${missingPages.slice(0, 5).join(', ')}. Run labels:doctor.`);

        for (const page of compact.pages) {
            // A group may hold several pages inside one split; spanning two
            // splits is the violation the corpus split prevents.
            const owner = seenGroups.get(page.group);
            if (owner !== undefined && owner !== split) {
                throw new TypeError(`Group ${page.group} appears in `
                    + `${owner} and ${split}; a group must stay inside one split.`);
            }
            seenGroups.set(page.group, split);
        }
        roles[split] = {compact, entries};
    }

    // Write the compact labels next to the manifest; the trainer CLI
    // resolves every capture path against the manifest directory, so the
    // capture paths are absolute and the manifest works from any cwd.
    const outDir = path.dirname(outPath);
    await mkdir(outDir, {recursive: true});
    // The compact files carry the same basenames as the canonical labels.
    // Writing them into the labels directory would overwrite the reviewed
    // records with compact copies, so refuse that outright — by real
    // path, so a symlink or a ".." spelling cannot hide the identity.
    requireValue(await realPath(outDir) !== await realPath(labelsDir),
        'The output directory must differ from the labels directory, '
            + 'or the compact files would overwrite the reviewed labels.');
    // The output may not be the input either: writing over the split
    // manifest destroys the artifact prepare:corpus owns.
    requireValue(await realPath(outPath) !== await realPath(manifestPath),
        'The output path must differ from the split manifest path, '
            + 'or the build would overwrite the corpus manifest.');
    const compactBasenames = Object.keys(roles)
        .map(split => `${split}.labels.json`);
    requireValue(!compactBasenames.includes(path.basename(outPath)),
        `The output manifest basename must not be `
            + `${compactBasenames.join(' or ')}, or the manifest write `
            + 'would overwrite a compact labels file.');
    const files = [];
    const manifest = {schemaVersion: 1, generatedAt: new Date().toISOString()};
    // Stage every output before any rename, so a write failure leaves the
    // whole previous generation intact instead of fresh compact labels
    // beside a stale manifest. The manifest renames last: until it does,
    // the old manifest still describes the old compact files.
    const staged = [];
    for (const split of Object.keys(roles)) {
        const {compact, entries} = roles[split];
        const labelsOut = path.join(outDir, `${split}.labels.json`);
        staged.push({file: labelsOut, text: `${JSON.stringify(compact, null, 2)}\n`});
        manifest[split] = {
            labels: path.basename(labelsOut),
            captures: entries.map(entry => ({
                id: entry.id,
                snapshot: path.resolve(entry.snapshot),
                features: path.resolve(entry.features)
            }))
        };
    }
    staged.push({file: outPath, text: `${JSON.stringify(manifest, null, 2)}\n`});
    for (const {file, text} of staged) await writeFile(`${file}.tmp`, text);
    for (const {file} of staged) {
        await rename(`${file}.tmp`, file);
        files.push(file);
    }
    return {manifest, files};
}

// CLI entry: node training-manifest.mjs --manifest corpus/manifests/splits.json
//   --labels corpus/manifests/labels --out runs/training/manifest.json
function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    try {
        const {files} = await buildTrainingManifest({
            manifestPath: option('manifest', 'corpus/manifests/splits.json'),
            labelsDir: option('labels', 'corpus/manifests/labels'),
            outPath: option('out')
        });
        for (const file of files) console.log(`wrote ${file}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
