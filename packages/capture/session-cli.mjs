#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {loadSteelCaptureConfig} from './steel.mjs';
import {runSteelSessionCrawl, sessionReportPath} from './session.mjs';

const configPath = process.argv[2];

if (!configPath) {
    console.error('Usage: smelt-steel-crawl path/to/config.json');
    process.exitCode = 1;
} else {
    let config = null;
    let result = null;
    let reportPath = null;
    try {
        config = await loadSteelCaptureConfig(configPath);
        result = await runSteelSessionCrawl(config);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
    if (config) {
        // Write the report even after a partial failure: the session records
        // and cost totals are the only place they survive.
        const report = {
            schemaVersion: 1,
            crawl: {
                outDir: config.outDir,
                egressLocation: config.egressLocation,
                requestedRegion: config.session.region,
                proxyCountry: config.session.proxyCountry
            },
            captured: result?.captures.length ?? 0,
            failed: result?.failures.length ?? 0,
            skipped: result?.skipped.length ?? 0,
            failures: result?.failures ?? [],
            skippedPages: result?.skipped ?? [],
            sessions: result?.sessions ?? [],
            chunkErrors: result?.chunkErrors ?? []
        };
        reportPath = sessionReportPath(config);
        await mkdir(path.dirname(reportPath), {recursive: true});
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        if ((result?.chunkErrors.length ?? 0) > 0) process.exitCode = 1;
        console.log(JSON.stringify({
            captured: report.captured,
            failed: report.failed,
            skipped: report.skipped,
            sessions: report.sessions.length,
            chunkErrors: report.chunkErrors.length,
            reportPath
        }, null, 2));
    }
}
