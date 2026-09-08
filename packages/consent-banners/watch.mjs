/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Experimental watch mode for single-page applications (IDEA.md 3.4.6,
// Appendix E decision 3): MutationObserver on childList and subtree, a
// trailing debounce, requestIdleCallback coalescing, revision tokens that
// drop stale runs, and a re-trigger on the Navigation API when present.
// v0.1 ships detect only; this module stays outside the v0.1 dist.

import {detect} from './index.mjs';

// The specification puts the default inside 150 to 300 ms.
export const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_IDLE_TIMEOUT_MS = 500;

/**
 * Watch a document and re-run detect when it changes.
 *
 * The first detection runs immediately. After that, childList and subtree
 * mutations (and Navigation API navigations, when the platform has them)
 * schedule one debounced re-detection. Idle scheduling coalesces bursts:
 * while a run is pending or in flight, new changes only bump the revision
 * and the pending run picks them up. A run whose revision is no longer
 * current is dropped, so the callback always sees the newest page.
 *
 * @param {Document} doc The document to watch.
 * @param {Function} callback Called as callback(result, {cause, revision})
 *     where cause is 'initial', 'mutation', or 'navigate'. Exceptions from
 *     the callback propagate, including as an unhandled rejection when no
 *     flush() awaits the run that raised them.
 * @param {object} [options] {debounceMs, idleTimeoutMs, MutationObserver}
 * @returns {object} Handle: cancel() stops watching, flush() runs a
 *     pending re-detection now and resolves when it finishes, reactive
 *     says whether a MutationObserver was available, and revision is the
 *     current token.
 */
export function watch(doc, callback, options = {}) {
    if (!doc?.documentElement) {
        throw new TypeError('watch() expects a Document.');
    }
    if (typeof callback !== 'function') {
        throw new TypeError('watch() expects a callback function.');
    }
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
        throw new RangeError('debounceMs must be a nonnegative number.');
    }
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const view = doc.defaultView ?? doc.parentWindow ?? globalThis;
    // An explicit option wins even when it is undefined: passing
    // {MutationObserver: undefined} asks for the degraded, run-once mode.
    const Observer = 'MutationObserver' in options
        ? options.MutationObserver
        : (view.MutationObserver ?? globalThis.MutationObserver);

    let revision = 0;
    let cancelled = false;
    let timer = null;
    let pendingCause = null;
    // The run scheduled but not yet started: it holds its own cancel, so
    // a stale callback firing late cannot cancel a newer scheduled run.
    let pending = null;
    let current = null;

    const deliver = async (rev, cause) => {
        const result = await detect(doc);
        // Drop the run when newer changes arrived while it was in flight.
        if (cancelled || rev !== revision) return;
        callback(result, {cause, revision: rev});
    };

    const startNow = (rev, cause) => {
        if (cancelled || rev !== revision) return;
        current = deliver(rev, cause);
    };

    const fire = () => {
        timer = null;
        const cause = pendingCause;
        pendingCause = null;
        if (cause === null) return;
        const rev = revision;
        let fired = false;
        const run = () => {
            // A scheduled run fires exactly once: flush() may run it by
            // hand, and a platform that ignored the cancel must not
            // replay it. Detach only when this callback is still the
            // pending run; a newer scheduled run must survive.
            if (fired) return;
            fired = true;
            if (pending?.run === run) pending = null;
            startNow(rev, cause);
        };
        if (typeof view.requestIdleCallback === 'function') {
            const id = view.requestIdleCallback(run, {timeout: idleTimeoutMs});
            pending = {run, cancel: () => view.cancelIdleCallback(id)};
        } else {
            const id = setTimeout(run, 0);
            pending = {run, cancel: () => clearTimeout(id)};
        }
    };

    const trigger = cause => {
        if (cancelled) return;
        revision += 1;
        pendingCause = cause;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(fire, debounceMs);
    };

    const stop = () => {
        cancelled = true;
        revision += 1;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        pendingCause = null;
        pending?.cancel();
        pending = null;
    };

    let observer = null;
    if (typeof Observer === 'function') {
        observer = new Observer(() => trigger('mutation'));
        observer.observe(doc, {childList: true, subtree: true});
    }

    const navigation = view.navigation;
    const onNavigate = () => trigger('navigate');
    if (typeof navigation?.addEventListener === 'function') {
        navigation.addEventListener('navigate', onNavigate);
    }

    // Report the page as it is now, without waiting for a first mutation.
    current = deliver(revision, 'initial');

    return {
        cancel() {
            stop();
            observer?.disconnect();
            if (typeof navigation?.removeEventListener === 'function') {
                navigation.removeEventListener('navigate', onNavigate);
            }
        },
        async flush() {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
                const cause = pendingCause;
                pendingCause = null;
                if (cause !== null) {
                    pending?.cancel();
                    pending = null;
                    startNow(revision, cause);
                }
            } else if (pending !== null) {
                pending.cancel();
                pending.run();
            }
            if (current !== null) {
                const run = current;
                try {
                    await run;
                } finally {
                    // Consume the run: a later flush with nothing pending
                    // must not replay an already-reported exception.
                    if (current === run) current = null;
                }
            }
        },
        reactive: observer !== null,
        get revision() {
            return revision;
        }
    };
}
