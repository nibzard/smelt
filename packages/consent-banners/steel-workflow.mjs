/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const DEFAULT_DETECTOR_GLOBAL = '__SmeltConsentSteelWorkflow';

function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object.`);
    }
    return value;
}

function requireString(value, name) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${name} must be a nonempty string.`);
    }
    return value.trim();
}

function requireFunction(value, name) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function.`);
    return value;
}

function finiteNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`${name} must be a nonnegative number.`);
    }
    return number;
}

function integer(value, name) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new TypeError(`${name} must be a nonnegative integer.`);
    }
    return number;
}

function compactNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function normalizeFixedAgent(input) {
    const agent = requireObject(input, 'fixedAgent');
    return {
        model: requireString(agent.model, 'fixedAgent.model'),
        promptHash: requireString(agent.promptHash, 'fixedAgent.promptHash'),
        actionPolicyHash: requireString(agent.actionPolicyHash, 'fixedAgent.actionPolicyHash')
    };
}

function normalizeWorkflowResult(result) {
    const value = requireObject(result, 'workflow result');
    const completed = Boolean(value.completed);
    const modelCalls = integer(value.modelCalls ?? 0, 'workflow result modelCalls');
    const totalCostUsd = finiteNumber(value.totalCostUsd ?? value.costUsd ?? 0,
        'workflow result totalCostUsd');
    return {
        completed,
        modelCalls,
        totalCostUsd,
        browserMs: value.browserMs === undefined ? null :
            compactNumber(finiteNumber(value.browserMs, 'workflow result browserMs')),
        workflowMs: value.workflowMs === undefined ? null :
            compactNumber(finiteNumber(value.workflowMs, 'workflow result workflowMs')),
        metadata: value.metadata ?? {}
    };
}

async function detectInPage(page, detectorGlobal) {
    return await page.evaluate(async globalName => {
        const cssSegment = element => {
            const tagName = element.tagName.toLowerCase();
            const escape = globalThis.CSS?.escape ?? (value => String(value).replace(/"/g, '\\"'));
            if (element.id) return `${tagName}#${escape(element.id)}`;
            const parent = element.parentElement;
            if (!parent) return tagName;
            const siblings = Array.from(parent.children)
                .filter(child => child.tagName === element.tagName);
            if (siblings.length === 1) return tagName;
            return `${tagName}:nth-of-type(${siblings.indexOf(element) + 1})`;
        };
        const detector = globalThis[globalName];
        if (typeof detector?.detect !== 'function') {
            throw new Error(`Detector global "${globalName}" is not installed.`);
        }
        const result = await detector.detect(document);
        const element = result.found?.[0] ?? null;
        const selector = element === null ? null : [];
        let current = element;
        while (current !== null && current.nodeType === Node.ELEMENT_NODE) {
            selector.unshift(cssSegment(current));
            current = current.parentElement;
        }
        return {
            found: element !== null,
            selectedElement: element === null ? null : {
                selector: selector.join(' > '),
                tagName: element.tagName.toLowerCase(),
                id: element.id || null,
                role: element.getAttribute('role'),
                textSample: String(element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
            },
            banner: result.banner === null ? null : {
                kind: result.banner.kind,
                evidence: result.banner.evidence,
                score: result.banner.score
            },
            stats: result.stats,
            degraded: result.degraded
        };
    }, detectorGlobal);
}

async function createDetectorBundle() {
    let build;
    try {
        ({build} = await import('esbuild'));
    } catch {
        throw new Error('esbuild is not installed. Run npm install before the Steel workflow pilot.');
    }
    const dir = await mkdtemp(resolve(tmpdir(), 'smelt-steel-workflow-'));
    const outfile = resolve(dir, 'consent-steel-workflow.js');
    await build({
        entryPoints: [resolve(dirname(fileURLToPath(import.meta.url)), 'index.mjs')],
        outfile,
        bundle: true,
        format: 'iife',
        globalName: DEFAULT_DETECTOR_GLOBAL,
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent'
    });
    return {dir, outfile, globalName: DEFAULT_DETECTOR_GLOBAL};
}

async function installDetector(page, options) {
    if (options.detectorAlreadyInstalled) {
        return {globalName: options.detectorGlobal ?? DEFAULT_DETECTOR_GLOBAL, cleanup: async () => {}};
    }
    const globalName = options.detectorGlobal ?? DEFAULT_DETECTOR_GLOBAL;
    const scriptPath = options.detectorScriptPath;
    if (scriptPath) {
        await page.addScriptTag({path: scriptPath});
        return {globalName, cleanup: async () => {}};
    }
    const bundle = await createDetectorBundle();
    await page.addScriptTag({path: bundle.outfile});
    return {
        globalName: bundle.globalName,
        cleanup: () => rm(bundle.dir, {recursive: true, force: true})
    };
}

/**
 * Run Smelt detection before the caller's fixed Steel agent workflow.
 *
 * The caller owns the model request, prompts, action policy, and page actions.
 * This helper only installs the detector, returns the selected root reference,
 * and records pilot metrics around that handoff.
 *
 * @param {object} options Controlled workflow options.
 * @returns {Promise<object>} A workflow record for the Steel pilot.
 */
export async function runControlledSteelWorkflow(options) {
    const value = requireObject(options, 'options');
    const page = requireObject(value.page, 'options.page');
    const workflow = requireFunction(value.workflow, 'options.workflow');
    const fixedAgent = normalizeFixedAgent(value.fixedAgent);
    const caseId = requireString(value.caseId ?? 'steel-case', 'options.caseId');
    const detector = await installDetector(page, value);
    const startedAt = new Date().toISOString();

    try {
        const detectionStart = performance.now();
        const detection = await detectInPage(page, detector.globalName);
        const addedLatencyMs = performance.now() - detectionStart;
        const workflowResult = normalizeWorkflowResult(await workflow({
            page,
            detection,
            fixedAgent
        }));
        return {
            schemaVersion: 1,
            task: 'consent-banners',
            caseId,
            variant: 'smelt-assisted',
            startedAt,
            completedAt: new Date().toISOString(),
            fixedAgent,
            detection,
            metrics: {
                taskCompleted: workflowResult.completed,
                modelCalls: workflowResult.modelCalls,
                totalWorkflowCostUsd: compactNumber(workflowResult.totalCostUsd),
                costPerCompletedTaskUsd: workflowResult.completed ?
                    compactNumber(workflowResult.totalCostUsd) : null,
                addedLatencyMs: compactNumber(addedLatencyMs),
                detectionMs: compactNumber(detection.stats?.ms ?? addedLatencyMs),
                browserMs: workflowResult.browserMs,
                workflowMs: workflowResult.workflowMs
            },
            workflow: {
                metadata: workflowResult.metadata
            }
        };
    } finally {
        await detector.cleanup();
    }
}
