/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

// The left-hand side of a rule

import {getDefault, maxes, setDefault, NiceSet} from './utils.mjs';


/**
 * Take nodes that match a given DOM selector. Example:
 * ``dom('meta[property="og:title"]')``
 *
 * Every ruleset has at least one ``dom`` or :func:`element` rule, as that is
 * where nodes begin to flow into the system. If run against a subtree of a
 * document, the root of the subtree is not considered as a possible match.
 */
export function dom(selector) {
    return new DomLhs(selector);
}

/**
 * Take a single given node if it matches a given DOM selector, without
 * examining its descendents or ancestors. Otherwise, take no nodes. Example:
 * ``element('input')``
 *
 * This is useful for applications in which you want Fathom to classify an
 * element the user has selected, rather than scanning the whole page for
 * candidates.
 */
export function element(selector) {
    return new ElementLhs(selector);
}

/**
 * Rules and the LHSs and RHSs that comprise them have no mutable state. A
 * run therefore borrows a ruleset's rules without duplicating them and
 * shares one cache among every rule that cares about a given type.
 *
 * Lhses are responsible for maintaining the run's maxCache.
 *
 * Lhs and its subclasses are private to the framework.
 */
export class Lhs {
    constructor() {
        this._predicate = () => true;
    }

    /** Return a new Lhs of the appropriate kind, given its first call. */
    static fromFirstCall(firstCall) {
        // firstCall is never 'dom', because dom() directly returns a DomLhs.
        if (firstCall.method === 'type') {
            return new TypeLhs(...firstCall.args);
        } else {
            throw new Error('The left-hand side of a rule() must start with dom(), element(), or type().');
        }
    }

    /**
     * Prune nodes from consideration early, before scoring is done.
     *
     * Reserve this for where you are sure it is always correct or when
     * performance demands it. It is generally preferable to use :func:`score`
     * and let the coefficients determine the significance of each rule.
     * Human intuition is often wrong, especially across languages.
     *
     * Example: ``dom('p').when(isVisible)``
     *
     * @arg {function} predicate Accepts a fnode and returns a boolean
     */
    when(predicate) {
        let lhs = this.clone();
        lhs._predicate = predicate;
        return lhs;
    }

    /**
     * Of all the dom nodes selected by type() or dom(), return only
     * the fnodes that satisfy all the predicates imposed by calls to
     * when()
     */
    fnodesSatisfyingWhen(fnodes) {
        return Array.from(fnodes).filter(this._predicate);
    }

    /**
     * Return an iterable of output fnodes selected by this left-hand-side
     * expression.
     *
     * Pre: The rules I depend on have already been run, and their results are
     * in the run's typeCache.
     *
     * @arg ruleset {BoundRun} The run the LHS is being evaluated within
     */
    // fnodes (ruleset) {}

    /**
     * Check that a RHS-emitted fact is legal for this kind of LHS, and throw
     * an error if it isn't.
     */
    checkFact(fact) {}

    /**
     * Return the single type the output of the LHS is guaranteed to have.
     * Return undefined if there is no such single type we can ascertain.
     */
    guaranteedType() {}

    /**
     * Return the type I aggregate if I am an aggregate LHS; return undefined
     * otherwise.
     */
    aggregatedType() {}

    /**
     * Return each combination of types my selected nodes could be locally (that
     * is, by this rule only) constrained to have.
     *
     * For example, type(A) would return [A].
     *
     * @return {NiceSet[]}
     */
    // possibleTypeCombinations() {}

    /**
     * Types mentioned in this LHS.
     *
     * In other words, the types I need to know the assignment status of before
     * I can make my selections
     *
     * @return NiceSet of strings
     */
    // typesMentioned() {}
}

class DomLhs extends Lhs {
    constructor(selector) {
        super();
        if (selector === undefined) {
            throw new Error('A querySelector()-style selector is required as the argument to ' + this._callName() + '().');
        }
        this.selector = selector;
    }

    /**
     * Return the name of this kind of LHS, for use in error messages.
     */
    _callName() {
        return 'dom';
    }

    clone() {
        return new this.constructor(this.selector);
    }

    fnodes(ruleset) {
        return this._domNodesToFilteredFnodes(
            ruleset,
            ruleset.doc.querySelectorAll(this.selector));
    }

    /**
     * Turn a NodeList of DOM nodes into an array of fnodes, and filter out
     * those that don't match the :func:`when()` clause.
     *
     * DOM nodes beyond the run's element budget are skipped, and the run
     * records the truncation.
     */
    _domNodesToFilteredFnodes(ruleset, domNodes) {
        let ret = [];
        for (let i = 0; i < domNodes.length; i++) {
            const fnode = this._fnodeWithinElementBudget(ruleset, domNodes[i]);
            if (fnode !== undefined) {
                ret.push(fnode);
            }
        }
        return this.fnodesSatisfyingWhen(ret);
    }

    /**
     * Return the fnode for a DOM node or, if the run's element budget is
     * exhausted, ``undefined`` after telling the run about the truncation.
     * The run counts each element that obtains its first fnode; elements
     * that already have fnodes pass free, since they add nothing to the
     * budget. Explicit ``get(domElement)`` calls bypass this and always
     * produce a fnode.
     */
    _fnodeWithinElementBudget(ruleset, element) {
        if (!ruleset.hasFnodeFor(element) && ruleset.atElementBudget()) {
            ruleset.noteTruncation();
            return undefined;
        }
        return ruleset.fnodeForElement(element);
    }

    checkFact(fact) {
        if (fact.type === undefined) {
            throw new Error(`The right-hand side of a ${this._callName()}() rule failed to specify a type. This means there is no way for its output to be used by later rules. All it specified was ${fact}.`);
        }
    }

    asLhs() {
        return this;
    }

    possibleTypeCombinations() {
        return [];
    }

    typesMentioned() {
        return new NiceSet();
    }
}

class ElementLhs extends DomLhs {
    _callName() {
        return 'element';
    }

    fnodes(ruleset) {
        return this._domNodesToFilteredFnodes(
            ruleset,
            ruleset.doc.matches(this.selector) ? [ruleset.doc] : []);
    }
}

/** Internal representation of a LHS constrained by type but not by max() */
class TypeLhs extends Lhs {
    constructor(type) {
        super();
        if (type === undefined) {
            throw new Error('A type name is required when calling type().');
        }
        this._type = type;  // the input type
    }

    clone() {
        return new this.constructor(this._type);
    }

    fnodes(ruleset) {
        const cached = getDefault(ruleset.typeCache, this._type, () => []);
        return this.fnodesSatisfyingWhen(cached);
    }

    /** Override the type previously specified by this constraint. */
    type(inputType) {
        // Preserve the class in case this is a TypeMaxLhs.
        return new this.constructor(inputType);
    }

    /**
     * Of the nodes selected by a ``type`` call to the left, constrain the LHS
     * to return only the max-scoring one. If there is a tie, more than 1 node
     * will be returned. Example: ``type('titley').max()``
     */
    max() {
        return new TypeMaxLhs(this._type);
    }

    guaranteedType() {
        return this._type;
    }

    possibleTypeCombinations() {
        return [this.typesMentioned()];
    }

    typesMentioned() {
        return new NiceSet([this._type]);
    }
}

/**
 * Abstract LHS that is an aggregate function taken across all fnodes of a type
 *
 * The main point here is that any aggregate function over a (typed) set of
 * nodes depends on first computing all the rules that could emit those nodes
 * (nodes of that type).
 */
class AggregateTypeLhs extends TypeLhs {
    aggregatedType() {
        return this._type;
    }
}

/**
 * Internal representation of a LHS that has both type and max([NUMBER])
 * constraints. max(NUMBER != 1) support is not yet implemented.
 */
class TypeMaxLhs extends AggregateTypeLhs {
    /**
     * Return the max-scoring node (or nodes if there is a tie) of the given
     * type.
     */
    fnodes(ruleset) {
        const self = this;
        // super cannot appear directly in a generator function body.
        const getSuperFnodes = () => super.fnodes(ruleset);
        const maxFnodes = setDefault(
            ruleset.maxCache,
            this._type,
            function maxFnodesOfType() {
                return maxes(getSuperFnodes(), fnode => ruleset.weightedScore(fnode.scoresSoFarFor(self._type)));
            });
        return this.fnodesSatisfyingWhen(maxFnodes);
    }
}
