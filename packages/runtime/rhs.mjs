/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

// The right-hand side of a rule

import {NiceSet, reversed} from './utils.mjs';


const TYPE = 1;
const NOTE = 2;
const SCORE = 4;
const ELEMENT = 8;
const SUBFACTS = {
    type: TYPE,
    note: NOTE,
    score: SCORE,
    element: ELEMENT
};

/**
 * Expose the output of this rule's LHS as a "final result" to the surrounding
 * program. It will be available by calling :func:`get` on the run that
 * executed the ruleset and passing the key.
 */
export function out(key) {
    return new OutwardRhs(key);
}

/**
 * The right-hand side of a rule whose output stays within the run: a chain
 * of type(), typeIn(), note(), score(), and atMost() calls, merged into
 * fnodes.
 *
 * InwardRhses are immutable; every chain method returns a new instance. This
 * lets rules be shared among runs without duplication.
 */
export class InwardRhs {
    constructor(calls = [], max = Infinity, types) {
        this._calls = calls.slice();
        this._max = max;  // max score
        this._types = new NiceSet(types);  // empty set if unconstrained
    }

    /**
     * Declare that the maximum returned subscore is such and such. This
     * doesn't force it to be true; it merely throws an error at runtime if
     * it isn't. To lift an ``atMost`` constraint, call ``atMost()`` with no
     * args. ``atMost`` and ``typeIn`` apply until explicitly cleared so a
     * distant safety constraint cannot be stomped on accidentally.
     */
    atMost(score) {
        return new this.constructor(this._calls, score, this._types);
    }

    _checkAtMost(fact) {
        if (fact.score !== undefined && fact.score > this._max) {
            throw new Error(`Score of ${fact.score} exceeds the declared atMost(${this._max}).`);
        }
    }

    /**
     * Set the type applied to fnodes processed by this RHS.
     */
    type(theType) {
        // Actually emit a given type.
        function getSubfacts() {
            return {type: theType};
        }
        getSubfacts.possibleSubfacts = TYPE;
        getSubfacts.type = theType;
        getSubfacts.kind = 'type';
        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    /**
     * Constrain this rule to emit 1 of a set of given types. Pass no args to lift
     * a previous ``typeIn`` constraint, as you might do when basing a LHS on a
     * common value to factor out repetition.
     *
     * ``typeIn`` is mostly a hint for the query planner, but it also checks
     * conformance at runtime to ensure validity.
     */
    typeIn(...types) {
        // Rationale: with the spelling type('a', 'b', ...), a later type()
        // call would sometimes override the constraint and sometimes stack
        // with it. A separate typeIn() keeps the override rules consistent
        // and lets a constraint survive substitution.
        return new this.constructor(this._calls,
                                    this._max,
                                    types);
    }

    /**
     * Check a fact for conformance with any typeIn() call.
     *
     * @arg leftType the type of the LHS, which becomes my emitted type if the
     *    fact doesn't specify one
     */
    _checkTypeIn(result, leftType) {
        if (this._types.size > 0) {
            if (result.type === undefined) {
                if (!this._types.has(leftType)) {
                    throw new Error(`A right-hand side claimed, via typeIn(...) to emit one of the types ${this._types} but actually inherited ${leftType} from the left-hand side.`);
                }
            } else if (!this._types.has(result.type)) {
                throw new Error(`A right-hand side claimed, via typeIn(...) to emit one of the types ${this._types} but actually emitted ${result.type}.`);
            }
        }
    }

    /**
     * Whatever the callback returns (even ``undefined``) becomes the note of
     * the fact. This overrides any previous call to ``note``.
     */
    note(callback) {
        function getSubfacts(fnode) {
            return {note: callback(fnode)};
        }
        getSubfacts.possibleSubfacts = NOTE;
        getSubfacts.kind = 'note';
        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    /**
     * Affect the confidence with which the input node should be considered a
     * member of a type.
     *
     * The parameter is generally between 0 and 1 (inclusive), with 0 meaning
     * the node does not have the "smell" this rule checks for and 1 meaning it
     * does. The range between 0 and 1 is available to represent "fuzzy"
     * confidences. If you have an unbounded range to compress down to [0, 1],
     * consider using :func:`sigmoid` or a scaling thereof.
     *
     * Since every node can have multiple, independent scores (one for each
     * type), this applies to the type explicitly set by the RHS or, if none,
     * to the type named by the ``type`` call on the LHS. If the LHS has none
     * because it's a ``dom(...)`` LHS, an error is raised.
     *
     * @arg {number|function} scoreOrCallback Can either be a static number,
     *     generally 0 to 1 inclusive, or else a callback which takes the fnode
     *     and returns such a number. If the callback returns a boolean, it is
     *     cast to a number.
     */
    score(scoreOrCallback) {
        let getSubfacts;

        function getSubfactsFromNumber(fnode) {
            return {score: scoreOrCallback};
        }

        function getSubfactsFromFunction(fnode) {
            let result = scoreOrCallback(fnode);
            if (typeof result === 'boolean') {
                // Case bools to numbers for convenience. Boolean features are
                // common. Don't cast other things, as it frustrates ruleset
                // debugging.
                result = Number(result);
            }
            return {score: result};
        }

        if (typeof scoreOrCallback === 'number') {
            getSubfacts = getSubfactsFromNumber;
        } else {
            getSubfacts = getSubfactsFromFunction;
        }
        getSubfacts.possibleSubfacts = SCORE;
        getSubfacts.kind = 'score';

        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    // -------- Methods below this point are private to the framework. --------

    /**
     * Run all my type().note().score() stuff across a given fnode, enforce my
     * atMost() stuff, and return a fact ({type, score, note}) for incorporation
     * into that fnode. Any of the fact properties can be missing; filling in
     * defaults is a job for the caller.
     *
     * @arg leftType The type the LHS takes in
     */
    fact(fnode, leftType) {
        const doneKinds = new Set();
        const result = {};
        let haveSubfacts = 0;
        for (let call of reversed(this._calls)) {
            // If we've already called a call of this kind, then forget it.
            if (!doneKinds.has(call.kind)) {
                doneKinds.add(call.kind);

                if (~haveSubfacts & call.possibleSubfacts) {
                    // This call might provide a subfact we are missing.
                    const newSubfacts = call(fnode);

                    // We start with an empty object, so we're okay here.
                    for (let subfact in newSubfacts) {
                        if (!result.hasOwnProperty(subfact)) {
                            result[subfact] = newSubfacts[subfact];
                        }
                        haveSubfacts |= SUBFACTS[subfact];
                    }
                }
            }
        }
        this._checkAtMost(result);
        this._checkTypeIn(result, leftType);
        return result;
    }

    /**
     * Return a record describing the types I might emit (which means either to
     * add a type to a fnode or to output a fnode that already has that type).
     * {couldChangeType: whether I might add a type to the fnode,
     *  possibleTypes: If couldChangeType, the types I might emit; empty set if
     *      we cannot infer it. If not couldChangeType, undefined.}
     */
    possibleEmissions() {
        // If there is a typeIn() constraint or there is a type() call, we
        // have a constraint. We hunt for the tightest constraint we can
        // find, favoring a type() call because it gives us a single type
        // but then falling back to a typeIn().
        for (let call of reversed(this._calls)) {
            if (call.kind === 'type') {
                return {couldChangeType: true,
                        possibleTypes: new Set([call.type])};
            }
        }
        return {couldChangeType: false,
                possibleTypes: this._types};
    }
}

/**
 * The right-hand side of a rule made with :func:`out`: a final goal of a
 * ruleset, whose results go out into the world rather than back into the
 * knowledgebase. The key names the output for later retrieval.
 */
export class OutwardRhs {
    constructor(key) {
        this.key = key;
    }

    asRhs() {
        return this;
    }
}
