/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

import {Lhs} from './lhs.mjs';
import {InwardRhs} from './rhs.mjs';


/** Constrain to an input type on the LHS, or apply a type on the RHS. */
export function type(theType) {
    return new Side({method: 'type', args: [theType]});
}

export function note(callback) {
    return new Side({method: 'note', args: [callback]});
}

export function score(scoreOrCallback) {
    return new Side({method: 'score', args: [scoreOrCallback]});
}

export function atMost(score) {
    return new Side({method: 'atMost', args: [score]});
}

export function typeIn(...types) {
    return new Side({method: 'typeIn', args: types});
}

/**
 * A chain of calls that can be compiled into a Rhs or Lhs, depending on its
 * position in a Rule. This lets us use type() as a leading call for both
 * RHSs and LHSs.
 */
class Side {
    constructor(...calls) {
        // A "call" is like {method: 'dom', args: ['p.smoo']}.
        this._calls = calls;
    }

    max() {
        return this._and('max');
    }

    type(...types) {
        return this._and('type', ...types);
    }

    note(callback) {
        return this._and('note', callback);
    }

    score(scoreOrCallback) {
        return this._and('score', scoreOrCallback);
    }

    atMost(score) {
        return this._and('atMost', score);
    }

    typeIn(...types) {
        return this._and('typeIn', ...types);
    }

    _and(method, ...args) {
        return new this.constructor(...this._calls.concat({method, args}));
    }

    asLhs() {
        return this._asSide(Lhs.fromFirstCall(this._calls[0]), this._calls.slice(1));
    }

    asRhs() {
        return this._asSide(new InwardRhs(), this._calls);
    }

    _asSide(side, calls) {
        for (let call of calls) {
            side = side[call.method](...call.args);
        }
        return side;
    }

    when(pred) {
        return this._and('when', pred);
    }
}
