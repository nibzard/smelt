/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

// The left-hand side of a rule

import {getDefault, maxes, querySelectorAllComposed, setDefault, NiceSet} from './utils.mjs';


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

/** Base class for private left-hand-side expressions. */
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

    /** Prune fnodes before scoring. */
    when(predicate) {
        let lhs = this.clone();
        lhs._predicate = predicate;
        return lhs;
    }

    /** Return only fnodes that satisfy the when() predicate. */
    fnodesSatisfyingWhen(fnodes) {
        return Array.from(fnodes).filter(this._predicate);
    }

    /** Return selected fnodes after prerequisites have run. */
    // fnodes (ruleset) {}

    /** Check that a RHS-emitted fact is legal for this LHS. */
    checkFact(fact) {}

    /** Return the guaranteed output type, if known. */
    guaranteedType() {}

    /** Return the aggregated type, if any. */
    aggregatedType() {}

    /** Return local type combinations as NiceSet values. */
    // possibleTypeCombinations() {}

    /** Return the types this LHS needs before it can select nodes. */
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

    /** Return the LHS name for error messages. */
    _callName() {
        return 'dom';
    }

    clone() {
        return new this.constructor(this.selector);
    }

    fnodes(ruleset) {
        return this._domNodesToFilteredFnodes(
            ruleset,
            querySelectorAllComposed(ruleset.doc, this.selector));
    }

    /** Turn DOM nodes into budgeted, filtered fnodes. */
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

    /** Return a fnode if the run still has element budget. */
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

/** Internal LHS with both type and max() constraints. */
class TypeMaxLhs extends AggregateTypeLhs {
    /** Return the max-scoring node, or nodes if there is a tie. */
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
