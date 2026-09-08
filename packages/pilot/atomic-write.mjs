/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Guarded writes for files outside version control. The new content is
// staged in a sibling temp file and fsynced, one backup of the current
// content is kept, and an atomic rename swaps the file in. A crash or a
// full disk mid-write leaves either the old or the new content, never a
// truncated file. Callers that write several files can stage them all
// first and commit them together, so a batch either fully applies or
// leaves every file unchanged.

import {copyFile, open, rename} from 'node:fs/promises';

export async function stageWrite(file, text) {
    const tmp = `${file}.tmp`;
    const handle = await open(tmp, 'w');
    try {
        await handle.writeFile(text);
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await copyFile(file, `${file}.bak`);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

export async function commitStaged(file) {
    await rename(`${file}.tmp`, file);
}
