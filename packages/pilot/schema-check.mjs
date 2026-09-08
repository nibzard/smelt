/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A small JSON Schema checker for the corpus schemas. It covers the subset
// those schemas use: type, enum, const, pattern, required, properties,
// additionalProperties: false, minItems, uniqueItems, items, string and
// number bounds, and $ref to #/$defs. It exists so prepare-corpus can
// refuse to write labels that violate the canonical task schemas without
// adding a dependency. The "format" keyword stays unchecked.

const TYPES = {
    object: value => typeof value === 'object' && value !== null && !Array.isArray(value),
    array: value => Array.isArray(value),
    string: value => typeof value === 'string',
    boolean: value => typeof value === 'boolean',
    number: value => typeof value === 'number',
    integer: value => Number.isInteger(value),
    null: value => value === null
};

export function validateSchema(instance, schema, root = schema, at = 'value') {
    const errors = [];
    const fail = message => errors.push(`${at}: ${message}`);

    if (schema.$ref) {
        const ref = schema.$ref.replace(/^#\/\$defs\//, '');
        const target = root.$defs?.[ref];
        if (!target) return [`${at}: unknown $ref ${schema.$ref}`];
        return validateSchema(instance, target, root, at);
    }

    if (schema.const !== undefined && instance !== schema.const) {
        fail(`must equal ${JSON.stringify(schema.const)}`);
    }
    if (schema.enum && !schema.enum.includes(instance)) {
        fail(`must be one of ${schema.enum.map(value => JSON.stringify(value)).join(', ')}`);
    }
    if (schema.type) {
        const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!allowed.some(type => TYPES[type]?.(instance))) {
            fail(`must be of type ${allowed.join(' or ')}`);
            return errors;
        }
    }
    if (schema.pattern && typeof instance === 'string'
        && !new RegExp(schema.pattern).test(instance)) {
        fail(`must match ${schema.pattern}`);
    }
    if (typeof instance === 'string' && schema.minLength !== undefined
        && instance.length < schema.minLength) {
        fail(`must have at least ${schema.minLength} characters`);
    }
    if (typeof instance === 'number' && schema.minimum !== undefined
        && instance < schema.minimum) {
        fail(`must be at least ${schema.minimum}`);
    }
    if (typeof instance === 'number' && schema.maximum !== undefined
        && instance > schema.maximum) {
        fail(`must be at most ${schema.maximum}`);
    }
    if (Array.isArray(instance)) {
        if (schema.minItems !== undefined && instance.length < schema.minItems) {
            fail(`must have at least ${schema.minItems} items`);
        }
        if (schema.uniqueItems && new Set(instance.map(item => JSON.stringify(item))).size
            !== instance.length) {
            fail('must have unique items');
        }
        if (schema.items) {
            instance.forEach((item, index) => errors.push(...validateSchema(
                item, schema.items, root, `${at}[${index}]`)));
        }
    }
    if (TYPES.object(instance)) {
        for (const field of schema.required ?? []) {
            // Own properties only; "in" would also count fields inherited
            // from Object.prototype, such as "toString".
            if (!Object.prototype.hasOwnProperty.call(instance, field)) {
                fail(`is missing required field "${field}"`);
            }
        }
        for (const [key, value] of Object.entries(instance)) {
            // Own properties only. A plain lookup like
            // schema.properties?.[key] resolves "__proto__",
            // "constructor", and "toString" through the prototype chain,
            // so those keys would slip past additionalProperties: false.
            const properties = schema.properties ?? {};
            const property = Object.prototype.hasOwnProperty.call(properties, key)
                ? properties[key]
                : undefined;
            if (!property) {
                if (schema.additionalProperties === false) {
                    fail(`has unexpected field "${key}"`);
                }
                continue;
            }
            errors.push(...validateSchema(value, property, root, `${at}.${key}`));
        }
    }
    return errors;
}
