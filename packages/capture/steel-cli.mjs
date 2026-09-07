#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {loadSteelCaptureConfig, runSteelCapture} from './steel.mjs';

const configPath = process.argv[2];

if (!configPath) {
    console.error('Usage: smelt-steel-capture path/to/config.json');
    process.exitCode = 1;
} else {
    try {
        const config = await loadSteelCaptureConfig(configPath);
        const captures = await runSteelCapture(config);
        console.log(JSON.stringify({captures}, null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
