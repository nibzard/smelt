#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {loadLocalCaptureConfig, runLocalCapture} from './local.mjs';

const configPath = process.argv[2];

if (!configPath) {
    console.error('Usage: smelt-local-capture path/to/config.json');
    process.exitCode = 1;
} else {
    try {
        const config = await loadLocalCaptureConfig(configPath);
        const captures = await runLocalCapture(config);
        console.log(JSON.stringify({captures}, null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
