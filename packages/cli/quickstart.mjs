/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The opt-in quickstart completion flow (IDEA.md 4.3, Appendix E decision
// 8): no telemetry, ever. The only completion signals leave this process
// as text the user may copy: a pre-filled GitHub issue link and an
// invitation to open an ADOPTERS.md pull request. This module performs no
// network I/O.

import {VERSION, detect} from '@smelt-oss/consent-banners';

export const REPOSITORY = 'https://github.com/smelt-oss/smelt';
export const ISSUE_MARKER = '[quickstart]';

// A page the shipped rules already detect. It exercises the full path in
// Node: HTML string in, linkedom fallback, rules, bundled model, best root.
export const SAMPLE_PAGE = `<html><body>
    <main id="content"><h1>Example shop</h1><p>North Atlantic goods.</p></main>
    <aside id="cookie">
        <p>This site uses cookies to improve privacy preferences.</p>
        <button>Accept</button>
    </aside>
</body></html>`;

function roundMs(value) {
    return Number(value.toFixed(1));
}

// Detection never reached a verdict when it degraded, so the report says
// null instead of a miss: a broken install is not a regression.
function foundFrom(result) {
    if (result.found?.length) return true;
    return result.degraded.length === 0 ? false : null;
}

/**
 * The pre-filled GitHub issue link a user may open to record their
 * quickstart run. The `[quickstart]` title marker keeps the runs countable
 * by title search; the outcome word (completed, failed, not run) splits
 * completions from failures, and every count taken this way is a lower
 * bound.
 *
 * @param {object} [summary] Fields reported in the issue body.
 * @param {string} [summary.version] Smelt version that ran.
 * @param {boolean|null} [summary.found] True when the sample detected,
 *     false on a miss, null when detection never ran.
 * @param {number} [summary.ms] Detection wall time in milliseconds.
 * @param {string[]} [summary.degraded] Degradation reasons, when any.
 * @returns {string} Absolute issues/new URL with title and body.
 */
export function completionIssueUrl(
    {version = VERSION, found = null, ms = null, degraded = []} = {}) {
    const outcome = found === true ? 'completed' : found === false ? 'failed' : 'not run';
    const title = `${ISSUE_MARKER} ${outcome} (smelt ${version})`;
    const detection = found === true ? 'found' : found === false ? 'not found' : 'not run';
    const body = [
        'I ran the Smelt quickstart.',
        '',
        `- version: ${version}`,
        `- sample detection: ${detection}`,
        ms === null ? '- sample time: not run' : `- sample time: ${roundMs(ms)} ms`,
        ...(degraded.length > 0 ? [`- degraded: ${degraded.join(', ')}`] : []),
        '',
        'This issue is an opt-in completion signal. Smelt sends no telemetry;',
        'I opened this link myself.',
        '',
        'Delete this issue if you did not mean to post it.'
    ].join('\n');
    const query = new URLSearchParams({title, body});
    return `${REPOSITORY}/issues/new?${query}`;
}

/**
 * Run the quickstart on the bundled sample page and collect everything the
 * command prints, including the opt-in links.
 *
 * @param {object} [options] {version} — the CLI version to report.
 * @returns {Promise<object>} Report with sample result, issue link, and
 *     telemetry flag.
 */
export async function quickstartReport({version = VERSION} = {}) {
    const result = await detect(SAMPLE_PAGE);
    const found = foundFrom(result);
    return {
        schemaVersion: 1,
        version,
        sample: {
            found,
            kind: result.banner?.kind ?? null,
            evidence: result.banner?.evidence ?? [],
            ms: roundMs(result.stats.ms),
            degraded: result.degraded
        },
        issueUrl: completionIssueUrl({version, found, ms: result.stats.ms,
            degraded: result.degraded}),
        adoptersUrl: `${REPOSITORY}/blob/main/ADOPTERS.md`,
        telemetry: 'none'
    };
}

/**
 * Render the quickstart report as the transcript the command prints.
 *
 * @param {object} report A report from quickstartReport().
 * @returns {string} Human-readable transcript.
 */
export function quickstartText(report) {
    const sample = report.sample.found === null
        ? `Sample page: detection degraded (${report.sample.degraded.join(', ')}); ` +
            'the demo did not run. Check the install (npm ci).'
        : `Sample page: ${report.sample.found ? 'consent banner found' : 'no banner found'}` +
            (report.sample.kind ? ` (kind: ${report.sample.kind})` : '');
    const lines = [
        'Smelt quickstart — local detection demo',
        '',
        `Smelt version: ${report.version}`,
        sample,
        ...(report.sample.found === null ? [] : [`Detection time: ${report.sample.ms} ms`]),
        '',
        'The bundled model trains on the synthetic seed corpus only.',
        'Release accuracy waits on the release corpus and the frozen test set.',
        '',
        'Next steps:',
        '- smelt test        Run the size and export gates.',
        '- smelt train       Train on your own labeled pages. The first run',
        '  provisions Python (uv sync, pinned lightgbm and numpy); measured',
        '  first run about 113 s, warm no-op about 40 ms.',
        '',
        'Opt-in completion signals (nothing is sent automatically):',
        `- Open a pre-filled issue to record your run:`,
        `  ${report.issueUrl}`,
        `- Adopted Smelt? Add yourself to ADOPTERS.md by pull request:`,
        `  ${report.adoptersUrl}`,
        '',
        'No telemetry: this command made no network requests.'
    ];
    return lines.join('\n');
}
