/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

import {CycleError} from './errors.mjs';
import {InwardRule, OutwardRule} from './rule.mjs';
import {BoundRun} from './executor.mjs';
import {getDefault, reversed, setDefault, toposort} from './utils.mjs';


/**
 * A shortcut for creating a new :class:`Ruleset`, for symmetry with
 * :func:`rule`
 */
export function ruleset(rules, coeffs = [], biases = []) {
    return new Ruleset(rules, coeffs, biases);
}

/**
 * An unbound ruleset. Binding it with :func:`~Ruleset.against` first
 * compiles it, then returns a :class:`BoundRun` that holds the results.
 */
export class Ruleset {
    /**
     * @arg rules {Array} Rules returned from :func:`rule`
     * @arg coeffs {Map} A map of rule names to numerical weights, typically
     *     returned by the :doc:`trainer<training>`. Example:
     *     ``[['someRuleName', 5.04], ...]``. If not given, coefficients
     *     default to 1.
     * @arg biases {object} A map of type names to neural-net biases. These
     *      enable accurate confidence estimates. Example: ``[['someType',
     *      -2.08], ...]``. If absent, biases default to 0.
     */
    constructor(rules, coeffs = [], biases = []) {
        this._inRules = [];
        this._outRules = new Map();  // key -> rule
        this._rulesThatCouldEmit = new Map();  // type -> [rules]
        this._rulesThatCouldAdd = new Map();  // type -> [rules]
        // Private to the framework:
        this._coeffs = new Map(coeffs);  // rule name => coefficient
        this.biases = new Map(biases);  // type name => bias
        this._compiledPlan = undefined;

        // Separate rules into out ones and in ones, and sock them away. We do
        // this here so mistakes raise errors early.
        for (let rule of rules) {
            if (rule instanceof InwardRule) {
                this._inRules.push(rule);

                // Keep track of what inward rules can emit or add:
                // TODO: Combine these hashes for space efficiency:
                const emittedTypes = rule.typesItCouldEmit();
                for (let type of emittedTypes) {
                    setDefault(this._rulesThatCouldEmit, type, () => []).push(rule);
                }
                for (let type of rule.typesItCouldAdd()) {
                    setDefault(this._rulesThatCouldAdd, type, () => []).push(rule);
                }
            } else if (rule instanceof OutwardRule) {
                this._outRules.set(rule.key(), rule);
            } else {
                throw new Error(`This element of ruleset()'s first param wasn't a rule: ${rule}`);
            }
        }
    }

    /**
     * Commit this ruleset to running against a specific DOM tree or
     * subtree. The root of the subtree is not a possible match. Compiles
     * on first use (rules are immutable), then runs the whole ruleset
     * eagerly, in one pass, before returning.
     */
    against(doc, options) {
        if (this._compiledPlan === undefined) {
            this._compiledPlan = compile(this);
        }
        return this._compiledPlan.against(doc, options);
    }

    /**
     * Return all the rules (both inward and outward) that make up this ruleset.
     *
     * From this, you can construct another ruleset like this one but with your
     * own rules added.
     */
    rules() {
        return Array.from([...this._inRules, ...this._outRules.values()]);
    }

    /** @return {Rule[]} */
    inwardRulesThatCouldEmit(type) {
        return getDefault(this._rulesThatCouldEmit, type, () => []);
    }

    /** @return {Rule[]} */
    inwardRulesThatCouldAdd(type) {
        return getDefault(this._rulesThatCouldAdd, type, () => []);
    }
}

/**
 * Compile a ruleset into an execution plan
 *
 * The whole ruleset is sorted once, here, rather than per ``get()`` call.
 * Failures raise eagerly at compile time: a non-rule element, a rule that
 * needs a type no rule emits or adds, or a cyclic dependency.
 *
 * @arg rulesetOrRules {Ruleset|Array} A :class:`Ruleset` (whose coeffs
 *     already apply) or a bare array of rules
 * @arg coeffs {Iterable} Coeffs for the bare-array form; see :class:`Ruleset`
 * @arg biases {Iterable} Biases for the bare-array form; see :class:`Ruleset`
 * @return {CompiledPlan}
 */
export function compile(rulesetOrRules, coeffs = [], biases = []) {
    const theRuleset = (rulesetOrRules instanceof Ruleset) ?
        rulesetOrRules :
        new Ruleset(rulesetOrRules, coeffs, biases);
    return new CompiledPlan(theRuleset);
}

/**
 * An immutable, topologically sorted plan for running a ruleset
 *
 * Built by :func:`compile`. Every rule appears exactly once, in an
 * order where each rule's prerequisites have already run.
 */
export class CompiledPlan {
    /**
     * @arg theRuleset {Ruleset} The ruleset to plan, with its indexes
     *     already built
     */
    constructor(theRuleset) {
        this.ruleset = theRuleset;

        // Build one prerequisite graph over all rules. Edges map each
        // prerequisite rule to the rules that need it:
        const allRules = theRuleset.rules();
        const prereqs = new Map();  // prereq -> [rules it is needed by]
        for (let rule of allRules) {
            for (let prereq of rule.prerequisites(theRuleset)) {
                setDefault(prereqs, prereq, () => []).push(rule);
            }
        }

        let sorted;
        try {
            sorted = toposort(allRules, rule => getDefault(prereqs, rule, () => []));
        } catch (exc) {
            if (exc instanceof CycleError) {
                throw new CycleError('There is a cyclic dependency in the ruleset.');
            } else {
                throw exc;
            }
        }

        // toposort emits dependents before prerequisites, so run the reverse,
        // the same orientation Fathom's lazy executor used:
        this.rules = Array.from(reversed(sorted));
    }

    /**
     * Commit this plan to a DOM tree or subtree, returning a
     * :class:`BoundRun` that has already run the whole plan.
     */
    against(doc, options) {
        return new BoundRun(this, doc, options);
    }
}
