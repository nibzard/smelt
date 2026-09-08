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
import {normalizeSessionConfig} from './session.mjs';

export async function loadSteelCaptureConfig(configPath) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assertObject(config, 'config');
    if (!Array.isArray(config.pages) || config.pages.length === 0) {
        throw new TypeError('config.pages must be a nonempty array.');
    }
    const pages = config.pages.map((page, index) => normalizePage(page, index));
    assertUniquePageIds(pages);
    const session = normalizeSessionConfig(config.session ?? null);
    if (!session && !(config.browser?.wsEndpoint ?? process.env.STEEL_BROWSER_WS_ENDPOINT)) {
        throw new TypeError(
            'Set config.browser.wsEndpoint, STEEL_BROWSER_WS_ENDPOINT, or config.session.');
    }
    return {
        outDir: requireString(config.outDir ?? 'corpus/captures', 'config.outDir'),
        browser: normalizeBrowser(config.browser ?? {}),
        viewport: normalizeViewport(config.viewport ?? {}),
        observationMs: normalizeNonNegativeNumber(config.observationMs, DEFAULT_OBSERVATION_MS,
            'config.observationMs'),
        navigationTimeoutMs: normalizeNonNegativeNumber(config.navigationTimeoutMs,
            DEFAULT_NAVIGATION_TIMEOUT_MS, 'config.navigationTimeoutMs'),
        egressLocation: optionalString(config.egressLocation, 'config.egressLocation'),
        storageState: normalizeStorageState(config.storageState, 'config.storageState'),
        singleFileScriptPath: config.singleFileScriptPath ?? null,
        session,
        pages
    };
}

function normalizeBrowser(browser) {
    assertObject(browser, 'config.browser');
    const name = normalizeBrowserName(browser.name);
    const wsEndpoint = optionalString(browser.wsEndpoint ?? process.env.STEEL_BROWSER_WS_ENDPOINT,
        'config.browser.wsEndpoint');
    return {name, wsEndpoint};
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

async function connectBrowser(config, playwright) {
    if (!config.browser.wsEndpoint) {
        throw new Error('Set config.browser.wsEndpoint or STEEL_BROWSER_WS_ENDPOINT for Steel capture.');
    }
    if (config.browser.name === 'chromium') {
        return playwright.chromium.connectOverCDP(config.browser.wsEndpoint);
    }
    return playwright.firefox.connect(config.browser.wsEndpoint);
}

// Returns an array of captures. With continueOnError, returns
// {captures, failures} instead and keeps going after a page fails.
export async function runSteelCapture(config, options = {}) {
    const playwright = options.playwright ?? await import('playwright');
    const browser = await connectBrowser(config, playwright);
    const continueOnError = options.continueOnError === true;
    const captures = [];
    const failures = [];

    try {
        for (const target of config.pages) {
            let context = null;
            let ownsContext = false;
            try {
                if (options.isolatedContexts) {
                    // A fresh context per page keeps third-party consent
                    // cookies from leaking between captures.
                    context = await browser.newContext({
                        userAgent: DEFAULT_USER_AGENT,
                        viewport: config.viewport,
                        storageState: config.storageState ?? undefined
                    });
                    ownsContext = true;
                } else {
                    context = browser.contexts?.()[0] ?? await browser.newContext({
                        userAgent: DEFAULT_USER_AGENT,
                        viewport: config.viewport,
                        storageState: config.storageState ?? undefined
                    });
                }
                const page = await context.newPage();
                try {
                    const capture = await capturePage(page, target, config,
                        {...options, backend: 'steel'});
                    const paths = await writeCapture(config.outDir, target.id, capture);
                    captures.push({id: target.id, url: target.url, paths});
                } finally {
                    await page.close();
                }
            } catch (error) {
                if (!continueOnError) throw error;
                failures.push({id: target.id, url: target.url,
                    error: String(error?.message ?? error)});
            } finally {
                if (ownsContext) await context?.close?.();
            }
        }
    } finally {
        await browser.close?.();
    }

    return continueOnError ? {captures, failures} : captures;
}

export function configUrl(configPath) {
    return pathToFileURL(path.resolve(configPath)).href;
}
