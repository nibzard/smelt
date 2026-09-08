/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Corpus preparation for the consent-banner pilot (task T010). It reads the
// capture files that the Steel crawl wrote into corpus/, assigns every group
// to exactly one split, writes provisional label files whose entries all
// wait for human review, extends the review queue, and reports summary
// statistics. It makes no network requests and changes no capture files.

import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {validateSchema} from './schema-check.mjs';

export const SPLIT_RATIOS = {train: 0.6, development: 0.2, test: 0.2};
export const SPLITS = ['train', 'development', 'test'];

function sha256Hex(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function assignGroupsToSplits(groups, ratios = SPLIT_RATIOS) {
    const names = [...new Set(groups)].sort();
    // A hash order keeps the assignment deterministic without keeping state:
    // the same groups always land in the same splits.
    const ordered = names
        .map(name => ({name, key: sha256Hex(`smelt-split:${name}`)}))
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(entry => entry.name);
    const assignment = {};
    const trainCount = Math.round(ordered.length * ratios.train);
    const developmentCount = Math.round(ordered.length * ratios.development);
    for (const [index, name] of ordered.entries()) {
        assignment[name] = index < trainCount ? 'train'
            : index < trainCount + developmentCount ? 'development' : 'test';
    }
    return assignment;
}

export async function readCaptures(capturesDir) {
    const files = await readdir(capturesDir);
    const ids = [...new Set(files
        .filter(file => file.endsWith('.metadata.json'))
        .map(file => file.slice(0, -'.metadata.json'.length)))];
    ids.sort();
    const captures = [];
    for (const id of ids) {
        const metadata = JSON.parse(
            await readFile(path.join(capturesDir, `${id}.metadata.json`), 'utf8'));
        const snapshot = JSON.parse(
            await readFile(path.join(capturesDir, `${id}.snapshot.json`), 'utf8'));
        const features = JSON.parse(
            await readFile(path.join(capturesDir, `${id}.features.json`), 'utf8'));
        captures.push({
            id,
            group: metadata.group,
            url: metadata.url,
            egressLocation: metadata.egressLocation,
            capturedAt: metadata.capturedAt,
            observationMs: metadata.observationMs,
            browserVersion: metadata.browserVersion,
            expected: metadata.targetMetadata?.expect ?? null,
            expectedJurisdiction: metadata.targetMetadata?.jurisdiction ?? null,
            note: metadata.targetMetadata?.note ?? null,
            frames: snapshot.frames ?? [],
            elementCount: snapshot.elements?.length ?? 0,
            paths: {
                snapshot: path.join(capturesDir, `${id}.snapshot.json`),
                features: path.join(capturesDir, `${id}.features.json`),
                metadata: path.join(capturesDir, `${id}.metadata.json`)
            }
        });
    }
    return captures;
}

export async function readSessionReports(sessionsDir) {
    try {
        const files = (await readdir(sessionsDir)).filter(file => file.endsWith('.json'));
        files.sort();
        const reports = [];
        for (const file of files) {
            reports.push(JSON.parse(await readFile(path.join(sessionsDir, file), 'utf8')));
        }
        return reports;
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

export function summarizeSessions(reports) {
    return reports.reduce((totals, report) => ({
        sessions: totals.sessions + (report.sessions?.length ?? 0),
        captured: totals.captured + (report.captured ?? 0),
        failed: totals.failed + (report.failed ?? 0),
        skipped: totals.skipped + (report.skipped ?? 0),
        creditsUsed: totals.creditsUsed
            + (report.sessions ?? []).reduce((sum, s) => sum + (s.creditsUsed ?? 0), 0),
        proxyBytesUsed: totals.proxyBytesUsed
            + (report.sessions ?? []).reduce((sum, s) => sum + (s.proxyBytesUsed ?? 0), 0),
        browserMs: totals.browserMs
            + (report.sessions ?? []).reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
    }), {sessions: 0, captured: 0, failed: 0, skipped: 0,
        creditsUsed: 0, proxyBytesUsed: 0, browserMs: 0});
}

function labelStub(capture) {
    const notes = [
        `awaiting initial human label; expected ${capture.expected ?? 'unknown'}`,
        `captured from ${capture.egressLocation ?? 'unknown location'}`
    ];
    if (capture.note) notes.push(capture.note);
    return {
        id: capture.id,
        group: capture.group,
        label_status: 'unresolved',
        has_banner: null,
        acceptable_roots: [],
        banner_root: null,
        banner_kind: null,
        jurisdiction: null,
        frame: {state: 'unknown', frame_id: null, element_id: null},
        evidence: [],
        confidence: null,
        review_notes: notes.join('; ')
    };
}

export function reviewItems(captures) {
    return captures.map(capture => {
        const inaccessible = capture.frames.filter(frame => frame.accessible === false);
        const notes = [
            `expected ${capture.expected ?? 'unknown'}`,
            `location ${capture.egressLocation ?? 'unknown'}`,
            `${capture.elementCount} elements`
        ];
        if (inaccessible.length > 0) {
            notes.push(`${inaccessible.length} inaccessible frame(s)`);
        }
        if (capture.note) notes.push(capture.note);
        return {
            capture_id: capture.id,
            group: capture.group,
            reason: inaccessible.length > 0
                ? 'initial label; capture has inaccessible frames'
                : 'initial label: no teacher label exists yet',
            source: inaccessible.length > 0 ? 'frame_inaccessible' : 'human_flag',
            snapshot_path: capture.paths.snapshot,
            notes: notes.join('; ')
        };
    });
}

export async function mergeReviewQueue(queuePath, items) {
    const existing = JSON.parse(await readFile(queuePath, 'utf8'));
    const known = new Set(existing.items.map(item => item.capture_id));
    const additions = items.filter(item => !known.has(item.capture_id));
    const merged = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        items: [...existing.items, ...additions].sort((a, b) =>
            a.capture_id.localeCompare(b.capture_id))
    };
    await writeFile(queuePath, `${JSON.stringify(merged, null, 2)}\n`);
    return {added: additions.length, total: merged.items.length};
}

function countBy(values) {
    return values.reduce((counts, value) => {
        const key = String(value);
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
    }, {});
}

export function buildCorpusArtifacts(captures, sessionReports, ratios = SPLIT_RATIOS) {
    const groups = captures.map(capture => capture.group);
    const assignment = assignGroupsToSplits(groups, ratios);

    const manifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        policy: {
            groupSplit: 'one registrable-domain or enterprise group appears in exactly one split',
            ratios,
            assignment: 'sha256 group hash order, deterministic'
        },
        splits: {train: [], development: [], test: []}
    };
    const labels = {train: [], development: [], test: []};
    for (const capture of captures) {
        const split = assignment[capture.group];
        manifest.splits[split].push({
            id: capture.id,
            group: capture.group,
            egressLocation: capture.egressLocation,
            expected: capture.expected,
            snapshot: capture.paths.snapshot,
            features: capture.paths.features,
            metadata: capture.paths.metadata
        });
        labels[split].push(labelStub(capture));
    }

    const splitStats = {};
    for (const split of SPLITS) {
        const splitCaptures = captures.filter(capture => assignment[capture.group] === split);
        splitStats[split] = {
            pages: splitCaptures.length,
            groups: new Set(splitCaptures.map(capture => capture.group)).size,
            byEgressLocation: countBy(splitCaptures.map(capture => capture.egressLocation)),
            byExpectedClass: countBy(splitCaptures.map(capture => capture.expected ?? 'unknown'))
        };
    }

    const inaccessibleFrames = captures.reduce((sum, capture) =>
        sum + capture.frames.filter(frame => frame.accessible === false).length, 0);
    const stats = {
        schemaVersion: 1,
        generatedAt: manifest.generatedAt,
        captures: captures.length,
        groups: new Set(groups).size,
        byEgressLocation: countBy(captures.map(capture => capture.egressLocation)),
        byExpectedClass: countBy(captures.map(capture => capture.expected ?? 'unknown')),
        splits: splitStats,
        inaccessibleFrameCaptures: captures.filter(capture =>
            capture.frames.some(frame => frame.accessible === false)).length,
        inaccessibleFrames,
        labelStatus: {reviewed: 0, unresolved: captures.length},
        teacherLabels: 0,
        browser: summarizeSessions(sessionReports),
        notes: [
            'expected classes are recipe hints for balance, not labels',
            'every label is unresolved until human review records acceptable roots',
            'the test split stays out of agent-loop inputs (IDEA.md 3.2.4)'
        ]
    };
    return {manifest, labels, stats};
}

export async function prepareCorpus(options = {}) {
    const capturesDir = options.capturesDir ?? 'corpus/captures';
    const sessionsDir = options.sessionsDir ?? 'corpus/sessions';
    const outDir = options.outDir ?? 'corpus';
    const queuePath = options.queuePath ?? 'tasks/consent-banners/review-queue.json';

    const captures = await readCaptures(capturesDir);
    if (captures.length === 0) {
        throw new Error(`no captures found under ${capturesDir}`);
    }
    const labelsSchema = JSON.parse(await readFile(
        options.labelsSchemaPath ?? 'tasks/consent-banners/labels.schema.json', 'utf8'));
    const queueSchema = JSON.parse(await readFile(
        options.queueSchemaPath ?? 'tasks/consent-banners/review-queue.schema.json', 'utf8'));
    const ids = new Set();
    for (const capture of captures) {
        if (ids.has(capture.id)) throw new Error(`duplicate capture id ${capture.id}`);
        ids.add(capture.id);
    }
    const sessionReports = await readSessionReports(sessionsDir);
    const {manifest, labels, stats} = buildCorpusArtifacts(captures, sessionReports,
        options.ratios ?? SPLIT_RATIOS);

    for (const split of SPLITS) {
        if (labels[split].length === 0) continue;
        const document = {schema_version: 1, split, pages: labels[split]};
        const errors = validateSchema(document, labelsSchema);
        if (errors.length > 0) {
            throw new Error(`label file for ${split} violates the canonical schema:\n`
                + errors.join('\n'));
        }
    }
    const queueProblems = reviewItems(captures)
        .flatMap(item => validateSchema(item, queueSchema.$defs.item));
    if (queueProblems.length > 0) {
        throw new Error(`review queue items violate the canonical schema:\n`
            + queueProblems.join('\n'));
    }

    const manifestsDir = path.join(outDir, 'manifests');
    const labelsDir = path.join(manifestsDir, 'labels');
    await mkdir(labelsDir, {recursive: true});
    await writeFile(path.join(manifestsDir, 'splits.json'),
        `${JSON.stringify(manifest, null, 2)}\n`);
    for (const split of SPLITS) {
        // The canonical label schema requires at least one page, so an
        // empty split gets no label file. The manifest lists it as empty.
        if (labels[split].length === 0) continue;
        await writeFile(path.join(labelsDir, `${split}.labels.json`),
            `${JSON.stringify({schema_version: 1, split, pages: labels[split]}, null, 2)}\n`);
    }
    await mkdir(path.join(outDir, 'stats'), {recursive: true});
    await writeFile(path.join(outDir, 'stats', 'pilot-corpus-stats.json'),
        `${JSON.stringify(stats, null, 2)}\n`);
    const queue = await mergeReviewQueue(queuePath, reviewItems(captures));

    return {manifest, stats, queue};
}
