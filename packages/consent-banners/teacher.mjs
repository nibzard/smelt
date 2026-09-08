/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Teacher adapters for corpus labeling (IDEA.md 3.3.4 and 3.3.5).
// Node-only factory code; the detect entry never imports this module.

import {createHash} from 'node:crypto';
import {SmeltError} from './index.mjs';

export const PROMPT_VERSION = 1;

const DEFAULT_MAX_CHARS = 120000;
const DEFAULT_MAX_ELEMENTS = 2500;
const TEXT_CAP = 120;
const EVIDENCE_CAP = 200;
const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link',
    'img', 'br', 'hr', 'source', 'track', 'path', 'use', 'circle', 'rect', 'g'
]);

export class TeacherError extends SmeltError {
}

export class TeacherResponseError extends TeacherError {
}

export class MissingApiKeyError extends TeacherError {
}

const TASK_TEXT = `You label frozen web pages for consent-banner detection training data.
The input is a sanitized DOM serialization. Each line looks like:
  e42 div .cookie-banner role=dialog [640x220@320,180] fixed "We value your privacy"
Find the primary visible consent or cookie notice, if one exists.
Rules:
- banner_root must contain the notice and its controls, and nothing unrelated.
- Never choose the html or body element, or a container that holds the whole page.
- Newsletter popups, age gates, sign-in walls, and cookie-policy footer links
  are not consent banners.
- A hidden or dismissed notice is not present.
Answer with JSON only:
{"has_banner": boolean, "banner_root": "e123" or null,
 "banner_kind": "banner"|"dialog"|"platform"|"custom"|"unknown",
 "jurisdiction": "eea"|"us"|"unknown",
 "confidence": number between 0 and 1,
 "evidence": [{"kind": "text", "value": "quoted text", "element_id": "e123"}]}
Use banner_root null, banner_kind "unknown", and empty evidence when
has_banner is false.`;

function sha256Hex(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isElementId(value) {
    return typeof value === 'string' && /^e[0-9]+$/.test(value);
}

function clampText(text, cap) {
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    return normalized.length <= cap ? normalized : `${normalized.slice(0, cap - 1)}…`;
}

// Page-controlled strings must not forge the structured fields of a line.
const UNSAFE_CHARS = {'"': "'", '=': ':', '[': '(', ']': ')'};

function sanitizeToken(text, cap) {
    return clampText(String(text).replace(/["=[\]]/g, ch => UNSAFE_CHARS[ch]), cap);
}

function isNotRendered(layout) {
    return layout.display === 'none' || layout.opacity === 0;
}

/**
 * Serialize a frozen capture into the canonical teacher input.
 *
 * Hidden subtrees, head noise, and drawing elements are stripped. Attribute
 * values are dropped except class tokens and role, free text is capped per
 * element, and the total size is capped. This is the prompt-injection defense
 * from IDEA.md 3.5.6: structure carries the label signal, not page prose.
 *
 * @param {object} snapshot Frozen DOM snapshot.
 * @param {object} features Frozen feature file.
 * @param {object} [options] Size caps.
 * @returns {object} Serialization with text, elementIds, and stripping stats.
 */
export function serializeForTeacher(snapshot, features, options = {}) {
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
    if (!Array.isArray(snapshot?.elements) || !isElementId(snapshot.rootElementId)) {
        throw new TeacherError('serializeForTeacher expects a frozen snapshot.');
    }
    if (!Array.isArray(features?.elements)) {
        throw new TeacherError('serializeForTeacher expects a frozen feature file.');
    }

    const snapshotById = new Map(snapshot.elements.map(element => [element.id, element]));
    const featuresById = new Map(features.elements.map(element => [element.id, element]));
    const stats = {elements: 0, included: 0, skippedHidden: 0, skippedTags: 0,
        skippedFrames: 0, truncated: false};
    const elementIds = new Set();
    const lines = [];
    let usedChars = 0;

    const emit = line => {
        lines.push(line);
        usedChars += line.length + 1;
    };
    const formatLine = (element, indent) => {
        const feature = featuresById.get(element.id);
        const intrinsic = feature?.intrinsic;
        const layout = feature?.layout;
        const parts = [element.id, element.tagName];
        if (intrinsic?.classTokens?.length > 0) {
            parts.push(sanitizeToken(`.${intrinsic.classTokens.slice(0, 3).join('.')}`, 60));
        }
        if (intrinsic?.role) parts.push(`role=${sanitizeToken(intrinsic.role, 60)}`);
        if (layout?.rect) {
            const {x, y, width, height} = layout.rect;
            parts.push(`[${Math.round(width)}x${Math.round(height)}@${Math.round(x)},${Math.round(y)}]`);
        }
        if (layout?.isFixed) parts.push('fixed');
        else if (layout?.isSticky) parts.push('sticky');
        const text = sanitizeToken(element.textSample ?? '', TEXT_CAP);
        if (text) parts.push(`"${text}"`);
        return `${' '.repeat(indent)}${parts.join(' ')}`;
    };

    // display:none and opacity:0 cannot be undone by descendants. A
    // visibility:hidden element can still render visible descendants, so the
    // walk keeps descending and each descendant's own visibility decides.
    const walkChildren = (element, indent) => {
        for (const childId of element.children ?? []) {
            const child = snapshotById.get(childId);
            if (child) walk(child, indent + 2);
        }
    };
    const walk = (element, indent) => {
        stats.elements += 1;
        const layout = featuresById.get(element.id)?.layout;
        if (layout && isNotRendered(layout)) {
            stats.skippedHidden += 1;
            return;
        }
        if (SKIP_TAGS.has(element.tagName)) {
            stats.skippedTags += 1;
            return;
        }
        if (layout?.visibility === 'hidden') {
            stats.skippedHidden += 1;
            walkChildren(element, indent + 2);
            return;
        }
        if (stats.included >= maxElements) {
            stats.truncated = true;
            return;
        }
        const line = formatLine(element, indent);
        if (usedChars + line.length + 1 > maxChars) {
            stats.truncated = true;
            return;
        }
        stats.included += 1;
        elementIds.add(element.id);
        emit(line);
        walkChildren(element, indent);
    };

    // A frame renders only when its host element chain renders. Frame-local
    // styles never reflect the host, so check the host chain here.
    const hostHidden = frame => {
        let host = frame.parentElementId ? snapshotById.get(frame.parentElementId) : null;
        while (host) {
            const layout = featuresById.get(host.id)?.layout;
            if (layout && (isNotRendered(layout) || layout.visibility === 'hidden')) return true;
            host = host.parentId ? snapshotById.get(host.parentId) : null;
        }
        return false;
    };

    for (const frame of snapshot.frames ?? []) {
        const childFrame = Boolean(frame.parentFrameId);
        if (childFrame && (!frame.accessible || hostHidden(frame))) {
            stats.skippedFrames += 1;
            const line = `frame ${frame.id} ${frame.accessible ?
                'HOST HIDDEN content not serialized' :
                'INACCESSIBLE cross-origin content not captured'}`;
            if (usedChars + line.length + 1 > maxChars) {
                stats.truncated = true;
                break;
            }
            emit(line);
            continue;
        }
        const header = `frame ${frame.id} ${sanitizeToken(frame.url, 200)} ` +
            `"${sanitizeToken(frame.title, 120)}"`;
        if (usedChars + header.length + 1 > maxChars) {
            stats.truncated = true;
            break;
        }
        emit(header);
        for (const element of snapshot.elements) {
            if (element.frameId === frame.id && element.parentId === null) {
                walk(element, 0);
            }
        }
    }
    if (stats.truncated) emit('… serialization truncated');

    const text = lines.join('\n');
    return {
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        elementIds,
        stats: {...stats, frames: (snapshot.frames ?? []).length}
    };
}

function anthropicAdapter(apiKey) {
    return {
        id: 'anthropic-claude-haiku-4-5',
        vendor: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        paidTierOnly: true,
        termsVersion: 'commercial-terms-2025-06-17',
        prices: {
            inputPerMillionUsd: 1.0,
            outputPerMillionUsd: 5.0,
            checkedAt: '2026-09-08'
        },
        rationale: 'Anthropic Commercial Terms (effective 2025-06-17) section D.4 bars ' +
            'building a competing product or training competing models. The Smelt student ' +
            'is a rules-plus-trees classifier for consent-banner roots, under 50 KB ' +
            'gzipped. It is not a language model, does not reproduce Anthropic output ' +
            'beyond page labels, and does not compete with Claude or with agentic browser ' +
            'products. Teacher use is one-shot labeling at training time on a paid key.',
        buildRequest({system, user}) {
            return {
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: this.model,
                    max_tokens: 1024,
                    temperature: 0,
                    system,
                    messages: [{role: 'user', content: user}]
                })
            };
        },
        parseResponse(payload) {
            const text = (payload?.content ?? [])
                .filter(part => part?.type === 'text')
                .map(part => part.text)
                .join('');
            if (!text) throw new TeacherResponseError('Anthropic response carried no text.');
            const usage = payload?.usage;
            if (typeof usage?.input_tokens !== 'number' || typeof usage?.output_tokens !== 'number') {
                throw new TeacherResponseError('Anthropic response carried no token usage.');
            }
            return {text, usage: {inputTokens: usage.input_tokens, outputTokens: usage.output_tokens}};
        }
    };
}

function geminiAdapter(apiKey) {
    return {
        id: 'google-gemini-2.5-flash-lite',
        vendor: 'google',
        model: 'gemini-2.5-flash-lite',
        paidTierOnly: true,
        termsVersion: 'gemini-api-terms-2026-03-23-paid-tier',
        prices: {
            inputPerMillionUsd: 0.1,
            outputPerMillionUsd: 0.4,
            checkedAt: '2026-09-08'
        },
        rationale: 'Google Gemini API terms (effective 2026-03-23) exclude paid-tier content ' +
            'from product improvement, and paid-tier EEA or UK content is not read by human ' +
            'reviewers. Labeling runs on a billed paid-tier key only; the free tier is banned ' +
            'for labeling. The trained artifact is a small classifier, not a derived ' +
            'language model, and does not compete with Gemini.',
        buildRequest({system, user}) {
            return {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
                headers: {
                    'content-type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify({
                    systemInstruction: {parts: [{text: system}]},
                    contents: [{role: 'user', parts: [{text: user}]}],
                    generationConfig: {
                        temperature: 0,
                        maxOutputTokens: 1024,
                        responseMimeType: 'application/json'
                    }
                })
            };
        },
        parseResponse(payload) {
            const candidate = payload?.candidates?.[0];
            const text = (candidate?.content?.parts ?? [])
                .map(part => part.text)
                .join('');
            if (!text) throw new TeacherResponseError('Gemini response carried no text.');
            const usage = payload?.usageMetadata;
            if (typeof usage?.promptTokenCount !== 'number' ||
                typeof usage?.candidatesTokenCount !== 'number') {
                throw new TeacherResponseError('Gemini response carried no token usage.');
            }
            return {
                text,
                usage: {inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount}
            };
        }
    };
}

function resolveApiKey(explicit, envName) {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const fromEnv = process.env?.[envName];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
    throw new MissingApiKeyError(`Pass options.apiKey or set ${envName}.`);
}

/**
 * Build the default Anthropic teacher (IDEA.md 3.3.5).
 * @param {object} [options] apiKey overrides the ANTHROPIC_API_KEY environment variable.
 * @returns {object} Adapter with vendor metadata and a written rationale.
 */
export function anthropicTeacher(options = {}) {
    return anthropicAdapter(resolveApiKey(options.apiKey, 'ANTHROPIC_API_KEY'));
}

/**
 * Build the default Google teacher on the paid tier (IDEA.md 3.3.5).
 * @param {object} [options] apiKey overrides the GEMINI_API_KEY environment variable.
 * @returns {object} Adapter with vendor metadata and a written rationale.
 */
export function geminiTeacher(options = {}) {
    return geminiAdapter(resolveApiKey(options.apiKey, 'GEMINI_API_KEY'));
}

function parseTeacherLabels(text, elementIds) {
    const stripped = text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
    let parsed;
    try {
        parsed = JSON.parse(stripped);
    } catch {
        throw new TeacherResponseError('Teacher answer was not valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new TeacherResponseError('Teacher answer must be a JSON object.');
    }
    const fail = reason => {
        throw new TeacherResponseError(`Teacher answer is invalid: ${reason}.`);
    };
    if (typeof parsed.has_banner !== 'boolean') fail('has_banner must be a boolean');
    if (!['banner', 'dialog', 'platform', 'custom', 'unknown'].includes(parsed.banner_kind)) {
        fail('banner_kind must be a known kind');
    }
    if (!['eea', 'us', 'unknown'].includes(parsed.jurisdiction)) {
        fail('jurisdiction must be a known value');
    }
    const confidence = parsed.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) ||
        confidence < 0 || confidence > 1) {
        fail('confidence must be a number between 0 and 1');
    }
    const root = parsed.banner_root ?? null;
    if (root !== null && !isElementId(root)) fail('banner_root must be an element id like e42');
    if (!Array.isArray(parsed.evidence)) fail('evidence must be an array');
    const evidence = parsed.evidence.map(item => {
        if (!item || typeof item !== 'object') fail('each evidence item must be an object');
        if (!['text', 'attribute', 'geometry'].includes(item.kind)) {
            fail('evidence kind must be text, attribute, or geometry');
        }
        if (typeof item.value !== 'string' || item.value.trim().length === 0) {
            fail('evidence value must be nonempty text');
        }
        if (item.element_id !== undefined && item.element_id !== null &&
            !isElementId(item.element_id)) {
            fail('evidence element_id must be an element id');
        }
        return {
            kind: item.kind,
            value: clampText(item.value, EVIDENCE_CAP),
            element_id: item.element_id ?? null
        };
    });
    if (parsed.has_banner) {
        if (root === null) fail('a positive label needs banner_root');
        if (!elementIds.has(root)) fail(`banner_root ${root} is not in the serialization`);
        if (evidence.length === 0) fail('a positive label needs evidence');
    } else {
        if (root !== null) fail('a negative label must leave banner_root null');
        if (parsed.banner_kind !== 'unknown') fail('a negative label must use banner_kind unknown');
        if (evidence.length > 0) fail('a negative label must carry no evidence');
    }
    return {has_banner: parsed.has_banner, banner_root: root, banner_kind: parsed.banner_kind,
        jurisdiction: parsed.jurisdiction, confidence, evidence};
}

/**
 * Check teacher labels against the frozen capture before they enter the corpus.
 *
 * @param {object} labels Teacher answer in the page-plus-root shape.
 * @param {object} features Frozen feature file for the same capture.
 * @returns {object} {status: pass|flag|reject, issues: [{severity, code, message, element_id}]}
 */
export function verifyTeacherLabels(labels, features) {
    const issues = [];
    const reject = (code, message, element_id) => issues.push({severity: 'reject', code, message, element_id});
    const flag = (code, message, element_id) => issues.push({severity: 'flag', code, message, element_id});
    const byId = new Map(features.elements.map(element => [element.id, element]));
    const rootId = labels.banner_root ?? null;
    const evidence = Array.isArray(labels.evidence) ? labels.evidence : [];

    if (!labels.has_banner) {
        if (rootId !== null) {
            reject('negative-has-root', 'A negative label must not carry a banner_root.', rootId);
        }
        return {status: issues.length > 0 ? 'reject' : 'pass', issues};
    }
    const root = byId.get(rootId);
    if (!root) {
        reject('unknown-root', `banner_root ${rootId} is not an element of this capture.`, rootId);
        return {status: 'reject', issues};
    }
    if (root.intrinsic.tagName === 'html' || root.intrinsic.tagName === 'body') {
        reject('root-is-page-container',
            'The root must not be the html or body element.', rootId);
    }
    if (root.layout.display === 'none' || root.layout.visibility === 'hidden') {
        reject('root-hidden', 'The root is hidden; a dismissed or hidden notice is absent.', rootId);
    }
    if (root.layout.opacity === 0) {
        reject('root-transparent', 'The root is fully transparent.', rootId);
    } else if (root.layout.opacity < 0.1) {
        flag('root-low-opacity', 'The root is nearly transparent.', rootId);
    }
    const {width, height} = root.layout.rect;
    if (width < 1 || height < 1) {
        reject('root-empty-geometry', 'The root has no visible area.', rootId);
    }
    const viewportWidth = features.viewport?.width ?? 0;
    const viewportHeight = features.viewport?.height ?? 0;
    const viewportArea = viewportWidth * viewportHeight;
    if (viewportArea > 0 && width * height > viewportArea * 1.5) {
        flag('root-covers-viewport',
            'The root covers more than 1.5 viewports; it may be a page-wide container.', rootId);
    }
    if (viewportWidth > 0 && viewportHeight > 0) {
        const rect = root.layout.rect;
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth) {
            reject('root-offscreen', 'The root lies entirely outside the viewport.', rootId);
        } else if (rect.top >= viewportHeight) {
            flag('root-below-viewport',
                'The root sits entirely below the fold; confirm it is not a dismissed notice.', rootId);
        }
    }
    if (root.intrinsic.descendantTextLength < 20) {
        flag('root-lacks-text', 'The root subtree carries almost no text.', rootId);
    }
    for (const item of evidence) {
        if (item.element_id && !byId.has(item.element_id)) {
            flag('unknown-evidence-element',
                `Evidence element ${item.element_id} is not part of this capture.`, item.element_id);
        }
    }
    const status = issues.some(issue => issue.severity === 'reject') ? 'reject' :
        issues.some(issue => issue.severity === 'flag') ? 'flag' : 'pass';
    return {status, issues};
}

/**
 * Label one frozen capture with a teacher adapter.
 *
 * @param {object} adapter An adapter from anthropicTeacher() or geminiTeacher().
 * @param {object} capture {snapshot, features} frozen capture files.
 * @param {object} [options] {fetchImpl, maxChars, maxElements, now}
 * @returns {Promise<object>} Provenance record with labels and verification.
 */
export async function runTeacher(adapter, capture, options = {}) {
    if (!adapter || typeof adapter.buildRequest !== 'function') {
        throw new TeacherError('runTeacher expects an adapter from anthropicTeacher() or geminiTeacher().');
    }
    const serialization = serializeForTeacher(capture.snapshot, capture.features, {
        maxChars: options.maxChars,
        maxElements: options.maxElements
    });
    const system = TASK_TEXT;
    const user = `VIEWPORT: ${capture.features.viewport?.width ?? 0}x${capture.features.viewport?.height ?? 0}\n\nPAGE:\n${serialization.text}`;
    const promptSha256 = sha256Hex(`${system}\n\n${user}`);

    const request = adapter.buildRequest({system, user});
    const fetchImpl = options.fetchImpl ?? fetch;
    if (typeof fetchImpl !== 'function') {
        throw new TeacherError('No fetch implementation is available.');
    }
    let response;
    try {
        response = await fetchImpl(request.url, {
            method: 'POST',
            headers: request.headers,
            body: request.body
        });
    } catch (error) {
        throw new TeacherResponseError(`Teacher request failed: ${error.message}`);
    }
    if (!response.ok) {
        const body = typeof response.text === 'function' ? await response.text() : '';
        throw new TeacherResponseError(`Teacher request returned HTTP ${response.status}: ` +
            `${clampText(body, 300)}`);
    }
    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new TeacherResponseError('Teacher response was not valid JSON.');
    }
    const {text, usage} = adapter.parseResponse(payload);
    const labels = parseTeacherLabels(text, serialization.elementIds);
    const {inputPerMillionUsd, outputPerMillionUsd} = adapter.prices;
    const costUsd = (usage.inputTokens * inputPerMillionUsd + usage.outputTokens * outputPerMillionUsd) /
        1e6;
    const verification = verifyTeacherLabels(labels, capture.features);
    if (serialization.stats.truncated) {
        verification.issues.push({
            severity: 'flag',
            code: 'truncated-input',
            message: 'The teacher input was truncated; the answer may rest on a partial page.',
            element_id: null
        });
        if (verification.status === 'pass') verification.status = 'flag';
    }
    return {
        adapter: {
            id: adapter.id,
            vendor: adapter.vendor,
            model: adapter.model,
            paidTierOnly: adapter.paidTierOnly,
            termsVersion: adapter.termsVersion,
            rationale: adapter.rationale
        },
        promptVersion: PROMPT_VERSION,
        promptSha256,
        usage,
        costUsd: Math.round(costUsd * 1e6) / 1e6,
        pricing: adapter.prices,
        serialization: {
            bytes: serialization.bytes,
            elementIds: serialization.elementIds.size,
            ...serialization.stats
        },
        labels,
        verification,
        labeledAt: options.now ? options.now() : new Date().toISOString()
    };
}
