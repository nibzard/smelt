/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {parseHTML} from 'linkedom';

const SKIPPED_TAGS = new Set(['script', 'noscript', 'style', 'template']);

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
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join('');
    const children = element.children
        .map(id => serializeElement(snapshotById.get(id), snapshotById))
        .join('');
    return `<${element.tagName}${attrs}>${escapeText(element.textSample)}${children}</${element.tagName}>`;
}

function elementsInDocumentOrder(doc) {
    return Array.from(doc.querySelectorAll('*'));
}

function alignSnapshotElements(doc, snapshot) {
    const elements = elementsInDocumentOrder(doc);
    if (elements.length !== snapshot.elements.length) {
        throw new Error(`Replayed DOM has ${elements.length} elements, but the snapshot has ${snapshot.elements.length}.`);
    }

    const elementsById = new Map();
    for (let i = 0; i < snapshot.elements.length; i++) {
        const expected = snapshot.elements[i];
        const actual = elements[i];
        if (actual.tagName.toLowerCase() !== expected.tagName) {
            throw new Error(`Replayed element "${expected.id}" expected <${expected.tagName}> but found <${actual.tagName.toLowerCase()}>.`);
        }
        elementsById.set(expected.id, actual);
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
 * Build a linkedom document from a stripped Smelt snapshot.
 *
 * The returned ``elementsById`` map links snapshot IDs to replay DOM elements.
 *
 * @arg snapshot {object} A Smelt snapshot file
 * @arg features {object} The matching feature file
 * @return {{document: Document, elementsById: Map<string, Element>}}
 */
export function documentFromSnapshot(snapshot, features) {
    assertVersion(snapshot, features);
    const {snapshotById} = elementIndexes(snapshot, features);
    const root = snapshotById.get(snapshot.rootElementId);
    if (root === undefined) {
        throw new Error(`Snapshot root element "${snapshot.rootElementId}" is missing.`);
    }

    const {document} = parseHTML(`<!doctype html>${serializeElement(root, snapshotById)}`);
    return {document, elementsById: alignSnapshotElements(document, snapshot)};
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
export function installFrozenLayout(doc, snapshot, features, elementsById = alignSnapshotElements(doc, snapshot)) {
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
 * @arg options {object} Parity options
 * @return {{browser: object, node: object, equal: boolean}}
 */
export function compareFrozenReplay(options) {
    const {
        ruleset,
        browserDocument,
        snapshot,
        features,
        ids = snapshot.elements.map(element => element.id),
        vector,
        runOptions
    } = options;
    if (typeof vector !== 'function') {
        throw new Error('compareFrozenReplay() requires a vector callback.');
    }

    const browserElementsById = installFrozenLayout(browserDocument, snapshot, features);
    const browserRun = ruleset.against(browserDocument, runOptions);
    const browser = vectorsFor(browserRun, browserElementsById, ids, vector);
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
