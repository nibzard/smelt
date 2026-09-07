/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
// Ported from fathom/test/utils_tests.mjs.

import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {NoWindowError, dom, rule, ruleset, score, type} from '../index.mjs';
import {attributesMatch, NiceSet, toposort, windowForElement} from '../utils.mjs';
import {staticDom} from './helpers.mjs';


describe('Utils', function () {
    describe('NiceSet', function () {
        test('pops', function () {
            const s = new NiceSet([1, 2]);
            assert.equal(s.pop(), 1);
            assert.equal(s.pop(), 2);
            assert.throws(() => s.pop(),
                          /Tried to pop from an empty NiceSet\./);
        });
    });

    describe('toposort', function () {
        test('sorts', function () {
            // Return answers that express the graph...
            // 4 <- 5 <- 6   <-  7
            //           |       |
            //           v       v
            //          5.1  <- 6.1
            // ...where -> means "needs".
            function nodesThatNeed(node) {
                return node === 5.1 ? [6, 6.1] : (node === 7 ? [] : [Math.floor(node) + 1]);
            }
            assert.deepEqual(toposort([4, 5, 5.1, 6, 6.1, 7], nodesThatNeed),
                             [7, 6, 5, 4, 6.1, 5.1]);
        });
        test('detects cycles', function () {
            // Express a graph of 3 nodes pointing in a circle.
            function nodesThatNeed(node) {
                return [(node + 1) % 3];
            }
            assert.throws(() => toposort([0, 1, 2], nodesThatNeed),
                          /The graph has a cycle\./);
        });
    });

    describe('attributesMatch', function () {
        test('searches all attributes', function () {
            const doc = staticDom(`
                <img id="foo" alt="boo"></img><img id="fat" src= "bat"></img>
            `);
            const rules = ruleset([
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), 'best')
            ]);

            function scoreFunc(fnode) {
                return attributesMatch(fnode.element, attr => attr.includes('oo')) ? 5 : 1;
            }

            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 1);
            assert.equal(best[0].element.id, 'foo');
        });

        test('searches specified attributes', function () {
            const doc = staticDom(`
                <img id="foo" alt="bat"></img><img id="sat" src="bat"></img>
            `);
            const rules = ruleset([
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), 'best')
            ]);

            function scoreFunc(fnode) {
                return attributesMatch(fnode.element, attr => attr.includes('at'), ['id']) ? 5 : 1;
            }

            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 1);
            assert.equal(best[0].element.id, 'sat');
        });

        test('searches attributes which are arrays', function () {
            const doc = staticDom(`
                <img id="fat" class="fat bat sat" ></img><img id="foo" class="foo bar boo"></img>
            `);
            const rules = ruleset([
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), 'best')
            ]);

            function scoreFunc(fnode) {
                return attributesMatch(fnode.element, attr => attr.includes('at')) ? 5 : 1;
            }

            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 1);
            assert.equal(best[0].element.id, 'fat');
        });

        test('returns false for elements that lack the requested attributes', function () {
            // The first element has the alt attribute, and the second one doesn't, so it shouldn't get included in the results
            const doc = staticDom(`
                <img id="foo" alt="bat"></img><img id="bar"></img>
            `);
            const rules = ruleset([
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), 'best')
            ]);

            function scoreFunc(fnode) {
                return attributesMatch(fnode.element, attr => attr.includes('at'), ['alt']) ? 5 : 1;
            }

            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 1);
            assert.equal(best[0].element.id, 'foo');
        });

        test("doesn't touch nodes that don't match", function () {
            const doc = staticDom(`
                <img id="foo"></img><img id="bar"></img>
            `);
            const rules = ruleset([
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), 'best')
            ]);

            function scoreFunc(fnode) {
                return attributesMatch(fnode.element, attr => attr.includes('z')) ? 5 : 1;
            }

            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 2);
        });

        test('searches multiple explicitly specified attributes', function () {
            const doc = staticDom(`
                <img id="foo" alt="bat"></img><img id="cat"></img><img ignored="fat"></img>
            `);
            const rules = ruleset([
                rule(dom('img'), type('attr')),
                rule(type('attr'), score(scoreFunc)),
                rule(type('attr').max(), 'best')
            ]);

            function scoreFunc(fnode) {
                return attributesMatch(fnode.element, attr => attr.includes('at'), ['alt', 'id']) ? 5 : 1;
            }

            const facts = rules.against(doc);
            const best = facts.get('best');
            assert.equal(best.length, 2);
            assert.equal(best[0].element.id, 'foo');
            assert.equal(best[1].element.id, 'cat');
        });
    });

    describe('windowForElement', function () {
        test('raises NoWindowError when run outside a window', function () {
            // We mock out the element because a real DOM actually provides a
            // window object:
            const element = {ownerDocument: {defaultView: null}};
            assert.throws(() => windowForElement(element),
                          NoWindowError);
        });
    });
});
