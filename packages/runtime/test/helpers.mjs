/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

// Shared helpers for the ported fathom tests. linkedom stands in for jsdom.

import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';


/**
 * Parse HTML into a linkedom Document, standing in for fathom's jsdom-based
 * staticDom() from utilsForBackend.mjs.
 */
export function staticDom(html) {
    return parseHTML(html).document;
}


/**
 * Order-insensitive member comparison, standing in for chai's
 * assert.sameMembers.
 */
export function assertSameMembers(actual, expected) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    assert.equal(actualSet.size, expectedSet.size);
    for (const item of expectedSet) {
        assert.ok(actualSet.has(item),
                  `missing expected member: ${String(item)}`);
    }
    for (const item of actualSet) {
        assert.ok(expectedSet.has(item),
                  `unexpected extra member: ${String(item)}`);
    }
}
