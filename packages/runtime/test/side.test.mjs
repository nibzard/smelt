/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
// Ported from fathom/test/side_tests.mjs.

import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {type} from '../index.mjs';


describe('Side', function () {
    test('makes a LHS out of a type()', function () {
        const side = type('smoo');
        assert.ok(side.asLhs);  // It appears to be a Side.
        const lhs = side.asLhs();
        assert.ok(lhs.max);  // It appears to be a TypeLhs.
    });

    test('is immutable and so can be factored up', function () {
        const defaults = type('smoo');
        const another = defaults.atMost(1);
        assert.equal(defaults._calls.length, 1);
        assert.equal(another._calls.length, 2);
    });
});
