/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {
    ISSUE_MARKER,
    REPOSITORY,
    completionIssueUrl,
    quickstartReport,
    quickstartText
} from '../quickstart.mjs';
import {runQuickstart} from '../smelt.mjs';
import {cliDir} from '../factory.mjs';

const smeltBin = join(cliDir, 'smelt.mjs');
const cliVersion = JSON.parse(
    readFileSync(join(cliDir, 'package.json'), 'utf8')).version;

function runSmelt(args) {
    return spawnSync(process.execPath, [smeltBin, ...args], {encoding: 'utf8'});
}

// Capture what a command prints while it runs.
async function capture(fn) {
    const logged = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = value => logged.push(String(value));
    console.error = value => errors.push(String(value));
    try {
        const code = await fn();
        return {code, logged, errors};
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
}

test('the completion issue link is pre-filled and countable', () => {
    const url = completionIssueUrl({version: '1.2.3', found: true, ms: 4.25});
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, `${REPOSITORY}/issues/new`);
    const query = parsed.searchParams;
    assert.equal(query.get('title'), `${ISSUE_MARKER} completed (smelt 1.2.3)`);
    const body = query.get('body');
    assert.match(body, /- version: 1\.2\.3/);
    assert.match(body, /- sample detection: found/);
    assert.match(body, /- sample time: 4\.3 ms/);
    assert.doesNotMatch(body, /- degraded:/);
    assert.match(body, /sends no telemetry/);
    // GitHub rejects very long new-issue queries; keep the body short.
    assert.ok(url.length < 4000, `url length ${url.length}`);
});

test('the issue title records the outcome, not just the marker', () => {
    const failed = completionIssueUrl({version: '1.2.3', found: false});
    assert.equal(new URL(failed).searchParams.get('title'),
        `${ISSUE_MARKER} failed (smelt 1.2.3)`);
    const notRun = completionIssueUrl({version: '1.2.3'});
    assert.equal(new URL(notRun).searchParams.get('title'),
        `${ISSUE_MARKER} not run (smelt 1.2.3)`);
    const body = new URL(notRun).searchParams.get('body');
    assert.match(body, /- sample detection: not run/);
    assert.match(body, /- sample time: not run/);
    const degraded = completionIssueUrl({version: '1.2.3', degraded: ['parse-failed']});
    assert.match(new URL(degraded).searchParams.get('body'), /- degraded: parse-failed/);
});

test('the quickstart detects the bundled sample page offline', async () => {
    const report = await quickstartReport({version: cliVersion});
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.version, cliVersion);
    assert.equal(report.sample.found, true);
    assert.equal(report.sample.kind, 'banner');
    assert.ok(report.sample.evidence.length > 0);
    assert.equal(report.sample.degraded.length, 0);
    assert.equal(typeof report.sample.ms, 'number');
    assert.equal(report.telemetry, 'none');

    const body = new URL(report.issueUrl).searchParams.get('body');
    assert.match(body, /- sample detection: found/);
    assert.ok(report.adoptersUrl.endsWith('/ADOPTERS.md'));
}, {timeout: 60000});

test('a degraded run is not reported as a detection miss', async () => {
    const base = await quickstartReport({version: cliVersion});
    const degraded = {
        ...base,
        sample: {...base.sample, found: null, degraded: ['parse-failed']},
        issueUrl: completionIssueUrl({version: cliVersion, found: null,
            degraded: ['parse-failed']})
    };
    const text = quickstartText(degraded);
    assert.match(text, /detection degraded \(parse-failed\); the demo did not run\./);
    assert.doesNotMatch(text, /no banner found/);
    assert.doesNotMatch(text, /Detection time/);
    const body = new URL(degraded.issueUrl).searchParams.get('body');
    assert.match(body, /- sample detection: not run/);
    assert.match(body, /- degraded: parse-failed/);
});

test('runQuickstart exits by the canary rules', async () => {
    const found = await capture(() => runQuickstart('9.9.9'));
    assert.equal(found.code, 0, found.errors.join('\n'));
    assert.match(found.logged.join('\n'), /Smelt version: 9\.9\.9/);
    assert.match(found.logged.join('\n'), /completed\+%28smelt\+9\.9\.9%29/);

    const missBase = await quickstartReport({version: '9.9.9'});
    const missed = await capture(() => runQuickstart('9.9.9',
        () => Promise.resolve({...missBase,
            sample: {found: false, kind: null, evidence: [], ms: 1, degraded: []}})));
    assert.equal(missed.code, 1);
    assert.match(missed.logged.join('\n'), /no banner found/);

    const broke = await capture(() => runQuickstart('9.9.9',
        () => Promise.reject(new Error('linkedom is missing'))));
    assert.equal(broke.code, 1);
    assert.match(broke.errors.join('\n'), /Quickstart failed: linkedom is missing/);
}, {timeout: 60000});

test('the transcript states the limits and the opt-in signals', async () => {
    const text = quickstartText(await quickstartReport({version: cliVersion}));
    assert.match(text, /synthetic seed corpus only/);
    assert.match(text, /No telemetry: this command made no network requests\./);
    assert.match(text, new RegExp(REPOSITORY.replaceAll('/', '\\/')));
    assert.match(text, /smelt test/);
});

test('the quickstart modules contain no network calls', () => {
    // The privacy stance is enforced in code: these modules may print a
    // link, but they must not be able to send anything. Dynamic import(
    // is not on the list because the launcher lazy-loads local modules.
    const forbidden = [
        'fetch(',
        'node:http',
        'node:https',
        'node:net',
        'node:dgram',
        'XMLHttpRequest',
        'sendBeacon',
        'WebSocket',
        '.request('
    ];
    for (const name of ['quickstart.mjs', 'smelt.mjs']) {
        const source = readFileSync(
            fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
        for (const token of forbidden) {
            assert.ok(!source.includes(token), `forbidden token in ${name}: ${token}`);
        }
    }
});

test('smelt quickstart runs the flow and exits zero', () => {
    const result = runSmelt(['quickstart']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /consent banner found/);
    assert.match(result.stdout, new RegExp(`Smelt version: ${cliVersion}`));
    assert.match(result.stdout, /github\.com\/smelt-oss\/smelt\/issues\/new\?/);
    assert.match(result.stdout, /title=%5Bquickstart%5D\+completed/);
    assert.match(result.stdout, /ADOPTERS\.md/);
    assert.match(result.stdout, /No telemetry/);
    // The command owns its whole argument list.
    const extra = runSmelt(['quickstart', '--steel']);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /quickstart takes no arguments\./);
    const help = runSmelt(['--help']);
    assert.match(help.stderr, /quickstart {16}Run the local detection demo\./);
}, {timeout: 60000});
