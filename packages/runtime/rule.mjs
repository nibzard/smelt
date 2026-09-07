/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

import {out, OutwardRhs} from './rhs.mjs';
import {forEach, NiceSet, setDefault} from './utils.mjs';


/**
 * Construct and return the proper type of rule class based on the
 * inwardness/outwardness of the RHS.
 *
 * @arg lhs {Lhs} The left-hand side of the rule
 * @arg rhs {Rhs} The right-hand side of the rule. A plain string is shorthand
 *     for ``out(string)``.
 * @arg options {object} Other, optional information about the rule.
 *     Currently, the only recognized option is ``name``, which points to a
 *     string that uniquely identifies this rule in a ruleset. The name
 *     correlates this rule with one of the coefficients passed into
 *     :func:`ruleset`. If no name is given, an identifier is assigned based on
 *     the index of this rule in the ruleset, but that is, of course, brittle.
 */
export function rule(lhs, rhs, options) {
    // Since out() is a valid call only on the RHS (unlike type()), we can take
    // a shortcut here: any outward RHS will already be an OutwardRhs; we don't
    // need to sidetrack it by way of a Side. And OutwardRhs has an asRhs()
    // that just returns itself.
    if (typeof rhs === 'string') {
        rhs = out(rhs);
    }
    return new ((rhs instanceof OutwardRhs) ? OutwardRule : InwardRule)(lhs, rhs, options);
}

let nextRuleNumber = 0;
function newInternalRuleName() {
    return '_' + nextRuleNumber++;
}

/**
 * We place the in/out distinction in Rules because it determines whether the
 * RHS result is cached.
 */
class Rule {  // abstract
    constructor(lhs, rhs, options) {
        this.lhs = lhs.asLhs();
        this.rhs = rhs.asRhs();
        // TODO: base auto-generated names on out types, so adding rules for
        // one type does not misalign coeffs for another.
        this.name = (options ? options.name : undefined) || newInternalRuleName();
    }

    /**
     * Return a NiceSet of the rules that this one shallowly depends on in the
     * given ruleset. The compile-time planner calls this over the whole
     * ruleset to build the execution order.
     *
     * Depend on emitters of any LHS type this rule finalizes (see
     * _typesFinalized) and on adders of any other LHS types. Where A is a
     * type: A.max -> anything depends on emitters of A, even for A.max -> A;
     * A -> A depends on adders of A; A -> anything else and A -> out()
     * depend on emitters of A.
     */
    prerequisites(ruleset) {
        // Extend prereqs with rules derived from each of the given types. If
        // no rules are found, raise an exception, as that indicates a
        // malformed ruleset.
        function extendOrThrow(prereqs, types, ruleGetter, verb) {
            for (let type of types) {
                const rules = ruleGetter(type);
                if (rules.length > 0) {
                    prereqs.extend(rules);
                } else {
                    throw new Error(`No rule ${verb} the "${type}" type, but another rule needs it as input.`);
                }
            }
        }

        const prereqs = new NiceSet();

        // Add finalized types:
        extendOrThrow(prereqs, this._typesFinalized(), type => ruleset.inwardRulesThatCouldEmit(type), 'emits');

        // Add mentioned types:
        // We could say this.lhs.typesMentioned().minus(typesFinalized) as an
        // optimization. But since types mentioned are a superset of types
        // finalized and rules adding are a subset of rules emitting, we get
        // the same result without.
        extendOrThrow(prereqs, this.lhs.typesMentioned(), type => ruleset.inwardRulesThatCouldAdd(type), 'adds');

        return prereqs;
    }

    /**
     * Return the types that this rule finalizes.
     *
     * To "finalize" a type means to make sure we're finished running all
     * possible rules that might change a node's score or notes w.r.t. a
     * given type: we're about to change the type of the nodes or aggregate
     * all nodes of a type. A simple type() LHS mention does not finalize
     * its nodes, because adding notes is immutable and adding to a score
     * is commutative. A max(B) LHS is not commutative with other B -> B
     * rules, so it finalizes B.
     *
     * @return Set of types
     */
    _typesFinalized() {
        const type = this.lhs.aggregatedType();
        return (type === undefined) ? new NiceSet() : new NiceSet([type]);
    }
}

/**
 * A normal rule, whose results head back into the Fathom knowledgebase, to be
 * operated on by further rules.
 */
export class InwardRule extends Rule {
    // TODO: On construct, complain about useless rules, like a dom() rule that
    // doesn't assign a type.

    /**
     * Return an iterable of the fnodes emitted by the RHS of this rule.
     * Side effect: update the run's store of fnodes, its accounting of which
     * rules are done executing, and its cache of results per type.
     *
     * @arg ruleset {BoundRun} The run executing this rule
     */
    results(ruleset) {
        if (ruleset.doneRules.has(this)) {  // shouldn't happen
            throw new Error('A bug in the rules engine caused results() to be called on an inward rule twice. That could cause redundant score contributions, etc.');
        }
        const self = this;
        // For now, we consider most of what a LHS computes to be cheap, aside
        // from type() and type().max(), which are cached by their specialized
        // LHS subclasses.
        const leftResults = this.lhs.fnodes(ruleset);
        // Avoid returning a single fnode more than once. LHSs uniquify
        // themselves, but the RHS can change the element it's talking
        // about and thus end up with dupes.
        const returnedFnodes = new Set();

        // Merge facts into fnodes:
        forEach(
            // Each left result is a plain fnode.
            function updateFnode(leftFnode) {
                const leftType = self.lhs.guaranteedType();
                // Grab the fact from the RHS:
                const fact = self.rhs.fact(leftFnode, leftType);
                self.lhs.checkFact(fact);
                const rightFnode = ruleset.fnodeForElement(fact.element || leftFnode.element);
                // If the RHS doesn't specify a type, default to the
                // type of the LHS, if any:
                const rightType = fact.type || self.lhs.guaranteedType();
                if (fact.score !== undefined) {
                    if (rightType !== undefined) {
                        rightFnode.addScoreFor(rightType, fact.score, self.name);
                    } else {
                        throw new Error(`The right-hand side of a rule specified a score (${fact.score}) with neither an explicit type nor one we could infer from the left-hand side.`);
                    }
                }
                if (fact.type !== undefined || fact.note !== undefined) {
                    // There's a reason to call setNoteFor.
                    if (rightType === undefined) {
                        throw new Error(`The right-hand side of a rule specified a note (${fact.note}) with neither an explicit type nor one we could infer from the left-hand side. Notes are per-type, per-node, so that's a problem.`);
                    } else {
                        rightFnode.setNoteFor(rightType, fact.note);
                    }
                }
                returnedFnodes.add(rightFnode);
            },
            leftResults);

        // Update the run's lookup tables.
        // First, mark this rule as done:
        ruleset.doneRules.add(this);
        // Then, stick each fnode in typeCache under all applicable types.
        // Optimization: we really only need to loop over the types
        // this rule can possibly add.
        for (let fnode of returnedFnodes) {
            for (let type of fnode.typesSoFar()) {
                setDefault(ruleset.typeCache, type, () => new Set()).add(fnode);
            }
        }
        return returnedFnodes.values();
    }

    /**
     * Return a Set of the types that could be emitted back into the system.
     * To emit a type means to either to add it to a fnode emitted from the RHS
     * or to leave it on such a fnode where it already exists.
     */
    typesItCouldEmit() {
        const rhs = this.rhs.possibleEmissions();
        if (!rhs.couldChangeType && this.lhs.guaranteedType() !== undefined) {
            // It's a b -> b rule.
            return new Set([this.lhs.guaranteedType()]);
        } else if (rhs.possibleTypes.size > 0) {
            // We can prove the type emission from the RHS alone.
            return rhs.possibleTypes;
        } else {
            throw new Error('Could not determine the emitted type of a rule because its right-hand side sets no type.');
        }
    }

    /**
     * Return a Set of types I could add to fnodes I output (where the fnodes
     * did not already have them).
     */
    typesItCouldAdd() {
        const ret = new Set(this.typesItCouldEmit());
        ret.delete(this.lhs.guaranteedType());
        return ret;
    }

    /**
     * Add the types we could change to the superclass's result.
     */
    _typesFinalized() {
        const self = this;
        function typesThatCouldChange() {
            const ret = new NiceSet();

            // Get types that could change:
            const emissions = self.rhs.possibleEmissions();
            if (emissions.couldChangeType) {
                // Get the possible guaranteed combinations of types on the LHS
                // (taking just this LHS into account). For each combo, if the RHS
                // adds a type that's not in the combo, the types in the combo get
                // unioned into ret.
                for (let combo of self.lhs.possibleTypeCombinations()) {
                    for (let rhsType of emissions.possibleTypes) {
                        if (!combo.has(rhsType)) {
                            ret.extend(combo);
                            break;
                        }
                    }
                }
            }
            // Optimization: combos could later be informed by earlier rules
            // that add the types mentioned in the LHS, yielding fewer types
            // finalized.
            return ret;
        }

        return typesThatCouldChange().extend(super._typesFinalized());
    }
}

/**
 * A rule whose RHS is an out(). This represents a final goal of a ruleset.
 * Its results go out into the world, not inward back into the Fathom
 * knowledgebase.
 */
export class OutwardRule extends Rule {
    /**
     * Return the fnodes to emit. Do not mark me done in ruleset.doneRules; out
     * rules are never marked as done. The executor runs each out rule once
     * and stores the resulting array under key() for the run's get().
     */
    results(ruleset) {
        // The LHS hands us plain fnodes. Copy them into a fresh Array so the
        // stored output can never alias one of the run's caches, which
        // TypeMaxLhs.fnodes, for instance, hands out directly.
        return Array.from(this.lhs.fnodes(ruleset));
    }

    /**
     * @return the key under which the output of this rule will be available
     */
    key() {
        return this.rhs.key;
    }

    /**
     * OutwardRules finalize all types mentioned.
     */
    _typesFinalized() {
        return this.lhs.typesMentioned().extend(super._typesFinalized());
    }
}
