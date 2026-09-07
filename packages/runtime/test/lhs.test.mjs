/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
// Ported from fathom/test/lhs_tests.mjs.

import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {dom, rule, ruleset, type} from '../index.mjs';
import {staticDom} from './helpers.mjs';


describe('LHS', function () {
    test('makes a dom() LHS that rule() tolerates', function () {
        const lhs = dom('smoo');
        const rhs = type('bar');
        rule(lhs, rhs);
    });

    test('finds max-scoring nodes of a type', function () {
        const doc = staticDom(`
            <p></p>
            <div></div>
            <div></div>
        `);
        const rules = ruleset([
            rule(dom('p'), type('smoo').score(2)),
            rule(dom('div'), type('smoo').score(5)),
            rule(type('smoo').max(), 'best')
        ]);
        const facts = rules.against(doc);
        const best = facts.get('best');
        assert.equal(best.length, 2);
        assert.equal(best[0].element.nodeName, 'DIV');
        assert.equal(best[1].element.nodeName, 'DIV');
    });

    test('returns [] for a top-totaling cluster of 0 nodes',
         {skip: 'dropped operator: bestCluster'},
         function () {
             // Original: rule(type('smoo').bestCluster(), 'cluster') returned
             // [] when no divs existed.
         });

    test('can have its type overridden', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), type('bar')),
            rule(type('foo').type('bar'), 'best')
        ]);
        const facts = rules.against(doc);
        const best = facts.get('best');
        assert.equal(best.length, 1);
    });

    test('filters using when() on type()', function () {
        const doc = staticDom('<p id="fat"></p><p id="bat"></p>');
        const rules = ruleset([
            rule(dom('p'), type('bar')),
            rule(type('bar').when(fnode => fnode.element.id === 'fat'), type('when')),
            rule(type('when'), 'best')
        ]);
        const facts = rules.against(doc);
        const best = facts.get('best');
        assert.equal(best.length, 1);
        assert.equal(best[0].element.id, 'fat');
    });

    test('filters using when() on dom()', function () {
        const doc = staticDom('<p id="fat"></p><p id="bat"></p>');
        const rules = ruleset([
            rule(dom('p').when(fnode => fnode.element.id === 'bat'), type('when')),
            rule(type('when'), 'best')
        ]);
        const facts = rules.against(doc);
        const best = facts.get('best');
        assert.equal(best.length, 1);
        assert.equal(best[0].element.id, 'bat');
    });

    // New coverage the fathom suite lacks: max() ties return every tied node.

    test('returns every tied node from max()', function () {
        const doc = staticDom(`
            <p id="a"></p>
            <p id="b"></p>
            <p id="c"></p>
        `);
        const rules = ruleset([
            rule(dom('p'), type('smoo').score(1)),
            rule(type('smoo').max(), 'all')
        ]);
        const facts = rules.against(doc);
        const all = facts.get('all');
        assert.equal(all.length, 3);
        assert.deepEqual(all.map(fnode => fnode.element.id), ['a', 'b', 'c']);
    });
});
