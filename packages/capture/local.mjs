/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {
    DEFAULT_NAVIGATION_TIMEOUT_MS,
    DEFAULT_OBSERVATION_MS,
    DEFAULT_USER_AGENT,
    assertObject,
    assertUniquePageIds,
    capturePage,
    normalizeBrowserName,
    normalizeNonNegativeNumber,
    normalizeStorageState,
    normalizeViewport,
    optionalString,
    requireString,
    writeCapture
} from './crawl.mjs';

export async function loadLocalCaptureConfig(configPath) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assertObject(config, 'config');
    if (!Array.isArray(config.pages) || config.pages.length === 0) {
        throw new TypeError('config.pages must be a nonempty array.');
    }
    const configDir = path.dirname(path.resolve(configPath));
    const pages = config.pages.map((page, index) => normalizeLocalPage(page, index, configDir));
    assertUniquePageIds(pages);
    return {
        outDir: requireString(config.outDir ?? 'corpus/captures', 'config.outDir'),
        browser: normalizeLocalBrowser(config.browser ?? {}),
        viewport: normalizeViewport(config.viewport ?? {}),
        observationMs: normalizeNonNegativeNumber(config.observationMs, DEFAULT_OBSERVATION_MS,
            'config.observationMs'),
        navigationTimeoutMs: normalizeNonNegativeNumber(config.navigationTimeoutMs,
            DEFAULT_NAVIGATION_TIMEOUT_MS, 'config.navigationTimeoutMs'),
        egressLocation: optionalString(config.egressLocation, 'config.egressLocation'),
        storageState: await normalizeLocalStorageState(config.storageState, configDir),
        singleFileScriptPath: config.singleFileScriptPath ?? null,
        pages
    };
}

async function normalizeLocalStorageState(value, configDir) {
    if (typeof value === 'string') {
        const statePath = requireString(value, 'config.storageState');
        const parsed = JSON.parse(await readFile(path.resolve(configDir, statePath), 'utf8'));
        return normalizeStorageState(parsed, 'config.storageState');
    }
    return normalizeStorageState(value, 'config.storageState');
}

function normalizeLocalBrowser(browser) {
    assertObject(browser, 'config.browser');
    if (browser.wsEndpoint != null) {
        throw new TypeError('config.browser.wsEndpoint is a Steel capture field. ' +
            'Remove it, or run smelt-steel-capture.');
    }
    return {name: normalizeBrowserName(browser.name)};
}

function normalizeLocalPage(page, index, configDir) {
    assertObject(page, `config.pages[${index}]`);
    if (page.url != null && page.file != null) {
        throw new TypeError(`config.pages[${index}] sets both url and file. Set one.`);
    }
    const url = page.file != null ? fileUrl(page, index, configDir) : pageUrl(page, index);
    return {
        id: requireString(page.id ?? defaultId(url), `config.pages[${index}].id`),
        url,
        group: optionalString(page.group, `config.pages[${index}].group`),
        metadata: page.metadata ?? {}
    };
}

function fileUrl(page, index, configDir) {
    const file = requireString(page.file, `config.pages[${index}].file`);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(file) && !/^[a-zA-Z]:[\\/]/.test(file)) {
        throw new TypeError(`config.pages[${index}].file must be a path relative to the ` +
            'config file. Put URLs in the url field.');
    }
    return pathToFileURL(path.resolve(configDir, file)).href;
}

function pageUrl(page, index) {
    const url = requireString(page.url, `config.pages[${index}].url`);
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
        throw new TypeError(`config.pages[${index}].url must be an HTTP, HTTPS, or file URL.`);
    }
    return url;
}

function defaultId(url) {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
        const basename = path.basename(parsed.pathname);
        return basename.replace(/\.[^.]*$/, '') || 'page';
    }
    return parsed.hostname;
}

async function loadPlaywright(options) {
    if (options.playwright) return options.playwright;
    try {
        return await import('playwright');
    } catch {
        throw new Error('playwright is not installed. Install it to run local capture.');
    }
}

export async function runLocalCapture(config, options = {}) {
    const playwright = await loadPlaywright(options);
    const engine = config.browser.name === 'firefox' ? playwright.firefox : playwright.chromium;
    const browser = await engine.launch({headless: options.headless ?? true});
    const captures = [];
    let page;

    try {
        const context = await browser.newContext({
            userAgent: DEFAULT_USER_AGENT,
            viewport: config.viewport,
            storageState: config.storageState ?? undefined
        });
        page = await context.newPage();
        for (const target of config.pages) {
            const capture = await capturePage(page, target, config, {...options, backend: 'local'});
            const paths = await writeCapture(config.outDir, target.id, capture);
            captures.push({id: target.id, url: target.url, paths});
        }
    } finally {
        await page?.close();
        await browser.close?.();
    }

    return captures;
}
