/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

import {validateSchema} from '../schema-check.mjs';

const labelsSchema = JSON.parse(await readFile(
    fileURLToPath(new URL('../../../tasks/consent-banners/labels.schema.json',
        import.meta.url)), 'utf8'));

function stubPage(overrides = {}) {
    return {
        id: 'example-eu',
        group: 'example.test',
        label_status: 'unresolved',
        has_banner: null,
        acceptable_roots: [],
        banner_root: null,
        banner_kind: null,
        jurisdiction: null,
        frame: {state: 'unknown', frame_id: null, element_id: null},
        evidence: [],
        confidence: null,
        review_notes: 'awaiting review',
        ...overrides
    };
}

test('validateSchema accepts a conforming label document', () => {
    const errors = validateSchema(
        {schema_version: 1, split: 'train', pages: [stubPage()]}, labelsSchema);
    assert.deepEqual(errors, []);
});

test('validateSchema catches schema violations', () => {
    const withoutGroup = stubPage({id: 'missing-group'});
    delete withoutGroup.group;
    const errors = validateSchema({schema_version: 1, split: 'holdout', pages: [
        stubPage({
            acceptable_roots: ['root'],          // pattern violation
            banner_kind: 'popover',              // enum violation
            jurisdiction: 'eu',                  // enum violation
            has_banner: 'yes',                   // type violation
            surprise: 1                          // additionalProperties violation
        }),
        withoutGroup
    ]}, labelsSchema);
    const joined = errors.join('\n');
    assert.match(joined, /split: must be one of/);
    assert.match(joined, /acceptable_roots\[0\]: must match/);
    assert.match(joined, /banner_kind: must be one of/);
    assert.match(joined, /jurisdiction: must be one of/);
    assert.match(joined, /has_banner: must be of type/);
    assert.match(joined, /unexpected field "surprise"/);
    assert.match(joined, /missing required field "group"/);
});

test('validateSchema follows $ref and checks unique items', () => {
    const errors = validateSchema({
        schema_version: 1,
        split: 'test',
        pages: [stubPage({
            acceptable_roots: ['e1', 'e1'],
            frame: {state: 'top', frame_id: 'x', element_id: 'e9'}
        })]
    }, labelsSchema);
    const joined = errors.join('\n');
    assert.match(joined, /acceptable_roots: must have unique items/);
    assert.match(joined, /frame.frame_id: must match/);
});

test('validateSchema enforces string and number bounds', () => {
    const errors = validateSchema({
        schema_version: 1,
        split: 'train',
        pages: [
            stubPage({id: ''}),
            stubPage({id: 'bounds-ok', label_status: 'reviewed', confidence: 5})
        ]
    }, labelsSchema);
    const joined = errors.join('\n');
    assert.match(joined, /pages\[0\].id: must have at least 1 characters/);
    assert.match(joined, /pages\[1\].confidence: must be at most 1/);
    // Null confidence passes: the schema allows null or a bounded number.
    const clean = validateSchema({schema_version: 1, split: 'train',
        pages: [stubPage()]}, labelsSchema);
    assert.deepEqual(clean, []);
});

test('validateSchema rejects prototype-chain keys as unknown fields', () => {
    // JSON.parse keeps "__proto__" as an own enumerable property. A plain
    // schema.properties[key] lookup resolves it (and "constructor",
    // "toString", and friends) through the prototype chain, so those keys
    // would slip past additionalProperties: false and validate against
    // Object.prototype, which constrains nothing.
    const poisoned = JSON.parse('{"id": "proto-eu", "label_status": "unresolved",'
        + ' "__proto__": {"evil": 1}, "constructor": 2, "toString": 3}');
    const errors = validateSchema(
        {schema_version: 1, split: 'train', pages: [poisoned]}, labelsSchema);
    const joined = errors.join('\n');
    assert.match(joined, /unexpected field "__proto__"/);
    assert.match(joined, /unexpected field "constructor"/);
    assert.match(joined, /unexpected field "toString"/);
    // No error claims the poisoned fields were validated: the only
    // messages for them are the unexpected-field rejections.
    assert.ok(!joined.includes('must be of type'), joined);
});
