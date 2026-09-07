/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

import {Fnode} from './fnodes.mjs';
import {InwardRule} from './rule.mjs';
import {getDefault, isDomElement, setDefault} from './utils.mjs';


/**
 * A compiled plan bound to a certain DOM
 *
 * Constructing one runs the entire plan, eagerly, in compiled order, exactly
 * once. Nothing is evaluated lazily afterward; ``get()`` only reads what the
 * pass already computed. Typically comes from
 * :meth:`~CompiledPlan.against`.
 */
export class BoundRun {
    /**
     * @arg compiledPlan {CompiledPlan} The plan to run
     * @arg doc {Node} The DOM tree or subtree to run against. When run
     *     against a subtree, the root of the subtree is not considered as a
     *     possible match.
     * @arg options {object} Can contain ``maxElements`` (default 20000),
     *     the number of elements ``dom()`` and ``element()`` rules may
     *     introduce fnodes for. Past the budget, those rules skip
     *     elements and set ``stats.truncated``.
     */
    constructor(compiledPlan, doc, options = {}) {
        this.doc = doc;
        this._ruleset = compiledPlan.ruleset;
        this._inRules = compiledPlan.rules;  // every rule, in execution order
        this._outputs = new Map();  // out() rule key -> Array of results
        // InwardRules that have been executed. OutwardRules run once, up
        // front, with their results stored, so they need no such accounting.
        this.doneRules = new Set();
        this.typeCache = new Map();  // type => Set of all fnodes of this type
        this.maxCache = new Map();  // type => Array of max fnode (or fnodes, if tied) of this type
        this.elementCache = new WeakMap();  // DOM element => fnode about it
        this._coeffs = this._ruleset._coeffs;

        // Private, for the use of only helper classes:
        this.biases = this._ruleset.biases;
        this._maxElements = (options.maxElements === undefined) ? 20000 : options.maxElements;
        this._stats = {ms: 0,             // execution time of the pass
                       elementsWalked: 0,  // fnodes created for elements
                       truncated: false,   // whether the element budget ran out
                       tier: 0,            // Tier 0, pure JavaScript
                       rulesExecuted: 0};  // rules run by the pass

        // Run the whole plan, eagerly, in order. Time it with
        // performance.now() where available, else Date.now():
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function') ?
            () => performance.now() :
            () => Date.now();
        const start = now();
        for (let rule of this._inRules) {
            if (rule instanceof InwardRule) {
                // The rule merges facts into fnodes, marks itself done in
                // doneRules, and updates the typeCache itself:
                rule.results(this);
            } else {
                // Compute the output of an out() rule once, and store it by
                // key:
                this._outputs.set(rule.key(), Array.from(rule.results(this)));
            }
            this._stats.rulesExecuted++;
        }
        this._stats.ms = now() - start;
    }

    /**
     * Return an array of zero or more fnodes.
     *
     * @arg thing {string|Side|Node} Can be
     *
     *       (1) A string which matches up with an ``out()`` rule in the
     *           ruleset.
     *       (2) A ``type()`` expression, including chained ``max()`` and
     *           ``when()`` calls, evaluated against the run's caches.
     *       (3) A DOM node, for which we will return the corresponding fnode.
     *
     *     Returns are fresh arrays and copies of stored data, so mutating a
     *     result cannot corrupt a later ``get()``. A type no rule emits has
     *     no fnodes, so it yields an empty array rather than an error.
     */
    get(thing) {
        if (typeof thing === 'string') {
            if (this._outputs.has(thing)) {
                return Array.from(this._outputs.get(thing));
            } else {
                throw new Error(`There is no out() rule with key "${thing}".`);
            }
        } else if (isDomElement(thing)) {
            // Everything has already run, so the fnode is complete.
            return this.fnodeForElement(thing);
        } else if (thing._calls !== undefined && thing._calls[0].method === 'type') {
            // Evaluate the whole chain (type, then max/when), the way
            // Fathom's lazy get() did, but against the settled caches:
            return Array.from(thing.asLhs().fnodes(this));
        } else {
            throw new Error('ruleset.get() expects a string, a type() expression, or a DOM element.');
        }
    }

    /**
     * Return the weighted sum of the per-rule, per-type scores from a fnode.
     *
     * @arg mapOfScores a Map of rule name to the [0, 1] score it computed for
     *      the type in question
     */
    weightedScore(mapOfScores) {
        let total = 0;
        for (const [name, score] of mapOfScores) {
            total += score * getDefault(this._coeffs, name, () => 1);
        }
        return total;
    }

    /**
     * @return {object} The statistics of the run: ``ms``,
     *     ``elementsWalked``, ``truncated``, ``tier`` (always 0), and
     *     ``rulesExecuted``.
     */
    get stats() {
        return this._stats;
    }

    // -------- Methods below this point are private to the framework. --------

    /** @return {Rule[]} */
    inwardRulesThatCouldEmit(type) {
        return this._ruleset.inwardRulesThatCouldEmit(type);
    }

    /** @return {Rule[]} */
    inwardRulesThatCouldAdd(type) {
        return this._ruleset.inwardRulesThatCouldAdd(type);
    }

    /**
     * @return whether the element already has a fnode this run. Cached
     *     elements pass the element budget free, since reintroducing them
     *     adds nothing to it.
     */
    hasFnodeFor(element) {
        return this.elementCache.has(element);
    }

    /**
     * @return the fnode that describes the given DOM element, creating it if
     *     necessary. This does not trigger any execution, so the result may
     *     be incomplete.
     */
    fnodeForElement(element) {
        return setDefault(this.elementCache,
                          element,
                          () => {
                              this._stats.elementsWalked++;
                              return new Fnode(element, this);
                          });
    }

    /**
     * @return whether the element budget is spent. ``dom()`` plus
     *     ``element()`` rules stop introducing new elements once it is.
     *     Explicit ``get(domElement)`` calls always create a fnode anyway.
     */
    atElementBudget() {
        return this._stats.elementsWalked >= this._maxElements;
    }

    /** Record that the element budget made some LHS skip elements. */
    noteTruncation() {
        this._stats.truncated = true;
    }
}
