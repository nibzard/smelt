/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

export const PROBE_SETS = Object.freeze({
    'ci-50': 50,
    'dev-1000': 1000,
    'frozen-1000': 1000
});

const DEFAULT_WARMUPS = 3;
const DEFAULT_REPETITIONS = 30;
const DEFAULT_CPU_THROTTLE = 4;
const SKIPPED_TAGS = new Set(['script', 'noscript', 'style', 'template']);
// HTML void elements have no closing tag. Writing one makes the parser
// add a second, phantom element and breaks replay parity.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img',
    'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Every replayed element carries its snapshot ID, so alignment works by
// identity. The HTML parser relocates elements that scripts moved into
// parser-illegal positions, which breaks alignment by position.
const REPLAY_ID_ATTRIBUTE = 'data-smelt-replay-id';

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function compactNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function escapeText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
    return escapeText(value).replace(/"/g, '&quot;');
}

function serializeElement(element, byId) {
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
        .map(id => serializeElement(byId.get(id), byId))
        .join('');
    return `<${element.tagName}${attrs}${marker}>${escapeText(element.textSample)}${children}</${element.tagName}>`;
}

// This duplicates replayableElements in @smelt-oss/capture on purpose, byte
// for byte in behavior: the bench ships in the published package, where the
// capture package is only a devDependency. A cross-package parity test keeps
// the two copies honest.
export function replayableElements(snapshot) {
    requireValue(snapshot?.schemaVersion === 1, 'Expected snapshot schemaVersion 1.');
    const byId = new Map(snapshot.elements.map(element => [element.id, element]));
    requireValue(byId.size === snapshot.elements.length, 'Snapshot element IDs must be unique.');
    requireValue(byId.get(snapshot.rootElementId) !== undefined,
        `Snapshot root element "${snapshot.rootElementId}" is missing.`);
    const ordered = [];
    const visit = id => {
        const element = byId.get(id);
        requireValue(element !== undefined, `Snapshot element "${id}" is missing.`);
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

export function snapshotToHtml(snapshot) {
    requireValue(snapshot?.schemaVersion === 1, 'Expected snapshot schemaVersion 1.');
    const byId = new Map(snapshot.elements.map(element => [element.id, element]));
    requireValue(byId.size === snapshot.elements.length, 'Snapshot element IDs must be unique.');
    const root = byId.get(snapshot.rootElementId);
    requireValue(root !== undefined, `Snapshot root element "${snapshot.rootElementId}" is missing.`);
    return `<!doctype html>${serializeElement(root, byId)}`;
}

function percentile(sortedValues, quantile) {
    if (sortedValues.length === 0) return null;
    const index = Math.min(sortedValues.length - 1, Math.max(0,
        Math.ceil(sortedValues.length * quantile) - 1));
    return sortedValues[index];
}

export function summarizeLatency(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) {
        return {count: 0, min: null, mean: null, p50: null, p95: null, max: null};
    }
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        count: sorted.length,
        min: compactNumber(sorted[0]),
        mean: compactNumber(sum / sorted.length),
        p50: compactNumber(percentile(sorted, 0.50)),
        p95: compactNumber(percentile(sorted, 0.95)),
        max: compactNumber(sorted[sorted.length - 1])
    };
}

function normalizeCapture(capture, baseDir) {
    requireValue(typeof capture?.id === 'string' && capture.id.length > 0,
        'Each benchmark capture needs an id.');
    requireValue(typeof capture.snapshot === 'string', `Capture "${capture.id}" needs a snapshot path.`);
    requireValue(typeof capture.features === 'string', `Capture "${capture.id}" needs a features path.`);
    return {
        id: capture.id,
        group: capture.group ?? null,
        snapshot: resolve(baseDir, capture.snapshot),
        features: resolve(baseDir, capture.features)
    };
}

export async function readBenchManifest(path, probeSet) {
    requireValue(PROBE_SETS[probeSet] !== undefined, `Unknown probe set: ${probeSet}`);
    const manifestPath = resolve(path);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    requireValue(manifest?.schemaVersion === 1, 'Expected benchmark manifest schemaVersion 1.');
    const baseDir = dirname(manifestPath);
    const captures = manifest.probeSets?.[probeSet] ?? manifest.sets?.[probeSet];
    requireValue(Array.isArray(captures) && captures.length > 0,
        `Benchmark manifest has no "${probeSet}" captures.`);
    requireValue(captures.length <= PROBE_SETS[probeSet],
        `${probeSet} accepts at most ${PROBE_SETS[probeSet]} captures.`);
    return captures.map(capture => normalizeCapture(capture, baseDir));
}

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

async function createBrowserBundle() {
    let build;
    try {
        ({build} = await import('esbuild'));
    } catch {
        throw new Error('esbuild is not installed. Run npm install, then run the benchmark again.');
    }
    const dir = await mkdtemp(resolve(tmpdir(), 'smelt-bench-'));
    const outfile = resolve(dir, 'consent-bench.js');
    await build({
        entryPoints: [resolve(dirname(fileURLToPath(import.meta.url)), 'index.mjs')],
        outfile,
        bundle: true,
        format: 'iife',
        globalName: '__SmeltConsentBenchBundle',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent'
    });
    return {dir, outfile};
}

async function loadPlaywright(options) {
    if (options.playwright) return options.playwright;
    try {
        return await import('playwright');
    } catch {
        throw new Error('playwright is not installed. Install it to run smelt bench.');
    }
}

async function installFrozenLayout(page, ordered, features) {
    return page.evaluate(({ordered, marker, features}) => {
        const actualById = new Map();
        for (const element of document.querySelectorAll(`[${marker}]`)) {
            actualById.set(element.getAttribute(marker), element);
        }
        if (actualById.size !== ordered.length) {
            throw new Error(`Replayed DOM holds ${actualById.size} marked elements, but the snapshot root holds ${ordered.length}.`);
        }
        const featureById = new Map(features.elements.map(element => [element.id, element]));
        const styleByElement = new WeakMap();
        for (const expected of ordered) {
            const actual = actualById.get(expected.id);
            if (actual === undefined) {
                throw new Error(`Replayed element "${expected.id}" is missing from the parsed document.`);
            }
            if (actual.tagName.toLowerCase() !== expected.tagName) {
                throw new Error(`Replayed element "${expected.id}" expected <${expected.tagName}>.`);
            }
            const layout = featureById.get(expected.id).layout;
            const rect = {...layout.rect};
            rect.toJSON = () => ({...layout.rect});
            styleByElement.set(actual, {
                display: layout.display,
                visibility: layout.visibility,
                opacity: String(layout.opacity),
                position: layout.position,
                zIndex: layout.zIndex === null ? 'auto' : String(layout.zIndex),
                overflow: 'visible'
            });
            Object.defineProperty(actual, 'getBoundingClientRect', {
                configurable: true,
                value: () => rect
            });
        }
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: Number(features.viewport.width)});
        Object.defineProperty(window, 'innerHeight', {configurable: true, value: Number(features.viewport.height)});
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: Number(features.viewport.deviceScaleFactor)
        });
        window.getComputedStyle = element => styleByElement.get(element) ?? {
            display: 'block',
            visibility: 'visible',
            opacity: '1',
            position: 'static',
            zIndex: 'auto',
            overflow: 'visible'
        };
        // The HTML parser inserts elements the snapshot never held, such as
        // a <tbody> around bare <tr> rows. Count them; do not fail the page.
        return Array.from(document.querySelectorAll('*'))
            .filter(element => !element.hasAttribute(marker)).length;
    }, {ordered, marker: REPLAY_ID_ATTRIBUTE, features});
}

function frameRecordCounts(snapshot) {
    // Placeholder frame records stand for documents the capture could not
    // reach; only accessible documents count as frame documents.
    const frames = snapshot.frames ?? [{accessible: true}];
    const documents = frames.filter(frame => frame.accessible !== false).length;
    return {documents, placeholderFrameRecords: frames.length - documents};
}

async function measurePage(page, bundlePath, capture, options) {
    const snapshot = await readJson(capture.snapshot);
    const features = await readJson(capture.features);
    const ordered = replayableElements(snapshot);
    await page.setViewportSize({
        width: Number(features.viewport.width),
        height: Number(features.viewport.height)
    });
    await page.setContent(snapshotToHtml(snapshot), {waitUntil: 'load'});
    const phantomElements = await installFrozenLayout(page, ordered, features);
    const initStart = performance.now();
    await page.addScriptTag({path: bundlePath});
    const initializationMs = performance.now() - initStart;
    const measured = await page.evaluate(async ({warmups, repetitions, initializationMs}) => {
        const detect = window.__SmeltConsentBenchBundle.detect;
        const timedDetect = async () => {
            const start = performance.now();
            const result = await detect(document);
            return {
                ms: performance.now() - start,
                detectMs: result.stats.ms,
                candidates: result.stats.candidates,
                elementsWalked: result.stats.elementsWalked,
                truncated: result.stats.truncated,
                degraded: result.degraded
            };
        };
        const first = await timedDetect();
        for (let i = 0; i < warmups; i++) await timedDetect();
        const repetitionsMs = [];
        let last = first;
        for (let i = 0; i < repetitions; i++) {
            last = await timedDetect();
            repetitionsMs.push(last.ms);
        }
        return {
            initializationMs,
            firstCallMs: first.ms,
            repeatedCallMs: repetitionsMs,
            lastStats: last
        };
    }, {
        warmups: options.warmups,
        repetitions: options.repetitions,
        initializationMs
    });
    return {
        ...measured,
        frames: {
            ...frameRecordCounts(snapshot),
            snapshotElements: snapshot.elements.length,
            replayedElements: ordered.length,
            phantomElements
        }
    };
}

export async function runBrowserBenchmark(options) {
    const probeSet = options.probeSet ?? 'ci-50';
    const warmups = Number(options.warmups ?? DEFAULT_WARMUPS);
    const repetitions = Number(options.repetitions ?? DEFAULT_REPETITIONS);
    const cpuThrottle = Number(options.cpuThrottle ?? DEFAULT_CPU_THROTTLE);
    requireValue(Number.isInteger(warmups) && warmups >= 0, 'warmups must be a nonnegative integer.');
    requireValue(Number.isInteger(repetitions) && repetitions > 0, 'repetitions must be a positive integer.');
    const captures = options.captures ?? await readBenchManifest(options.manifest, probeSet);
    const playwright = await loadPlaywright(options);
    const bundle = await createBrowserBundle();
    const startedAt = new Date().toISOString();
    let browser;
    try {
        browser = await playwright.chromium.launch({headless: options.headless ?? true});
        const context = await browser.newContext();
        // A replayed capture keeps its original resource attributes. Block
        // every request so the benchmark fetches nothing and no external
        // server sees benchmark traffic; subresources fail fast instead of
        // holding back the load event.
        await context.route('**/*', route => route.abort());
        const pages = [];
        for (const capture of captures) {
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: cpuThrottle});
            await cdp.detach();
            let measured;
            try {
                measured = await measurePage(page, bundle.outfile, capture, {warmups, repetitions});
            } finally {
                await page.close();
            }
            pages.push({
                id: capture.id,
                group: capture.group,
                initializationMs: compactNumber(measured.initializationMs),
                firstCallMs: compactNumber(measured.firstCallMs),
                repeatedCall: summarizeLatency(measured.repeatedCallMs),
                samplesMs: measured.repeatedCallMs.map(compactNumber),
                stats: measured.lastStats,
                frames: measured.frames
            });
        }
        const repeated = pages.flatMap(item => item.samplesMs);
        const firstCalls = pages.map(item => item.firstCallMs);
        const initialization = pages.map(item => item.initializationMs);
        const multiFramePages = pages.filter(item => item.frames.documents > 1).length;
        return {
            schemaVersion: 1,
            task: 'consent-banners',
            probeSet,
            startedAt,
            completedAt: new Date().toISOString(),
            browser: {
                name: 'chromium',
                cpuThrottle,
                headless: options.headless ?? true
            },
            warmups,
            repetitions,
            pages,
            corpus: {
                pages: pages.length,
                initialization: summarizeLatency(initialization),
                firstCall: summarizeLatency(firstCalls),
                repeatedCall: summarizeLatency(repeated),
                frames: {
                    // Replay rebuilds the top-frame document only; the
                    // detector runs v0.1 top-frame detection.
                    replay: 'top-frame',
                    multiFramePages,
                    placeholderFrameRecords: pages.reduce((sum, item) =>
                        sum + item.frames.placeholderFrameRecords, 0),
                    snapshotElements: pages.reduce((sum, item) =>
                        sum + item.frames.snapshotElements, 0),
                    replayedElements: pages.reduce((sum, item) =>
                        sum + item.frames.replayedElements, 0),
                    // Elements the HTML parser inserted without a snapshot
                    // counterpart, such as a <tbody> around bare <tr> rows.
                    phantomElements: pages.reduce((sum, item) =>
                        sum + item.frames.phantomElements, 0)
                }
            }
        };
    } finally {
        if (browser !== undefined) await browser.close();
        await rm(bundle.dir, {recursive: true, force: true});
    }
}

export async function writeBenchmarkReport(report, outputPath) {
    const path = resolve(outputPath);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}
