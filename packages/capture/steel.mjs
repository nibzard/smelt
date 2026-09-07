/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {FEATURE_SCHEMA_VERSION, SNAPSHOT_SCHEMA_VERSION} from './index.mjs';

const DEFAULT_USER_AGENT = 'SmeltCorpusBot/1.0';
const DEFAULT_OBSERVATION_MS = 1500;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;

function assertObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object.`);
    }
}

function requireString(value, name) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`${name} must be a nonempty string.`);
    }
    return value.trim();
}

function optionalString(value, name) {
    if (value == null) return null;
    return requireString(value, name);
}

function nowIso() {
    return new Date().toISOString();
}

function safeFilename(id) {
    return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function outputPaths(outDir, captureId) {
    const base = path.join(outDir, safeFilename(captureId));
    return {
        snapshot: `${base}.snapshot.json`,
        features: `${base}.features.json`,
        metadata: `${base}.metadata.json`
    };
}

function inPageCapture(payload) {
    const skippedElements = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'TEMPLATE']);
    const safeAttribute = /^(id|class|role|type|name|title|aria-[\w-]+|data-[\w-]+|href|src|lang)$/i;
    const normalizeText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const clampText = (value, limit = 240) => {
        const text = normalizeText(value);
        return text.length > limit ? `${text.slice(0, limit)}...` : text;
    };
    const safeAttributes = element => Array.from(element.attributes ?? [])
        .filter(attribute => safeAttribute.test(attribute.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(attribute => [attribute.name, clampText(attribute.value, 160)]);
    const childElements = element => Array.from(element.children ?? [])
        .filter(child => !skippedElements.has(child.tagName));
    const styleFor = element => {
        const style = element.ownerDocument.defaultView.getComputedStyle?.(element);
        const attrStyle = element.getAttribute('style') ?? '';
        return {
            display: style?.display || (attrStyle.includes('display:none') ? 'none' : 'block'),
            visibility: style?.visibility || (attrStyle.includes('visibility:hidden') ? 'hidden' : 'visible'),
            opacity: Number.parseFloat(style?.opacity ?? '1'),
            position: style?.position || (/position:\s*fixed/i.test(attrStyle) ? 'fixed' :
                /position:\s*sticky/i.test(attrStyle) ? 'sticky' : 'static'),
            zIndex: style?.zIndex ?? 'auto'
        };
    };
    const rectFor = element => {
        const rect = element.getBoundingClientRect();
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
    };
    const implicitRole = element => {
        const role = element.getAttribute('role');
        if (role) return role;
        if (element.tagName === 'BUTTON') return 'button';
        if (element.tagName === 'A' && element.hasAttribute('href')) return 'link';
        if (element.tagName === 'DIALOG') return 'dialog';
        return null;
    };
    const classTokens = element => Array.from(new Set(String(element.getAttribute('class') ?? '')
        .split(/\s+/)
        .map(token => token.toLowerCase())
        .filter(Boolean))).sort();
    const textStats = element => {
        const ownText = Array.from(element.childNodes ?? [])
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent)
            .join(' ');
        const descendantText = normalizeText(element.textContent);
        return {
            textSample: clampText(ownText, 120),
            textLength: normalizeText(ownText).length,
            descendantTextLength: descendantText.length,
            wordCount: descendantText ? descendantText.split(/\s+/).length : 0
        };
    };
    const linkDensity = element => {
        const textLength = normalizeText(element.textContent).length;
        if (!textLength) return 0;
        const linkTextLength = Array.from(element.querySelectorAll('a'))
            .reduce((sum, link) => sum + normalizeText(link.textContent).length, 0);
        return linkTextLength / textLength;
    };
    const intrinsicFor = element => {
        const attrs = safeAttributes(element);
        const role = implicitRole(element);
        return {
            tagName: element.tagName.toLowerCase(),
            role,
            attributeNames: attrs.map(([name]) => name),
            classTokens: classTokens(element),
            ...textStats(element),
            descendantElementCount: element.querySelectorAll('*').length,
            linkDensity: linkDensity(element),
            hasDialogRole: role === 'dialog' || role === 'alertdialog',
            hasAriaModal: element.getAttribute('aria-modal') === 'true',
            hasClickableControl: Boolean(element.querySelector('button, input, select, textarea, a[href]'))
        };
    };
    const layoutFor = element => {
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
    };
    const addFrame = (state, frameId, doc, parent) => {
        state.frames.push({
            id: frameId,
            url: String(doc.URL ?? ''),
            title: String(doc.title ?? ''),
            parentFrameId: parent?.frameId ?? null,
            parentElementId: parent?.elementId ?? null,
            accessible: true
        });
    };
    const inaccessibleFrame = (state, element, frameId, elementId) => {
        state.frames.push({
            id: `f${state.nextFrameId++}`,
            url: String(element.getAttribute('src') ?? ''),
            title: '',
            parentFrameId: frameId,
            parentElementId: elementId,
            accessible: false
        });
    };
    const walkElement = (element, state, parentId, childIndex, frameId) => {
        const id = `e${state.nextElementId++}`;
        const children = [];
        state.snapshotElements.push({
            id,
            frameId,
            parentId,
            childIndex,
            tagName: element.tagName.toLowerCase(),
            namespaceURI: element.namespaceURI ?? null,
            attributes: Object.fromEntries(safeAttributes(element)),
            textSample: clampText(Array.from(element.childNodes ?? [])
                .filter(node => node.nodeType === Node.TEXT_NODE)
                .map(node => node.textContent)
                .join(' '), 120),
            children
        });
        state.featureElements.push({
            id,
            frameId,
            layout: layoutFor(element),
            intrinsic: intrinsicFor(element)
        });

        if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') {
            try {
                const childDocument = element.contentDocument;
                if (childDocument?.documentElement) {
                    const childFrameId = `f${state.nextFrameId++}`;
                    addFrame(state, childFrameId, childDocument, {frameId, elementId: id});
                    walkElement(childDocument.documentElement, state, null, 0, childFrameId);
                } else {
                    inaccessibleFrame(state, element, frameId, id);
                }
            } catch {
                inaccessibleFrame(state, element, frameId, id);
            }
        }

        childElements(element).forEach((child, index) => {
            children.push(walkElement(child, state, id, index, frameId));
        });
        return id;
    };

    const metadata = {
        captureId: payload.captureId,
        capturedAt: payload.capturedAt,
        url: String(document.URL ?? payload.url),
        backend: 'steel',
        browserName: payload.browserName,
        browserVersion: payload.browserVersion,
        userAgent: navigator.userAgent,
        egressLocation: payload.egressLocation,
        storageState: payload.storageState,
        navigationTiming: performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null,
        captureTiming: payload.captureTiming,
        observationMs: payload.observationMs
    };
    const viewport = {
        width: Number(innerWidth ?? payload.viewport.width),
        height: Number(innerHeight ?? payload.viewport.height),
        deviceScaleFactor: Number(devicePixelRatio ?? payload.viewport.deviceScaleFactor)
    };
    const state = {
        nextElementId: 0,
        nextFrameId: 1,
        frames: [],
        snapshotElements: [],
        featureElements: []
    };

    addFrame(state, 'f0', document, null);
    const rootElementId = walkElement(document.documentElement, state, null, 0, 'f0');
    return {
        snapshot: {
            schemaVersion: payload.snapshotSchemaVersion,
            metadata,
            viewport,
            rootFrameId: 'f0',
            rootElementId,
            frames: state.frames,
            elements: state.snapshotElements
        },
        features: {
            schemaVersion: payload.featureSchemaVersion,
            metadata,
            viewport,
            elements: state.featureElements
        }
    };
}

export async function loadSteelCaptureConfig(configPath) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assertObject(config, 'config');
    if (!Array.isArray(config.pages) || config.pages.length === 0) {
        throw new TypeError('config.pages must be a nonempty array.');
    }
    return {
        outDir: requireString(config.outDir ?? 'corpus/captures', 'config.outDir'),
        browser: normalizeBrowser(config.browser ?? {}),
        viewport: normalizeViewport(config.viewport ?? {}),
        observationMs: Number(config.observationMs ?? DEFAULT_OBSERVATION_MS),
        navigationTimeoutMs: Number(config.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS),
        egressLocation: optionalString(config.egressLocation, 'config.egressLocation'),
        storageState: config.storageState ?? null,
        singleFileScriptPath: config.singleFileScriptPath ?? null,
        pages: config.pages.map((page, index) => normalizePage(page, index))
    };
}

function normalizeBrowser(browser) {
    assertObject(browser, 'config.browser');
    const name = requireString(browser.name ?? 'chromium', 'config.browser.name');
    if (name !== 'chromium' && name !== 'firefox') {
        throw new TypeError('config.browser.name must be "chromium" or "firefox".');
    }
    const wsEndpoint = optionalString(browser.wsEndpoint ?? process.env.STEEL_BROWSER_WS_ENDPOINT,
        'config.browser.wsEndpoint');
    return {name, wsEndpoint};
}

function normalizeViewport(viewport) {
    return {
        width: Number(viewport.width ?? 1280),
        height: Number(viewport.height ?? 720),
        deviceScaleFactor: Number(viewport.deviceScaleFactor ?? 1)
    };
}

function normalizePage(page, index) {
    assertObject(page, `config.pages[${index}]`);
    const url = requireString(page.url, `config.pages[${index}].url`);
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new TypeError(`config.pages[${index}].url must be an HTTP or HTTPS URL.`);
    }
    return {
        id: requireString(page.id ?? parsed.hostname, `config.pages[${index}].id`),
        url,
        group: optionalString(page.group, `config.pages[${index}].group`),
        metadata: page.metadata ?? {}
    };
}

export async function injectSingleFileEngine(page, config) {
    if (config.singleFileScriptPath) {
        const content = await readFile(config.singleFileScriptPath, 'utf8');
        await page.addInitScript({content});
        await page.addInitScript({
            content: `window.__SMELT_CAPTURE_ENGINE__ = ${inPageCapture.toString()};`
        });
        return {injected: true, source: config.singleFileScriptPath};
    }
    await page.addInitScript({
        content: `window.__SMELT_CAPTURE_ENGINE__ = ${inPageCapture.toString()};`
    });
    return {injected: true, source: null};
}

export async function capturePage(page, target, config, options = {}) {
    await page.setViewportSize?.({width: config.viewport.width, height: config.viewport.height});
    await injectSingleFileEngine(page, config);

    const startedAt = Date.now();
    await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs
    });
    if (page.waitForLoadState) {
        await page.waitForLoadState('networkidle', {timeout: Math.min(config.navigationTimeoutMs, 10000)})
            .catch(() => undefined);
    }
    if (config.observationMs > 0) await page.waitForTimeout(config.observationMs);

    const browser = page.context?.().browser?.();
    const browserVersion = options.browserVersion ?? await browser?.version?.() ?? null;
    const payload = {
        captureId: target.id,
        capturedAt: options.capturedAt ?? nowIso(),
        url: target.url,
        browserName: config.browser.name,
        browserVersion,
        egressLocation: config.egressLocation,
        storageState: config.storageState,
        viewport: config.viewport,
        observationMs: config.observationMs,
        snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        captureTiming: {startedAt, endedAt: Date.now()}
    };

    const result = await page.evaluate(payload => {
        const engine = globalThis.__SMELT_CAPTURE_ENGINE__ ?? inPageCapture;
        return engine(payload);
    }, payload);
    const metadata = {
        schemaVersion: 1,
        captureId: target.id,
        url: target.url,
        group: target.group,
        backend: 'steel',
        browserName: config.browser.name,
        browserVersion,
        egressLocation: config.egressLocation,
        storageState: config.storageState,
        viewport: config.viewport,
        observationMs: config.observationMs,
        capturedAt: payload.capturedAt,
        targetMetadata: target.metadata
    };
    return {...result, metadata};
}

export async function writeCapture(outDir, captureId, capture) {
    await mkdir(outDir, {recursive: true});
    const paths = outputPaths(outDir, captureId);
    await writeJson(paths.snapshot, capture.snapshot);
    await writeJson(paths.features, capture.features);
    await writeJson(paths.metadata, capture.metadata);
    return paths;
}

async function writeJson(filename, data) {
    await writeFile(filename, `${JSON.stringify(data, null, 2)}\n`);
}

async function connectBrowser(config, playwright) {
    if (!config.browser.wsEndpoint) {
        throw new Error('Set config.browser.wsEndpoint or STEEL_BROWSER_WS_ENDPOINT for Steel capture.');
    }
    if (config.browser.name === 'chromium') {
        return playwright.chromium.connectOverCDP(config.browser.wsEndpoint);
    }
    return playwright.firefox.connect(config.browser.wsEndpoint);
}

export async function runSteelCapture(config, options = {}) {
    const playwright = options.playwright ?? await import('playwright');
    const browser = await connectBrowser(config, playwright);
    const context = browser.contexts?.()[0] ?? await browser.newContext({
        userAgent: DEFAULT_USER_AGENT,
        viewport: config.viewport,
        storageState: config.storageState ?? undefined
    });
    const page = await context.newPage();
    const captures = [];

    try {
        for (const target of config.pages) {
            const capture = await capturePage(page, target, config, options);
            const paths = await writeCapture(config.outDir, target.id, capture);
            captures.push({id: target.id, url: target.url, paths});
        }
    } finally {
        await page.close?.();
        await browser.close?.();
    }

    return captures;
}

export function configUrl(configPath) {
    return pathToFileURL(path.resolve(configPath)).href;
}
