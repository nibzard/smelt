/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {parseHTML} from 'linkedom';

const SKIPPED_TAGS = new Set(['script', 'noscript', 'style', 'template']);

// HTML void elements have no closing tag. Writing one makes the parser
// add a second, phantom element and breaks replay parity.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
    'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Every replayed element carries its snapshot ID, so alignment works by
// identity. The HTML parser relocates elements that scripts moved into
// parser-illegal positions, which breaks alignment by position.
export const REPLAY_ID_ATTRIBUTE = 'data-smelt-replay-id';

function escapeText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
    return escapeText(value).replace(/"/g, '&quot;');
}

function assertVersion(snapshot, features) {
    if (snapshot?.schemaVersion !== 1) {
        throw new Error('Expected snapshot schemaVersion 1.');
    }
    if (features?.schemaVersion !== 1) {
        throw new Error('Expected features schemaVersion 1.');
    }
}

function elementIndexes(snapshot, features) {
    const snapshotById = new Map(snapshot.elements.map(element => [element.id, element]));
    const featureById = new Map(features.elements.map(element => [element.id, element]));
    if (snapshotById.size !== snapshot.elements.length) {
        throw new Error('Snapshot element IDs must be unique.');
    }
    if (featureById.size !== features.elements.length) {
        throw new Error('Feature element IDs must be unique.');
    }
    for (const id of snapshotById.keys()) {
        if (!featureById.has(id)) {
            throw new Error(`Feature file is missing element "${id}".`);
        }
    }
    return {snapshotById, featureById};
}

function serializeElement(element, snapshotById) {
    if (SKIPPED_TAGS.has(element.tagName)) return '';
    const attrs = Object.entries(element.attributes ?? {})
        // A captured page may already carry our marker name. Drop it: the
        // HTML parser keeps the first of two same-named attributes, so a
        // page-supplied value would shadow the real snapshot ID.
        .filter(([name]) => name !== REPLAY_ID_ATTRIBUTE)
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join('');
    const marker = ` ${REPLAY_ID_ATTRIBUTE}="${escapeAttribute(element.id)}"`;
    if (VOID_TAGS.has(element.tagName)) return `<${element.tagName}${attrs}${marker}>`;
    const children = element.children
        .map(id => serializeElement(snapshotById.get(id), snapshotById))
        .join('');
    return `<${element.tagName}${attrs}${marker}>${escapeText(element.textSample)}${children}</${element.tagName}>`;
}

/**
 * List the elements a replay can rebuild, in traversal order.
 *
 * A snapshot can hold several frame documents, but an HTML parse keeps only
 * the document under ``rootElementId``, the top frame. Skipped tags and
 * their subtrees are not serialized, so they stay out of the list too. The
 * full element set stays in the snapshot file, untouched.
 *
 * @arg snapshot {object} A Smelt snapshot file
 * @return {Array<object>} The replayable elements, in traversal order
 */
export function replayableElements(snapshot) {
    const byId = new Map(snapshot.elements.map(element => [element.id, element]));
    const ordered = [];
    const visit = id => {
        const element = byId.get(id);
        if (element === undefined) {
            throw new Error(`Snapshot element "${id}" is missing.`);
        }
        if (SKIPPED_TAGS.has(element.tagName)) return;
        ordered.push(element);
        // Void elements are serialized without children, so their children
        // cannot replay. Skip them here to match the serializer.
        if (VOID_TAGS.has(element.tagName)) return;
        for (const child of element.children ?? []) visit(child);
    };
    visit(snapshot.rootElementId);
    return ordered;
}

// The HTML parser inserts elements the snapshot never held: a phantom empty
// <p> when a serialized <p> holds block children, or a <tbody> around bare
// <tr> rows. Real captures contain such pages, so replay counts these
// foreign elements instead of refusing the page. Callers surface the count.
function phantomElements(doc, elementsById) {
    const replayed = new Set(elementsById.values());
    return Array.from(doc.querySelectorAll('*'))
        .filter(element => !replayed.has(element));
}

function alignSnapshotElements(doc, orderedElements) {
    const elementsById = new Map();
    for (const element of doc.querySelectorAll(`[${REPLAY_ID_ATTRIBUTE}]`)) {
        elementsById.set(element.getAttribute(REPLAY_ID_ATTRIBUTE), element);
    }
    if (elementsById.size !== orderedElements.length) {
        throw new Error(`Replayed DOM holds ${elementsById.size} marked elements, but the snapshot root holds ${orderedElements.length}. The HTML parser dropped or duplicated elements.`);
    }
    for (const expected of orderedElements) {
        const actual = elementsById.get(expected.id);
        if (actual === undefined) {
            throw new Error(`Replayed element "${expected.id}" is missing from the parsed document.`);
        }
        if (actual.tagName.toLowerCase() !== expected.tagName) {
            throw new Error(`Replayed element "${expected.id}" expected <${expected.tagName}> but found <${actual.tagName.toLowerCase()}>.`);
        }
    }
    return elementsById;
}

function makeRect(rect) {
    return {
        x: Number(rect.x),
        y: Number(rect.y),
        top: Number(rect.top),
        right: Number(rect.right),
        bottom: Number(rect.bottom),
        left: Number(rect.left),
        width: Number(rect.width),
        height: Number(rect.height),
        toJSON() {
            return {...this};
        }
    };
}

function styleFromLayout(layout) {
    return {
        display: layout.display,
        visibility: layout.visibility,
        opacity: String(layout.opacity),
        position: layout.position,
        zIndex: layout.zIndex === null ? 'auto' : String(layout.zIndex),
        overflow: 'visible'
    };
}

/**
 * Serialize the top-frame document of a snapshot to HTML.
 *
 * Every serialized element carries its snapshot ID in a data attribute, so
 * two parsers of the same string can be aligned by identity.
 *
 * @arg snapshot {object} A Smelt snapshot file
 * @return {string} The HTML document for the top frame
 */
export function snapshotToHtml(snapshot) {
    const snapshotById = new Map(snapshot.elements.map(element => [element.id, element]));
    const root = snapshotById.get(snapshot.rootElementId);
    if (root === undefined) {
        throw new Error(`Snapshot root element "${snapshot.rootElementId}" is missing.`);
    }
    return `<!doctype html>${serializeElement(root, snapshotById)}`;
}

/**
 * Build a linkedom document from a stripped Smelt snapshot.
 *
 * The returned ``elementsById`` map links snapshot IDs to replay DOM elements.
 * ``phantomCount`` counts elements the HTML parser inserted although the
 * snapshot never held them.
 *
 * @arg snapshot {object} A Smelt snapshot file
 * @arg features {object} The matching feature file
 * @return {{document: Document, elementsById: Map<string, Element>,
 *     phantomCount: number}}
 */
export function documentFromSnapshot(snapshot, features) {
    assertVersion(snapshot, features);
    elementIndexes(snapshot, features);
    const {document} = parseHTML(snapshotToHtml(snapshot));
    const elementsById = alignSnapshotElements(document, replayableElements(snapshot));
    return {document, elementsById, phantomCount: phantomElements(document, elementsById).length};
}

/**
 * Patch DOM layout APIs with values from a frozen feature file.
 *
 * Rules can then call ``getBoundingClientRect()`` and ``getComputedStyle()``
 * in Node and receive the captured browser values.
 *
 * @arg doc {Document} The document to patch
 * @arg snapshot {object} A Smelt snapshot file
 * @arg features {object} The matching feature file
 * @arg elementsById {Map<string, Element>} Optional existing snapshot ID map
 * @return {Map<string, Element>} Snapshot IDs mapped to patched elements
 */
export function installFrozenLayout(doc, snapshot, features,
    elementsById = alignSnapshotElements(doc, replayableElements(snapshot))) {
    assertVersion(snapshot, features);
    const {featureById} = elementIndexes(snapshot, features);
    const styleByElement = new WeakMap();

    for (const [id, element] of elementsById) {
        const layout = featureById.get(id).layout;
        const rect = makeRect(layout.rect);
        styleByElement.set(element, styleFromLayout(layout));
        Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => rect
        });
    }

    const view = doc.defaultView;
    Object.defineProperty(view, 'innerWidth', {
        configurable: true,
        value: Number(features.viewport.width)
    });
    Object.defineProperty(view, 'innerHeight', {
        configurable: true,
        value: Number(features.viewport.height)
    });
    Object.defineProperty(view, 'devicePixelRatio', {
        configurable: true,
        value: Number(features.viewport.deviceScaleFactor)
    });
    Object.defineProperty(view, 'getComputedStyle', {
        configurable: true,
        value: element => styleByElement.get(element) ?? styleFromLayout({
            display: 'block',
            visibility: 'visible',
            opacity: 1,
            position: 'static',
            zIndex: null
        })
    });
    return elementsById;
}

function vectorsFor(run, elementsById, ids, vector) {
    const ret = {};
    for (const id of ids) {
        if (!elementsById.has(id)) {
            throw new Error(`Element "${id}" is not in the replayable top frame. Pass only ids from replayableElements(snapshot).`);
        }
        ret[id] = vector(run.get(elementsById.get(id)), id);
    }
    return ret;
}

/**
 * Compare browser and Node feature vectors over the same frozen capture.
 *
 * The ``vector`` callback receives a fnode and its snapshot ID. It must return
 * JSON-stable data, such as the feature vector used by a trainer fixture.
 *
 * By default both sides are replayed documents and the comparison only checks
 * the replay itself. Pass ``browserElementsById`` for a genuine browser-versus-
 * Node comparison: a map from snapshot ID to the element in ``browserDocument``
 * that the capture saw. Such a document is the live page or a linkedom parse
 * of the original markup, so it carries no replay markers.
 *
 * @arg options {object} Parity options
 * @return {{browser: object, node: object, equal: boolean}}
 */
export function compareFrozenReplay(options) {
    const {
        ruleset,
        browserDocument,
        snapshot,
        features,
        ids = replayableElements(snapshot).map(element => element.id),
        vector,
        runOptions,
        browserElementsById
    } = options;
    if (typeof vector !== 'function') {
        throw new Error('compareFrozenReplay() requires a vector callback.');
    }

    const browserIds = browserElementsById ?? installFrozenLayout(browserDocument, snapshot, features);
    const browserRun = ruleset.against(browserDocument, runOptions);
    const browser = vectorsFor(browserRun, browserIds, ids, vector);
    const replay = documentFromSnapshot(snapshot, features);
    installFrozenLayout(replay.document, snapshot, features, replay.elementsById);
    const nodeRun = ruleset.against(replay.document, runOptions);

    const node = vectorsFor(nodeRun, replay.elementsById, ids, vector);
    return {
        browser,
        node,
        equal: JSON.stringify(browser) === JSON.stringify(node)
    };
}

/**
 * Run a ruleset against a snapshot-backed Node DOM.
 *
 * @arg ruleset {Ruleset} A Smelt runtime ruleset
 * @arg snapshot {object} A Smelt snapshot file
 * @arg features {object} The matching feature file
 * @arg options {object} BoundRun options
 * @return {{document: Document, elementsById: Map<string, Element>, run: BoundRun}}
 */
export function runFrozenSnapshot(ruleset, snapshot, features, options) {
    const replay = documentFromSnapshot(snapshot, features);
    installFrozenLayout(replay.document, snapshot, features, replay.elementsById);
    return {
        ...replay,
        run: ruleset.against(replay.document, options)
    };
}
