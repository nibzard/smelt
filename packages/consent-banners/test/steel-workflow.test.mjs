/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';

import {runControlledSteelWorkflow} from '../steel-workflow.mjs';

class FakeSteelPage {
    constructor() {
        this.doc = parseHTML(`
            <!doctype html>
            <html><body>
                <main><h1>Example</h1></main>
                <section id="consent" role="dialog">
                    <p>We use cookies for analytics.</p>
                    <button>Accept</button>
                </section>
            </body></html>
        `).document;
        this.addedScripts = [];
        this.detected = false;
        this.doc.defaultView.__SmeltConsentSteelWorkflow = {
            detect: async document => {
                this.detected = true;
                return {
                    found: [document.querySelector('#consent')],
                    banner: {kind: 'dialog', evidence: ['banner-text'], score: 0.91},
                    stats: {ms: 3.25, elementsWalked: 7, truncated: false, tier: 0},
                    degraded: []
                };
            }
        };
    }

    async addScriptTag(script) {
        this.addedScripts.push(script);
    }

    async evaluate(callback, payload) {
        const previousDocument = globalThis.document;
        const previousNode = globalThis.Node;
        const previousCss = globalThis.CSS;
        const previousDetector = globalThis.__SmeltConsentSteelWorkflow;
        Object.defineProperty(globalThis, 'document', {value: this.doc, configurable: true});
        Object.defineProperty(globalThis, 'Node', {value: this.doc.defaultView.Node, configurable: true});
        Object.defineProperty(globalThis, 'CSS', {
            value: {escape: value => String(value).replace(/"/g, '\\"')},
            configurable: true
        });
        Object.defineProperty(globalThis, '__SmeltConsentSteelWorkflow', {
            value: this.doc.defaultView.__SmeltConsentSteelWorkflow,
            configurable: true
        });
        try {
            return await callback(payload);
        } finally {
            restore('document', previousDocument);
            restore('Node', previousNode);
            restore('CSS', previousCss);
            restore('__SmeltConsentSteelWorkflow', previousDetector);
        }
    }
}

function restore(name, value) {
    if (value === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, {value, configurable: true});
}

const fixedAgent = {
    model: 'steel-agent-model',
    promptHash: 'sha256-prompt',
    actionPolicyHash: 'sha256-policy'
};

test('runs Smelt detection before the fixed Steel workflow callback', async () => {
    const page = new FakeSteelPage();
    const calls = [];

    const record = await runControlledSteelWorkflow({
        page,
        caseId: 'case-1',
        fixedAgent,
        detectorAlreadyInstalled: true,
        workflow: async ({detection, fixedAgent: agent}) => {
            calls.push({detected: page.detected, detection, agent});
            return {
                completed: true,
                modelCalls: 2,
                totalCostUsd: 0.0123,
                browserMs: 420,
                workflowMs: 950,
                metadata: {route: 'baseline-policy'}
            };
        }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].detected, true);
    assert.equal(calls[0].detection.selectedElement.selector, 'html > body > section#consent');
    assert.deepEqual(calls[0].agent, fixedAgent);
    assert.equal(record.variant, 'smelt-assisted');
    assert.equal(record.metrics.taskCompleted, true);
    assert.equal(record.metrics.modelCalls, 2);
    assert.equal(record.metrics.totalWorkflowCostUsd, 0.0123);
    assert.equal(record.metrics.costPerCompletedTaskUsd, 0.0123);
    assert.equal(record.metrics.detectionMs, 3.25);
    assert.equal(typeof record.metrics.addedLatencyMs, 'number');
    assert.equal(record.workflow.metadata.route, 'baseline-policy');
});

test('records failed workflows without a completion cost denominator', async () => {
    const page = new FakeSteelPage();

    const record = await runControlledSteelWorkflow({
        page,
        caseId: 'case-2',
        fixedAgent,
        detectorAlreadyInstalled: true,
        workflow: async () => ({
            completed: false,
            modelCalls: 1,
            totalCostUsd: 0.004
        })
    });

    assert.equal(record.metrics.taskCompleted, false);
    assert.equal(record.metrics.modelCalls, 1);
    assert.equal(record.metrics.totalWorkflowCostUsd, 0.004);
    assert.equal(record.metrics.costPerCompletedTaskUsd, null);
});

test('requires fixed agent identity and workflow metrics', async () => {
    await assert.rejects(() => runControlledSteelWorkflow({
        page: new FakeSteelPage(),
        detectorAlreadyInstalled: true,
        fixedAgent: {
            model: 'steel-agent-model',
            promptHash: 'sha256-prompt'
        },
        workflow: async () => ({completed: true, modelCalls: 1, totalCostUsd: 0.01})
    }), /fixedAgent.actionPolicyHash/);

    await assert.rejects(() => runControlledSteelWorkflow({
        page: new FakeSteelPage(),
        detectorAlreadyInstalled: true,
        fixedAgent,
        workflow: async () => ({completed: true, modelCalls: -1, totalCostUsd: 0.01})
    }), /modelCalls/);
});
