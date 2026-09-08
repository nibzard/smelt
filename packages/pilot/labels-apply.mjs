/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Apply reviewed label records to the split label files (task T010). The
// review viewer copies one record per page; pasting each over its stub by
// hand invites the accidents labels-doctor guards against. This command
// finds the page by id, replaces the stub, and writes the file only when
// the replacement passes the same schema and semantic checks. Rejected
// records never touch the file they targeted.

import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {commitStaged, stageWrite} from './atomic-write.mjs';
import {validateConsentLabels} from './labels.mjs';
import {validateSchema} from './schema-check.mjs';
import {SPLITS} from './prepare-corpus.mjs';

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

// Key-sorted stringify, so two records with the same fields in a
// different order count as the same label.
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

// Staged writes with a kept backup come from ./atomic-write.mjs, shared
// with prepare-corpus: the labels directory is outside version control,
// so no other recovery path exists.

/**
 * Parse the contents of a records file.
 *
 * The file may hold a JSON array of records, an object with a `pages`
 * array, or viewer records pasted one after another with no commas and
 * no wrapping array — the copied record is pretty-printed, so demanding
 * a hand-assembled array puts every paste accident back into the flow
 * this command exists to remove. Whitespace separates pasted values.
 * Anything else fails with the byte offset, so a torn paste or stray
 * text is named, never silently skipped. Review notes hold non-ASCII
 * text, so the offset counts file bytes, not UTF-16 code units.
 *
 * @arg {string} text File contents.
 * @returns {Array} The label records.
 */
export function parseRecords(text) {
    const records = [];
    let index = 0;
    const byteOffset = () => Buffer.byteLength(text.slice(0, index), 'utf8');
    const skipSpace = () => {
        while (index < text.length && /\s/.test(text[index])) index += 1;
    };
    skipSpace();
    while (index < text.length) {
        const opener = text[index];
        if (opener !== '{' && opener !== '[') {
            throw new SyntaxError(`Records file has unexpected content at byte `
                + `offset ${byteOffset()}: `
                + `${JSON.stringify(text.slice(index, index + 20))}. Hold `
                + 'label records as objects pasted one after another, as a JSON '
                + 'array, or as an object with a pages array.');
        }
        // Scan one balanced value. Strings hide braces, brackets, and
        // quotes, so track string state and escapes while counting depth.
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let i = index; i < text.length; i++) {
            const char = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
            } else if (char === '{' || char === '[') {
                depth += 1;
            } else if (char === '}' || char === ']') {
                depth -= 1;
                if (depth <= 0) {
                    if (depth < 0) break;
                    end = i;
                    break;
                }
            }
        }
        if (end === -1) {
            throw new SyntaxError(`Records file holds an unfinished JSON value at `
                + `byte offset ${byteOffset()}: it starts with `
                + `${JSON.stringify(text.slice(index, index + 20))} and never `
                + 'closes, so nothing was applied. Check the last pasted record.');
        }
        let value;
        try {
            value = JSON.parse(text.slice(index, end + 1));
        } catch (error) {
            throw new SyntaxError(`Records file holds an invalid JSON value at `
                + `byte offset ${byteOffset()}: ${error.message}`);
        }
        const pages = Array.isArray(value) ? value : value?.pages;
        if (Array.isArray(pages)) {
            records.push(...pages);
        } else if (value !== null && typeof value === 'object' && !Array.isArray(value)
            && typeof value.id === 'string') {
            records.push(value);
        } else {
            throw new SyntaxError('Records file holds a value that is neither a '
                + `label record nor a records array, at byte offset `
                + `${byteOffset()}. Records need an id field; batches need a `
                + 'pages array.');
        }
        index = end + 1;
        skipSpace();
    }
    requireValue(records.length > 0,
        'Records file must hold label records: objects pasted one after '
            + 'another, a JSON array of records, or an object with a pages array.');
    return records;
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
 * the labels file, or when the replacement would fail validation. A
 * record that would change an already reviewed page is rejected unless
 * it is identical to the stored record or `replaceReviewed` is set; a
 * reviewed page is never demoted back to `unresolved`. Rejected records
 * leave the target file untouched.
 *
 * @param {object} input {records, labelsDir, labelsSchemaPath,
 *   replaceReviewed}.
 * @returns {Promise<object>} {applied, rejected, written}.
 */
export async function applyLabels(input) {
    const records = input?.records;
    const labelsDir = input?.labelsDir;
    const replaceReviewed = input?.replaceReviewed === true;
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
        if (!Array.isArray(dataset.pages)) {
            throw new Error(`${file} holds a pages field that is not an array.`);
        }
        for (const [index, page] of dataset.pages.entries()) {
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
        // A reviewed record is the scarce human-review asset. It is never
        // demoted, and a change needs the explicit replace option, so a
        // stale records file from an earlier session cannot silently
        // revert a correction. An identical re-apply stays allowed.
        if (existing.label_status === 'reviewed' && record.label_status !== 'reviewed') {
            rejected.push({id, reason: 'page is already reviewed; labels:apply '
                + 'never demotes a reviewed page back to unresolved'});
            continue;
        }
        if (existing.label_status === 'reviewed' && !replaceReviewed
            && stableStringify(record) !== stableStringify(existing)) {
            rejected.push({id, reason: 'page is already reviewed with a different '
                + 'label; pass --replace to correct it'});
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

    // Swap the accepted records in memory. Every touched file must pass
    // the whole-file checks before anything is staged, so one bad file
    // cannot leave another half-applied through the write loop.
    const applied = [];
    const written = [];
    const touched = new Map();
    for (const item of accepted) {
        datasets[item.split].pages[item.index] = item.record;
        if (!touched.has(item.split)) touched.set(item.split, []);
        touched.get(item.split).push(item.id);
    }
    const failedSplits = [];
    for (const [split, ids] of touched) {
        const problem = problemsIn(datasets[split], labelsSchema);
        if (problem) {
            for (const id of ids) rejected.push({id, reason: problem});
            failedSplits.push(split);
        }
    }
    for (const split of failedSplits) touched.delete(split);

    // Stage every write first, then swap them in. A staging failure
    // changes nothing; a swap failure mid-way is reported with exactly
    // which files were already updated, and re-running the same records
    // file finishes the batch because an identical re-apply is allowed.
    try {
        const staged = [];
        for (const split of touched.keys()) {
            const file = path.join(labelsDir, `${split}.labels.json`);
            const text = `${JSON.stringify(datasets[split], null, 2)}\n`;
            await stageWrite(file, text);
            staged.push({file, split});
        }
        for (const {file, split} of staged) {
            await commitStaged(file);
            written.push(file);
            applied.push(...touched.get(split));
        }
    } catch (error) {
        const updated = written.map(file => path.basename(file)).join(', ') || 'none';
        throw Object.assign(
            new Error(`${error.message} Updated so far: ${updated}. Re-run the same `
                + 'records file to finish the batch; each updated file keeps a '
                + '.bak copy of its previous content.'),
            {cause: error, partial: {applied, rejected, written}});
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
            labelsSchemaPath: option('schema', 'tasks/consent-banners/labels.schema.json'),
            replaceReviewed: process.argv.includes('--replace')
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
