/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Derived from fathom-web 3.7.3 (Mozilla, MPL-2.0).

/**
 * A :func:`rule` depends on another rule which itself depends on the first
 * rule again, either directly or indirectly.
 */
export class CycleError extends Error {
}

/**
 * An examined element was not contained in a browser ``window`` object, but
 * something needed it to be.
 */
export class NoWindowError extends Error {
}
