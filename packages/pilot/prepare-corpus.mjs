/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Corpus preparation for the consent-banner pilot (task T010). It reads the
// capture files that the Steel crawl wrote into corpus/, assigns every group
// to exactly one split, writes provisional label files whose entries all
// wait for human review, extends the review queue, and reports summary
// statistics. It makes no network requests and changes no capture files.

import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {commitStaged, stageWrite} from './atomic-write.mjs';
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

export const AUTO_STUB_NOTE_PREFIX = 'awaiting initial human label';

export async function readExistingLabels(labelsDir) {
    const existing = {};
    for (const split of SPLITS) {
        existing[split] = new Map();
        const file = path.join(labelsDir, `${split}.labels.json`);
        let document;
        try {
            document = JSON.parse(await readFile(file, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            continue;
        }
        // These files are the only record of human work, so anything that
        // is not the document this command writes is a stop, not a zero:
        // a wrong shape used to read as "no pages" and the re-run
        // replaced the file with fresh stubs.
        if (document === null || typeof document !== 'object'
                || Array.isArray(document) || !Array.isArray(document.pages)) {
            throw new Error(`${file} is not a labels document with a pages `
                + 'array; fix the file by hand and run labels:doctor. '
                + 'No file was merged or written.');
        }
        if (document.split !== split) {
            throw new Error(`${file} declares split `
                + `${JSON.stringify(document.split)}, expected ${split}; fix the `
                + 'file by hand and run labels:doctor. No file was merged '
                + 'or written.');
        }
        for (const [index, page] of document.pages.entries()) {
            if (page === null || typeof page !== 'object' || Array.isArray(page)
                    || typeof page.id !== 'string') {
                throw new Error(`${file} page ${index} is not a record with a `
                    + 'string id; fix the file by hand and run labels:doctor. '
                    + 'No file was merged or written.');
            }
            if (existing[split].has(page.id)) {
                // A paste below the stub instead of over it. Keeping the
                // last entry silently discarded the human record, so the
                // run stops before any write.
                throw new Error(`duplicate page id ${page.id} in ${file}; fix `
                    + 'the duplicated record and run labels:doctor. '
                    + 'No file was merged or written.');
            }
            existing[split].set(page.id, page);
        }
    }
    return existing;
}

// Human work in the existing label files survives a re-run. A reviewed
// record is kept verbatim. An unresolved record is kept when its notes no
// longer start with the generated stub prefix, which means a person wrote
// something beyond the automatic text. Any other status cannot come from
// the stub writer, so it is kept too: the schema check at the end of the
// run then names the file, and a typo in a hand edit cannot silently
// delete the record by turning it back into a stub.
export function isHumanTouched(page) {
    if (page === null || typeof page !== 'object') return false;
    if (page.label_status === 'reviewed') return true;
    if (page.label_status === 'unresolved') {
        return typeof page.review_notes === 'string'
            && page.review_notes.length > 0
            && !page.review_notes.startsWith(AUTO_STUB_NOTE_PREFIX);
    }
    return true;
}

/**
 * Merge fresh stubs with preserved human records.
 *
 * @arg freshLabels {object} Fresh stub pages keyed by split.
 * @arg existing {object} Maps of split to existing page records.
 * @return {object} {labels, report} with preserved, moved, and dropped ids.
 */
export function mergeCorpusLabels(freshLabels, existing) {
    const byId = new Map();
    for (const [split, pageMap] of Object.entries(existing)) {
        for (const [id, page] of pageMap) {
            if (byId.has(id)) {
                throw new Error(`duplicate page id ${id} in existing label files`);
            }
            byId.set(id, {page, split});
        }
    }
    const labels = {train: [], development: [], test: []};
    const report = {preservedReviewed: 0, preservedUnresolved: 0, moved: [], dropped: []};
    for (const split of SPLITS) {
        for (const stub of freshLabels[split]) {
            const record = byId.get(stub.id);
            if (record && isHumanTouched(record.page)) {
                labels[split].push(record.page);
                if (record.page.label_status === 'reviewed') report.preservedReviewed++;
                else report.preservedUnresolved++;
                if (record.split !== split) {
                    report.moved.push({id: stub.id, from: record.split, to: split});
                }
            } else {
                labels[split].push(stub);
            }
            byId.delete(stub.id);
        }
    }
    // Anything left has no capture anymore: a capture was removed or
    // renamed, so the page record has nothing to label.
    report.dropped = [...byId.keys()].sort();
    return {labels, report};
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
    const fresh = new Map(items.map(item => [item.capture_id, item]));
    // Queue entries are derived from capture metadata, never hand-edited,
    // so a re-run refreshes them: the first corpus run left four items
    // with the group an older capture metadata carried.
    let updated = 0;
    const mergedItems = existing.items.map(item => {
        const next = fresh.get(item.capture_id);
        if (!next) return item;
        updated++;
        return next;
    });
    const additions = items.filter(item => !known.has(item.capture_id));
    const merged = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        items: [...mergedItems, ...additions].sort((a, b) =>
            a.capture_id.localeCompare(b.capture_id))
    };
    await writeFile(queuePath, `${JSON.stringify(merged, null, 2)}\n`);
    return {added: additions.length, updated, total: merged.items.length};
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
            capturedAt: capture.capturedAt,
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
    const {manifest, labels: freshLabels, stats} = buildCorpusArtifacts(captures,
        sessionReports, options.ratios ?? SPLIT_RATIOS);

    // Pastes by the human reviewer live in the existing label files. Keep
    // them; only pages that still carry the automatic stub text regenerate.
    const labelsDir = path.join(outDir, 'manifests', 'labels');
    const existing = await readExistingLabels(labelsDir);
    const {labels, report: labelMerge} = mergeCorpusLabels(freshLabels, existing);
    // A re-crawl overwrites capture files under the same id. A preserved
    // reviewed label was written against the old content, so the run
    // refuses instead of silently carrying the label to pages the
    // reviewer never saw. The previous run's manifest — kept as .bak by
    // the staged write — supplies the capturedAt the label was reviewed
    // against; the check starts with the first run that leaves a .bak.
    let previousManifest = null;
    try {
        previousManifest = JSON.parse(await readFile(
            path.join(outDir, 'manifests', 'splits.json.bak'), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (previousManifest !== null) {
        const capturedAtOf = (document) => {
            const byId = new Map();
            for (const split of SPLITS) {
                for (const entry of document.splits?.[split] ?? []) {
                    if (typeof entry?.id === 'string') byId.set(entry.id, entry.capturedAt);
                }
            }
            return byId;
        };
        const before = capturedAtOf(previousManifest);
        const after = capturedAtOf(manifest);
        const recrawled = [];
        for (const split of SPLITS) {
            for (const page of labels[split]) {
                if (page.label_status !== 'reviewed') continue;
                if (before.has(page.id) && before.get(page.id) !== after.get(page.id)) {
                    recrawled.push(page.id);
                }
            }
        }
        if (recrawled.length > 0) {
            throw new Error(`capture ${recrawled[0]} was re-crawled after its review `
                + '(capturedAt changed); the reviewed label was written against '
                + 'different content. Re-review the page or remove its record, '
                + `then run again. Affected: ${recrawled.sort().join(', ')}. `
                + 'No file was written.');
        }
    }
    const statusCounts = countBy(SPLITS.flatMap(split =>
        labels[split].map(page => page.label_status)));
    stats.labelStatus = {
        reviewed: statusCounts.reviewed ?? 0,
        unresolved: statusCounts.unresolved ?? 0
    };

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
    await mkdir(labelsDir, {recursive: true});
    // Every guarded file is staged before any commit, and the split
    // manifest commits last: a crash mid-sequence leaves at most a labels
    // and manifest pair that labels:doctor flags loudly, never a
    // truncated human-labels file. Each staged write keeps a .bak of the
    // previous content; corpus/ is outside version control, so no other
    // recovery path exists.
    const staged = [];
    for (const split of SPLITS) {
        // The canonical label schema requires at least one page, so an
        // empty split gets no label file. The manifest lists it as empty.
        if (labels[split].length === 0) continue;
        const file = path.join(labelsDir, `${split}.labels.json`);
        await stageWrite(file,
            `${JSON.stringify({schema_version: 1, split, pages: labels[split]}, null, 2)}\n`);
        staged.push(file);
    }
    const splitsPath = path.join(manifestsDir, 'splits.json');
    await stageWrite(splitsPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const file of staged) await commitStaged(file);
    await commitStaged(splitsPath);
    // A split that emptied holds only records whose captures moved or
    // disappeared; moved records are preserved in their new split, and
    // dropped ones are named in the merge report. The stale file
    // otherwise wedges every later run: readExistingLabels loads it, and
    // the cross-file duplicate guard aborts before any write.
    for (const split of SPLITS) {
        if (labels[split].length > 0) continue;
        const file = path.join(labelsDir, `${split}.labels.json`);
        await unlink(file).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
    await mkdir(path.join(outDir, 'stats'), {recursive: true});
    await writeFile(path.join(outDir, 'stats', 'pilot-corpus-stats.json'),
        `${JSON.stringify(stats, null, 2)}\n`);
    const queue = await mergeReviewQueue(queuePath, reviewItems(captures));

    return {manifest, stats, queue, labelMerge};
}
