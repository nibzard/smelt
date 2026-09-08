/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The npm export path (IDEA.md 2.7 and 3.1.4): bundle the rules and the
// model into a self-contained dist that a consumer installs as one file
// plus the auditable artifact copies, with sha256 integrity metadata.
//
// Usage: node scripts/export.mjs [--out DIR] [--budget BYTES]
//        [--package-dir DIR]
// The output directory must stay inside this repository: the post-export
// smoke test imports the staged result, and Node must resolve
// @smelt-oss/runtime. The check below enforces it.

import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {readModelArtifact, rulesHash} from '../model.mjs';
import {measureBundle} from './bundle-size.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '../..');
const defaultPackageDir = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const valueOf = flag => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        console.error(`Expected a value after ${flag}.`);
        process.exit(1);
    }
    return value;
};
// --package-dir lets tests point the export at a copied, broken package.
const packageDir = valueOf('--package-dir') ?? defaultPackageDir;
const outDir = valueOf('--out') ?? resolve(packageDir, 'dist');
const budgetBytes = Number(valueOf('--budget') ?? 51200);
if (!Number.isInteger(budgetBytes) || budgetBytes < 1) {
    console.error('The budget must be a positive integer.');
    process.exit(1);
}
const insideRepo = dir => {
    const path = relative(repoRoot, resolve(dir));
    return path !== '' && !path.startsWith('..');
};

const sha256 = text => `sha256-${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const fail = message => {
    console.error(message);
    process.exit(1);
};

if (!insideRepo(outDir)) {
    fail(`The output directory must stay inside ${repoRoot} so the smoke test ` +
        'resolves @smelt-oss/runtime. Pass --out inside the repository.');
}

const indexSource = await readFile(resolve(packageDir, 'index.mjs'), 'utf8');
const rulesSource = await readFile(resolve(packageDir, 'rules.mjs'), 'utf8');
// Normalize once so the inlined copy, the hashed copy, and the written file
// are the same bytes.
const modelText = `${(await readFile(resolve(packageDir, 'model.smelt.json'), 'utf8'))
    .trimEnd()}\n`;
const {version: packageVersion} = JSON.parse(
    await readFile(resolve(packageDir, 'package.json'), 'utf8'));
if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    fail('package.json must declare a nonempty version string.');
}

// Gate 1: the artifact parses and its rules hash matches the rules that ship.
let artifact;
try {
    artifact = readModelArtifact(modelText);
} catch (error) {
    fail(`The model artifact is invalid: ${error.message}`);
}
const rulesSha = rulesHash(rulesSource);
if (artifact.rulesHash !== rulesSha) {
    fail(`The model artifact was trained against different rules ` +
        `(${artifact.rulesHash}, expected ${rulesSha}). Retrain before exporting.`);
}

// The generated wrapper reuses index.mjs as the single source of truth. Each
// template pattern must match exactly one full line, or the export fails
// instead of rewriting the first text that resembles the line.
const RULES_IMPORT_LINE =
    'import {CANDIDATE_TYPE, consentRules, vectorForConsentCandidate} from \'./rules.mjs\';';
const MODEL_IMPORT_LINE = /^import modelArtifact from '\.\/model\.smelt\.json' with \{type: 'json'\};$/m;
const RULES_IMPORT = new RegExp(
    `^${RULES_IMPORT_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
const VERSION_LINE = /^export const VERSION = '[^']*';$/m;
const TEMPLATE = [
    ['the model artifact import', MODEL_IMPORT_LINE],
    ['the rules import', RULES_IMPORT],
    ['the version line', VERSION_LINE]
];
const occurrences = (pattern, text) =>
    (text.match(new RegExp(pattern.source, pattern.flags.includes('g') ?
        pattern.flags : `${pattern.flags}g`)) ?? []).length;
for (const [name, pattern] of TEMPLATE) {
    const count = occurrences(pattern, indexSource);
    if (count !== 1) {
        fail(`index.mjs has ${count} lines matching ${name}; the export template ` +
            'needs exactly one. Update scripts/export.mjs or index.mjs.');
    }
}

// The generated module: index.mjs with the artifact inlined as base64. The
// helpers append at the end; function declarations hoist, so the decode call
// above them works. Interpolated values are JSON-encoded, never spliced raw.
const modelBase64 = Buffer.from(modelText, 'utf8').toString('base64');
const modelSha = sha256(modelText);
const transformed = indexSource
    .replace(/^\/\*[^]*?\*\/\n/, '')
    .replace(MODEL_IMPORT_LINE, '// The artifact rides inside this file as base64; the JSON copy\n' +
        '// in the package is for audit only (IDEA.md 3.1.4).')
    .replace(RULES_IMPORT, RULES_IMPORT_LINE.replace('./rules.mjs', './rules.js'))
    .replace(VERSION_LINE, `export const VERSION = ${JSON.stringify(packageVersion)};`);
const generated = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Generated by scripts/export.mjs from index.mjs and model.smelt.json.
// Do not edit; regenerate with "npm run export".

${transformed}

export const MODEL_SHA256 = ${JSON.stringify(modelSha)};
export const RULES_SHA256 = ${JSON.stringify(rulesSha)};
export const PACKAGE_VERSION = ${JSON.stringify(packageVersion)};
export const CORPUS_REVISION = ${JSON.stringify(artifact.corpus)};

const MODEL_BASE64 = ${JSON.stringify(modelBase64)};

const modelArtifact = decodeModelArtifact(MODEL_BASE64);

function decodeModelArtifact(base64) {
    const text = typeof Buffer === 'function' ?
        Buffer.from(base64, 'base64').toString('utf8') :
        new TextDecoder().decode(Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)));
    return JSON.parse(text);
}

/**
 * Re-hash the inlined artifact and compare it with the export hash. In a
 * context without crypto.subtle (a plain-http origin), returns ok:false
 * with an error message instead of throwing.
 *
 * @returns {Promise<object>} {ok, modelSha256, rulesSha256, corpus, error?}
 */
export async function verifyIntegrity() {
    if (typeof crypto === 'undefined' || typeof crypto?.subtle !== 'object' ||
            typeof crypto.subtle.digest !== 'function') {
        return {ok: false, modelSha256: null, rulesSha256: RULES_SHA256,
            corpus: CORPUS_REVISION,
            error: 'crypto.subtle is unavailable in this context.'};
    }
    const bytes = typeof Buffer === 'function' ?
        Buffer.from(MODEL_BASE64, 'base64') :
        Uint8Array.from(atob(MODEL_BASE64), ch => ch.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
    return {
        ok: \`sha256-\${hash}\` === MODEL_SHA256,
        modelSha256: \`sha256-\${hash}\`,
        rulesSha256: RULES_SHA256,
        corpus: CORPUS_REVISION
    };
}
`;

// Stage everything inside the output directory. A failed gate then leaves
// the previous export untouched, so integrity.json always describes the
// files beside it.
await mkdir(outDir, {recursive: true});
const staging = await mkdtemp(join(outDir, '.staging-'));
const stagedFiles = ['rules.js', 'model.smelt.json', 'detect.mjs', 'integrity.json'];
const cleanup = async () => rm(staging, {recursive: true, force: true});
await writeFile(join(staging, 'rules.js'), rulesSource, 'utf8');
await writeFile(join(staging, 'model.smelt.json'), modelText, 'utf8');
await writeFile(join(staging, 'detect.mjs'), generated, 'utf8');

// Gate 2: the staged wrapper imports, detects, self-verifies, and reports
// the package version.
const SMOKE_HTML = `<html><body><main id="content"><h1>Example</h1></main>
<section id="consent" role="dialog" aria-modal="true" style="position:fixed">
<p>We use cookies for analytics.</p><button>Accept all</button>
</section></body></html>`;
let smoke;
try {
    smoke = await import(pathToFileURL(join(staging, 'detect.mjs')).href);
} catch (error) {
    await cleanup();
    fail(`The exported detect.mjs failed to import: ${error.message}`);
}
const smokeResult = await smoke.detect(SMOKE_HTML);
if (smokeResult.found === null || smokeResult.degraded.includes('parse-failed') ||
        smokeResult.degraded.includes('rule-evaluation-failed')) {
    await cleanup();
    fail(`The exported detect.mjs did not detect the smoke fixture: ` +
        `${JSON.stringify(smokeResult)}.`);
}
const integrityCheck = await smoke.verifyIntegrity();
if (!integrityCheck.ok) {
    await cleanup();
    fail('The exported detect.mjs failed its own integrity check.');
}
if (smoke.VERSION !== packageVersion) {
    await cleanup();
    fail(`The exported detect.mjs reports version ${smoke.VERSION}; ` +
        `the package declares ${packageVersion}.`);
}

// Gate 3: the published bytes stay inside the package budget.
const measurement = await measureBundle(join(staging, 'detect.mjs'));
const record = {
    schemaVersion: 1,
    task: artifact.task,
    packageVersion,
    exportedAt: new Date().toISOString(),
    generator: 'packages/consent-banners/scripts/export.mjs',
    rules: {file: 'rules.js', bytes: Buffer.byteLength(rulesSource, 'utf8'),
        sha256: rulesSha},
    model: {file: 'model.smelt.json', bytes: Buffer.byteLength(modelText, 'utf8'),
        sha256: modelSha, modelVersion: artifact.modelVersion,
        rulesHash: artifact.rulesHash, corpus: artifact.corpus},
    detect: {file: 'detect.mjs',
        bytes: Buffer.byteLength(generated, 'utf8'), sha256: sha256(generated)},
    size: {eagerGzippedBytes: measurement.eagerGzippedBytes,
        budgetBytes,
        withinBudget: measurement.eagerGzippedBytes < budgetBytes}
};
await writeFile(join(staging, 'integrity.json'), `${JSON.stringify(record, null, 2)}\n`,
    'utf8');

if (!record.size.withinBudget) {
    await cleanup();
    fail(`The exported package needs ${measurement.eagerGzippedBytes} gzipped bytes; ` +
        `the budget is ${budgetBytes}.`);
}
for (const chunk of measurement.lazy.filter(item => !item.reached)) {
    await cleanup();
    fail(`Lazy chunk ${chunk.name} is not reachable through dynamic imports.`);
}

// Every gate passed: publish the staged files over the previous export.
for (const name of stagedFiles) {
    await rename(join(staging, name), join(outDir, name));
}
await cleanup();

console.log(`Exported @smelt-oss/consent-banners ${packageVersion} to ${outDir}`);
console.log(`  rules.js         ${record.rules.bytes} bytes  ${rulesSha}`);
console.log(`  model.smelt.json ${record.model.bytes} bytes  ${modelSha}`);
console.log(`  detect.mjs       ${record.detect.bytes} bytes  ${record.detect.sha256}`);
console.log(`  eager gzipped    ${measurement.eagerGzippedBytes} bytes ` +
    `(budget ${budgetBytes}, lazy ${measurement.lazy.length} chunks)`);
console.log(`  corpus           ${artifact.corpus.id} revision ${artifact.corpus.revision}`);
console.log('MODEL.md ships with the release corpus (T026); it is not part of this export.');
