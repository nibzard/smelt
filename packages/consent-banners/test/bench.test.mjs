/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {test} from 'node:test';

import {PROBE_SETS, readBenchManifest, summarizeLatency} from '../bench.mjs';

test('summarizes repeated-call latency with p50 and p95', () => {
    const summary = summarizeLatency([10, 2, 8, 4, 6]);

    assert.deepEqual(summary, {
        count: 5,
        min: 2,
        mean: 6,
        p50: 6,
        p95: 10,
        max: 10
    });
});

test('loads a named benchmark probe set from a manifest', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'smelt-bench-test-'));
    try {
        const manifestPath = resolve(dir, 'bench.json');
        await writeFile(manifestPath, JSON.stringify({
            schemaVersion: 1,
            probeSets: {
                'ci-50': [
                    {
                        id: 'example',
                        group: 'example.com',
                        snapshot: 'example.snapshot.json',
                        features: 'example.features.json'
                    }
                ]
            }
        }));

        const captures = await readBenchManifest(manifestPath, 'ci-50');

        assert.equal(PROBE_SETS['ci-50'], 50);
        assert.equal(captures.length, 1);
        assert.equal(captures[0].id, 'example');
        assert.equal(captures[0].snapshot, resolve(dir, 'example.snapshot.json'));
        assert.equal(captures[0].features, resolve(dir, 'example.features.json'));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
