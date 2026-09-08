/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHTML} from 'linkedom';

import {captureFrozenSnapshot} from '@smelt-oss/capture';
import {readModelArtifact, scorePackedForest} from '../model.mjs';
import {trainConsentBaselines} from '../train.mjs';

const viewport = {width: 1200, height: 900, deviceScaleFactor: 1};

function parse(html) {
    return parseHTML(html, {url: 'https://example.test/'}).document;
}

function layout(rect, position = 'static', zIndex = 'auto', display = 'block') {
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
        style: {display, visibility: 'visible', opacity: '1', position, zIndex}
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

function snapshotId(snapshot, domId) {
    return snapshot.elements.find(element => element.attributes.id === domId)?.id;
}

function makeCapture(id, html, layoutById, label) {
    const doc = parse(html);
    installLayout(doc, layoutById);
    const {snapshot, features} = captureFrozenSnapshot(doc, {
        captureId: id,
        capturedAt: '2026-09-07T23:40:00Z',
        viewport
    });
    const root = label.rootDomId ? snapshotId(snapshot, label.rootDomId) : null;
    return {
        capture: {id, snapshot, features},
        page: {
            id,
            group: label.group,
            hasBanner: root !== null,
            acceptableRoots: root ? [root] : [],
            exactRoot: root
        }
    };
}

function consentPage(id, group, text = 'We use cookies for analytics.') {
    return makeCapture(id, `
        <html><body>
            <main id="content"><h1>Example</h1></main>
            <section id="consent" role="dialog" aria-modal="true">
                <p>${text}</p>
                <button>Accept all</button>
                <button>Manage choices</button>
            </section>
        </body></html>
    `, new Map([
        ['content', layout({x: 80, y: 80, width: 700, height: 380})],
        ['consent', layout({x: 0, y: 650, width: 1200, height: 250}, 'fixed', '2147483647')]
    ]), {group, rootDomId: 'consent'});
}

function negativePage(id, group, html, rootId) {
    return makeCapture(id, html, new Map([
        [rootId, layout({x: 320, y: 180, width: 430, height: 230}, 'fixed', '1001')]
    ]), {group, rootDomId: null});
}

function split(name, cases) {
    return {
        labels: {
            schemaVersion: 1,
            split: name,
            pages: cases.map(item => item.page)
        },
        captures: cases.map(item => item.capture)
    };
}

// A page whose only acceptable root sits in another frame document. The
// top-frame replay can neither produce nor score that root.
function frameRootPage(id, group) {
    const item = consentPage(id, group);
    const frameBanner = 'frame-element-banner';
    item.capture.snapshot.elements.push(
        {id: frameBanner, tagName: 'div', textSample: 'Frame banner', attributes: {}, children: []}
    );
    item.capture.features.elements.push({id: frameBanner, layout: {
        rect: {x: 0, y: 0, top: 0, right: 300, bottom: 150, left: 0, width: 300, height: 150},
        display: 'block', visibility: 'visible', opacity: 1, position: 'fixed', zIndex: 5
    }});
    item.page.acceptableRoots = [frameBanner];
    item.page.exactRoot = frameBanner;
    return item;
}

test('trains and compares rules, linear, and LightGBM baselines', () => {
    const train = split('train', [
        consentPage('train-positive', 'example-a'),
        negativePage('train-newsletter', 'example-b', `
            <html><body>
                <div id="newsletter" role="dialog">
                    <p>Subscribe to our newsletter.</p>
                    <button>Sign up</button>
                </div>
            </body></html>
        `, 'newsletter'),
        negativePage('train-signin', 'example-c', `
            <html><body>
                <form id="signin" role="dialog">
                    <p>Sign in to continue.</p>
                    <button>Log in</button>
                </form>
            </body></html>
        `, 'signin')
    ]);
    const development = split('development', [
        consentPage('dev-positive', 'example-d', 'We use cookies and personalized ads.'),
        negativePage('dev-policy', 'example-e', `
            <html><body>
                <footer id="footer"><a href="/cookies">Cookie policy</a></footer>
            </body></html>
        `, 'footer'),
        frameRootPage('dev-frame-root', 'example-f')
    ]);

    const report = trainConsentBaselines({
        schemaVersion: 1,
        trainedAt: '2026-09-07T23:58:00Z',
        corpus: {id: 'synthetic-consent', revision: 'test-fixture'},
        humanEffortHours: 1.5,
        costs: {teacherUsd: 0.25, humanReviewUsd: 4, browserUsd: 0.1},
        train,
        development
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.modelArtifact.task, 'consent-banners');
    assert.equal(report.modelArtifact.trainedAt, '2026-09-07T23:58:00Z');
    assert.equal(report.modelArtifact.corpus.id, 'synthetic-consent');
    assert.equal(report.modelArtifactChecks.lightgbm.signAgreement, 1);
    assert.equal(typeof report.modelArtifactChecks.lightgbm.maxProbabilityDelta, 'number');
    const artifact = readModelArtifact(report.modelArtifact);
    assert.equal(typeof scorePackedForest(artifact.decodedForest, Object.fromEntries(
        report.featureNames.map(name => [name, 0])
    )), 'number');
    assert.deepEqual(report.baselines.map(item => item.name), ['rules', 'linear', 'lightgbm']);
    for (const baseline of report.baselines) {
        // Evaluation covers the two scored pages; the frame-root page is
        // counted in the split stats, not scored.
        assert.equal(baseline.accuracy.pages, 2);
        assert.equal(typeof baseline.accuracy.detectionF1, 'number');
        assert.equal(typeof baseline.effort.machineTrainingMs, 'number');
        assert.equal(baseline.cost.trainingUsd, 0);
        assert.equal(typeof baseline.latency.vectorizeMs, 'number');
        assert.equal(typeof baseline.latency.scoreMs, 'number');
    }
    assert.equal(report.splits.train.pages, 3);
    assert.equal(report.splits.development.pages, 3);
    // The frame-root page is skipped, not scored as a false negative.
    assert.equal(report.splits.development.frameRootPages, 1);
    assert.equal(report.splits.train.frameRootPages, 0);
});
