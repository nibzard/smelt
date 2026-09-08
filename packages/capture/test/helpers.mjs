/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {parseHTML} from 'linkedom';

export class FakePage {
    constructor(html, browserVersion = '128.0.0') {
        this.doc = parseHTML(html, {url: 'https://example.test/'}).document;
        this.browserVersion = browserVersion;
        this.initScripts = [];
        this.viewport = null;
        this.gotoUrl = null;
    }

    async setViewportSize(viewport) {
        this.viewport = viewport;
        this.doc.defaultView.innerWidth = viewport.width;
        this.doc.defaultView.innerHeight = viewport.height;
    }

    async addInitScript(script) {
        this.initScripts.push(script);
    }

    async goto(url) {
        this.gotoUrl = url;
        Object.defineProperty(this.doc, 'URL', {value: url, configurable: true});
    }

    async waitForLoadState() {}

    async waitForTimeout() {}

    context() {
        return {browser: () => ({version: () => this.browserVersion})};
    }

    async evaluate(callback, payload) {
        const previousDocument = globalThis.document;
        const previousNavigator = globalThis.navigator;
        const previousInnerWidth = globalThis.innerWidth;
        const previousInnerHeight = globalThis.innerHeight;
        const previousDevicePixelRatio = globalThis.devicePixelRatio;
        const previousNode = globalThis.Node;
        const previousPerformance = globalThis.performance;
        Object.defineProperty(globalThis, 'document', {value: this.doc, configurable: true});
        Object.defineProperty(globalThis, 'navigator', {
            value: {userAgent: 'FakeSteelBrowser/1.0'},
            configurable: true
        });
        globalThis.innerWidth = this.viewport.width;
        globalThis.innerHeight = this.viewport.height;
        globalThis.devicePixelRatio = 1;
        globalThis.Node = this.doc.defaultView.Node;
        globalThis.performance = {
            getEntriesByType: () => [{toJSON: () => ({type: 'navigate'})}]
        };
        try {
            return callback(payload);
        } finally {
            restore('document', previousDocument);
            restore('navigator', previousNavigator);
            globalThis.innerWidth = previousInnerWidth;
            globalThis.innerHeight = previousInnerHeight;
            globalThis.devicePixelRatio = previousDevicePixelRatio;
            globalThis.Node = previousNode;
            globalThis.performance = previousPerformance;
        }
    }

    async close() {}
}

function restore(name, value) {
    if (value === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, {value, configurable: true});
}

export class FakeBrowser {
    constructor(page) {
        this.page = page;
        this.closed = false;
        this.launchOptions = null;
    }

    async newContext() {
        return {newPage: async () => this.page};
    }

    async close() {
        this.closed = true;
    }
}

export function fakePlaywright(page) {
    const browser = new FakeBrowser(page);
    const launch = async options => {
        browser.launchOptions = options ?? {};
        return browser;
    };
    return {chromium: {launch}, firefox: {launch}, browser};
}
