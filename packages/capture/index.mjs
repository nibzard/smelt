/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const FEATURE_SCHEMA_VERSION = 1;

const SKIPPED_ELEMENTS = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE']);
const SAFE_ATTRIBUTE = /^(id|class|role|type|name|title|aria-[\w-]+|data-[\w-]+|href|src|lang)$/i;

function nowIso() {
    return new Date().toISOString();
}

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clampText(value, limit = 240) {
    const text = normalizeText(value);
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function safeAttributes(element) {
    return Array.from(element.attributes ?? [])
        .filter(attribute => SAFE_ATTRIBUTE.test(attribute.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(attribute => [attribute.name, clampText(attribute.value, 160)]);
}

function childElements(element) {
    return Array.from(element.children ?? [])
        .filter(child => !SKIPPED_ELEMENTS.has(child.tagName));
}

function styleFor(element) {
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle?.(element);
    const attrStyle = element.getAttribute?.('style') ?? '';
    return {
        display: style?.display || (attrStyle.includes('display:none') ? 'none' : 'block'),
        visibility: style?.visibility || (attrStyle.includes('visibility:hidden') ? 'hidden' : 'visible'),
        opacity: Number.parseFloat(style?.opacity ?? '1'),
        position: style?.position || (/position:\s*fixed/i.test(attrStyle) ? 'fixed' :
            /position:\s*sticky/i.test(attrStyle) ? 'sticky' : 'static'),
        zIndex: style?.zIndex ?? 'auto'
    };
}

function rectFor(element) {
    const rect = element.getBoundingClientRect?.() ?? {};
    return {
        x: Number(rect.x ?? rect.left ?? 0),
        y: Number(rect.y ?? rect.top ?? 0),
        top: Number(rect.top ?? rect.y ?? 0),
        right: Number(rect.right ?? 0),
        bottom: Number(rect.bottom ?? 0),
        left: Number(rect.left ?? rect.x ?? 0),
        width: Number(rect.width ?? 0),
        height: Number(rect.height ?? 0)
    };
}

function implicitRole(element) {
    const role = element.getAttribute?.('role');
    if (role) return role;
    if (element.tagName === 'BUTTON') return 'button';
    if (element.tagName === 'A' && element.hasAttribute?.('href')) return 'link';
    if (element.tagName === 'DIALOG') return 'dialog';
    return null;
}

function classTokens(element) {
    return Array.from(new Set(String(element.getAttribute?.('class') ?? '')
        .split(/\s+/)
        .map(token => token.toLowerCase())
        .filter(Boolean))).sort();
}

// Text inside these tags never renders, so text statistics must skip it.
const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function renderedText(node) {
    let out = '';
    for (const child of node.childNodes ?? []) {
        if (child.nodeType === 3) out += ` ${child.textContent}`;
        else if (child.nodeType === 1 && !NON_TEXT_TAGS.has(child.tagName)) {
            out += ` ${renderedText(child)}`;
        }
    }
    return out;
}

function textStats(element) {
    const ownText = Array.from(element.childNodes ?? [])
        .filter(node => node.nodeType === 3)
        .map(node => node.textContent)
        .join(' ');
    const descendantText = normalizeText(renderedText(element));
    return {
        textSample: clampText(ownText, 120),
        textLength: normalizeText(ownText).length,
        descendantTextLength: descendantText.length,
        wordCount: descendantText ? descendantText.split(/\s+/).length : 0
    };
}

function descendantElementCount(element) {
    return element.querySelectorAll?.('*').length ?? 0;
}

function linkDensity(element) {
    const textLength = normalizeText(renderedText(element)).length;
    if (!textLength) return 0;
    const linkTextLength = Array.from(element.querySelectorAll?.('a') ?? [])
        .reduce((sum, link) => sum + normalizeText(link.textContent).length, 0);
    return linkTextLength / textLength;
}

function intrinsicFor(element) {
    const attrs = safeAttributes(element);
    const stats = textStats(element);
    const role = implicitRole(element);
    const tagName = element.tagName.toLowerCase();
    return {
        tagName,
        role,
        attributeNames: attrs.map(([name]) => name),
        classTokens: classTokens(element),
        ...stats,
        descendantElementCount: descendantElementCount(element),
        linkDensity: linkDensity(element),
        hasDialogRole: role === 'dialog' || role === 'alertdialog',
        hasAriaModal: element.getAttribute?.('aria-modal') === 'true',
        hasClickableControl: Boolean(element.querySelector?.('button, input, select, textarea, a[href]'))
    };
}

function layoutFor(element) {
    const style = styleFor(element);
    return {
        rect: rectFor(element),
        zIndex: style.zIndex === 'auto' ? null : Number.parseInt(style.zIndex, 10),
        position: style.position,
        isFixed: style.position === 'fixed',
        isSticky: style.position === 'sticky',
        display: style.display,
        visibility: style.visibility,
        opacity: Number.isFinite(style.opacity) ? style.opacity : 1
    };
}

function viewportFor(doc, optionViewport) {
    const view = doc.defaultView;
    return {
        width: Number(optionViewport?.width ?? view?.innerWidth ?? 0),
        height: Number(optionViewport?.height ?? view?.innerHeight ?? 0),
        deviceScaleFactor: Number(optionViewport?.deviceScaleFactor ?? view?.devicePixelRatio ?? 1)
    };
}

function addFrame(frames, frameId, doc, options, parent) {
    frames.push({
        id: frameId,
        url: String(options.url ?? doc.URL ?? ''),
        title: String(doc.title ?? ''),
        parentFrameId: parent?.frameId ?? null,
        parentElementId: parent?.elementId ?? null,
        accessible: true
    });
}

function walkElement(element, state, parentId, childIndex, frameId) {
    const id = `e${state.nextElementId++}`;
    const children = [];
    const snapshotElement = {
        id,
        frameId,
        parentId,
        childIndex,
        tagName: element.tagName.toLowerCase(),
        namespaceURI: element.namespaceURI ?? null,
        attributes: Object.fromEntries(safeAttributes(element)),
        textSample: clampText(Array.from(element.childNodes ?? [])
            .filter(node => node.nodeType === 3)
            .map(node => node.textContent)
            .join(' '), 120),
        children
    };
    state.snapshotElements.push(snapshotElement);
    state.featureElements.push({
        id,
        frameId,
        layout: layoutFor(element),
        intrinsic: intrinsicFor(element)
    });

    if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') {
        const childDocument = element.contentDocument;
        if (childDocument?.documentElement) {
            const childFrameId = `f${state.nextFrameId++}`;
            addFrame(state.frames, childFrameId, childDocument,
                {url: childDocument.URL || element.getAttribute?.('src') || ''},
                {frameId, elementId: id});
            walkElement(childDocument.documentElement, state, null, 0, childFrameId);
        } else {
            state.frames.push({
                id: `f${state.nextFrameId++}`,
                url: String(element.getAttribute?.('src') ?? ''),
                title: '',
                parentFrameId: frameId,
                parentElementId: id,
                accessible: false
            });
        }
    }

    childElements(element).forEach((child, index) => {
        const childId = walkElement(child, state, id, index, frameId);
        children.push(childId);
    });
    return id;
}

/**
 * Capture a stripped DOM snapshot and a matching feature file.
 * Element IDs are assigned by document pre-order and are stable for a fixed DOM.
 * @param {Document} doc The rendered document to capture.
 * @param {object} options Capture metadata and viewport values.
 * @returns {{snapshot: object, features: object}}
 */
export function captureFrozenSnapshot(doc, options = {}) {
    if (!doc?.documentElement) throw new TypeError('Expected a Document with a documentElement.');

    const captureId = options.captureId ?? `capture-${Date.now()}`;
    const capturedAt = options.capturedAt ?? nowIso();
    const viewport = viewportFor(doc, options.viewport);
    const metadata = {
        captureId,
        capturedAt,
        url: String(options.url ?? doc.URL ?? ''),
        backend: options.backend ?? 'local',
        browserName: options.browserName ?? null,
        browserVersion: options.browserVersion ?? null,
        userAgent: options.userAgent ?? doc.defaultView?.navigator?.userAgent ?? null,
        egressLocation: options.egressLocation ?? null,
        storageState: options.storageState ?? null,
        navigationTiming: options.navigationTiming ?? null,
        captureTiming: options.captureTiming ?? null,
        observationMs: Number(options.observationMs ?? 0)
    };
    const state = {
        nextElementId: 0,
        nextFrameId: 1,
        frames: [],
        snapshotElements: [],
        featureElements: []
    };
    addFrame(state.frames, 'f0', doc, options, null);
    const rootElementId = walkElement(doc.documentElement, state, null, 0, 'f0');

    return {
        snapshot: {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            metadata,
            viewport,
            rootFrameId: 'f0',
            rootElementId,
            frames: state.frames,
            elements: state.snapshotElements
        },
        features: {
            schemaVersion: FEATURE_SCHEMA_VERSION,
            metadata,
            viewport,
            elements: state.featureElements
        }
    };
}
