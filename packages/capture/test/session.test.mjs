/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {
    createSteelSession,
    normalizeSessionConfig,
    parseRobotsGroups,
    releaseSteelSession,
    robotsAllows,
    robotsAllowsPath,
    rulesForUserAgent,
    runSteelSessionCrawl,
    sessionReportPath
} from '../session.mjs';
import {loadSteelCaptureConfig} from '../steel.mjs';
import {FakePage} from './helpers.mjs';

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
}

function sessionApi() {
    const requests = [];
    let nextSession = 1;
    const fetchImpl = async (url, init = {}) => {
        const body = JSON.parse(init.body ?? '{}');
        requests.push({url, method: init.method ?? 'GET', body});
        if (url.endsWith('/sessions') && init.method === 'POST') {
            return jsonResponse(201, {
                id: `session-${nextSession}`,
                websocketUrl: `wss://steel.test/session-${nextSession}`,
                region: 'iad'
            });
        }
        const match = /\/sessions\/([^/]+)(\/release)?$/.exec(url);
        if (match?.[2]) {
            return jsonResponse(200, {success: true});
        }
        if (match) {
            return jsonResponse(200, {
                id: match[1],
                region: body.region ?? 'iad',
                creditsUsed: 3,
                proxyBytesUsed: 1024,
                duration: 45000,
                status: 'released'
            });
        }
        return jsonResponse(404, {error: 'not found'});
    };
    return {requests, fetchImpl, nextSessionId: () => nextSession++};
}

test('normalizeSessionConfig validates the session block', () => {
    assert.equal(normalizeSessionConfig(null), null);
    const session = normalizeSessionConfig({proxyCountry: 'DE', chunkSize: 5});
    assert.equal(session.proxyCountry, 'DE');
    assert.equal(session.region, null);
    assert.equal(session.chunkSize, 5);
    assert.equal(session.respectRobots, true);
    assert.equal(session.reportDir, null);

    assert.throws(() => normalizeSessionConfig({region: 'eu-west'}), /must be one of/);
    assert.throws(() => normalizeSessionConfig({proxyCountry: 'deu'}), /Alpha-2/);
    assert.throws(() => normalizeSessionConfig({proxyCountry: 'de'}), /Alpha-2/);
    assert.throws(() => normalizeSessionConfig({chunkSize: 0}), /positive integer/);
    assert.throws(() => normalizeSessionConfig({timeoutMs: -1}), /nonnegative/);
});

test('loadSteelCaptureConfig requires an endpoint or a session block', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-session-config-'));
    try {
        const base = {
            outDir: path.join(dir, 'captures'),
            pages: [{id: 'example', url: 'https://example.test/'}]
        };
        const withSession = path.join(dir, 'with-session.json');
        await (await import('node:fs/promises')).writeFile(withSession, JSON.stringify({
            ...base,
            session: {proxyCountry: 'DE'}
        }));
        const loaded = await loadSteelCaptureConfig(withSession);
        assert.equal(loaded.session.proxyCountry, 'DE');
        assert.equal(loaded.browser.wsEndpoint, null);

        const bare = path.join(dir, 'bare.json');
        await (await import('node:fs/promises')).writeFile(bare, JSON.stringify(base));
        await assert.rejects(() => loadSteelCaptureConfig(bare),
            /config.browser.wsEndpoint, STEEL_BROWSER_WS_ENDPOINT, or config.session/);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('createSteelSession sends region and proxy geolocation', async () => {
    const api = sessionApi();
    const session = await createSteelSession({
        apiKey: 'test-key',
        fetchImpl: api.fetchImpl,
        region: 'iad',
        proxyCountry: 'DE',
        timeoutMs: 60000,
        inactivityTimeoutMs: 0
    });
    assert.equal(session.id, 'session-1');
    const create = api.requests.find(request => request.method === 'POST');
    assert.deepEqual(create.body, {
        region: 'iad',
        useProxy: {geolocation: {country: 'DE'}},
        timeout: 60000,
        inactivityTimeout: 0
    });
});

test('createSteelSession requires an API key and reports failures', async () => {
    const saved = process.env.STEEL_API_KEY;
    delete process.env.STEEL_API_KEY;
    try {
        await assert.rejects(() => createSteelSession({fetchImpl: sessionApi().fetchImpl}),
            /STEEL_API_KEY/);
        await assert.rejects(() => createSteelSession({
            apiKey: 'test-key',
            fetchImpl: async () => jsonResponse(402, {error: 'plan required'})
        }), /402.*plan required/);
    } finally {
        if (saved !== undefined) process.env.STEEL_API_KEY = saved;
    }
});

test('releaseSteelSession reports the release outcome', async () => {
    const api = sessionApi();
    const release = await releaseSteelSession({
        apiKey: 'test-key',
        fetchImpl: api.fetchImpl,
        sessionId: 'session-9'
    });
    assert.deepEqual(release, {ok: true, status: 200});
    assert.ok(api.requests.some(request => request.url.includes('/sessions/session-9/release')));
});

test('parseRobotsGroups keeps groups and rulesForUserAgent picks the match', () => {
    const groups = parseRobotsGroups(`
        User-agent: Googlebot
        Disallow: /private

        User-agent: *
        Disallow: /consent
        Allow: /consent/public

        User-agent: SmeltCorpusBot
        User-agent: crawl-buddy
        Disallow: /opt-out
    `);
    assert.deepEqual(groups.map(group => group.agents), [
        ['googlebot'],
        ['*'],
        ['smeltcorpusbot', 'crawl-buddy']
    ]);

    // An own group wins over the wildcard group.
    assert.deepEqual(rulesForUserAgent(groups, 'SmeltCorpusBot/1.0'), [
        {kind: 'disallow', value: '/opt-out'}
    ]);
    // A named bot with no group falls back to the wildcard rules.
    assert.deepEqual(rulesForUserAgent(groups, 'OtherBot/2.0'), [
        {kind: 'disallow', value: '/consent'},
        {kind: 'allow', value: '/consent/public'}
    ]);
    // An empty "Disallow" stays in the rules; it allows every path.
    assert.deepEqual(rulesForUserAgent(parseRobotsGroups('User-agent: *\nDisallow:'),
        'AnyBot/1.0'), [{kind: 'disallow', value: ''}]);
});

test('robotsAllowsPath follows longest-match wins', () => {
    const rules = [
        {kind: 'disallow', value: '/'},
        {kind: 'allow', value: '/public'}
    ];
    assert.equal(robotsAllowsPath(rules, '/'), false);
    assert.equal(robotsAllowsPath(rules, '/public/page'), true);

    // Equal lengths: the allow wins.
    const tie = [{kind: 'disallow', value: '/'}, {kind: 'allow', value: '/'}];
    assert.equal(robotsAllowsPath(tie, '/'), true);

    assert.equal(robotsAllowsPath([], '/'), true);
    // An empty disallow value allows everything.
    assert.equal(robotsAllowsPath([{kind: 'disallow', value: ''}], '/'), true);
});

test('robotsAllows caches parsed rules per origin and answers each path freshly',
    async () => {
    const fetched = [];
    const fetchImpl = async url => {
        fetched.push(url);
        return jsonResponse(200, 'User-agent: *\nDisallow: /private');
    };
    const cache = new Map();
    const blocked = await robotsAllows('https://mixed.test/private/page', {fetchImpl, cache});
    const open = await robotsAllows('https://mixed.test/public', {fetchImpl, cache});
    const noRobots = await robotsAllows('https://open.test/', {
        fetchImpl: async () => jsonResponse(404, ''),
        cache
    });

    // One fetch per origin; the second path sees a different verdict.
    assert.deepEqual(blocked, {allowed: false, reason: 'robots-disallow'});
    assert.deepEqual(open, {allowed: true, reason: 'robots-allow'});
    assert.deepEqual(noRobots, {allowed: true, reason: 'no-robots-file'});
    assert.deepEqual(fetched, ['https://mixed.test/robots.txt']);

    const unreachable = await robotsAllows('https://down.test/', {
        fetchImpl: async () => { throw new Error('offline'); },
        cache: new Map()
    });
    assert.deepEqual(unreachable, {allowed: true, reason: 'robots-unreachable'});
});

test('robotsRules applies the group that names this crawler', async () => {
    const fetchImpl = async () => jsonResponse(200, `
        User-agent: *
        Disallow:

        User-agent: smeltcorpusbot
        Disallow: /
    `);
    const verdict = await robotsAllows('https://selective.test/any', {fetchImpl});
    assert.deepEqual(verdict, {allowed: false, reason: 'robots-disallow'});
});

function crawlConfig(overrides = {}) {
    return {
        outDir: 'corpus/captures',
        browser: {name: 'chromium', wsEndpoint: null},
        viewport: {width: 1280, height: 720, deviceScaleFactor: 1},
        observationMs: 1,
        navigationTimeoutMs: 1000,
        egressLocation: 'test',
        storageState: null,
        session: normalizeSessionConfig({region: 'iad', chunkSize: 2}),
        pages: [
            {id: 'a', url: 'https://a.test/', group: 'a.test'},
            {id: 'b', url: 'https://b.test/', group: 'b.test'}
        ],
        ...overrides
    };
}

function fakePlaywrightForCrawl(pages) {
    const browsers = [];
    const chromium = {connectOverCDP: async endpoint => {
        const browser = {
            endpoint,
            createdContexts: [],
            async newContext() {
                const page = pages.shift();
                const context = {
                    closed: false,
                    async close() { this.closed = true; },
                    newPage: async () => page
                };
                browser.createdContexts.push(context);
                return context;
            },
            async close() {}
        };
        browsers.push(browser);
        return browser;
    }};
    return {chromium, browsers};
}

test('runSteelSessionCrawl captures through managed sessions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-session-crawl-'));
    const api = sessionApi();
    try {
        const pages = [
            new FakePage('<html><body>Ok A</body></html>'),
            new FakePage('<html><body>Ok B</body></html>')
        ];
        const playwright = fakePlaywrightForCrawl(pages);
        const result = await runSteelSessionCrawl(crawlConfig({outDir: dir}), {
            apiKey: 'test-key',
            fetchImpl: api.fetchImpl,
            playwright,
            robotsCache: new Map([['https://a.test', {rules: [], reason: 'no-robots-file'}],
                ['https://b.test', {rules: [], reason: 'no-robots-file'}]])
        });

        assert.deepEqual(result.captures.map(capture => capture.id), ['a', 'b']);
        assert.deepEqual(result.failures, []);
        assert.deepEqual(result.skipped, []);
        assert.equal(result.sessions.length, 1);
        const [report] = result.sessions;
        assert.equal(report.sessionId, 'session-1');
        assert.deepEqual(report.capturedIds, ['a', 'b']);
        assert.equal(report.creditsUsed, 3);
        assert.equal(report.proxyBytesUsed, 1024);
        assert.equal(report.released, true);
        assert.equal(playwright.browsers[0].endpoint, 'wss://steel.test/session-1');
        // One isolated context per page, and each context closes.
        assert.equal(playwright.browsers[0].createdContexts.length, 2);
        assert.ok(playwright.browsers[0].createdContexts.every(context => context.closed));
        const metadata = JSON.parse(
            await readFile(path.join(dir, 'a.metadata.json'), 'utf8'));
        assert.equal(metadata.backend, 'steel');
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('runSteelSessionCrawl chunks pages across sessions and survives failures',
    async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'smelt-session-chunk-'));
        const api = sessionApi();
        try {
            const badPage = new FakePage('<html><body>Bad</body></html>');
            badPage.goto = async () => { throw new Error('navigation timed out'); };
            const pages = [
                new FakePage('<html><body>Ok A</body></html>'),
                badPage,
                new FakePage('<html><body>Ok C</body></html>')
            ];
            const playwright = fakePlaywrightForCrawl(pages);
            const config = crawlConfig({
                outDir: dir,
                session: normalizeSessionConfig({chunkSize: 2}),
                pages: [
                    {id: 'a', url: 'https://a.test/', group: 'a.test'},
                    {id: 'b', url: 'https://b.test/', group: 'b.test'},
                    {id: 'c', url: 'https://c.test/', group: 'c.test'}
                ]
            });
            const robotsCache = new Map(['a', 'b', 'c'].map(name =>
                [`https://${name}.test`, {rules: [], reason: 'no-robots-file'}]));
            const result = await runSteelSessionCrawl(config, {
                apiKey: 'test-key',
                fetchImpl: api.fetchImpl,
                playwright,
                robotsCache
            });

            assert.deepEqual(result.captures.map(capture => capture.id), ['a', 'c']);
            assert.deepEqual(result.failures,
                [{id: 'b', url: 'https://b.test/', error: 'navigation timed out'}]);
            assert.equal(result.sessions.length, 2);
            assert.equal(result.sessions[0].released, true);
            assert.equal(result.sessions[1].released, true);
            // The failed page still writes no capture files.
            const files = await (await import('node:fs/promises'))
                .readdir(dir);
            assert.equal(files.includes('b.metadata.json'), false);
        } finally {
            await rm(dir, {recursive: true, force: true});
        }
    });

test('runSteelSessionCrawl records chunk errors and still releases', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smelt-session-throw-'));
    const api = sessionApi();
    try {
        const playwright = {chromium: {connectOverCDP: async () => {
            throw new Error('tunnel down');
        }}};
        const result = await runSteelSessionCrawl(crawlConfig({outDir: dir}), {
            apiKey: 'test-key',
            fetchImpl: api.fetchImpl,
            playwright,
            robotsCache: new Map([['https://a.test', {rules: [], reason: 'no-robots-file'}],
                ['https://b.test', {rules: [], reason: 'no-robots-file'}]])
        });

        assert.deepEqual(result.captures, []);
        assert.deepEqual(result.chunkErrors,
            [{pages: ['a', 'b'], error: 'tunnel down'}]);
        // The session still gets released and reported.
        assert.equal(result.sessions.length, 1);
        assert.equal(result.sessions[0].released, true);
        assert.deepEqual(result.sessions[0].capturedIds, []);
        assert.ok(api.requests.some(request =>
            request.method === 'POST' && request.url.endsWith('/sessions/session-1/release')));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('runSteelSessionCrawl merges the higher post-release cost counters',
    async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'smelt-session-cost-'));
        try {
            const settleCounters = released => ({
                creditsUsed: released ? 5 : 3,
                proxyBytesUsed: released ? 2048 : 1024,
                duration: released ? 9000 : 4500
            });
            const crawlWith = fetchImpl => runSteelSessionCrawl(
                crawlConfig({outDir: dir, pages: [{id: 'a', url: 'https://a.test/'}]}), {
                    apiKey: 'test-key',
                    fetchImpl,
                    playwright: fakePlaywrightForCrawl([
                        new FakePage('<html><body>Ok</body></html>')
                    ]),
                    robotsCache: new Map([['https://a.test',
                        {rules: [], reason: 'no-robots-file'}]])
                });

            // Counters settle upward after release; the report keeps the max.
            let released = false;
            const settling = async (url, init = {}) => {
                if (url.endsWith('/sessions') && init.method === 'POST') {
                    return jsonResponse(201,
                        {id: 's1', websocketUrl: 'wss://steel.test/s1'});
                }
                if (url.endsWith('/release')) {
                    released = true;
                    return jsonResponse(200, {success: true});
                }
                return jsonResponse(200, {id: 's1', ...settleCounters(released)});
            };
            const settled = await crawlWith(settling);
            assert.equal(settled.sessions[0].creditsUsed, 5);
            assert.equal(settled.sessions[0].proxyBytesUsed, 2048);
            assert.equal(settled.sessions[0].durationMs, 9000);

            // A vanished post-release session falls back to the live read.
            let reads = 0;
            const vanishing = async (url, init = {}) => {
                if (url.endsWith('/sessions') && init.method === 'POST') {
                    return jsonResponse(201,
                        {id: 's1', websocketUrl: 'wss://steel.test/s1'});
                }
                if (url.endsWith('/release')) {
                    return jsonResponse(200, {success: true});
                }
                reads += 1;
                return reads === 1
                    ? jsonResponse(200, {id: 's1', ...settleCounters(false)})
                    : jsonResponse(404, {error: 'gone'});
            };
            const vanished = await crawlWith(vanishing);
            assert.equal(vanished.sessions[0].creditsUsed, 3);
            assert.equal(vanished.sessions[0].durationMs, 4500);
        } finally {
            await rm(dir, {recursive: true, force: true});
        }
    });

test('runSteelSessionCrawl skips robots-blocked pages without a session',
    async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'smelt-session-robots-'));
        const api = sessionApi();
        try {
            const playwright = fakePlaywrightForCrawl([
                new FakePage('<html><body>Ok</body></html>')
            ]);
            const config = crawlConfig({
                outDir: dir,
                pages: [
                    {id: 'blocked', url: 'https://blocked.test/', group: 'blocked.test'},
                    {id: 'open', url: 'https://open.test/', group: 'open.test'}
                ]
            });
            const fetchImpl = async (url, init = {}) => {
                if (url === 'https://blocked.test/robots.txt') {
                    return jsonResponse(200, 'User-agent: *\nDisallow: /');
                }
                if (url === 'https://open.test/robots.txt') {
                    return jsonResponse(404, '');
                }
                if (url.endsWith('/sessions') || url.includes('/release')) {
                    return api.fetchImpl(url, {method: 'POST', body: '{}'});
                }
                return api.fetchImpl(url, init);
            };
            const result = await runSteelSessionCrawl(config, {
                apiKey: 'test-key',
                fetchImpl,
                playwright
            });

            assert.deepEqual(result.skipped, [{
                id: 'blocked',
                url: 'https://blocked.test/',
                reason: 'robots-disallow'
            }]);
            assert.deepEqual(result.captures.map(capture => capture.id), ['open']);
            assert.equal(result.sessions.length, 1);
            assert.equal(result.sessions[0].pages, 1);
        } finally {
            await rm(dir, {recursive: true, force: true});
        }
    });

test('sessionReportPath lands outside the captures directory', () => {
    const config = crawlConfig({outDir: 'corpus/captures'});
    const reportPath = sessionReportPath(config);
    assert.equal(path.dirname(reportPath), 'corpus/sessions');
    assert.match(path.basename(reportPath), /^crawl-test-\d{4}-\d{2}-\d{2}T/);
});
