/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';

import {captureFrozenSnapshot} from '@smelt-oss/capture';
import {
    LoopError,
    buildResults,
    createCommandAgent,
    failureDigest,
    loadRulesModule,
    runRulesLoop,
    validateRulesSource
} from '../loop.mjs';

const viewport = {width: 1200, height: 900, deviceScaleFactor: 1};
const shippedRules = await readFile(
    fileURLToPath(new URL('../rules.mjs', import.meta.url)), 'utf8');

function parse(html) {
    return parseHTML(html, {url: 'https://example.test/'}).document;
}

function layout(rect, position = 'static', zIndex = 'auto') {
    return {
        rect: {
            x: rect.x, y: rect.y, top: rect.y,
            right: rect.x + rect.width, bottom: rect.y + rect.height,
            left: rect.x, width: rect.width, height: rect.height
        },
        style: {display: 'block', visibility: 'visible', opacity: '1', position, zIndex}
    };
}

function installLayout(doc, byId) {
    const fallback = layout({x: 0, y: 0, width: 640, height: 160});
    for (const element of doc.querySelectorAll('*')) {
        const data = byId.get(element.id) ?? fallback;
        Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => data.rect
        });
    }
    doc.defaultView.getComputedStyle = element => (byId.get(element.id) ?? fallback).style;
    Object.defineProperty(doc.defaultView, 'innerWidth', {configurable: true, value: viewport.width});
    Object.defineProperty(doc.defaultView, 'innerHeight', {configurable: true, value: viewport.height});
}

function makeCapture(id, html, layoutById, label) {
    const doc = parse(html);
    installLayout(doc, layoutById);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: id,
        capturedAt: '2026-09-07T23:40:00Z',
        viewport
    });
    const root = label.rootDomId ?
        snapshot.elements.find(element => element.attributes.id === label.rootDomId)?.id : null;
    return {
        capture: {id, snapshot, features},
        page: {
            id,
            group: label.group,
            hasBanner: root !== null,
            acceptableRoots: root ? [root] : [],
            exactRoot: root
        }
    };
}

function consentPage(id, group, text = 'We use cookies for analytics.') {
    return makeCapture(id, `
        <html><body>
            <main id="content"><h1>Example</h1></main>
            <section id="consent" role="dialog" aria-modal="true">
                <p>${text}</p>
                <button>Accept all</button>
                <button>Manage choices</button>
            </section>
        </body></html>
    `, new Map([
        ['content', layout({x: 80, y: 80, width: 700, height: 380})],
        ['consent', layout({x: 0, y: 650, width: 1200, height: 250}, 'fixed', '2147483647')]
    ]), {group, rootDomId: 'consent'});
}

function negativePage(id, group, html, rootId) {
    return makeCapture(id, html, new Map([
        [rootId, layout({x: 320, y: 180, width: 430, height: 230}, 'fixed', '1001')]
    ]), {group, rootDomId: null});
}

function newsletterPage(id, group) {
    return negativePage(id, group, `
        <html><body>
            <div id="newsletter" role="dialog">
                <p>Subscribe to our newsletter.</p>
                <button>Sign up</button>
            </div>
        </body></html>
    `, 'newsletter');
}

function developmentSplit() {
    return {
        labels: {
            schemaVersion: 1,
            split: 'development',
            pages: [
                consentPage('dev-positive', 'example-d', 'We use cookies and personalized ads.').page,
                newsletterPage('dev-newsletter', 'example-e').page
            ]
        },
        captures: [
            consentPage('dev-positive', 'example-d', 'We use cookies and personalized ads.').capture,
            newsletterPage('dev-newsletter', 'example-e').capture
        ]
    };
}

// A weak incumbent: it promotes every dialog-shaped element without reading
// text, so the newsletter page becomes a false positive.
const WEAK_SOURCE = `import {dom, out, rule, ruleset, type} from '@smelt-oss/runtime';

export const CANDIDATE_TYPE = 'consentCandidate';
export const RULE_NAMES = ['candidate'];

export function consentRules() {
    return ruleset([
        rule(dom('section, div[role="dialog"]'), type('consentCandidate').score(1), {name: 'candidate'}),
        rule(type('consentCandidate').max(), out('consentCandidates'))
    ]);
}

export function vectorForConsentCandidate(fnode) {
    return {candidate: fnode.scoresSoFarFor('consentCandidate').get('candidate') ?? 0};
}
`;

function manifest() {
    return {schemaVersion: 1, development: developmentSplit()};
}

function recordingAgent(answers) {
    const payloads = [];
    const agent = async payload => {
        payloads.push(payload);
        const answer = answers[Math.min(payloads.length - 1, answers.length - 1)];
        return typeof answer === 'function' ? answer(payload) : answer;
    };
    return {agent, payloads};
}

test('validateRulesSource permits only the canonical runtime import', async () => {
    const shipped = validateRulesSource(shippedRules);
    assert.equal(shipped.ok, true);
    assert.deepEqual(shipped.issues, []);

    const forbidden = [
        [`import fs from 'node:fs';\nexport const A = 1;`, 'import'],
        [`const m = await import('./other.mjs');\nexport const A = m;`, 'import'],
        ['export const A = eval("1 + 1");', 'eval call'],
        ['export const A = fetch("https://example.test/");', 'network fetch'],
        ['export const A = process.env.HOME;', 'process global'],
        ['export const A = localStorage;', 'storage API'],
        ['export const A = [].constructor.constructor("return 1");', 'constructor access'],
        ['export const A = Function("return 1");', 'Function reference'],
        ['export const A = ({}).__proto__;', 'prototype access'],
        [`const v = globalThis['process'];`, 'computed string member access'],
        [`const v = rules['inner helper'];`, 'computed string member access'],
        [`const u = 'data:text/javascript,1;';`, 'data: URL'],
        [`export*from'data:text/javascript;base64,${Buffer.from('1;').toString('base64')}';`,
            'module specifier'],
        [`import'data:text/javascript,1;';`, 'import']
    ];
    for (const [source, label] of forbidden) {
        const check = validateRulesSource(source);
        assert.equal(check.ok, false, `rejects ${label}`);
        assert.ok(check.issues.every(issue => issue.code === 'unsafe-source'));
    }

    const manyRules = `export const A = [\n${'rule(1),\n'.repeat(201)}];\n`;
    assert.equal(validateRulesSource(manyRules).ok, false);
    assert.ok(validateRulesSource(manyRules).issues
        .some(issue => issue.code === 'oversized-source' && issue.message.includes('201 rules')));

    const manyLines = `export const A = 1;\n${'\n'.repeat(1000)}`;
    assert.equal(validateRulesSource(manyLines).ok, false);

    assert.deepEqual(validateRulesSource(42).issues[0].code, 'invalid-source');
    assert.deepEqual(validateRulesSource('').issues[0].code, 'invalid-source');
});

test('loadRulesModule imports and validates candidate exports', async () => {
    const shipped = await loadRulesModule(shippedRules);
    assert.equal(typeof shipped.module.consentRules, 'function');
    assert.equal(shipped.module.RULE_NAMES.length, 8);
    await rm(shipped.directory, {recursive: true, force: true});

    await assert.rejects(loadRulesModule('export const A = 1;'), /must export/);
    await assert.rejects(loadRulesModule('export const A = {'), /failed to import/);
});

test('runRulesLoop keeps a real improvement and discards the rest', async () => {
    const unsafe = `import fs from 'node:fs';\nexport const A = fs;`;
    const {agent, payloads} = recordingAgent([
        {source: shippedRules, costUsd: 0.01, usage: {inputTokens: 1000, outputTokens: 500}},
        {source: shippedRules},
        {source: unsafe}
    ]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: WEAK_SOURCE,
        maxIterations: 3
    });

    assert.equal(log.schemaVersion, 1);
    assert.equal(log.stoppedFor, 'max-iterations');
    assert.deepEqual(log.iterations.map(entry => entry.verdict), ['kept', 'discarded', 'discarded']);
    assert.deepEqual(log.iterations[0].reasons, []);
    // The weak incumbent ties at thresholds 0 and 1, so the higher one wins;
    // the shipped rules separate the pages at 15.
    assert.equal(log.incumbent.threshold, 1);
    assert.equal(log.incumbent.f1, 0.666667);
    assert.equal(log.final.threshold, 15);
    assert.deepEqual(log.iterations[0].gates.f1, {f1: 1, incumbentF1: 0.666667});
    assert.equal(log.iterations[0].costUsd, 0.01);
    assert.deepEqual(log.iterations[0].usage, {inputTokens: 1000, outputTokens: 500});
    assert.ok(log.iterations[1].reasons[0].startsWith('ratchet:'));
    assert.ok(log.iterations[2].reasons[0].startsWith('safety:'));
    assert.equal(log.iterations[2].gates.safety.ok, false);
    assert.equal(log.iterations[2].gates.latency, undefined);
    assert.ok(log.iterations[0].diff.some(hunk => hunk.op === '+' && hunk.line.includes('banner-text')));

    assert.equal(log.final.kept, 1);
    assert.equal(log.final.discarded, 2);
    assert.equal(log.final.changed, true);
    assert.equal(log.final.source, shippedRules);
    assert.equal(log.final.f1, 1);
    assert.ok(log.final.rulesHash.length > 0);
    assert.equal(log.totals.iterations, 3);
    assert.equal(log.totals.spentUsd, 0.01);
    assert.ok(log.totals.f1Gain > 0.3);

    // The first digest describes the weak incumbent's failures.
    const firstDigest = payloads[0].digest;
    assert.equal(firstDigest.totals.pages, 2);
    assert.equal(firstDigest.totals.failures, 1);
    const failure = firstDigest.failures[0];
    assert.equal(failure.pageId, 'dev-newsletter');
    assert.equal(failure.outcome, 'false-positive');
    assert.equal(failure.nextAction, 'extend-hard-negatives');
    assert.ok(failure.snippet.includes('Subscribe to our newsletter'));
    assert.ok(failure.ancestorPath.includes('div'));
    assert.deepEqual(failure.activations, {candidate: 1});
    // The second digest reflects the improved incumbent.
    assert.equal(payloads[1].digest.totals.failures, 0);
    // The agent always receives the current incumbent source and no program.
    assert.equal(payloads[0].rulesSource, WEAK_SOURCE);
    assert.equal(payloads[1].rulesSource, shippedRules);
    assert.equal(payloads[0].program, null);
});

test('runRulesLoop stops at the cost cap', async () => {
    const {agent} = recordingAgent([{source: shippedRules, costUsd: 30}]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: WEAK_SOURCE,
        maxIterations: 5,
        costCapUsd: 40
    });
    assert.equal(log.stoppedFor, 'cost-cap');
    assert.equal(log.totals.iterations, 2);
    assert.equal(log.totals.spentUsd, 60);
    assert.deepEqual(log.iterations.map(entry => entry.verdict), ['kept', 'discarded']);
});

test('runRulesLoop stops after consecutive discards', async () => {
    const {agent} = recordingAgent([{source: shippedRules}]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: shippedRules,
        maxIterations: 10,
        consecutiveDiscardStop: 2
    });
    assert.equal(log.stoppedFor, 'consecutive-discards');
    assert.equal(log.totals.iterations, 2);
    assert.equal(log.final.kept, 0);
    assert.equal(log.final.changed, false);
    assert.equal(log.final.source, shippedRules);
});

test('runRulesLoop stops at the wall cap before the first iteration', async () => {
    const {agent} = recordingAgent([{source: shippedRules}]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: shippedRules,
        wallCapMs: 0
    });
    assert.equal(log.stoppedFor, 'wall-cap');
    assert.equal(log.totals.iterations, 0);
});

test('runRulesLoop discards slow candidates at the latency gate', async () => {
    const {agent} = recordingAgent([{source: shippedRules}]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: WEAK_SOURCE,
        maxIterations: 1,
        pageLatencyCapMs: 0.0001
    });
    assert.equal(log.iterations[0].verdict, 'discarded');
    assert.ok(log.iterations[0].reasons[0].startsWith('latency:'));
    assert.equal(log.iterations[0].gates.latency.ok, false);
    assert.ok(log.iterations[0].gates.latency.slowestPageMs >= 0);
    assert.equal(log.iterations[0].gates.f1, undefined);
    assert.equal(log.final.changed, false);
});

test('runRulesLoop discards oversized candidates at the size gate', async () => {
    const {agent} = recordingAgent([{source: shippedRules}]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: WEAK_SOURCE,
        maxIterations: 1,
        sizeCapBytes: 10
    });
    assert.ok(log.iterations[0].reasons[0].startsWith('size:'));
    assert.equal(log.iterations[0].gates.size.ok, false);
    assert.ok(log.iterations[0].gates.size.gzippedBytes > 10);
    assert.equal(log.iterations[0].gates.latency, undefined);
});

test('runRulesLoop keeps nothing while parity does not hold', async () => {
    const {agent} = recordingAgent([{source: shippedRules}]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: WEAK_SOURCE,
        maxIterations: 1,
        parityHolds: false
    });
    assert.ok(log.iterations[0].reasons[0].startsWith('parity:'));
    assert.equal(log.iterations[0].verdict, 'discarded');
    assert.equal(log.iterations[0].gates.f1, undefined);
});

test('runRulesLoop records agent failures as discards', async () => {
    const boom = async () => {
        throw new Error('rate limited');
    };
    const log = await runRulesLoop(manifest(), {
        agent: boom,
        incumbentSource: shippedRules,
        maxIterations: 1
    });
    assert.ok(log.iterations[0].reasons[0].startsWith('agent-error: rate limited'));
    assert.equal(log.iterations[0].verdict, 'discarded');

    const nonString = recordingAgent([{source: 42}]).agent;
    const second = await runRulesLoop(manifest(), {
        agent: nonString,
        incumbentSource: shippedRules,
        maxIterations: 1
    });
    assert.equal(second.iterations[0].reasons[0], 'agent-error: the agent must return {source}.');
});

test('runRulesLoop discards candidates that fail during evaluation', async () => {
    const throwing = `export const CANDIDATE_TYPE = 'consentCandidate';
export const RULE_NAMES = ['candidate'];
export function consentRules() { throw new Error('boom'); }
export function vectorForConsentCandidate() { return {}; }
`;
    const {agent} = recordingAgent([{source: throwing}]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: shippedRules,
        maxIterations: 1
    });
    assert.equal(log.iterations[0].verdict, 'discarded');
    assert.ok(log.iterations[0].reasons[0].startsWith('evaluation-error: boom'));
    assert.equal(log.final.changed, false);
});

test('runRulesLoop validates its manifest and options', async () => {
    await assert.rejects(runRulesLoop({development: developmentSplit()}, {}),
        /schemaVersion 1/);
    await assert.rejects(runRulesLoop({schemaVersion: 1}, {}),
        /development split/);
    await assert.rejects(runRulesLoop(manifest(), {}),
        /agent function/);
    await assert.rejects(runRulesLoop({
        schemaVersion: 1,
        development: {labels: {schemaVersion: 2, split: 'development', pages: []}, captures: []}
    }, {agent: async () => ({source: 'x'})}), LoopError);
});

test('failureDigest sorts, caps, and counts deterministically', () => {
    const record = (pageId, outcome, nextAction, withBest) => ({
        pageId, group: 'g', hasBanner: true, outcome, predictedRoot: withBest ? 'e2' : null,
        acceptableRoots: ['e3'], nextAction,
        best: withBest ? {elementId: 'e2', activations: {candidate: 1}, score: 1,
            ancestorPath: 'html#e0 > body#e1 > div#e2', snippet: 'text'} : null
    });
    const results = [
        record('page-a', 'tp', 'none', true),
        record('page-c', 'false-positive', 'extend-hard-negatives', true),
        record('page-b', 'miss', 'raise-recall', false),
        record('page-d', 'wrong-root', 'sharpen-root-choice', true),
        record('page-e', 'false-positive', 'strengthen-existing-negative', true)
    ];
    const digest = failureDigest(results, {maxPages: 3});
    assert.equal(digest.totals.pages, 5);
    assert.equal(digest.totals.failures, 4);
    assert.deepEqual(digest.nextActionCounts, {
        'extend-hard-negatives': 1,
        'raise-recall': 1,
        'sharpen-root-choice': 1,
        'strengthen-existing-negative': 1
    });
    assert.equal(digest.failures.length, 3);
    assert.deepEqual(digest.failures.map(failure => failure.pageId),
        ['page-c', 'page-b', 'page-d']);
    assert.equal(digest.failures[0].snippet, 'text');
    assert.equal(digest.failures[1].snippet, null);
    assert.equal(JSON.stringify(failureDigest(results, {maxPages: 3})),
        JSON.stringify(digest));
});

test('createCommandAgent bridges a command with JSON stdio', async () => {
    const script = `
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => {
            const payload = JSON.parse(chunks.join(''));
            if (!payload.digest || typeof payload.rulesSource !== 'string' ||
                    payload.program !== null) {
                process.exit(3);
            }
            process.stdout.write(JSON.stringify(
                {source: payload.rulesSource, costUsd: 0.5, usage: {turns: 1}}));
        });
    `;
    const {agent, payloads} = recordingAgent([createCommandAgent(process.execPath, ['-e', script])]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: shippedRules,
        maxIterations: 1
    });
    assert.equal(log.totals.iterations, 1);
    assert.equal(log.iterations[0].costUsd, 0.5);
    assert.deepEqual(log.iterations[0].usage, {turns: 1});
    assert.ok(log.iterations[0].reasons[0].startsWith('ratchet:'));
    assert.equal(payloads.length, 1);
});

test('createCommandAgent reports command failures', async () => {
    const failing = createCommandAgent(process.execPath, ['-e', 'process.exit(2)']);
    await assert.rejects(failing({digest: {}, rulesSource: ''}), /exited with 2/);
    const notJson = createCommandAgent(process.execPath,
        ['-e', 'process.stdout.write("nope")']);
    await assert.rejects(notJson({digest: {}, rulesSource: ''}), /did not print JSON/);
    const noSource = createCommandAgent(process.execPath,
        ['-e', 'process.stdout.write("{}")']);
    await assert.rejects(noSource({digest: {}, rulesSource: ''}), /source field/);
    const hanging = createCommandAgent(process.execPath,
        ['-e', 'setTimeout(() => {}, 60000)'], {timeoutMs: 50});
    await assert.rejects(hanging({digest: {}, rulesSource: ''}), /timed out after 50/);
});

test('createCommandAgent unwraps the claude -p result envelope', async () => {
    const script = `
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => {
            const payload = JSON.parse(chunks.join(''));
            process.stdout.write(JSON.stringify({
                result: JSON.stringify({source: payload.rulesSource}),
                usage: {turns: 2},
                total_cost_usd: 1.25
            }));
        });
    `;
    const agent = createCommandAgent(process.execPath, ['-e', script]);
    const answer = await agent({digest: {}, rulesSource: 'export const A = 1;'});
    assert.equal(answer.source, 'export const A = 1;');
    assert.equal(answer.costUsd, 1.25);
    assert.deepEqual(answer.usage, {turns: 2});

    const broken = createCommandAgent(process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify({result: "not json"}))']);
    await assert.rejects(broken({digest: {}, rulesSource: ''}), /result is not JSON/);
});

test('runRulesLoop clamps negative agent cost to zero', async () => {
    const {agent} = recordingAgent([
        {source: shippedRules, costUsd: -5},
        {source: shippedRules, costUsd: Number.NaN}
    ]);
    const log = await runRulesLoop(manifest(), {
        agent,
        incumbentSource: shippedRules,
        maxIterations: 2
    });
    assert.equal(log.iterations[0].costUsd, 0);
    assert.equal(log.iterations[1].costUsd, null);
    assert.equal(log.totals.spentUsd, 0);
});

test('buildResults breaks score ties on the lower element id', () => {
    const labels = {pages: [{id: 'page-tie', group: 'g', hasBanner: true,
        acceptableRoots: ['e5']}]};
    const rows = [
        {pageId: 'page-tie', group: 'g', elementId: 'e9', label: 0, vector: {candidate: 1}},
        {pageId: 'page-tie', group: 'g', elementId: 'e5', label: 1, vector: {candidate: 1}}
    ];
    const scores = new Map(rows.map(row => [row, 1]));
    const results = buildResults(labels, rows, scores, 1, new Map());
    assert.equal(results[0].predictedRoot, 'e5');
    assert.equal(results[0].outcome, 'tp');
    assert.equal(results[0].best.elementId, 'e5');
});

test('buildResults and failureDigest keep digest fields within bounds', () => {
    // A 40-element ancestor chain and about 24,000 characters of text: the
    // digest must cap the path at 8 parts, the snippet at 1,200 characters,
    // and the failure list at the default 20 pages.
    const elements = [];
    for (let i = 0; i < 40; i++) {
        elements.push({id: `e${i}`, tagName: 'div', parentId: i === 0 ? null : `e${i - 1}`,
            children: i === 39 ? [] : [`e${i + 1}`], textSample: 'x'.repeat(600)});
    }
    const snapshot = {elements};
    const labels = {pages: []};
    const rows = [];
    const scores = new Map();
    const captureById = new Map();
    for (let i = 0; i < 25; i++) {
        const id = `page-${String(i).padStart(2, '0')}`;
        labels.pages.push({id, group: 'g', hasBanner: true, acceptableRoots: []});
        const row = {pageId: id, group: 'g', elementId: 'e39', label: 0, vector: {candidate: 1}};
        rows.push(row);
        scores.set(row, 5);
        captureById.set(id, {snapshot});
    }
    const results = buildResults(labels, rows, scores, 100, captureById);
    assert.equal(results.length, 25);
    assert.ok(results.every(result => result.outcome === 'miss'));
    assert.ok(results.every(result => result.best.ancestorPath.split(' > ').length === 8));
    assert.ok(results.every(result => result.best.snippet.length <= 1200));

    const digest = failureDigest(results);
    assert.equal(digest.totals.failures, 25);
    assert.equal(digest.failures.length, 20);
    assert.deepEqual(digest.failures.map(failure => failure.pageId),
        Array.from({length: 20}, (_, i) => `page-${String(i).padStart(2, '0')}`));
});

test('runRulesLoop removes every scratch directory it creates', async () => {
    const scratchDirs = async () => (await readdir(tmpdir()))
        .filter(name => name.startsWith('smelt-loop-'));
    const before = await scratchDirs();
    const throwing = `export const CANDIDATE_TYPE = 'consentCandidate';
export const RULE_NAMES = ['candidate'];
export function consentRules() { throw new Error('boom'); }
export function vectorForConsentCandidate() { return {}; }
`;
    const {agent} = recordingAgent([{source: shippedRules}, {source: throwing}]);
    await runRulesLoop(manifest(), {
        agent,
        incumbentSource: WEAK_SOURCE,
        maxIterations: 2
    });
    const after = await scratchDirs();
    assert.deepEqual(after, before);
});
