/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseHTML} from 'linkedom';

import {DEFAULT_DEBOUNCE_MS, watch} from '../watch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const viewport = {width: 1200, height: 900};

function parse(html) {
    return parseHTML(html, {url: 'https://example.test/'}).document;
}

const PLAIN_PAGE = `
    <html><body>
        <main id="content"><h1>Example shop</h1></main>
    </body></html>
`;

const BANNER_HTML = `
    <aside id="cookie">
        <p>This site uses cookies to improve privacy preferences.</p>
        <button>Accept</button>
    </aside>
`;

// Detection on a parsed Document needs geometry, exactly as in
// detect.test.mjs: rects and computed styles drive the visibility rules.
function layout(rect, position = 'static', zIndex = 'auto') {
    return {
        rect: {
            x: rect.x,
            y: rect.y,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
            left: rect.x,
            width: rect.width,
            height: rect.height
        },
        style: {display: 'block', visibility: 'visible', opacity: '1',
            position, zIndex}
    };
}

function installLayout(doc, byId) {
    const fallback = layout({x: 0, y: 0, width: 640, height: 160});
    for (const element of doc.querySelectorAll('*')) {
        const data = byId.get(element.id) ?? fallback;
        Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => data.rect
        });
    }
    doc.defaultView.getComputedStyle = element => (byId.get(element.id) ?? fallback).style;
    Object.defineProperty(doc.defaultView, 'innerWidth', {configurable: true, value: viewport.width});
    Object.defineProperty(doc.defaultView, 'innerHeight', {configurable: true, value: viewport.height});
}

function addBanner(doc) {
    doc.body.insertAdjacentHTML('beforeend', BANNER_HTML);
    installLayout(doc, new Map([
        ['content', layout({x: 80, y: 80, width: 720, height: 420})],
        ['cookie', layout({x: 0, y: 650, width: 1200, height: 250}, 'fixed', '2147483647')]
    ]));
}

// linkedom ships a working MutationObserver, so most tests run the real
// integration: a DOM change fires the observer, the debounce elapses, and
// detect runs. The fake below fires synchronously, which the race tests
// need for deterministic control.
class FakeMutationObserver {
    static instances = [];

    constructor(callback) {
        this.callback = callback;
        this.target = null;
        this.options = null;
        this.disconnected = false;
        FakeMutationObserver.instances.push(this);
    }

    observe(target, options) {
        this.target = target;
        this.options = options;
    }

    disconnect() {
        this.disconnected = true;
    }

    fire() {
        if (!this.disconnected) this.callback([], this);
    }
}

function record() {
    const events = [];
    return {
        events,
        push: (result, event) => events.push({
            found: result.banner?.kind ?? result.found,
            cause: event.cause,
            revision: event.revision
        })
    };
}

function fakeNavigation(view) {
    const listeners = new Map();
    view.navigation = {
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: type => listeners.delete(type)
    };
    return {
        navigate: () => listeners.get('navigate')?.(),
        listenerCount: () => listeners.size
    };
}

test('validates its arguments', () => {
    const doc = parse(PLAIN_PAGE);
    assert.throws(() => watch(null, () => {}), TypeError);
    assert.throws(() => watch(doc, null), TypeError);
    assert.throws(() => watch({}, () => {}), TypeError);
    assert.throws(() => watch(doc, () => {}, {debounceMs: -1}), RangeError);
    assert.throws(() => watch(doc, () => {}, {debounceMs: 'soon'}), RangeError);
});

test('the default debounce sits inside the specified 150 to 300 ms band',
    () => {
        assert.ok(DEFAULT_DEBOUNCE_MS >= 150 && DEFAULT_DEBOUNCE_MS <= 300);
    });

test('reports the current page immediately as the initial run', async () => {
    const doc = parse(PLAIN_PAGE);
    installLayout(doc, new Map([['content', layout({x: 80, y: 80, width: 720, height: 420})]]));
    const seen = record();
    const handle = watch(doc, seen.push, {debounceMs: 5});
    assert.equal(handle.reactive, true);
    await handle.flush();
    assert.deepEqual(seen.events, [{found: null, cause: 'initial', revision: 0}]);
    handle.cancel();
});

test('observes childList and subtree on the whole document', () => {
    const doc = parse(PLAIN_PAGE);
    const handle = watch(doc, () => {},
        {MutationObserver: FakeMutationObserver, debounceMs: 5});
    const [observer] = FakeMutationObserver.instances.slice(-1);
    assert.equal(observer.target, doc);
    assert.deepEqual(observer.options, {childList: true, subtree: true});
    handle.cancel();
});

test('one debounced run for a batch of DOM changes', async () => {
    const doc = parse(PLAIN_PAGE);
    const seen = record();
    const handle = watch(doc, seen.push, {debounceMs: 20});
    await handle.flush();
    addBanner(doc);
    doc.querySelector('#cookie p').append('More text.');
    doc.body.insertAdjacentHTML('beforeend', '<div id="promo">Sale</div>');
    await sleep(1);
    // linkedom batches records per microtask checkpoint, so the whole
    // burst is one observer callback and one revision bump. This test
    // pins that integration; the debounce-reset test below uses the
    // fake observer to space the triggers apart.
    const newest = handle.revision;
    assert.ok(newest >= 1);
    await sleep(60);
    assert.deepEqual(seen.events.slice(1),
        [{found: 'banner', cause: 'mutation', revision: newest}]);
    handle.cancel();
});

test('a change inside the debounce window resets it and joins one run', async () => {
    const doc = parse(PLAIN_PAGE);
    const seen = record();
    const handle = watch(doc, seen.push,
        {MutationObserver: FakeMutationObserver, debounceMs: 20});
    await handle.flush();
    const [observer] = FakeMutationObserver.instances.slice(-1);
    addBanner(doc);
    observer.fire();
    await sleep(5);
    doc.querySelector('#cookie p').append('More text.');
    observer.fire();
    // Fifteen ms after the first trigger, ten after the second: the
    // trailing debounce still holds the run.
    await sleep(10);
    assert.equal(seen.events.length, 1);
    await sleep(30);
    assert.deepEqual(seen.events.slice(1),
        [{found: 'banner', cause: 'mutation', revision: 2}]);
    handle.cancel();
});

test('a change that lands during the initial run cancels that run', async () => {
    const doc = parse(PLAIN_PAGE);
    const seen = record();
    const handle = watch(doc, seen.push,
        {MutationObserver: FakeMutationObserver, debounceMs: 5});
    // The fake fires synchronously, before the initial detect() resumes at
    // its first await, so this trigger wins the revision race.
    const [observer] = FakeMutationObserver.instances.slice(-1);
    addBanner(doc);
    observer.fire();
    assert.equal(handle.revision, 1);
    await handle.flush();
    await sleep(10);
    assert.deepEqual(seen.events.map(event => event.cause), ['mutation']);
    assert.equal(seen.events[0].found, 'banner');
    handle.cancel();
});

test('debounces on a timer when nothing flushes', async () => {
    const doc = parse(PLAIN_PAGE);
    const seen = record();
    const handle = watch(doc, seen.push, {debounceMs: 15});
    await handle.flush();
    addBanner(doc);
    // Before the debounce elapses there is no new event; after it, one.
    await sleep(5);
    assert.equal(seen.events.length, 1);
    await sleep(40);
    assert.deepEqual(seen.events.slice(1),
        [{found: 'banner', cause: 'mutation', revision: 1}]);
    handle.cancel();
});

test('retriggers on the Navigation API and stops after cancel', async () => {
    const doc = parse(PLAIN_PAGE);
    installLayout(doc, new Map([['content', layout({x: 80, y: 80, width: 720, height: 420})]]));
    const navigation = fakeNavigation(doc.defaultView);
    const seen = record();
    const handle = watch(doc, seen.push, {debounceMs: 5});
    await handle.flush();
    navigation.navigate();
    assert.equal(handle.revision, 1);
    await handle.flush();
    assert.deepEqual(seen.events.slice(1),
        [{found: null, cause: 'navigate', revision: 1}]);

    handle.cancel();
    assert.equal(navigation.listenerCount(), 0);
    const revisionAtCancel = handle.revision;
    addBanner(doc);
    navigation.navigate();
    assert.equal(handle.revision, revisionAtCancel);
    await sleep(20);
    assert.equal(seen.events.length, 2);
});

test('runs the debounced detection through requestIdleCallback', async () => {
    const doc = parse(PLAIN_PAGE);
    const view = doc.defaultView;
    assert.equal(typeof view.requestIdleCallback, 'undefined');
    const scheduled = [];
    view.requestIdleCallback = (task, options) => {
        scheduled.push({task, options});
        return scheduled.length;
    };
    view.cancelIdleCallback = () => {};
    const seen = record();
    // A custom timeout proves the option reaches the platform call.
    const handle = watch(doc, seen.push, {debounceMs: 5, idleTimeoutMs: 1234});
    await handle.flush();
    addBanner(doc);
    await sleep(10);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(scheduled[0].options, {timeout: 1234});
    // flush() also runs a callback that idle scheduling has not fired yet.
    scheduled[0].task();
    await handle.flush();
    assert.deepEqual(seen.events.slice(1),
        [{found: 'banner', cause: 'mutation', revision: 1}]);
    handle.cancel();
    delete view.requestIdleCallback;
    delete view.cancelIdleCallback;
});

test('flush during the idle wait cancels the armed platform callback', async () => {
    const doc = parse(PLAIN_PAGE);
    const view = doc.defaultView;
    // A browser-faithful stub: it fires by itself, and a cancel stops it.
    const armed = [];
    let nextId = 1;
    view.requestIdleCallback = (task, options) => {
        const entry = {task, options, cancelled: false,
            timer: setTimeout(() => {
                if (!entry.cancelled) task();
            }, 20)};
        entry.id = nextId++;
        armed.push(entry);
        return entry.id;
    };
    view.cancelIdleCallback = id => {
        const entry = armed.find(candidate => candidate.id === id);
        if (entry) {
            entry.cancelled = true;
            clearTimeout(entry.timer);
        }
    };
    const seen = record();
    const handle = watch(doc, seen.push, {debounceMs: 5});
    await handle.flush();
    addBanner(doc);
    await sleep(10);
    assert.equal(armed.length, 1);
    // flush() runs the held task by hand and must also cancel it; a
    // platform firing later would otherwise deliver the same revision a
    // second time.
    await handle.flush();
    assert.equal(armed[0].cancelled, true);
    await sleep(60);
    assert.deepEqual(seen.events.slice(1),
        [{found: 'banner', cause: 'mutation', revision: 1}]);
    handle.cancel();
    delete view.requestIdleCallback;
    delete view.cancelIdleCallback;
});

test('a change during the idle wait drops the run the idle callback held',
    async () => {
        const doc = parse(PLAIN_PAGE);
        const view = doc.defaultView;
        const scheduled = [];
        view.requestIdleCallback = task => {
            scheduled.push(task);
            return scheduled.length;
        };
        view.cancelIdleCallback = () => {};
        const seen = record();
        const handle = watch(doc, seen.push, {debounceMs: 5});
        await handle.flush();
        addBanner(doc);
        await sleep(10);
        assert.equal(scheduled.length, 1);
        // A late change bumps the revision past the run the idle callback
        // still holds; firing it now must deliver nothing.
        doc.querySelector('#cookie p').append('Late edit.');
        await sleep(10);
        assert.equal(scheduled.length, 2);
        scheduled[0]();
        await sleep(5);
        assert.deepEqual(seen.events.map(event => event.cause), ['initial']);
        // The run for the newest revision is the only one that reports.
        await handle.flush();
        assert.deepEqual(seen.events.slice(1),
            [{found: 'banner', cause: 'mutation', revision: 2}]);
        handle.cancel();
        delete view.requestIdleCallback;
        delete view.cancelIdleCallback;
    });

test('without a MutationObserver it degrades to the initial run only',
    async () => {
        const doc = parse(PLAIN_PAGE);
        const seen = record();
        const handle = watch(doc, seen.push, {MutationObserver: undefined});
        assert.equal(handle.reactive, false);
        await handle.flush();
        addBanner(doc);
        await sleep(20);
        assert.deepEqual(seen.events.map(event => event.cause), ['initial']);
        handle.cancel();
    });

test('callback exceptions surface through flush', async () => {
    const doc = parse(PLAIN_PAGE);
    const handle = watch(doc, () => {
        throw new Error('callback exploded');
    }, {MutationObserver: FakeMutationObserver, debounceMs: 5});
    await assert.rejects(() => handle.flush(), /callback exploded/);
    handle.cancel();
});

test('a consumed exception does not replay on a later flush', async () => {
    const doc = parse(PLAIN_PAGE);
    const handle = watch(doc, () => {
        throw new Error('callback exploded');
    }, {MutationObserver: FakeMutationObserver, debounceMs: 5});
    await assert.rejects(() => handle.flush(), /callback exploded/);
    handle.cancel();
    // Nothing is pending now; the already-reported error must not return.
    await handle.flush();
});

test('a throwing callback surfaces as an unhandled rejection without flush',
    () => {
        // node:test converts an in-process unhandled rejection into a
        // test failure, so observe the documented behavior in a child.
        const script = `
import {parseHTML} from 'linkedom';
const {watch} = await import(process.argv[1]);
const {document} = parseHTML(
    '<html><body><main id="content">x</main></body></html>',
    {url: 'https://example.test/'});
watch(document, () => { throw new Error('callback exploded'); });
await new Promise(resolve => setTimeout(resolve, 50));
console.log('unhandled rejection did not happen');
`;
        const result = spawnSync(process.execPath,
            ['--input-type=module', '-e', script,
                fileURLToPath(new URL('../watch.mjs', import.meta.url))],
            {encoding: 'utf8', cwd: dirname(fileURLToPath(import.meta.url)) + '/..'});
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /callback exploded/);
        assert.doesNotMatch(result.stdout, /did not happen/);
    });
