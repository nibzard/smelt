/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bounded rules agent loop (IDEA.md 3.2.1 through 3.2.7).
// Node-only factory code; the detect entry never imports this module.

import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

import {replayableElements, runFrozenSnapshot} from '@smelt-oss/capture/replay';
import {evaluate} from '@smelt-oss/pilot';
import {type} from '@smelt-oss/runtime';
import {rulesHash} from './model.mjs';

export const LOOP_SCHEMA_VERSION = 1;

export const DEFAULTS = Object.freeze({
    epsilon: 0.005,
    maxIterations: 600,
    consecutiveDiscardStop: 40,
    costCapUsd: 40,
    wallCapMs: 8 * 60 * 60 * 1000,
    sizeCapBytes: 15360,
    maxRules: 200,
    maxLines: 1000,
    pageLatencyCapMs: 200,
    digestPages: 20,
    digestSnippetChars: 1200,
    maxActivationNames: 200,
    parityHolds: true
});

// The runner injects the runtime itself, so the canonical runtime import
// line is permitted and stripped; every other import is forbidden
// (IDEA.md 3.2.3).
const RUNTIME_IMPORT = /^import\s*\{[^}]*\}\s*from\s*'@smelt-oss\/runtime';[ \t]*$/mg;
const RUNTIME_PATH = fileURLToPath(new URL('../runtime/index.mjs', import.meta.url));
const RUNTIME_PREFIX = `import {compile, dom, element, note, out, rule, ruleset, score, ` +
    `type, typeIn, atMost, utils} from '${RUNTIME_PATH}';\n`;

// A rules edit may not reach anything outside its own arithmetic and the
// DOM callbacks the runtime hands it (IDEA.md 3.2.3).
const FORBIDDEN_SOURCE = [
    [/\bimport\b/, 'import'],
    [/\bimport\s*\(/, 'dynamic import'],
    // After the canonical runtime import is stripped, no module request of
    // any kind may remain: import-from, re-export-from, or a bare
    // side-effect import. Data: URL re-exports carry hidden payloads.
    [/\bfrom\s*['"`]/, 'module specifier'],
    [/data:/i, 'data: URL'],
    [/\brequire\s*\(/, 'require call'],
    [/\beval\b/, 'eval reference'],
    [/\bnew\s+Function\b/, 'Function constructor'],
    [/\bFunction\b/, 'Function reference'],
    [/\bconstructor\b/, 'constructor access'],
    [/__proto__|__defineGetter__|lookupSetter/, 'prototype access'],
    [/[\w$\)]\s*\[\s*['"]/, 'computed string member access'],
    [/\bfetch\b/, 'network fetch'],
    [/XMLHttpRequest|WebSocket|EventSource/, 'network API'],
    [/\bprocess\b/, 'process global'],
    [/\bglobalThis\b/, 'globalThis'],
    [/node:|child_process|worker_threads/, 'Node API'],
    [/\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b/, 'storage API']
];

export class LoopError extends Error {
}

function compactNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function isoNow() {
    return new Date().toISOString();
}

function strippedSource(source) {
    return source.replace(RUNTIME_IMPORT, '');
}

/**
 * Reject unsafe or oversized rules sources before anything imports them.
 * The canonical @smelt-oss/runtime import is permitted; nothing else is.
 *
 * @param {string} source Candidate rules source.
 * @param {object} [limits] Overrides for the size limits.
 * @returns {object} {ok, issues: [{code, message}]}
 */
export function validateRulesSource(source, limits = {}) {
    const maxRules = limits.maxRules ?? DEFAULTS.maxRules;
    const maxLines = limits.maxLines ?? DEFAULTS.maxLines;
    const issues = [];
    if (typeof source !== 'string' || source.length === 0) {
        return {ok: false, issues: [{code: 'invalid-source',
            message: 'The rules source must be a nonempty string.'}]};
    }
    const body = strippedSource(source);
    for (const [pattern, label] of FORBIDDEN_SOURCE) {
        if (pattern.test(body)) {
            issues.push({code: 'unsafe-source', message: `Forbidden in rules: ${label}.`});
        }
    }
    const lines = source.split('\n').length;
    if (lines > maxLines) {
        issues.push({code: 'oversized-source',
            message: `Rules file has ${lines} lines; the cap is ${maxLines}.`});
    }
    const ruleCount = (body.match(/\brule\s*\(/g) ?? []).length;
    if (ruleCount > maxRules) {
        issues.push({code: 'oversized-source',
            message: `Rules file declares ${ruleCount} rules; the cap is ${maxRules}.`});
    }
    return {ok: issues.length === 0, issues};
}

function rulesExports(module) {
    return typeof module?.consentRules === 'function' &&
        typeof module?.vectorForConsentCandidate === 'function' &&
        Array.isArray(module?.RULE_NAMES) && module.RULE_NAMES.length > 0 &&
        typeof module?.CANDIDATE_TYPE === 'string';
}

/**
 * Import a candidate rules source from a scratch directory.
 * The runtime bindings are prepended by the runner, never fetched.
 * Callers must remove the returned directory.
 *
 * @param {string} source Candidate rules source.
 * @param {object} [limits] Size limits forwarded to validateRulesSource().
 * @returns {Promise<object>} {module, directory}
 */
export async function loadRulesModule(source, limits = {}) {
    const check = validateRulesSource(source, limits);
    if (!check.ok) {
        throw new LoopError(`Rules source rejected: ${check.issues[0].message}`);
    }
    const directory = await mkdtemp(join(tmpdir(), 'smelt-loop-'));
    const file = join(directory, `rules-${randomUUID()}.mjs`);
    await writeFile(file, RUNTIME_PREFIX + strippedSource(source), 'utf8');
    let module;
    try {
        module = await import(file);
    } catch (error) {
        await rm(directory, {recursive: true, force: true});
        throw new LoopError(`Rules source failed to import: ${error.message}`);
    }
    if (!rulesExports(module)) {
        await rm(directory, {recursive: true, force: true});
        throw new LoopError('Rules source must export CANDIDATE_TYPE, RULE_NAMES, ' +
            'consentRules, and vectorForConsentCandidate.');
    }
    return {module, directory};
}

function validateSplit(split, name) {
    const dataset = split?.labels;
    if (dataset?.schemaVersion !== 1) throw new LoopError(`Expected ${name} labels schemaVersion 1.`);
    if (dataset.split !== name) throw new LoopError(`Expected ${name} labels.`);
    if (!Array.isArray(dataset.pages) || dataset.pages.length === 0) {
        throw new LoopError(`Expected nonempty ${name} pages.`);
    }
    if (!Array.isArray(split?.captures) || split.captures.length === 0) {
        throw new LoopError(`Expected nonempty ${name} captures.`);
    }
    return {labels: dataset,
        captureById: new Map(split.captures.map(capture => [capture.id, capture]))};
}

function vectorizeSplit(module, split, name) {
    const {labels, captureById} = validateSplit(split, name);
    if (captureById.size !== labels.pages.length) {
        throw new LoopError(`Capture count does not match ${name} label count.`);
    }
    const rows = [];
    const scoredPages = [];
    let slowestPageMs = 0;
    let frameRootPages = 0;
    let phantomElements = 0;
    for (const page of labels.pages) {
        const capture = captureById.get(page.id);
        if (capture === undefined) throw new LoopError(`Missing capture for page: ${page.id}`);
        // A page whose acceptable roots all sit outside the replayable top
        // frame can neither produce nor score a correct root. In practice
        // the roots sit in other frame documents, but any non-replayable
        // root (under a skipped tag, for example) counts too. Skip the
        // page, count it, and leave it out of scoring. A page without any
        // acceptable root is a true negative, not a skip.
        const replayableIds = new Set(replayableElements(capture.snapshot).map(element => element.id));
        if (page.acceptableRoots.length > 0
                && !page.acceptableRoots.some(rootId => replayableIds.has(rootId))) {
            frameRootPages++;
            continue;
        }
        scoredPages.push(page);
        const start = performance.now();
        const replay = runFrozenSnapshot(module.consentRules(), capture.snapshot, capture.features);
        slowestPageMs = Math.max(slowestPageMs, performance.now() - start);
        phantomElements += replay.phantomCount;
        for (const fnode of replay.run.get(type(module.CANDIDATE_TYPE))) {
            const elementId = [...replay.elementsById.entries()]
                .find(([, element]) => element === fnode.element)?.[0];
            if (elementId === undefined) {
                throw new LoopError(`Candidate element was not in snapshot: ${page.id}`);
            }
            rows.push({
                pageId: page.id,
                group: page.group,
                elementId,
                label: page.acceptableRoots.includes(elementId) ? 1 : 0,
                vector: sanitizeVector(module, fnode, page.id)
            });
        }
    }
    if (rows.length === 0) throw new LoopError(`No candidate rows in ${name} split.`);
    return {rows, labels: {...labels, pages: scoredPages}, frameRootPages, phantomElements,
        slowestPageMs: compactNumber(slowestPageMs), captureById};
}

// The candidate module controls vectorForConsentCandidate, so its output is
// capped to the declared rule names and coerced to finite numbers before it
// reaches the digest or the log.
function sanitizeVector(module, fnode, pageId) {
    let raw;
    try {
        raw = module.vectorForConsentCandidate(fnode);
    } catch (error) {
        throw new LoopError(`vectorForConsentCandidate failed on ${pageId}: ${error.message}`);
    }
    const vector = {};
    for (const name of module.RULE_NAMES.slice(0, DEFAULTS.maxActivationNames)) {
        const value = Number(raw?.[name] ?? 0);
        vector[name] = Number.isFinite(value) ? value : 0;
    }
    return vector;
}

function scoreRows(module, rows) {
    const scores = new Map();
    for (const row of rows) {
        scores.set(row, module.RULE_NAMES.reduce(
            (sum, name) => sum + Number(row.vector[name] ?? 0), 0));
    }
    return scores;
}

function bestRowByPage(rows, scores) {
    const best = new Map();
    for (const row of rows) {
        const score = scores.get(row);
        const current = best.get(row.pageId);
        if (current === undefined || score > current.score ||
            (score === current.score && row.elementId < current.row.elementId)) {
            best.set(row.pageId, {row, score});
        }
    }
    return best;
}

function predictionsFor(labels, rows, scores, threshold) {
    const best = bestRowByPage(rows, scores);
    return labels.pages.map(page => {
        const entry = best.get(page.id);
        return {id: page.id,
            roots: entry !== undefined && entry.score >= threshold ? [entry.row.elementId] : []};
    });
}

function f1For(labels, rows, scores, threshold) {
    const dataset = {...labels, pages: labels.pages.map(page => ({
        id: page.id,
        group: page.group,
        hasBanner: page.hasBanner,
        acceptableRoots: page.acceptableRoots,
        exactRoot: page.exactRoot ?? page.acceptableRoots[0] ?? null
    }))};
    return evaluate(dataset, predictionsFor(labels, rows, scores, threshold)).detection.f1 ?? -1;
}

function selectThreshold(labels, rows, scores) {
    const values = [...new Set([...scores.values()])].sort((a, b) => a - b);
    const candidates = values.length > 0 ?
        [values[0] - 1, ...values, values[values.length - 1] + 1] : [0];
    let best = {threshold: candidates[0], f1: -1};
    for (const threshold of candidates) {
        const f1 = f1For(labels, rows, scores, threshold);
        if (f1 > best.f1 || (f1 === best.f1 && threshold > best.threshold)) {
            best = {threshold, f1};
        }
    }
    return best;
}

function ancestorPath(snapshot, elementId, cap = 8) {
    const byId = new Map(snapshot.elements.map(element => [element.id, element]));
    const parts = [];
    let current = byId.get(elementId);
    while (current && parts.length < cap) {
        parts.unshift(`${current.tagName}#${current.id}`);
        current = current.parentId ? byId.get(current.parentId) : null;
    }
    return parts.join(' > ');
}

function snippetFor(snapshot, elementId, cap) {
    const byId = new Map(snapshot.elements.map(element => [element.id, element]));
    let text = '';
    const visit = element => {
        if (text.length >= cap) return;
        if (element.textSample) text += ` ${element.textSample}`;
        for (const childId of element.children ?? []) {
            const child = byId.get(childId);
            if (child) visit(child);
        }
    };
    const root = byId.get(elementId);
    if (root) visit(root);
    return text.replace(/\s+/g, ' ').trim().slice(0, cap);
}

function nextActionFor(outcome, vector) {
    if (outcome === 'miss') return 'raise-recall';
    if (outcome === 'wrong-root') return 'sharpen-root-choice';
    if (outcome === 'false-positive') {
        return Number(vector['hard-negative'] ?? 0) < 0 ?
            'strengthen-existing-negative' : 'extend-hard-negatives';
    }
    return 'none';
}

/**
 * Project evaluation rows into the per-page results.jsonl records that both
 * the agent digest and the human review table read (IDEA.md 3.2.7). The best
 * candidate carries context even when it stays below the threshold, so a miss
 * still shows the agent what the rules saw.
 *
 * @param {object} labels Development labels.
 * @param {object[]} rows Candidate rows.
 * @param {Map} scores Row scores.
 * @param {number} threshold Selected threshold.
 * @param {Map} captureById Captures by page id.
 * @param {object} [options] {digestSnippetChars}
 * @returns {object[]} Per-page result records.
 */
export function buildResults(labels, rows, scores, threshold, captureById, options = {}) {
    const snippetChars = options.digestSnippetChars ?? DEFAULTS.digestSnippetChars;
    const best = bestRowByPage(rows, scores);
    return labels.pages.map(page => {
        const entry = best.get(page.id);
        const predicted = entry !== undefined && entry.score >= threshold ? entry.row : null;
        const bestRow = entry !== undefined ? entry.row : null;
        let outcome = 'tn';
        if (page.hasBanner && !predicted) outcome = 'miss';
        else if (page.hasBanner && predicted && !page.acceptableRoots.includes(predicted.elementId)) {
            outcome = 'wrong-root';
        } else if (!page.hasBanner && predicted) outcome = 'false-positive';
        else if (page.hasBanner && predicted) outcome = 'tp';
        const capture = captureById.get(page.id);
        return {
            pageId: page.id,
            group: page.group,
            hasBanner: page.hasBanner,
            outcome,
            predictedRoot: predicted ? predicted.elementId : null,
            acceptableRoots: page.acceptableRoots,
            nextAction: nextActionFor(outcome, bestRow ? bestRow.vector : {}),
            best: bestRow ? {
                elementId: bestRow.elementId,
                activations: bestRow.vector,
                score: compactNumber(entry.score),
                ancestorPath: capture ? ancestorPath(capture.snapshot, bestRow.elementId) : '',
                snippet: capture ? snippetFor(capture.snapshot, bestRow.elementId,
                    snippetChars) : ''
            } : null
        };
    });
}

const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the deterministic agent digest from results.jsonl records.
 *
 * @param {object[]} results Per-page result records from buildResults().
 * @param {object} [options] {maxPages}
 * @returns {object} Digest with failures, totals, and next-action counts.
 */
export function failureDigest(results, options = {}) {
    const maxPages = options.maxPages ?? options.digestPages ?? DEFAULTS.digestPages;
    const isFailure = result => result.outcome !== 'tp' && result.outcome !== 'tn';
    const failures = results
        .filter(isFailure)
        // Codepoint order, not locale order, keeps the capped page set
        // identical on every machine.
        .sort((a, b) => byCodepoint(a.nextAction, b.nextAction) ||
            byCodepoint(a.pageId, b.pageId))
        .slice(0, maxPages)
        .map(result => ({
            pageId: result.pageId,
            group: result.group,
            outcome: result.outcome,
            nextAction: result.nextAction,
            predictedRoot: result.predictedRoot,
            acceptableRoots: result.acceptableRoots,
            activations: result.best ? result.best.activations : null,
            ancestorPath: result.best ? result.best.ancestorPath : null,
            snippet: result.best ? result.best.snippet : null
        }));
    const nextActionCounts = {};
    for (const result of results) {
        if (result.nextAction !== 'none') {
            nextActionCounts[result.nextAction] = (nextActionCounts[result.nextAction] ?? 0) + 1;
        }
    }
    return {
        totals: {
            pages: results.length,
            failures: results.filter(isFailure).length
        },
        nextActionCounts,
        failures
    };
}

function diffLines(before, after) {
    const left = before.split('\n');
    const right = after.split('\n');
    // Longest common subsequence over lines; the 1,000-line cap keeps this
    // table under a million cells.
    const table = Array.from({length: left.length + 1},
        () => new Array(right.length + 1).fill(0));
    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            table[i][j] = left[i] === right[j] ?
                table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const hunks = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            hunks.push({op: ' ', line: left[i]});
            i++;
            j++;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            hunks.push({op: '-', line: left[i]});
            i++;
        } else {
            hunks.push({op: '+', line: right[j]});
            j++;
        }
    }
    while (i < left.length) hunks.push({op: '-', line: left[i++]});
    while (j < right.length) hunks.push({op: '+', line: right[j++]});
    return hunks;
}

/**
 * Build an agent that runs a command per iteration, mirroring the production
 * `claude -p --output-format json` bridge (IDEA.md 3.2.1). The command
 * receives {digest, rulesSource, program} on stdin and prints JSON with at
 * least {source}. Usage and cost pass through when present. A command that
 * runs past its timeout is killed and reported as an agent error.
 *
 * @param {string} command Executable to run per iteration.
 * @param {string[]} [args] Arguments for the executable.
 * @param {object} [options] {timeoutMs} Kill the command after this delay.
 * @returns {Function} Async agent function for runRulesLoop().
 */
export function createCommandAgent(command, args = [], options = {}) {
    const timeoutMs = options.timeoutMs ?? 600000;
    return async payload => {
        const child = spawn(command, args, {stdio: ['pipe', 'pipe', 'pipe']});
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        const timer = timeoutMs > 0 ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // A child that traps SIGTERM gets a hard kill and torn pipes.
            const killTimer = setTimeout(() => {
                child.kill('SIGKILL');
                child.stdout?.destroy();
                child.stderr?.destroy();
            }, 5000);
            killTimer.unref();
        }, timeoutMs) : null;
        const closed = new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', code => resolve({code, stderr}));
        });
        const written = new Promise((resolve, reject) => {
            child.stdin.on('error', reject);
            child.stdin.end(JSON.stringify(payload), 'utf8', resolve);
        });
        const [{code, stderr: exitError}] = await Promise.all([closed, written])
            .finally(() => {
                if (timer !== null) clearTimeout(timer);
            });
        if (timedOut) {
            throw new LoopError(`Agent command timed out after ${timeoutMs} ms.`);
        }
        if (code !== 0) {
            throw new LoopError(`Agent command exited with ${code}: ${exitError.trim().slice(0, 300)}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(stdout);
        } catch {
            throw new LoopError('Agent command did not print JSON.');
        }
        // `claude -p --output-format json` wraps the answer in a `result`
        // string and reports spend as `total_cost_usd` (IDEA.md 3.2.1).
        let answer = parsed;
        if (typeof parsed?.source !== 'string' && typeof parsed?.result === 'string') {
            try {
                answer = JSON.parse(parsed.result);
            } catch {
                throw new LoopError('Agent result is not JSON with a source field.');
            }
        }
        if (typeof answer?.source !== 'string') {
            throw new LoopError('Agent command must print JSON with a source field.');
        }
        return {
            source: answer.source,
            usage: answer.usage ?? parsed?.usage ?? null,
            costUsd: Number.isFinite(answer.costUsd) ? Math.max(0, answer.costUsd) :
                (Number.isFinite(parsed?.total_cost_usd) ? Math.max(0, parsed.total_cost_usd) : null)
        };
    };
}

async function evaluateRules(module, split) {
    const {rows, labels, frameRootPages, phantomElements, slowestPageMs, captureById} =
        vectorizeSplit(module, split, 'development');
    const scores = scoreRows(module, rows);
    const {threshold, f1} = selectThreshold(labels, rows, scores);
    return {rows, labels, frameRootPages, phantomElements, scores, threshold, f1,
        slowestPageMs, captureById};
}

/**
 * Run the bounded keep-or-discard loop over the development split. Every
 * iteration passes the digest and the incumbent source to the agent, then
 * gates the candidate in fixed order: safety, size, latency, dev F1. The
 * ratchet keeps a candidate only when its dev F1 beats the incumbent by at
 * least epsilon. The log records the diff, the gates, the usage, and the
 * verdict for every iteration (IDEA.md 3.2.2 through 3.2.4).
 *
 * @param {object} input {schemaVersion, development: {labels, captures}, program?}.
 * @param {object} options {agent, incumbentSource?, epsilon, maxIterations,
 *     consecutiveDiscardStop, costCapUsd, wallCapMs, sizeCapBytes,
 *     pageLatencyCapMs, parityHolds}.
 * @returns {Promise<object>} The experiment log.
 */
export async function runRulesLoop(input, options = {}) {
    if (input?.schemaVersion !== 1) throw new LoopError('Expected loop manifest schemaVersion 1.');
    if (!input.development) {
        throw new LoopError('Expected a development split; the loop scores dev data only.');
    }
    if (typeof options.agent !== 'function') {
        throw new LoopError('Pass an agent function or createCommandAgent(command).');
    }
    const config = {...DEFAULTS, ...options};
    const startedMs = performance.now();
    const incumbentSource = options.incumbentSource ?? await readFileAsString();
    // The incumbent loads through the same guarded path as every candidate.
    const incumbentScratch = await loadRulesModule(incumbentSource, config);
    let base;
    try {
        base = await evaluateRules(incumbentScratch.module, input.development);
    } finally {
        await rm(incumbentScratch.directory, {recursive: true, force: true});
    }
    let incumbent = {source: incumbentSource, f1: base.f1, threshold: base.threshold,
        rulesHash: rulesHash(incumbentSource)};
    let currentDigest = failureDigest(
        buildResults(base.labels, base.rows, base.scores, base.threshold, base.captureById,
            config),
        config);

    const log = {
        schemaVersion: LOOP_SCHEMA_VERSION,
        task: 'consent-banners',
        startedAt: isoNow(),
        config: {
            epsilon: config.epsilon,
            maxIterations: config.maxIterations,
            consecutiveDiscardStop: config.consecutiveDiscardStop,
            costCapUsd: config.costCapUsd,
            wallCapMs: config.wallCapMs,
            sizeCapBytes: config.sizeCapBytes,
            pageLatencyCapMs: config.pageLatencyCapMs,
            parityHolds: config.parityHolds
        },
        incumbent: {f1: compactNumber(base.f1), threshold: base.threshold,
            rulesHash: incumbent.rulesHash},
        iterations: [],
        stoppedFor: null
    };

    let consecutiveDiscards = 0;
    let spentUsd = 0;

    for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
        if (performance.now() - startedMs > config.wallCapMs) {
            log.stoppedFor = 'wall-cap';
            break;
        }
        if (spentUsd >= config.costCapUsd) {
            log.stoppedFor = 'cost-cap';
            break;
        }
        if (consecutiveDiscards >= config.consecutiveDiscardStop) {
            log.stoppedFor = 'consecutive-discards';
            break;
        }
        const entry = {iteration, verdict: 'discarded', reasons: [], gates: {}, usage: null,
            costUsd: null, diff: null, ms: null};
        const beforeSource = incumbent.source;
        const iterationStart = performance.now();
        let candidateSource = null;
        let agentError = null;
        try {
            const answer = await options.agent({
                digest: currentDigest,
                rulesSource: beforeSource,
                program: input.program ?? null,
                iteration
            });
            if (typeof answer?.source === 'string') candidateSource = answer.source;
            entry.usage = answer?.usage ?? null;
            entry.costUsd = Number.isFinite(answer?.costUsd) ?
                Math.max(0, answer.costUsd) : null;
            if (entry.costUsd !== null) spentUsd += entry.costUsd;
        } catch (error) {
            agentError = error.message;
        }

        if (agentError !== null) {
            entry.reasons.push(`agent-error: ${agentError}`);
        } else if (typeof candidateSource !== 'string') {
            entry.reasons.push('agent-error: the agent must return {source}.');
        } else {
            const safety = validateRulesSource(candidateSource, config);
            entry.gates.safety = {ok: safety.ok, issues: safety.issues};
            if (!safety.ok) {
                entry.reasons.push(`safety: ${safety.issues[0].message}`);
            }
            const gzippedBytes = safety.ok ?
                gzipSync(Buffer.from(candidateSource, 'utf8')).length : null;
            entry.gates.size = {
                ok: safety.ok && gzippedBytes < config.sizeCapBytes,
                gzippedBytes
            };
            if (safety.ok && gzippedBytes >= config.sizeCapBytes) {
                entry.reasons.push(`size: ${gzippedBytes} gzipped bytes is at or over the cap.`);
            }
            if (entry.reasons.length === 0 && !config.parityHolds) {
                entry.reasons.push('parity: the browser-versus-Node parity fixture has not passed.');
            }
            if (entry.reasons.length === 0) {
                let scratch = null;
                try {
                    scratch = await loadRulesModule(candidateSource, config);
                    const evaluated = await evaluateRules(scratch.module, input.development);
                    entry.gates.latency = {ok: evaluated.slowestPageMs < config.pageLatencyCapMs,
                        slowestPageMs: evaluated.slowestPageMs,
                        frameRootPages: evaluated.frameRootPages,
                        phantomElements: evaluated.phantomElements};
                    if (!entry.gates.latency.ok) {
                        entry.reasons.push(`latency: ${evaluated.slowestPageMs} ms on the slowest ` +
                            'page is at or over the cap.');
                    } else {
                        entry.gates.f1 = {f1: compactNumber(evaluated.f1),
                            incumbentF1: compactNumber(incumbent.f1)};
                        if (evaluated.f1 >= incumbent.f1 + config.epsilon) {
                            entry.verdict = 'kept';
                            incumbent = {source: candidateSource, f1: evaluated.f1,
                                threshold: evaluated.threshold,
                                rulesHash: rulesHash(candidateSource)};
                            currentDigest = failureDigest(
                                buildResults(evaluated.labels, evaluated.rows, evaluated.scores,
                                    evaluated.threshold, evaluated.captureById, config),
                                config);
                        } else {
                            entry.reasons.push(`ratchet: ${compactNumber(evaluated.f1)} is not ` +
                                `above the incumbent ${compactNumber(incumbent.f1)} ` +
                                `by ${config.epsilon}.`);
                        }
                    }
                } catch (error) {
                    entry.reasons.push(`evaluation-error: ${error.message}`);
                } finally {
                    if (scratch !== null) await rm(scratch.directory, {recursive: true, force: true});
                }
            }
            entry.diff = diffLines(beforeSource, candidateSource);
        }
        entry.ms = compactNumber(performance.now() - iterationStart);
        log.iterations.push(entry);
        consecutiveDiscards = entry.verdict === 'kept' ? 0 : consecutiveDiscards + 1;
    }
    if (log.stoppedFor === null) log.stoppedFor = 'max-iterations';
    log.finishedAt = isoNow();
    const kept = log.iterations.filter(entry => entry.verdict === 'kept').length;
    log.final = {
        f1: compactNumber(incumbent.f1),
        threshold: incumbent.threshold,
        rulesHash: incumbent.rulesHash,
        source: incumbent.source,
        kept,
        discarded: log.iterations.length - kept,
        changed: incumbent.source !== incumbentSource
    };
    log.totals = {
        iterations: log.iterations.length,
        wallMs: compactNumber(performance.now() - startedMs),
        spentUsd: compactNumber(spentUsd),
        f1Gain: compactNumber(incumbent.f1 - base.f1)
    };
    return log;
}

async function readFileAsString() {
    const {readFile} = await import('node:fs/promises');
    return readFile(fileURLToPath(new URL('./rules.mjs', import.meta.url)), 'utf8');
}
