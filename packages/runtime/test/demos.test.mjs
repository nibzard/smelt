/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).
// Ported from fathom/test/demos.mjs.

import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {dom, rule, ruleset, type} from '../index.mjs';
import {sigmoid} from '../utils.mjs';
import {staticDom} from './helpers.mjs';


describe('Design-driving demos', function () {
    test('handles a simple series of short-circuiting rules', function () {
        // TODO: Short-circuiting isn't implemented in fathom either. The
        // motivation of this test is to inspire the engine so it's smart
        // enough to run the highest-possible-scoring type-chain of rules
        // first and, if it succeeds, omit the others.
        const doc = staticDom(`
            <meta name="hdl" content="HDL">
            <meta property="og:title" content="OpenGraph">
            <meta property="twitter:title" content="Twitter">
            <title>Title</title>
        `);
        const typeAndNote = type('titley').note(fnode => fnode.element.getAttribute('content'));
        const rules = ruleset([
            rule(dom('meta[property="og:title"]'),
                 typeAndNote.score(40)),
            rule(dom('meta[property="twitter:title"]'),
                 typeAndNote.score(30)),
            rule(dom('meta[name="hdl"]'),
                 typeAndNote.score(20)),
            rule(dom('title'),
                 typeAndNote.score(10).note(fnode => fnode.element.text)),
            rule(type('titley').max(), 'bestTitle')
        ]);
        const facts = rules.against(doc);
        const node = facts.get('bestTitle')[0];
        assert.equal(node.scoreFor('titley'), sigmoid(40));
        assert.equal(node.noteFor('titley'), 'OpenGraph');
    });
});
