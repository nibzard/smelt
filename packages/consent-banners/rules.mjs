/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {dom, out, rule, ruleset, type, utils} from '@smelt-oss/runtime';

export const CANDIDATE_TYPE = 'consentCandidate';
export const OUTPUT_KEY = 'consentCandidates';
export const RULE_NAMES = Object.freeze([
    'candidate',
    'banner-text',
    'role',
    'position',
    'size',
    'visibility',
    'controls',
    'hard-negative'
]);

const CANDIDATE_SELECTOR = [
    'aside',
    'dialog',
    'div',
    'footer',
    'form',
    'header',
    'section',
    '[role="alertdialog"]',
    '[role="dialog"]'
].join(',');

const CONSENT_TEXT = /\b(cookie|cookies|consent|privacy|tracking|personalized|personalised|advertising|gdpr|ccpa|preferences)\b/i;
const CONTROL_TEXT = /\b(accept|agree|allow|reject|decline|deny|manage|settings|preferences|choices|save)\b/i;
const HARD_NEGATIVE_TEXT = /\b(newsletter|subscribe|sign in|log in|login|register|create account|age|years old|verify age)\b/i;
const POLICY_ONLY_TEXT = /\b(cookie policy|privacy policy)\b/i;

function normalizedText(element) {
    return String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function roleFor(element) {
    return String(element.getAttribute?.('role') ?? '').toLowerCase();
}

function styleFor(element) {
    return element.ownerDocument.defaultView.getComputedStyle(element);
}

function viewportArea(element) {
    const view = element.ownerDocument.defaultView;
    return Math.max(1, Number(view.innerWidth || 0) * Number(view.innerHeight || 0));
}

function controlElements(element) {
    return Array.from(element.querySelectorAll('button, input, select, textarea, a[href]'));
}

function isPolicyOnly(element, text) {
    const controls = controlElements(element);
    return POLICY_ONLY_TEXT.test(text) &&
        controls.every(control => control.tagName === 'A');
}

function scoreBannerText(fnode) {
    const text = normalizedText(fnode.element);
    if (!text) return 0;
    if (CONSENT_TEXT.test(text)) return 3;
    return 0;
}

function scoreRole(fnode) {
    const element = fnode.element;
    const role = roleFor(element);
    if (role === 'dialog' || role === 'alertdialog') return 2;
    if (element.tagName === 'DIALOG') return 2;
    if (element.getAttribute?.('aria-modal') === 'true') return 1;
    return 0;
}

function scorePosition(fnode) {
    const element = fnode.element;
    const style = styleFor(element);
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView;
    let score = 0;
    if (style.position === 'fixed' || style.position === 'sticky') score += 2;
    if (rect.top <= 24 || rect.bottom >= Number(view.innerHeight || 0) - 24) score += 1;
    if (Number.parseInt(style.zIndex, 10) >= 1000) score += 1;
    return score;
}

function scoreSize(fnode) {
    const rect = fnode.element.getBoundingClientRect();
    const areaRatio = (rect.width * rect.height) / viewportArea(fnode.element);
    if (areaRatio >= 0.03 && areaRatio <= 0.70) return 2;
    if (areaRatio > 0 && areaRatio < 0.03) return -1;
    if (areaRatio > 0.70) return -2;
    return 0;
}

function scoreVisibility(fnode) {
    const style = styleFor(fnode.element);
    const rect = fnode.element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return -4;
    if (!utils.isVisible(fnode.element)) return -4;
    if (rect.width <= 0 || rect.height <= 0) return -4;
    return 1;
}

function scoreControls(fnode) {
    const controls = controlElements(fnode.element);
    if (controls.length === 0) return -2;
    const controlText = controls.map(control => normalizedText(control)).join(' ');
    if (CONTROL_TEXT.test(controlText)) return 3;
    return 1;
}

function scoreHardNegative(fnode) {
    const element = fnode.element;
    const text = normalizedText(element);
    if (isPolicyOnly(element, text)) return -5;
    if (HARD_NEGATIVE_TEXT.test(text) && !CONSENT_TEXT.test(text)) return -5;
    if ((element.tagName === 'FOOTER' || roleFor(element) === 'contentinfo') &&
        controlElements(element).length === 0) {
        return -4;
    }
    return 0;
}

export function consentRules() {
    const candidate = type(CANDIDATE_TYPE);
    return ruleset([
        rule(dom(CANDIDATE_SELECTOR), type(CANDIDATE_TYPE).score(0), {name: 'candidate'}),
        rule(candidate, candidate.score(scoreBannerText), {name: 'banner-text'}),
        rule(candidate, candidate.score(scoreRole), {name: 'role'}),
        rule(candidate, candidate.score(scorePosition), {name: 'position'}),
        rule(candidate, candidate.score(scoreSize), {name: 'size'}),
        rule(candidate, candidate.score(scoreVisibility), {name: 'visibility'}),
        rule(candidate, candidate.score(scoreControls), {name: 'controls'}),
        rule(candidate, candidate.score(scoreHardNegative), {name: 'hard-negative'}),
        rule(candidate.max(), out(OUTPUT_KEY))
    ]);
}

export function vectorForConsentCandidate(fnode) {
    const scores = fnode.scoresSoFarFor(CANDIDATE_TYPE);
    const vector = {};
    for (const name of RULE_NAMES) {
        vector[name] = scores.get(name) ?? 0;
    }
    return vector;
}
