/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import path from 'node:path';

import {normalizeNonNegativeNumber, optionalString} from './crawl.mjs';
import {runSteelCapture} from './steel.mjs';

export const STEEL_API_URL = 'https://api.steel.dev/v1';
export const DEFAULT_CHUNK_SIZE = 25;
export const DEFAULT_SESSION_TIMEOUT_MS = 900000;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 300000;
export const ROBOTS_USER_AGENT = 'SmeltCorpusBot/1.0';

// Steel documents iad and lax. The API accepts other strings but then serves
// a US browser anyway, so reject anything else up front.
export const STEEL_REGIONS = ['iad', 'lax'];

const COUNTRY_PATTERN = /^[A-Z]{2}$/;

export function normalizeSessionConfig(session) {
    if (session == null) return null;
    if (typeof session !== 'object' || Array.isArray(session)) {
        throw new TypeError('config.session must be an object.');
    }
    const region = optionalString(session.region, 'config.session.region');
    if (region !== null && !STEEL_REGIONS.includes(region)) {
        throw new TypeError(
            `config.session.region must be one of ${STEEL_REGIONS.join(', ')}.`);
    }
    const proxyCountry = optionalString(session.proxyCountry,
        'config.session.proxyCountry');
    if (proxyCountry !== null && !COUNTRY_PATTERN.test(proxyCountry)) {
        throw new TypeError(
            'config.session.proxyCountry must be an ISO 3166 Alpha-2 code.');
    }
    const chunkSize = session.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
        throw new TypeError('config.session.chunkSize must be a positive integer.');
    }
    return {
        region,
        proxyCountry,
        chunkSize,
        timeoutMs: normalizeNonNegativeNumber(session.timeoutMs,
            DEFAULT_SESSION_TIMEOUT_MS, 'config.session.timeoutMs'),
        inactivityTimeoutMs: normalizeNonNegativeNumber(session.inactivityTimeoutMs,
            DEFAULT_INACTIVITY_TIMEOUT_MS, 'config.session.inactivityTimeoutMs'),
        respectRobots: session.respectRobots !== false,
        reportDir: optionalString(session.reportDir, 'config.session.reportDir')
    };
}

function requireApiKey(options) {
    const apiKey = options.apiKey ?? process.env.STEEL_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
        throw new Error('Set STEEL_API_KEY or pass options.apiKey for Steel sessions.');
    }
    return apiKey;
}

// Session responses carry token-bearing URLs. Never stringify one into an
// error; surface only the vendor's own error or message field.
function describeFailure(body) {
    const reason = typeof body?.error === 'string' ? body.error
        : typeof body?.message === 'string' ? body.message : 'no session in response';
    return reason.slice(0, 160);
}

export async function createSteelSession(options = {}) {
    const apiKey = requireApiKey(options);
    const apiUrl = options.apiUrl ?? STEEL_API_URL;
    const body = {};
    if (options.region) body.region = options.region;
    if (options.proxyCountry) {
        body.useProxy = {geolocation: {country: options.proxyCountry}};
    }
    if (options.timeoutMs != null) body.timeout = options.timeoutMs;
    if (options.inactivityTimeoutMs != null) {
        body.inactivityTimeout = options.inactivityTimeoutMs;
    }
    const response = await (options.fetchImpl ?? fetch)(`${apiUrl}/sessions`, {
        method: 'POST',
        headers: {'steel-api-key': apiKey, 'content-type': 'application/json'},
        body: JSON.stringify(body)
    });
    const session = await response.json().catch(() => null);
    if (!response.ok || !session?.id || !session?.websocketUrl) {
        throw new Error(
            `Steel session create failed (${response.status}): ${describeFailure(session)}`);
    }
    return session;
}

export async function fetchSteelSession(options = {}) {
    const apiKey = requireApiKey(options);
    const apiUrl = options.apiUrl ?? STEEL_API_URL;
    const response = await (options.fetchImpl ?? fetch)(
        `${apiUrl}/sessions/${encodeURIComponent(options.sessionId)}`, {
            method: 'GET',
            headers: {'steel-api-key': apiKey}
        });
    if (!response.ok) return null;
    return response.json().catch(() => null);
}

export async function releaseSteelSession(options = {}) {
    const apiKey = requireApiKey(options);
    const apiUrl = options.apiUrl ?? STEEL_API_URL;
    const response = await (options.fetchImpl ?? fetch)(
        `${apiUrl}/sessions/${encodeURIComponent(options.sessionId)}/release`, {
            method: 'POST',
            headers: {'steel-api-key': apiKey}
        });
    return {ok: response.ok, status: response.status};
}

// A minimal RFC 9309 reader. It keeps user-agent groups, picks the group
// that names this crawler (or the "*" group as fallback), and answers one
// path question. Anything it cannot parse counts as allowed, because an
// unreadable robots file blocks nothing.
export function parseRobotsGroups(text) {
    const groups = [];
    let agents = [];
    let rules = [];
    let sawRule = false;
    const flush = () => {
        if (agents.length > 0 && rules.length > 0) {
            groups.push({agents, rules});
        }
        agents = [];
        rules = [];
    };
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const separator = line.indexOf(':');
        if (separator === -1) continue;
        const field = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (field === 'user-agent') {
            if (sawRule) flush();
            sawRule = false;
            agents.push(value.toLowerCase());
        } else if (field === 'allow' || field === 'disallow') {
            sawRule = true;
            rules.push({kind: field, value});
        }
    }
    flush();
    return groups;
}

export function rulesForUserAgent(groups, userAgent) {
    const token = String(userAgent).toLowerCase().split('/')[0].trim();
    const own = groups.filter(group => group.agents.includes(token));
    if (own.length > 0) return own.flatMap(group => group.rules);
    return groups.filter(group => group.agents.includes('*'))
        .flatMap(group => group.rules);
}

export function robotsAllowsPath(rules, pagePath) {
    const matches = rules
        .filter(rule => rule.kind === 'disallow' && rule.value !== ''
            && pagePath.startsWith(rule.value))
        .map(rule => rule.value);
    if (matches.length === 0) return true;
    // Blocked, unless an "allow" of equal or greater length wins.
    const blocking = matches.reduce((longest, value) =>
        value.length > longest.length ? value : longest);
    return rules.some(rule => rule.kind === 'allow'
        && rule.value !== '' && pagePath.startsWith(rule.value)
        && rule.value.length >= blocking.length);
}

// The cache stores parsed rules per origin, not a verdict. Two pages on one
// origin can have different paths with different rules.
export async function robotsRules(url, options = {}) {
    const parsed = new URL(url);
    const cache = options.cache ?? new Map();
    if (cache.has(parsed.origin)) return cache.get(parsed.origin);
    let entry = {rules: [], reason: 'no-robots-file'};
    try {
        const response = await (options.fetchImpl ?? fetch)(
            `${parsed.origin}/robots.txt`, {
                headers: {'user-agent': ROBOTS_USER_AGENT},
                signal: AbortSignal.timeout(5000)
            });
        if (response.ok) {
            entry = {
                rules: rulesForUserAgent(
                    parseRobotsGroups(await response.text()), ROBOTS_USER_AGENT),
                reason: 'robots-loaded'
            };
        }
    } catch {
        entry = {rules: [], reason: 'robots-unreachable'};
    }
    cache.set(parsed.origin, entry);
    return entry;
}

export async function robotsAllows(url, options = {}) {
    const parsed = new URL(url);
    const entry = await robotsRules(url, options);
    if (entry.rules.length === 0) return {allowed: true, reason: entry.reason};
    const pagePath = parsed.pathname || '/';
    return robotsAllowsPath(entry.rules, pagePath)
        ? {allowed: true, reason: 'robots-allow'}
        : {allowed: false, reason: 'robots-disallow'};
}

export function sessionReportPath(config) {
    const reportDir = config.session.reportDir
        ?? path.join(path.dirname(config.outDir), 'sessions');
    // The egress label comes from a config file; keep it inside one name.
    const label = String(config.egressLocation ?? 'steel')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(reportDir, `crawl-${label}-${stamp}.json`);
}

// Cost and release calls must never mask the capture result. A failed read
// returns null; a failed release returns a recorded outcome.
async function readSessionOrNull(request) {
    try {
        return await fetchSteelSession(request);
    } catch {
        return null;
    }
}

async function releaseSessionOrNull(request) {
    try {
        return await releaseSteelSession(request);
    } catch (error) {
        return {ok: false, status: null, error: String(error?.message ?? error)};
    }
}

export async function runSteelSessionCrawl(config, options = {}) {
    if (!config.session) {
        throw new TypeError('runSteelSessionCrawl requires config.session.');
    }
    const session = config.session;
    const apiKey = requireApiKey(options);
    const robotsCache = options.robotsCache ?? new Map();
    const allowed = [];
    const skipped = [];
    for (const target of config.pages) {
        if (session.respectRobots) {
            const verdict = await robotsAllows(target.url, {...options, cache: robotsCache});
            if (!verdict.allowed) {
                skipped.push({id: target.id, url: target.url, reason: verdict.reason});
                continue;
            }
        }
        allowed.push(target);
    }

    const captures = [];
    const failures = [];
    const sessionReports = [];
    const chunkErrors = [];
    const readRequest = sessionId => ({
        apiKey,
        apiUrl: options.apiUrl,
        fetchImpl: options.fetchImpl,
        sessionId
    });
    for (let start = 0; start < allowed.length; start += session.chunkSize) {
        const chunk = allowed.slice(start, start + session.chunkSize);
        let created = null;
        let chunkResult = {captures: [], failures: []};
        try {
            created = await createSteelSession({
                apiKey,
                apiUrl: options.apiUrl,
                fetchImpl: options.fetchImpl,
                region: session.region,
                proxyCountry: session.proxyCountry,
                timeoutMs: session.timeoutMs,
                inactivityTimeoutMs: session.inactivityTimeoutMs
            });
            chunkResult = await runSteelCapture({
                ...config,
                browser: {...config.browser, wsEndpoint: created.websocketUrl},
                pages: chunk
            }, {...options, continueOnError: true, isolatedContexts: true});
        } catch (error) {
            chunkErrors.push({
                pages: chunk.map(page => page.id),
                error: String(error?.message ?? error)
            });
        } finally {
            if (created) {
                // Cost counters settle asynchronously, so read the live
                // session before releasing and merge with a post-release
                // read. Release must happen even when the capture threw.
                const live = await readSessionOrNull(readRequest(created.id));
                const release = await releaseSessionOrNull(readRequest(created.id));
                const final = await readSessionOrNull(readRequest(created.id));
                sessionReports.push({
                    sessionId: created.id,
                    requestedRegion: session.region,
                    proxyCountry: session.proxyCountry,
                    region: final?.region ?? live?.region ?? null,
                    pages: chunk.length,
                    capturedIds: chunkResult.captures.map(capture => capture.id),
                    failures: chunkResult.failures,
                    creditsUsed: Math.max(final?.creditsUsed ?? 0, live?.creditsUsed ?? 0) || null,
                    proxyBytesUsed: Math.max(final?.proxyBytesUsed ?? 0, live?.proxyBytesUsed ?? 0) || null,
                    durationMs: Math.max(final?.duration ?? 0, live?.duration ?? 0) || null,
                    released: release.ok
                });
            }
        }
        captures.push(...chunkResult.captures);
        failures.push(...chunkResult.failures);
    }
    return {captures, failures, skipped, sessions: sessionReports, chunkErrors};
}
