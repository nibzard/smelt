/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// CLI entry: run one paid-tier teacher over the review queue and append a
// proposal record per page. Run from the repository root, because the
// default relative paths resolve against the working directory:
//
//   node packages/consent-banners/teacher-labels-cli.mjs \
//     --captures corpus/captures \
//     --queue tasks/consent-banners/review-queue.json \
//     --manifest corpus/manifests/splits.json \
//     --teacher anthropic \
//     --out runs/teacher-labels/anthropic.jsonl
//
// The output holds proposals for the human reviewer, never labels. Pass
// --manifest so the frozen test captures stay teacher-free; a real run
// refuses to start without it, and --dry-run serializes and estimates the
// cost without an API key.

import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {anthropicTeacher, geminiTeacher} from './teacher.mjs';
import {runTeacherBatch} from './teacher-labels.mjs';

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}

function numeric(name, fallback) {
    const raw = option(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        console.error(`--${name} expects a number, received "${raw}".`);
        process.exit(1);
    }
    return value;
}

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}

// The split manifest lists capture ids and paths, not labels, so reading
// it keeps the frozen test set out of teacher reach without opening the
// test labels file (IDEA.md 3.2.4 and 3.3.6). A manifest without a test
// split array is refused rather than treated as "nothing to exclude": a
// wrong or stale manifest path must stop the batch, not silently send the
// frozen test pages to the vendor.
async function testCaptureIds(manifestPath, requireSplit) {
    if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
        if (requireSplit) {
            throw new Error('Missing --manifest. Pass the split manifest so the '
                + 'frozen test captures are excluded; without it every queue '
                + 'item, test pages included, goes to the teacher.');
        }
        return [];
    }
    const manifest = await readJson(manifestPath);
    const testSplit = manifest?.splits?.test;
    if (requireSplit && !Array.isArray(testSplit)) {
        throw new Error(`${manifestPath} has no splits.test array; it is not the `
            + 'split manifest this command needs, so no capture is provably '
            + 'excluded from teaching.');
    }
    const ids = (Array.isArray(testSplit) ? testSplit : [])
        .map(entry => entry?.id)
        .filter(id => typeof id === 'string');
    if (ids.length === 0) {
        console.error('Warning: the manifest declares no test captures; '
            + 'nothing was excluded from teaching.');
    }
    return ids;
}

function buildTeacher(name) {
    if (name === 'anthropic') return anthropicTeacher();
    if (name === 'gemini') return geminiTeacher();
    console.error(`Unknown teacher "${name}"; expected anthropic or gemini.`);
    process.exit(1);
}

const USAGE = `Usage: node teacher-labels-cli.mjs --teacher anthropic|gemini
  --out path/to/proposals.jsonl
  --manifest corpus/manifests/splits.json
  [--captures corpus/captures] [--queue tasks/consent-banners/review-queue.json]
  [--max-cost 40] [--limit 0] [--delay-ms 500]
  [--max-chars 120000] [--max-elements 2500]
  [--dry-run]  serialize and estimate cost; needs no API key, no --manifest`;

try {
    const dryRun = process.argv.includes('--dry-run');
    const teacherName = option('teacher');
    const outPath = option('out');
    if (!dryRun && typeof outPath !== 'string') {
        console.error('Missing --out for the proposals file.');
        console.error(USAGE);
        process.exit(1);
    }
    if (!dryRun && typeof teacherName !== 'string') {
        console.error('Missing --teacher; expected anthropic or gemini.');
        console.error(USAGE);
        process.exit(1);
    }
    const queue = await readJson(option('queue', 'tasks/consent-banners/review-queue.json'));
    if (!Array.isArray(queue?.items)) {
        throw new Error('The queue file holds no items array.');
    }
    const excludeIds = await testCaptureIds(option('manifest'), !dryRun);
    const summary = await runTeacherBatch({
        adapter: dryRun ? null : buildTeacher(teacherName),
        capturesDir: option('captures', 'corpus/captures'),
        items: queue.items,
        outPath,
        dryRun,
        excludeIds,
        delayMs: numeric('delay-ms', undefined),
        maxCostUsd: numeric('max-cost', undefined),
        limit: numeric('limit', 0),
        maxChars: numeric('max-chars', undefined),
        maxElements: numeric('max-elements', undefined),
        onRecord: record => {
            if (record.labels) {
                console.log(`${record.capture_id} ${record.verification.status} `
                    + `${record.costUsd} USD`);
            } else {
                console.log(`${record.capture_id} ERROR ${record.error}`);
            }
        }
    });
    console.log(JSON.stringify(summary));
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
