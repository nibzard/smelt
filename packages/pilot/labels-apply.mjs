/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Apply reviewed label records to the split label files (task T010). The
// review viewer copies one record per page; pasting each over its stub by
// hand invites the accidents labels-doctor guards against. This command
// finds the page by id, replaces the stub, and writes the file only when
// the replacement passes the same schema and semantic checks. Rejected
// records never touch the file they targeted.

import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {validateConsentLabels} from './labels.mjs';
import {validateSchema} from './schema-check.mjs';
import {SPLITS} from './prepare-corpus.mjs';

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

/**
 * Parse the contents of a records file.
 *
 * @arg {string} text File contents: a JSON array of records, or an object
 *   with a `pages` array.
 * @returns {Array} The label records.
 */
export function parseRecords(text) {
    const parsed = JSON.parse(text);
    const pages = Array.isArray(parsed) ? parsed : parsed?.pages;
    requireValue(Array.isArray(pages) && pages.length > 0,
        'Records file must hold a JSON array of label records '
            + 'or an object with a pages array.');
    return pages;
}

// The first schema or semantic problem in the dataset, or null. The same
// checks labels-doctor runs, so an applied file always passes the doctor.
function problemsIn(dataset, labelsSchema) {
    for (const schemaError of validateSchema(dataset, labelsSchema)) {
        return `schema: ${schemaError}`;
    }
    try {
        validateConsentLabels(dataset);
    } catch (error) {
        return `semantic: ${error.message}`;
    }
    return null;
}

/**
 * Replace the stub of each record's page in the split label files.
 *
 * A record is rejected when no split file holds its page id, when the id
 * appears more than once across the files, when its group disagrees with
 * the labels file, or when the replacement would fail validation. Rejected
 * records leave the target file untouched.
 *
 * @param {object} input {records, labelsDir, labelsSchemaPath}.
 * @returns {Promise<object>} {applied, rejected, written}.
 */
export async function applyLabels(input) {
    const records = input?.records;
    const labelsDir = input?.labelsDir;
    requireValue(Array.isArray(records) && records.length > 0,
        'Expected at least one label record.');
    requireValue(typeof labelsDir === 'string' && labelsDir.length > 0,
        'Expected a labels directory.');
    const labelsSchema = JSON.parse(await readFile(
        input.labelsSchemaPath ?? 'tasks/consent-banners/labels.schema.json', 'utf8'));

    // Load every split file that exists. A file that exists but does not
    // parse stops the whole run, because guessing its target is worse.
    const datasets = {};
    const where = new Map();
    const duplicated = new Set();
    for (const split of SPLITS) {
        const file = path.join(labelsDir, `${split}.labels.json`);
        let text;
        try {
            text = await readFile(file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        let dataset;
        try {
            dataset = JSON.parse(text);
        } catch (error) {
            throw new Error(`${file} is not valid JSON: ${error.message}`);
        }
        datasets[split] = dataset;
        for (const [index, page] of (dataset.pages ?? []).entries()) {
            if (where.has(page.id)) duplicated.add(page.id);
            else where.set(page.id, {split, index});
        }
    }

    const rejected = [];
    const accepted = [];
    const claimed = new Set();
    for (const record of records) {
        const id = record?.id;
        if (typeof id !== 'string' || id.length === 0) {
            rejected.push({id: null, reason: 'record has no page id'});
            continue;
        }
        if (claimed.has(id)) {
            rejected.push({id, reason: 'record appears twice in this batch'});
            continue;
        }
        if (duplicated.has(id)) {
            rejected.push({id, reason: 'page id appears more than once in the label '
                + 'files; run labels:doctor first'});
            continue;
        }
        const spot = where.get(id);
        if (!spot) {
            rejected.push({id, reason: 'no split file holds a page with this id'});
            continue;
        }
        const existing = datasets[spot.split].pages[spot.index];
        // The labels file owns the group that split the corpus. A record
        // from another page's viewer, or a stale copy, disagrees with it.
        if (record.group !== existing.group) {
            rejected.push({id, reason: `record group ${record.group} disagrees with `
                + `the labels file group ${existing.group}`});
            continue;
        }
        // The record must validate in place before anything is written.
        const trial = datasets[spot.split].pages.slice();
        trial[spot.index] = record;
        const problem = problemsIn({...datasets[spot.split], pages: trial}, labelsSchema);
        if (problem) {
            rejected.push({id, reason: problem});
            continue;
        }
        claimed.add(id);
        accepted.push({id, split: spot.split, index: spot.index, record});
    }

    // Swap the accepted records in memory, then write each touched file
    // only after the whole file passes the checks one more time.
    const applied = [];
    const written = [];
    const touched = new Map();
    for (const item of accepted) {
        datasets[item.split].pages[item.index] = item.record;
        if (!touched.has(item.split)) touched.set(item.split, []);
        touched.get(item.split).push(item.id);
    }
    for (const [split, ids] of touched) {
        const problem = problemsIn(datasets[split], labelsSchema);
        if (problem) {
            for (const id of ids) rejected.push({id, reason: problem});
            continue;
        }
        const file = path.join(labelsDir, `${split}.labels.json`);
        await writeFile(file, `${JSON.stringify(datasets[split], null, 2)}\n`);
        written.push(file);
        applied.push(...ids);
    }
    return {applied, rejected, written};
}

// CLI entry: node labels-apply.mjs --records collected.json
//   --labels corpus/manifests/labels
//   --schema tasks/consent-banners/labels.schema.json
function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    try {
        const recordsFile = option('records');
        if (!recordsFile) throw new Error('Expected --records <file>.');
        const records = parseRecords(await readFile(recordsFile, 'utf8'));
        const {applied, rejected, written} = await applyLabels({
            records,
            labelsDir: option('labels', 'corpus/manifests/labels'),
            labelsSchemaPath: option('schema', 'tasks/consent-banners/labels.schema.json')
        });
        for (const item of rejected) {
            console.error(`rejected ${item.id ?? '(no id)'}: ${item.reason}`);
        }
        for (const file of written) console.log(`updated ${file}`);
        console.log(`applied ${applied.length} record(s), rejected ${rejected.length}`);
        process.exitCode = rejected.length > 0 ? 1 : 0;
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
