/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Batch teacher labeling over the review queue (IDEA.md 3.3.4). Every
// record is a proposal for the human reviewer, never a label: nothing in
// this file writes to the split labels files, and the reviewed record is
// the only label that counts (IDEA.md 3.3.1).

import {appendFile, mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {runTeacher, serializeForTeacher, teacherCatalog} from './teacher.mjs';

export const DEFAULT_DELAY_MS = 500;
export const DEFAULT_MAX_COST_USD = 40;
// Five failures in a row means the teacher endpoint is down or the
// captures are unreadable as a class; paying for the rest of the queue
// would only repeat the same failure.
export const CONSECUTIVE_ERROR_LIMIT = 5;

// Estimation constants for dry runs. The overhead covers the task text and
// the viewport line every request repeats; real usage arrives with each
// answer and replaces these numbers in the live records.
const PROMPT_OVERHEAD_BYTES = 2048;
const ESTIMATED_OUTPUT_TOKENS = 150;
const BYTES_PER_TOKEN = 4;

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadCapture(capturesDir, captureId) {
    const base = path.join(capturesDir, captureId);
    const [snapshot, features] = await Promise.all([
        readFile(`${base}.snapshot.json`, 'utf8').then(JSON.parse),
        readFile(`${base}.features.json`, 'utf8').then(JSON.parse)
    ]);
    return {snapshot, features};
}

// Read the proposals file from an earlier run. A capture counts as done
// only when a full record with labels exists for it, so an interrupted
// batch re-labels exactly the pages it never finished. A torn final line
// is the interrupt itself and is dropped; a corrupt line in the middle is
// counted, and the capture it held is re-labeled, so one page can hold a
// corrupt line followed by a fresh record. The consumer takes the last
// record per capture id.
async function readDoneIds(outPath) {
    let text;
    try {
        text = await readFile(outPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return {done: new Set(), corrupt: 0,
            endsWithNewline: true};
        throw error;
    }
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    const done = new Set();
    let corrupt = 0;
    for (const line of lines) {
        if (line.trim() === '') continue;
        try {
            const record = JSON.parse(line);
            if (record && typeof record.capture_id === 'string' && record.labels) {
                done.add(record.capture_id);
            }
        } catch {
            corrupt += 1;
        }
    }
    return {done, corrupt, endsWithNewline: text.endsWith('\n')};
}

function estimateCatalogCosts(serializations) {
    return teacherCatalog().map(meta => {
        const inputTokens = serializations.reduce(
            (sum, serialization) => sum + Math.ceil(
                (serialization.bytes + PROMPT_OVERHEAD_BYTES) / BYTES_PER_TOKEN), 0);
        const outputTokens = serializations.length * ESTIMATED_OUTPUT_TOKENS;
        const costUsd = (inputTokens * meta.prices.inputPerMillionUsd
            + outputTokens * meta.prices.outputPerMillionUsd) / 1e6;
        return {
            id: meta.id,
            model: meta.model,
            prices: meta.prices,
            inputTokens,
            outputTokens,
            costUsd: Math.round(costUsd * 1e6) / 1e6
        };
    });
}

async function dryRunBatch(ids, capturesDir, excludeIds, summary, caps) {
    const serializations = [];
    let totalBytes = 0;
    let truncated = 0;
    for (const captureId of ids) {
        if (excludeIds.has(captureId)) {
            summary.skippedExcluded += 1;
            continue;
        }
        let serialization;
        try {
            const capture = await loadCapture(capturesDir, captureId);
            serialization = serializeForTeacher(capture.snapshot, capture.features, caps);
        } catch (error) {
            summary.failed += 1;
            summary.failures.push({capture_id: captureId, error: error.message});
            continue;
        }
        serializations.push(serialization);
        totalBytes += serialization.bytes;
        if (serialization.stats.truncated) truncated += 1;
    }
    summary.estimation = {
        pages: serializations.length,
        totalBytes,
        bytesPerPage: serializations.length > 0
            ? Math.round(totalBytes / serializations.length) : 0,
        truncatedPages: truncated,
        caps,
        teachers: estimateCatalogCosts(serializations)
    };
    return summary;
}

/**
 * Run one teacher over a queue of captures and append a proposal record
 * per page to a JSONL file.
 *
 * @param {object} input {adapter, capturesDir, items, outPath, excludeIds,
 *   fetchImpl, delayMs, maxCostUsd, limit, maxChars, maxElements, dryRun,
 *   now, onRecord}. `items` holds `{capture_id}` records in queue order.
 *   `maxChars` and `maxElements` override the serialization caps; a page
 *   that hits either cap is serialized truncated and its answer is always
 *   flagged for human review. `dryRun` needs no adapter and writes
 *   nothing: it serializes every page and estimates the cost for both
 *   default teachers.
 * @returns {Promise<object>} Batch summary; the proposals file holds one
 *   JSON line per finished page.
 */
export async function runTeacherBatch(input) {
    const adapter = input?.adapter ?? null;
    const capturesDir = input?.capturesDir;
    const items = input?.items;
    const outPath = input?.outPath ?? null;
    const dryRun = input?.dryRun === true;
    const delayMs = input?.delayMs ?? DEFAULT_DELAY_MS;
    const maxCostUsd = input?.maxCostUsd ?? DEFAULT_MAX_COST_USD;
    const limit = input?.limit ?? 0;
    const maxChars = input?.maxChars ?? undefined;
    const maxElements = input?.maxElements ?? undefined;
    const excludeIds = new Set(input?.excludeIds ?? []);
    requireValue(typeof capturesDir === 'string' && capturesDir.length > 0,
        'Expected a captures directory.');
    requireValue(Array.isArray(items) && items.length > 0, 'Expected queue items.');
    requireValue(dryRun || adapter !== null,
        'Expected a teacher adapter; build one with anthropicTeacher() or geminiTeacher().');
    requireValue(dryRun || (typeof outPath === 'string' && outPath.length > 0),
        'Expected an output path for the proposals file.');
    requireValue(Number.isFinite(delayMs) && delayMs >= 0,
        'Expected a nonnegative delay in milliseconds.');
    requireValue(Number.isFinite(maxCostUsd) && maxCostUsd > 0,
        'Expected a positive cost cap in USD.');
    requireValue(maxChars === undefined || (Number.isFinite(maxChars) && maxChars > 0),
        'Expected a positive maxChars cap.');
    requireValue(maxElements === undefined || (Number.isFinite(maxElements) && maxElements > 0),
        'Expected a positive maxElements cap.');

    const ids = items.map(item => item?.capture_id);
    requireValue(ids.every(id => typeof id === 'string' && id.length > 0),
        'Every queue item needs a capture_id.');

    const summary = {labeled: 0, resumed: 0, skippedExcluded: 0, failed: 0,
        verification: {pass: 0, flag: 0, reject: 0}, spentUsd: 0,
        stopped: null, corruptLines: 0, failures: []};
    if (dryRun) {
        return await dryRunBatch(ids, capturesDir, excludeIds, summary,
            {maxChars, maxElements});
    }

    const append = async record => {
        await appendFile(outPath, `${JSON.stringify(record)}\n`);
        if (typeof input?.onRecord === 'function') input.onRecord(record);
    };
    const {done, corrupt, endsWithNewline} = await readDoneIds(outPath);
    summary.corruptLines = corrupt;
    await mkdir(path.dirname(outPath), {recursive: true});
    // A torn line has no trailing newline; without this separator the next
    // appended record would merge into it and become unreadable too.
    if (!endsWithNewline) await appendFile(outPath, '\n');

    let consecutiveErrors = 0;
    for (const captureId of ids) {
        if (excludeIds.has(captureId)) {
            summary.skippedExcluded += 1;
            continue;
        }
        if (done.has(captureId)) {
            summary.resumed += 1;
            continue;
        }
        // The cap is checked before each paid call; the call that crosses
        // it still completes, so spending can overshoot by one call.
        if (summary.spentUsd >= maxCostUsd) {
            summary.stopped = 'cost';
            break;
        }
        if (limit > 0 && summary.labeled >= limit) {
            summary.stopped = 'limit';
            break;
        }
        let capture;
        try {
            capture = await loadCapture(capturesDir, captureId);
        } catch (error) {
            await append({capture_id: captureId, adapterId: adapter.id,
                error: error.message, failedAt: timestamp(input)});
            summary.failed += 1;
            summary.failures.push({capture_id: captureId, error: error.message});
            consecutiveErrors += 1;
            if (consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
                summary.stopped = 'errors';
                break;
            }
            continue;
        }
        try {
            const record = await runTeacher(adapter, capture,
                {fetchImpl: input?.fetchImpl, now: input?.now, maxChars, maxElements});
            summary.verification[record.verification.status] += 1;
            summary.spentUsd = Math.round((summary.spentUsd + record.costUsd) * 1e6) / 1e6;
            summary.labeled += 1;
            consecutiveErrors = 0;
            await append({capture_id: captureId, ...record});
        } catch (error) {
            await append({capture_id: captureId, adapterId: adapter.id,
                error: error.message, failedAt: timestamp(input)});
            summary.failed += 1;
            summary.failures.push({capture_id: captureId, error: error.message});
            consecutiveErrors += 1;
            if (consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
                summary.stopped = 'errors';
                break;
            }
            continue;
        }
        if (delayMs > 0) await sleep(delayMs);
    }
    return summary;
}

function timestamp(input) {
    return typeof input?.now === 'function' ? input.now() : new Date().toISOString();
}
