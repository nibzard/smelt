/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function isId(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isElementId(value) {
    return typeof value === 'string' && /^e[0-9]+$/.test(value);
}

function hasUniqueValues(values) {
    return new Set(values).size === values.length;
}

function isConfidence(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateFrame(page) {
    requireValue(page.frame && typeof page.frame === 'object', `Invalid frame: ${page.id}`);
    requireValue(['top', 'same_origin', 'cross_origin', 'inaccessible', 'unknown'].includes(page.frame.state),
        `Invalid frame state: ${page.id}`);
    requireValue(page.frame.frame_id === null || /^f[0-9]+$/.test(page.frame.frame_id),
        `Invalid frame ID: ${page.id}`);
    requireValue(page.frame.element_id === null || isElementId(page.frame.element_id),
        `Invalid frame element ID: ${page.id}`);
}

function validateEvidence(page) {
    requireValue(Array.isArray(page.evidence), `Invalid evidence: ${page.id}`);
    for (const evidence of page.evidence) {
        requireValue(evidence && typeof evidence === 'object', `Invalid evidence item: ${page.id}`);
        requireValue(['text', 'attribute', 'geometry', 'teacher', 'verifier'].includes(evidence.kind),
            `Invalid evidence kind: ${page.id}`);
        requireValue(isId(evidence.value), `Invalid evidence value: ${page.id}`);
        requireValue(evidence.element_id === undefined || evidence.element_id === null ||
            isElementId(evidence.element_id), `Invalid evidence element ID: ${page.id}`);
    }
}

function validateReviewedPage(page) {
    requireValue(typeof page.has_banner === 'boolean', `Invalid has_banner: ${page.id}`);
    requireValue(isConfidence(page.confidence), `Invalid confidence: ${page.id}`);
    requireValue(['eea', 'us', 'unknown'].includes(page.jurisdiction), `Invalid jurisdiction: ${page.id}`);
    requireValue(['banner', 'dialog', 'platform', 'custom', 'unknown'].includes(page.banner_kind),
        `Invalid banner_kind: ${page.id}`);
    requireValue(page.has_banner === (page.acceptable_roots.length > 0),
        `Label and acceptable roots disagree: ${page.id}`);
    if (page.has_banner) {
        requireValue(isElementId(page.banner_root), `Missing banner_root: ${page.id}`);
        requireValue(page.acceptable_roots.includes(page.banner_root),
            `banner_root must be acceptable: ${page.id}`);
        requireValue(page.evidence.length > 0, `Positive labels need evidence: ${page.id}`);
    } else {
        requireValue(page.banner_root === null, `Negative labels must not have banner_root: ${page.id}`);
        requireValue(page.banner_kind === 'unknown', `Negative labels use unknown banner_kind: ${page.id}`);
    }
}

function validateUnresolvedPage(page) {
    requireValue(page.has_banner === null, `Unresolved labels leave has_banner null: ${page.id}`);
    requireValue(page.banner_root === null, `Unresolved labels leave banner_root null: ${page.id}`);
    requireValue(page.banner_kind === null, `Unresolved labels leave banner_kind null: ${page.id}`);
    requireValue(page.jurisdiction === null, `Unresolved labels leave jurisdiction null: ${page.id}`);
    requireValue(page.confidence === null, `Unresolved labels leave confidence null: ${page.id}`);
    requireValue(page.acceptable_roots.length === 0, `Unresolved labels leave acceptable_roots empty: ${page.id}`);
    requireValue(isId(page.review_notes), `Unresolved labels need review_notes: ${page.id}`);
}

/**
 * Validate the consent-banner label schema and cross-field invariants.
 * @param {object} dataset Versioned labels for one split.
 * @returns {object[]} Pages that need human review.
 */
export function validateConsentLabels(dataset) {
    requireValue(dataset?.schema_version === 1, 'Expected label schema_version 1.');
    requireValue(['train', 'development', 'test'].includes(dataset.split), 'Invalid dataset split.');
    requireValue(Array.isArray(dataset.pages) && dataset.pages.length > 0, 'Expected nonempty pages.');

    const pageIds = new Set();
    const reviewQueue = [];
    for (const page of dataset.pages) {
        requireValue(isId(page?.id) && !pageIds.has(page.id), 'Page IDs must be unique nonempty strings.');
        pageIds.add(page.id);
        requireValue(isId(page.group), `Missing domain/template group: ${page.id}`);
        requireValue(['reviewed', 'unresolved'].includes(page.label_status), `Invalid label_status: ${page.id}`);
        requireValue(Array.isArray(page.acceptable_roots) && page.acceptable_roots.every(isElementId),
            `Invalid acceptable_roots: ${page.id}`);
        requireValue(hasUniqueValues(page.acceptable_roots), `Duplicate acceptable root: ${page.id}`);
        requireValue(page.banner_root === null || isElementId(page.banner_root), `Invalid banner_root: ${page.id}`);
        validateFrame(page);
        validateEvidence(page);

        if (page.label_status === 'reviewed') validateReviewedPage(page);
        else {
            validateUnresolvedPage(page);
            reviewQueue.push({id: page.id, group: page.group, reason: page.review_notes});
        }
    }
    return reviewQueue;
}

/**
 * Convert reviewed consent labels to the compact evaluator input shape.
 * @param {object} dataset Versioned consent-banner labels.
 * @returns {object} Dataset accepted by evaluate().
 */
export function toEvaluationDataset(dataset) {
    validateConsentLabels(dataset);
    const pages = dataset.pages.filter(page => page.label_status === 'reviewed').map(page => ({
        id: page.id,
        group: page.group,
        hasBanner: page.has_banner,
        acceptableRoots: page.acceptable_roots,
        exactRoot: page.banner_root
    }));
    requireValue(pages.length > 0, 'No reviewed pages are available for evaluation.');
    return {schemaVersion: 1, split: dataset.split, pages};
}

/**
 * Build the human review queue from unresolved consent labels.
 * @param {object} dataset Versioned consent-banner labels.
 * @param {string} generatedAt ISO timestamp for the queue.
 * @returns {object} Versioned review queue.
 */
export function reviewQueueFromLabels(dataset, generatedAt = new Date().toISOString()) {
    const items = validateConsentLabels(dataset).map(page => ({
        capture_id: page.id,
        group: page.group,
        reason: page.reason,
        source: 'human_flag'
    }));
    return {schema_version: 1, generated_at: generatedAt, items};
}
