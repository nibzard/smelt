/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
// Ported from fathom/test/rule_tests.mjs.

import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {compile, dom, rule, ruleset, score, type, typeIn} from '../index.mjs';
import {assertSameMembers, staticDom} from './helpers.mjs';


describe('Rule', function () {
    test('knows what it can add and emit', function () {
        const a = rule(dom('p'), type('para'));
        assertSameMembers(Array.from(a.typesItCouldEmit()), ['para']);
        assertSameMembers(Array.from(a.typesItCouldAdd()), ['para']);

        // The original b-rule was typeIn('q').props('dummy').typeIn('r', 's'),
        // whose props() call made the RHS able to change type. Without props,
        // a bare typeIn() cannot, so the emission collapses to the LHS type:
        const b = rule(type('r'), typeIn('q').typeIn('r', 's'));
        assertSameMembers(Array.from(b.typesItCouldEmit()), ['r']);
        assertSameMembers(Array.from(b.typesItCouldAdd()), []);

        const c = rule(type('a'), score(2));
        assertSameMembers(Array.from(c.typesItCouldEmit()), ['a']);
    });

    test('knows what it can add and emit when props() makes types undeterminable',
         {skip: 'dropped operator: props'},
         function () {
             // Original: rule(type('r'), typeIn('q').props('dummy')
             //               .typeIn('r', 's')) emitted ['r', 's'] and
             // added ['s'].
         });

    test('identifies prerequisite rules', function () {
        const domRule = rule(dom('p'), type('a'));
        const maxRule = rule(type('a').max(), type('b'));
        const maintainRule = rule(type('b'), score(2));
        const addRule = rule(type('b'), type('c'));
        const rules = ruleset([domRule, maxRule, maintainRule, addRule]);
        const facts = rules.against(staticDom(''));
        assertSameMembers(Array.from(domRule.prerequisites(facts)), []);
        assertSameMembers(Array.from(maxRule.prerequisites(facts)), [domRule]);
        assertSameMembers(Array.from(maintainRule.prerequisites(facts)), [maxRule]);
        assertSameMembers(Array.from(addRule.prerequisites(facts)), [maxRule, maintainRule]);

        // Fathom exposed the lazy planner's per-request prerequisite map via
        // facts._prerequisitesTo(rule). Smelt bakes the same graph into the
        // compile-time order instead, so assert the same relationships
        // positionally: every prerequisite runs before its dependent.
        const order = compile(rules).rules;
        assert.ok(order.indexOf(domRule) < order.indexOf(maxRule));
        assert.ok(order.indexOf(maxRule) < order.indexOf(maintainRule));
        assert.ok(order.indexOf(maxRule) < order.indexOf(addRule));
        assert.ok(order.indexOf(maintainRule) < order.indexOf(addRule));
        assert.equal(order.length, 4);
    });
});
