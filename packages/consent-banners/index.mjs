/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import modelArtifact from './model.smelt.json' with {type: 'json'};
import {readModelArtifact, scoreCandidates} from '@smelt-oss/runtime';
import {type} from '@smelt-oss/runtime';
import {CANDIDATE_TYPE, consentRules, vectorForConsentCandidate} from './rules.mjs';

export const VERSION = '0.0.0';

const DEFAULT_MAX_ELEMENTS = 20000;

let parsedModel;

export class SmeltError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}

export class UnsupportedInputError extends SmeltError {
}

export class ModelArtifactError extends SmeltError {
}

function now() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function') ?
        performance.now() :
        Date.now();
}

function fallbackRect() {
    return {
        x: 0,
        y: 0,
        top: 0,
        right: 1024,
        bottom: 160,
        left: 0,
        width: 1024,
        height: 160
    };
}

function fallbackStyle() {
    return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position: 'static',
        zIndex: 'auto'
    };
}

function ensureDetectionDom(doc, forceFallbackLayout = false) {
    const view = doc.defaultView ?? doc.parentWindow;
    if (view === undefined) return;
    if (typeof view.innerWidth !== 'number') {
        Object.defineProperty(view, 'innerWidth', {configurable: true, value: 1024});
    }
    if (typeof view.innerHeight !== 'number') {
        Object.defineProperty(view, 'innerHeight', {configurable: true, value: 768});
    }
    if (typeof view.getComputedStyle !== 'function') {
        view.getComputedStyle = fallbackStyle;
    }
    for (const element of doc.querySelectorAll('*')) {
        if (forceFallbackLayout || typeof element.getBoundingClientRect !== 'function') {
            Object.defineProperty(element, 'getBoundingClientRect', {
                configurable: true,
                value: fallbackRect
            });
        }
    }
}

function normalizeInput(input) {
    if (input?.documentElement) return {doc: input, syntheticLayout: false};
    if (typeof input !== 'string') {
        throw new UnsupportedInputError('detect() expects a Document or an HTML string.');
    }
    if (typeof DOMParser === 'function') {
        return {doc: new DOMParser().parseFromString(input, 'text/html'), syntheticLayout: true};
    }
    return null;
}

async function documentFrom(input) {
    const normalized = normalizeInput(input);
    if (normalized !== null) return normalized;
    const {parseHTML} = await import('linkedom');
    return {
        doc: parseHTML(input, {url: 'https://smelt.local/'}).document,
        syntheticLayout: true
    };
}

function model() {
    if (parsedModel !== undefined) return parsedModel;
    try {
        parsedModel = readModelArtifact(modelArtifact);
    } catch (error) {
        throw new ModelArtifactError(`Bundled consent model is invalid: ${error.message}`);
    }
    return parsedModel;
}

function rootSize(fnode) {
    return fnode.element.querySelectorAll('*').length + 1;
}

function bannerKind(element, vector) {
    if (vector.role > 0 || element.tagName === 'DIALOG') return 'dialog';
    if (vector.position > 0) return 'banner';
    return 'notice';
}

function evidenceFor(vector) {
    return Object.entries(vector)
        .filter(([, value]) => Number(value) > 0)
        .map(([name]) => name);
}

function emptyResult(start, degraded, stats = {}) {
    return {
        found: null,
        banner: null,
        stats: {
            ms: now() - start,
            elementsWalked: 0,
            truncated: false,
            tier: 0,
            rulesExecuted: 0,
            candidates: 0,
            scoreMs: 0,
            ...stats
        },
        degraded
    };
}

/**
 * Detect the primary visible consent notice in a Document or HTML string.
 *
 * @param {Document|string} input Page document or HTML source.
 * @returns {Promise<object>} Detection result with found, banner, stats, and degraded.
 */
export async function detect(input) {
    const start = now();
    const degraded = [];
    let doc;
    let syntheticLayout = false;
    try {
        ({doc, syntheticLayout} = await documentFrom(input));
        if (!doc?.documentElement) {
            return emptyResult(start, ['missing-document']);
        }
        ensureDetectionDom(doc, syntheticLayout);
    } catch (error) {
        if (error instanceof SmeltError) throw error;
        return emptyResult(start, ['parse-failed'], {error: error.message});
    }

    const rules = consentRules();
    let run;
    let candidates;
    try {
        run = rules.against(doc, {maxElements: DEFAULT_MAX_ELEMENTS});
        candidates = run.get(type(CANDIDATE_TYPE));
    } catch (error) {
        return emptyResult(start, ['rule-evaluation-failed'], {error: error.message});
    }

    if (run.stats.truncated) degraded.push('element-budget-exceeded');
    const scored = scoreCandidates(model(), candidates, vectorForConsentCandidate, {rootSize});
    const best = scored.best;
    return {
        found: best ? [best.element] : null,
        banner: best ? {
            element: best.element,
            kind: bannerKind(best.element, vectorForConsentCandidate(best)),
            evidence: evidenceFor(vectorForConsentCandidate(best)),
            score: scored.scored.find(item => item.candidate === best)?.score ?? null
        } : null,
        stats: {
            ms: now() - start,
            elementsWalked: run.stats.elementsWalked,
            truncated: run.stats.truncated,
            tier: run.stats.tier,
            rulesExecuted: run.stats.rulesExecuted,
            candidates: scored.stats.candidates,
            scoreMs: scored.stats.ms
        },
        degraded
    };
}
