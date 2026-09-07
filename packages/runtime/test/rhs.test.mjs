/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
// Ported from fathom/test/rhs_tests.mjs.

import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {atMost, dom, note, rule, ruleset, score, type, typeIn} from '../index.mjs';
import {sigmoid} from '../utils.mjs';
import {staticDom} from './helpers.mjs';


describe('RHS', function () {
    test('combines different calls piecewise, with rightmost repeated subfacts shadowing',
         {skip: 'dropped operator: props'},
         function () {
             // Original: type('foo').score(5).props(node => ({score: 6}))
             // deep-equals {type: 'foo', score: 6} from rhs.fact('dummy').
         });

    test('has same-named calls shadow, with rightmost winning',
         {skip: 'dropped operator: props'},
         function () {
             // Original: props(node => ({score: 1})).props(node => ({note: 'foo'}))
             // deep-equals {note: 'foo'} from rhs.fact('dummy').
         });

    test('runs callbacks only once',
         {skip: 'dropped operator: props'},
         function () {
             // Original: a props(addOne) RHS runs addOne exactly once per
             // rhs.fact('dummy') call.
         });

    test('ignores unexpected subfacts returned from props() callbacks',
         {skip: 'dropped operator: props'},
         function () {
             // Original: props(node => ({booga: true, score: 3})) keeps only
             // {score: 3}.
         });

    test('enforces atMost()', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), score(8).type('para').atMost(3))
        ]);
        // Smelt runs the whole ruleset eagerly in against(), so the violation
        // surfaces there rather than at get() time:
        assert.throws(() => rules.against(doc),
                      /Score of 8 exceeds the declared atMost\(3\)\./);
    });

    test('works fine when atMost() is satisfied', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), atMost(3).score(2).type('para'))
        ]);
        const facts = rules.against(doc);
        assert.equal(facts.get(type('para'))[0].scoreFor('para'), sigmoid(2));
    });

    test('enforces typeIn() for explicit types', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), typeIn('nope').type('para'))
        ]);
        // Eager execution: the conformance error throws from against():
        assert.throws(() => rules.against(doc),
                      /A right-hand side claimed, via typeIn\(\.\.\.\) to emit one of the types \{nope\} but actually emitted para\./);
    });

    test('enforces typeIn() for inherited types', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), type('para')),
            // The original second rule used props(n => ({})).typeIn('nope');
            // a bare typeIn() leaves the fact empty the same way, so the RHS
            // inherits 'para' from the LHS and violates the constraint:
            rule(type('para'), typeIn('nope'))
        ]);
        assert.throws(() => rules.against(doc),
                      /A right-hand side claimed, via typeIn\(\.\.\.\) to emit one of the types \{nope\} but actually inherited para from the left-hand side\./);
    });

    test('works fine when typeIn() is satisfied', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), typeIn('para').type('para'))
        ]);
        const facts = rules.against(doc);
        assert.equal(facts.get(type('para')).length, 1);
    });

    test('runs out().through() callbacks',
         {skip: 'dropped operator: through'},
         function () {
             // Original: rule(dom('p'), out('para').through(fnode =>
             // fnode.element.tagName)) made facts.get('para')[0] === 'P'.
         });

    test('paves over undefined notes', function () {
        // We shouldn't re-run any rules. Run order shouldn't matter, because
        // we forbid notes from overwriting, score contribution is
        // commutative, and type assignment is idempotent and immutable.
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), type('para')),
            rule(type('para'), note(fnode => undefined)),
            rule(type('para'), note(fnode => 'foo'))
        ]);
        const facts = rules.against(doc);
        assert.equal(facts.get(type('para'))[0].noteFor('para'), 'foo');
    });

    test('runs scoring callbacks', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), type('p').score(fnode => 5))
        ]);
        const facts = rules.against(doc);
        assert.equal(facts.get(type('p'))[0].scoreFor('p'), sigmoid(5));
    });

    // New coverage the fathom suite lacks: the note-overwrite guard.

    test('forbids overwriting a note', function () {
        const doc = staticDom('<p></p>');
        const rules = ruleset([
            rule(dom('p'), type('para').note(fnode => 'first')),
            rule(type('para'), note(fnode => 'second'))
        ]);
        assert.throws(() => rules.against(doc),
                      /tried to add a note of type para to an element, but one of that type already exists\. Overwriting notes is not allowed/);
    });
});
