/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
// Ported from fathom/test/ruleset_tests.mjs.

import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {compile, CycleError, dom, element, rule, ruleset, score, type, typeIn} from '../index.mjs';
import {sigmoid} from '../utils.mjs';
import {staticDom} from './helpers.mjs';


describe('Ruleset', function () {
    describe('get()s', function () {
        test('by arbitrary passed-in LHSs (and scores dom() nodes at 0)', function () {
            const doc = staticDom(`
                <div>Hooooooo</div>
            `);
            const rules = ruleset([
                rule(dom('div'), type('paragraphish'))
            ]);
            const facts = rules.against(doc);
            const div = facts.get(type('paragraphish'))[0];
            assert.equal(div.scoreFor('paragraphish'), sigmoid(0));
        });

        test('by passed-in type(A) LHS, after running A -> A rules along the way', function () {
            const doc = staticDom(`
                <div>Hooooooo</div>
            `);
            const rules = ruleset([
                rule(dom('div'), type('paragraphish')),
                rule(type('paragraphish'), score(2)),
                rule(type('paragraphish'), type('foo'))
            ]);
            const facts = rules.against(doc);

            // Smelt runs the A -> A rules eagerly, in the BoundRun
            // constructor, so they have already run by query time:
            const div = facts.get(type('paragraphish'))[0];
            assert.equal(div.scoreFor('paragraphish'), sigmoid(2));

            // get() of a type() side reads the type cache, no matter what
            // later calls (like max()) the side carries:
            const divMax = facts.get(type('paragraphish').max())[0];
            assert.equal(divMax.scoreFor('paragraphish'), sigmoid(2));
            assert.equal(divMax, div);
        });

        test('by passed-in and(A, B) LHS',
             {skip: 'dropped operator: and'},
             function () {
                 // Original: facts.get(and(type('paragraphish'),
                 // type('foo')))[0] returned the same fnode as the type()
                 // queries.
             });

        test('results by out-rule key', function () {
            const doc = staticDom(`
                <div>Hooooooo</div>
            `);
            const rules = ruleset([
                rule(dom('div'), type('paragraphish')),
                rule(type('paragraphish'), 'p')
            ]);
            assert.equal(rules.against(doc).get('p').length, 1);
        });

        test('the fnode corresponding to a passed-in node', function () {
            const doc = staticDom(`
                <div>Hooooooo</div>
            `);
            const rules = ruleset([
                rule(dom('div'), type('paragraphish')),  // when we add .score(1), the test passes.
                rule(type('paragraphish'), score(fnode => fnode.element.textContent.length))
            ]);
            const facts = rules.against(doc);
            const div = facts.get(doc.querySelectorAll('div')[0]);
            // Everything already ran eagerly, so the score is complete:
            assert.equal(div.scoreFor('paragraphish'), sigmoid(8));
        });

        test('an empty iterable for nonexistent types', function () {
            // While we're at it, test that querying a nonexistent type from a
            // bound ruleset doesn't crash.
            // The original rule used props(n => ({type: 'a'})).typeIn('a', 'b')
            // to register both types; a type() call does the same job here:
            const rules = ruleset([
                rule(dom('a'), typeIn('a', 'b').type('a'))
            ]);
            const facts = rules.against(staticDom('<a></a>'));
            // Tempt it to multiply once:
            assert.deepEqual(facts.get(type('b')), []);
        });
    });

    test('assigns scores and notes to nodes', function () {
        // Test the score() and note() calls themselves as well as the ruleset
        // that obeys them.
        const doc = staticDom(`
            <p>
                <a class="good" href="https://github.com/jsdom">Good!</a>
                <a class="bad" href="https://github.com/jsdom">Bad!</a>
            </p>
        `);
        const rules = ruleset([
            rule(dom('a[class=good]'), score(2).type('anchor').note(fnode => 'lovely'))
        ]);
        const anchors = rules.against(doc).get(type('anchor'));
        // Make sure dom() selector actually discriminates:
        assert.equal(anchors.length, 1);
        const anchor = anchors[0];
        assert.equal(anchor.scoreFor('anchor'), sigmoid(2));
        assert.equal(anchor.noteFor('anchor'), 'lovely');
    });

    test("doesn't leak scores upstream (and runs the whole ruleset eagerly)", function () {
        // Fathom fired rules lazily, so an unqueried type had no scores yet.
        // Smelt's eager pass has already computed everything by query time.
        const doc = staticDom(`
            <p></p>
        `);
        const rules = ruleset([
            rule(dom('p'), type('para').score(2)),
            rule(type('para'), type('smoo').score(3))
        ]);
        const facts = rules.against(doc);

        const para = facts.get(type('para'))[0];
        // Show other-typed scores don't backpropagate to the upstream type:
        assert.equal(para.scoreFor('para'), sigmoid(2));
        // Intended delta: the downstream rule has already run, so its type's
        // scores are the rule's contribution, not the default:
        assert.equal(para.scoresSoFarFor('smoo').size, 1);
        assert.equal(para.scoreFor('smoo'), sigmoid(3));
    });

    describe('runs nearest()', function () {
        test('pairs nearest() nodes',
             {skip: 'dropped operator: nearest'},
             function () {
                 // Original: rule(nearest(type('good'), type('indifferent'),
                 // distance), type('goodAndIndifferent')) paired each good
                 // node with its nearest indifferent one, by note.
             });
    });

    describe('complains about rules with missing input', function () {
        test('emitters', function () {
            const doc = staticDom('');
            const rules = ruleset([
                rule(type('c'), type('b'))
            ]);
            // Smelt detects this at compile time, which against() triggers:
            assert.throws(() => rules.against(doc),
                          /No rule emits the "c" type, but another rule needs it as input\./);
        });

        test('adders', function () {
            const doc = staticDom('');
            const rules = ruleset([
                rule(type('c'), score(2)),  // emits c but doesn't add it
                rule(type('c'), type('b'))
            ]);
            assert.throws(() => rules.against(doc),
                          /No rule adds the "c" type, but another rule needs it as input\./);
        });
    });

    describe('avoids cycles', function () {
        test('that should be statically detectable, throwing an error', function () {
            const doc = staticDom('<p></p>');
            const rules = ruleset([
                rule(dom('p'), type('a')),
                rule(type('a'), type('b')),
                rule(type('b'), type('a'))
            ]);
            // Cycle detection moved to compile time, which against() runs:
            assert.throws(() => rules.against(doc),
                          /There is a cyclic dependency in the ruleset\./);
        });

        // This proves that the order of aggregate rules can't matter, because
        // arrangements where it would matter are illegal due to cycles.
        test('made of aggregates', function () {
            const doc = staticDom('');
            const rules = ruleset([
                rule(dom('p'), type('a')),
                rule(type('a').max(), score(2)),
                rule(type('a').max(), score(.5))
            ]);
            assert.throws(() => rules.against(doc),
                          /There is a cyclic dependency in the ruleset\./);
        });
    });

    describe('plans rule execution', function () {
        test('by demanding rules have determinate type', function () {
            // The fathom test used props('dummy') without typeIn(); props is
            // dropped, and a dom() rule with no type at all now trips the
            // same guard (with the reworded message):
            assert.throws(() => ruleset([rule(dom('p'), type('a')),
                                         rule(dom('p'), score(2))]),
                          /Could not determine the emitted type of a rule because its right-hand side sets no type\./);
        });

        test('by remembering what types rules add and emit', function () {
            // The original rule1 was props('dummy').typeIn('q', 'r'); a bare
            // typeIn() declares the same possible emissions:
            const rule1 = rule(dom('p'), typeIn('q', 'r'));
            const rule2 = rule(type('r'), type('s'));
            const facts = ruleset([rule1, rule2]).against(staticDom(''));
            assert.deepEqual(facts.inwardRulesThatCouldEmit('q'), [rule1]);
            assert.deepEqual(facts.inwardRulesThatCouldAdd('s'), [rule2]);
        });

        test('and runs even unneeded rules (eager execution)', function () {
            // Fathom's lazy planner skipped the b and d rules entirely when
            // only the c chain was queried. Smelt runs everything, so b and d
            // show up in the fnode's types as well.
            const doc = staticDom('<p></p>');
            const rules = ruleset([
                rule(dom('p'), type('a')),
                rule(dom('p'), type('b')),
                rule(type('a'), type('c')),
                rule(type('b'), type('d')),
                rule(type('c'), 'c')
            ]);
            const facts = rules.against(doc);
            const p = facts.get('c')[0];
            const typesSoFar = new Set(p.typesSoFar());
            assert.ok(typesSoFar.has('a'));
            assert.ok(typesSoFar.has('c'));
            // Intended delta: nothing is left unrun:
            assert.ok(typesSoFar.has('b'));
            assert.ok(typesSoFar.has('d'));
        });
    });

    test('plans for and runs a working and()',
         {skip: 'dropped operator: and'},
         function () {
             // Original: rule(and(type('A'), type('C')), type('BOTH'))
             // matched only the element with both types, and lazy execution
             // left the NEEDLESS rule unrun.
         });

    test('spits back its rules() verbatim', function () {
        const rules = ruleset([
            rule(dom('a'), type('A')),
            rule(type('A'), type('B')),
            rule(type('A'), 'ay'),
            rule(type('B'), 'be')
        ]);
        const ruleList = rules.rules();
        assert.equal(ruleList.length, 4);
        assert.deepEqual(ruleset(ruleList), rules);
    });

    test('takes a subtree of a document and operates on it', function () {
        const doc = staticDom(`
            <div id=root>some text
             <div id=inner>some more text</div>
            </div>
        `);
        const rules = ruleset([
            rule(dom('#root'), type('smoo').score(10)),
            rule(dom('#inner'), type('smoo').score(5)),
            rule(type('smoo').max(), 'best')
        ]);
        const facts = rules.against(doc);
        const best = facts.get('best');
        assert.equal(best.length, 1);
        assert.equal(best[0].element.id, 'root');

        const subtree = doc.getElementById('root');
        const subtreeFacts = rules.against(subtree);
        const subtreeBest = subtreeFacts.get('best');
        assert.equal(subtreeBest.length, 1);
        assert.equal(subtreeBest[0].element.id, 'inner');
    });

    describe('evaluates a single element', function () {
        test('without going inside or outside it', function () {
            const doc = staticDom(`
                <div id=root class=target>some text
                    <div id=middle class=target>
                        <div id=inner class=target></div>
                    </div>
                </div>
            `);
            const rules = ruleset([
                rule(element('.target'), type('smoo'))
            ]);
            const subtree = doc.getElementById('middle');
            const facts = rules.against(subtree);
            const fnodes = facts.get(type('smoo'));
            assert.equal(fnodes.length, 1);
            assert.equal(fnodes[0].element.id, 'middle');
        });

        test('negatively', function () {
            const doc = staticDom(`
                <div id=thing class=target></div>
            `);
            const rules = ruleset([
                rule(element('.tarrrrrrrget'), type('smoo'))
            ]);
            const subtree = doc.getElementById('thing');
            assert.equal(rules.against(subtree).get(type('smoo')).length, 0);
        });
    });

    test('applies coeffs and biases after construction', function () {
        // Fathom retuned a live run with facts.setCoeffsAndBiases(); Smelt has
        // no lazy runs to retune, so coeffs and biases arrive at construction
        // and the run carries them:
        const doc = staticDom(`
        `);
        const rules = ruleset([], [['someRule', 2]], [['someType', 5]]);
        const facts = rules.against(doc);
        assert.equal(facts._coeffs.get('someRule'), 2);
        assert.equal(facts.biases.get('someType'), 5);
    });

    // -------- New coverage the fathom suite lacks --------

    describe('compile()', function () {
        test('accepts a bare array of rules', function () {
            const plan = compile([
                rule(dom('p'), type('para').score(1)),
                rule(type('para'), 'p')
            ]);
            const facts = plan.against(staticDom('<p></p>'));
            assert.equal(facts.get('p').length, 1);
            assert.equal(facts.get('p')[0].scoreFor('para'), sigmoid(1));
        });

        test('accepts a bare array of rules with coeffs and biases', function () {
            const plan = compile([
                rule(dom('p'), type('para').score(1), {name: 'scorer'})
            ], [['scorer', 3]], [['para', 1]]);
            const facts = plan.against(staticDom('<p></p>'));
            // 3 * 1 + 1 bias:
            assert.equal(facts.get(type('para'))[0].scoreFor('para'), sigmoid(4));
        });

        test('accepts a Ruleset and keeps its coeffs', function () {
            const plan = compile(ruleset([
                rule(dom('p'), type('para').score(1), {name: 'scorer'})
            ], [['scorer', 3]]));
            const facts = plan.against(staticDom('<p></p>'));
            assert.equal(facts.get(type('para'))[0].scoreFor('para'), sigmoid(3));
        });

        test('throws a CycleError at compile time on a 2-rule type cycle', function () {
            const cyclic = () => compile([
                rule(type('a'), type('b')),
                rule(type('b'), type('a'))
            ]);
            assert.throws(cyclic, /There is a cyclic dependency in the ruleset\./);
            try {
                cyclic();
                assert.fail('expected a CycleError');
            } catch (error) {
                assert.ok(error instanceof CycleError);
            }
        });

        test('complains at compile time about rules with missing input', function () {
            assert.throws(() => compile([rule(type('c'), type('b'))]),
                          /No rule emits the "c" type, but another rule needs it as input\./);
            assert.throws(() => compile([rule(type('c'), score(2)),  // emits c but doesn't add it
                                         rule(type('c'), type('b'))]),
                          /No rule adds the "c" type, but another rule needs it as input\./);
            assert.throws(() => compile([rule(type('missing'), 'out')]),
                          /No rule emits the "missing" type, but another rule needs it as input\./);
        });
    });

    describe('stats', function () {
        test('reports the shape of a run', function () {
            const facts = ruleset([
                rule(dom('p'), type('a')),
                rule(type('a'), 'out')
            ]).against(staticDom('<p></p>'));
            const stats = facts.stats;
            assert.equal(typeof stats.ms, 'number');
            assert.ok(stats.ms >= 0);
            assert.equal(stats.tier, 0);
            assert.equal(stats.truncated, false);
            assert.equal(stats.elementsWalked, 1);
            assert.equal(stats.rulesExecuted, 2);
        });

        test('enforces the maxElements budget', function () {
            const doc = staticDom(`
                <p id="a"></p>
                <p id="b"></p>
                <p id="c"></p>
            `);
            const rules = ruleset([rule(dom('p'), type('para'))]);
            const facts = rules.against(doc, {maxElements: 2});
            assert.equal(facts.stats.elementsWalked, 2);
            assert.equal(facts.stats.truncated, true);
            assert.equal(facts.get(type('para')).length, 2);
            // Explicit get(element) still works past the budget:
            const third = doc.getElementById('c');
            assert.equal(facts.get(third).element, third);
        });

        test('applies the maxElements budget to element() rules', function () {
            const doc = staticDom(`
                <section id="target">
                    <p id="a"></p>
                </section>
            `);
            const target = doc.getElementById('target');
            const facts = ruleset([
                rule(dom('p'), type('para')),
                rule(element('#target'), type('target'))
            ]).against(target, {maxElements: 0});
            assert.equal(facts.stats.elementsWalked, 0);
            assert.equal(facts.stats.truncated, true);
            assert.equal(facts.get(type('para')).length, 0);
            assert.equal(facts.get(type('target')).length, 0);
            assert.equal(facts.get(target).element, target);
            assert.equal(facts.stats.elementsWalked, 1);
        });

        test('leaves truncation unset when the budget suffices', function () {
            const facts = ruleset([rule(dom('p'), type('para'))]).against(staticDom('<p></p>'));
            assert.equal(facts.stats.elementsWalked, 1);
            assert.equal(facts.stats.truncated, false);
        });
    });

    describe('coeffs and biases', function () {
        test('defaults coeffs to 1', function () {
            const facts = ruleset([
                rule(dom('p'), type('t').score(1), {name: 'a'}),
                rule(type('t'), score(fnode => 2), {name: 'b'})
            ]).against(staticDom('<p></p>'));
            // 1 * 1 + 1 * 2:
            assert.equal(facts.get(type('t'))[0].scoreFor('t'), sigmoid(3));
        });

        test('weights named rules with coeffs given to ruleset()', function () {
            const facts = ruleset([
                rule(dom('p'), type('t').score(1), {name: 'a'}),
                rule(type('t'), score(fnode => 2), {name: 'b'})
            ], [['a', 5]]).against(staticDom('<p></p>'));
            // 5 * 1 + 1 * 2:
            assert.equal(facts.get(type('t'))[0].scoreFor('t'), sigmoid(7));
        });

        test('weights named rules with coeffs given to compile()', function () {
            const facts = compile([
                rule(dom('p'), type('t').score(1), {name: 'a'})
            ], [['a', 4]]).against(staticDom('<p></p>'));
            assert.equal(facts.get(type('t'))[0].scoreFor('t'), sigmoid(4));
        });

        test('takes biases into account in scoreFor()', function () {
            const facts = ruleset([
                rule(dom('p'), type('t').score(1))
            ], [], [['t', 2]]).against(staticDom('<p></p>'));
            // 1 + 2 bias:
            assert.equal(facts.get(type('t'))[0].scoreFor('t'), sigmoid(3));
        });
    });

    describe('get() error shapes', function () {
        test('on an unknown out() key', function () {
            const facts = ruleset([rule(dom('p'), type('t'))]).against(staticDom('<p></p>'));
            assert.throws(() => facts.get('nope'),
                          /There is no out\(\) rule with key "nope"\./);
        });

        test('on things that are not strings, type() sides, or elements', function () {
            const facts = ruleset([rule(dom('p'), type('t'))]).against(staticDom('<p></p>'));
            assert.throws(() => facts.get(42),
                          /ruleset\.get\(\) expects a string, a type\(\) expression, or a DOM element\./);
        });

        test('on arbitrary LHS sides, which the lazy planner alone supported', function () {
            // Intended delta: no lazy get(), so a dom() side is not a query:
            const facts = ruleset([
                rule(dom('p'), type('t')),
                rule(type('t'), 't')
            ]).against(staticDom('<p></p>'));
            assert.throws(() => facts.get(dom('p')),
                          /ruleset\.get\(\) expects a string, a type\(\) expression, or a DOM element\./);
        });
    });
});

describe('Post-review regressions', function () {
    test('get() honors chained max() and when() on a type() side', function () {
        const doc = staticDom('<p id="a">one</p><p id="b">two</p><p id="c">three</p>');
        const facts = ruleset([
            rule(dom('p#a'), type('x').score(1)),
            rule(dom('p#b'), type('x').score(0.5)),
            rule(dom('p#c'), type('x').score(1))
        ]).against(doc);
        const maxes = facts.get(type('x').max());
        assert.deepEqual(maxes.map(f => f.element.getAttribute('id')).sort(), ['a', 'c']);
        const filtered = facts.get(type('x').when(f => f.element.getAttribute('id') === 'a'));
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].element.getAttribute('id'), 'a');
    });

    test('get() filters max() results with chained when()', function () {
        const doc = staticDom('<p id="a">one</p><p id="b">two</p><p id="c">three</p>');
        const facts = ruleset([
            rule(dom('p#a'), type('x').score(1)),
            rule(dom('p#b'), type('x').score(0.5)),
            rule(dom('p#c'), type('x').score(1))
        ]).against(doc);
        const filtered = facts.get(type('x').max().when(f => f.element.getAttribute('id') === 'c'));
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].element.getAttribute('id'), 'c');
    });

    test('get() returns fresh arrays, so callers cannot corrupt stored outputs', function () {
        const facts = ruleset([
            rule(dom('p'), type('x').score(1)),
            rule(type('x'), 'o')
        ]).against(staticDom('<p>one</p><p>two</p>'));
        facts.get('o').pop();
        assert.equal(facts.get('o').length, 2);
        assert.equal(facts.get(type('x')).length, 2);
    });

    test('stores out() results once during eager execution', function () {
        let checks = 0;
        const facts = ruleset([
            rule(dom('p'), type('x')),
            rule(type('x').when(fnode => {
                checks++;
                return fnode.element.textContent !== 'skip';
            }), 'o')
        ]).against(staticDom('<p>keep</p><p>skip</p>'));
        assert.equal(checks, 2);
        assert.equal(facts.get('o').length, 1);
        assert.equal(facts.get('o').length, 1);
        assert.equal(checks, 2);
    });

    test('elements that already have fnodes pass an exhausted element budget free', function () {
        // Three paragraphs, three elements max. The second dom() rule must
        // still see all three, even though the budget is spent by then:
        const doc = staticDom('<p id="a">1</p><p id="b">2</p><p id="c">3</p>');
        const facts = ruleset([
            rule(dom('p'), type('x').score(1)),
            rule(dom('p'), type('y').score(1)),
            rule(type('y'), 'ys')
        ]).against(doc, {maxElements: 3});
        assert.equal(facts.stats.elementsWalked, 3);
        assert.equal(facts.stats.truncated, false);
        assert.equal(facts.get('ys').length, 3);
    });
});
