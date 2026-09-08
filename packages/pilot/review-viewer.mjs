/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {snapshotToHtml} from '@smelt-oss/capture/replay';

function requireValue(condition, message) {
    if (!condition) throw new TypeError(message);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// The layout map shrinks each captured element to the fields the overlay
// needs, so a 2,600-element page stays around 100 KB of embedded JSON.
function layoutMap(features) {
    const map = {};
    for (const element of features.elements ?? []) {
        const rect = element.layout?.rect;
        if (rect === undefined) continue;
        map[element.id] = {
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height,
            z: element.layout.zIndex,
            d: element.layout.display,
            v: element.layout.visibility
        };
    }
    return map;
}

// A JSON string literal, safe inside a <script> element: every "<" becomes a
// JS escape, so no page value can close the script early.
function jsonLiteral(value) {
    return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');
}

// JSON data for a <script> element. Numbers and null need no quotes, but a
// hand-edited features file could hold strings, so escape "<" the same way.
function jsonData(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Derive the label jurisdiction prefill from the capture location.
 *
 * @arg egressLocation {string} The capture egress location, or nothing.
 * @return {string} One of the label schema jurisdictions
 */
export function egressJurisdiction(egressLocation) {
    if (typeof egressLocation !== 'string') return 'unknown';
    if (egressLocation.startsWith('eu-')) return 'eea';
    if (egressLocation.startsWith('us-')) return 'us';
    return 'unknown';
}

// The overlay positions every replayed element at its captured rectangle.
// Absolute offsets are relative to the nearest positioned ancestor, so each
// element is placed relative to its nearest boxed replayed ancestor. The
// offsets then compose to the captured viewport coordinates. The bar shifts
// only the outermost element, so the whole tree moves down once. A captured
// inline border on an ancestor would shift its padding box; the corpus holds
// no such pages, and the geometry test would catch one.
const OVERLAY = `
<style>
  html, body { margin: 0; }
  body { font: 14px/1.4 sans-serif; }
  [data-smelt-replay-id]:hover { outline: 2px dashed #d33; }
  .smelt-selected { outline: 2px solid #0a0 !important; background: rgba(0, 170, 0, .1); }
  .smelt-frame-catch { outline: 1px dashed #88f; }
  .smelt-frame-catch:hover { outline: 2px dashed #d33; background: rgba(0, 128, 255, .08); }
  .smelt-frame-label { position: absolute; top: 2px; left: 4px; font: 10px monospace;
      color: #036; background: #fff; padding: 0 4px; border: 1px solid #88f; }
  #smelt-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      background: #16161d; color: #eee; font: 12px/1.5 monospace; padding: 8px 12px;
      border-bottom: 1px solid #444; }
  #smelt-bar a { color: #8cf; }
  #smelt-bar button { font: 12px monospace; margin-left: 8px; padding: 2px 8px; }
  #smelt-bar select, #smelt-bar input { font: 12px monospace; margin-left: 4px; }
  #smelt-bar label { margin-left: 10px; }
  #smelt-hover { position: fixed; z-index: 2147483647; background: #000; color: #fff;
      font: 11px monospace; padding: 2px 6px; pointer-events: none; display: none; }
  #smelt-json { position: fixed; top: 100px; left: 12px; right: 12px;
      z-index: 2147483647; background: #101014; color: #8f8;
      font: 11px/1.4 monospace; padding: 8px; border: 1px solid #444;
      white-space: pre-wrap; max-height: 40%; overflow: auto; }
</style>
<div id="smelt-bar">
  <strong>__CAPTURE_ID__</strong> · group __GROUP__ · <a href="__URL__" target="_blank" rel="noreferrer">__URL_TEXT__</a><br>
  Click the banner root first, then any extra acceptable roots. Click a
  selected element again to remove it. If the banner sits inside an iframe,
  click the dashed blue iframe overlay and add a note.
  <label>kind <select id="smelt-kind">
    <option value="unknown">unknown</option>
    <option value="banner">banner</option>
    <option value="dialog">dialog</option>
    <option value="platform">platform</option>
    <option value="custom">custom</option>
  </select></label>
  <label>jurisdiction <select id="smelt-jurisdiction">
    <option value="eea">eea</option>
    <option value="us">us</option>
    <option value="unknown">unknown</option>
  </select></label>
  <label>confidence <select id="smelt-confidence">
    <option value="1">1</option>
    <option value="0.9">0.9</option>
    <option value="0.7">0.7</option>
    <option value="0.5">0.5</option>
  </select></label>
  <input id="smelt-notes" size="30" placeholder="review notes">
  <button id="smelt-copy" type="button">Copy label JSON</button>
  <span id="smelt-selection"></span>
</div>
<div id="smelt-hover"></div>
<pre id="smelt-json" hidden></pre>
<script>
  (function () {
      function start() {
          var captureId = __CAPTURE_JSON__;
          var group = __GROUP_JSON__;
          var layout = __LAYOUT_JSON__;
          var selected = [];
          var frameIds = {};
          var catchers = [];
          var bar = document.getElementById('smelt-bar');
          var hover = document.getElementById('smelt-hover');
          var jsonBox = document.getElementById('smelt-json');
          var button = document.getElementById('smelt-copy');
          var kind = document.getElementById('smelt-kind');
          var jurisdiction = document.getElementById('smelt-jurisdiction');
          var confidence = document.getElementById('smelt-confidence');
          var notes = document.getElementById('smelt-notes');
          var marked = document.querySelectorAll('[data-smelt-replay-id]');
          var barHeight = 0;

          // Prefill jurisdiction from the capture location or crawl recipe.
          jurisdiction.value = __JURISDICTION_JSON__;
          notes.value = __NOTES_JSON__;

          function boxOf(element) {
              if (!element || !element.getAttribute) return null;
              var id = element.getAttribute('data-smelt-replay-id');
              return id !== null && layout[id] !== undefined ? layout[id] : null;
          }

          function nearestBoxedAncestor(element) {
              var parent = element.parentElement;
              while (parent) {
                  var box = boxOf(parent);
                  if (box) return box;
                  parent = parent.parentElement;
              }
              return null;
          }

          function placeAt(box, element, parentBox) {
              element.style.position = 'absolute';
              element.style.left = (box.x - (parentBox ? parentBox.x : 0)) + 'px';
              element.style.top = (box.y - (parentBox ? parentBox.y : 0)
                  + (parentBox ? 0 : barHeight)) + 'px';
              element.style.width = box.w + 'px';
              element.style.height = box.h + 'px';
          }

          function positionAll() {
              barHeight = bar.offsetHeight;
              document.body.style.paddingTop = barHeight + 'px';
              marked.forEach(function (element) {
                  var id = element.getAttribute('data-smelt-replay-id');
                  var tag = element.tagName.toLowerCase();
                  if (tag === 'iframe' || tag === 'frame') {
                      // A frame host would load its recorded remote URL (the
                      // queue holds hundreds of tracker frames) and its child
                      // document would swallow clicks. Blank it; a catcher
                      // below takes the clicks.
                      frameIds[id] = true;
                      element.removeAttribute('src');
                      element.removeAttribute('srcdoc');
                      element.src = 'about:blank';
                      element.setAttribute('sandbox', '');
                      element.style.pointerEvents = 'none';
                  }
                  var box = layout[id];
                  if (!box) return;
                  placeAt(box, element, nearestBoxedAncestor(element));
                  // The bar, hover tip, and JSON box own the top two z
                  // values, so page content never covers the review chrome.
                  // Chromium clamps z-index at 2147483647 anyway, so a
                  // captured higher value is fiction either way.
                  if (box.z !== null && box.z !== undefined) {
                      element.style.zIndex = Math.min(box.z, 2147483645);
                  }
                  if (box.d === 'none') element.style.display = 'none';
                  if (box.v === 'hidden') element.style.visibility = 'hidden';
              });
              // One clickable catcher per visible frame host. The catcher
              // carries the frame's snapshot ID; the selection outline and
              // the copy JSON therefore treat it as that frame element. It
              // sits below the bar and the JSON box so their text stays
              // selectable.
              catchers.forEach(function (catcher) { catcher.remove(); });
              catchers = [];
              var bodyBox = boxOf(document.body);
              Object.keys(frameIds).forEach(function (id) {
                  var box = layout[id];
                  if (!box || box.d === 'none' || box.v === 'hidden') return;
                  if (!box.w || !box.h) return;
                  var catcher = document.createElement('div');
                  catcher.setAttribute('data-smelt-replay-id', id);
                  catcher.className = 'smelt-frame-catch';
                  // Re-layout rebuilds the catchers; keep a selection made
                  // before a resize visible on the new catcher.
                  if (selected.indexOf(id) !== -1) catcher.classList.add('smelt-selected');
                  placeAt(box, catcher, bodyBox);
                  catcher.style.zIndex = 2147483646;
                  var label = document.createElement('span');
                  label.className = 'smelt-frame-label';
                  label.textContent = 'iframe ' + id + ' (click to select)';
                  catcher.appendChild(label);
                  document.body.appendChild(catcher);
                  catchers.push(catcher);
              });
          }

          // Resolve the element a review click or hover refers to. Bar and
          // JSON chrome never select. The document roots never select
          // either: <body> carries a replay marker and wraps the whole page,
          // so clicks on blank areas or the controls would otherwise toggle
          // it into the selection and corrupt the copied label.
          function markedRoot(event) {
              var target = event.target;
              if (!target || !target.closest) return null;
              if (target.closest('#smelt-bar, #smelt-json')) return null;
              var element = target.closest('[data-smelt-replay-id]');
              if (!element) return null;
              var tag = element.tagName.toLowerCase();
              if (tag === 'html' || tag === 'body') return null;
              return element;
          }

          document.addEventListener('mousemove', function (event) {
              var target = markedRoot(event);
              if (!target) { hover.style.display = 'none'; return; }
              hover.style.display = 'block';
              hover.style.left = event.clientX + 12 + 'px';
              hover.style.top = event.clientY + 12 + 'px';
              hover.textContent = target.getAttribute('data-smelt-replay-id')
                  + ' <' + target.tagName.toLowerCase() + '>';
          });

          document.addEventListener('click', function (event) {
              var target = markedRoot(event);
              if (!target) return;
              event.preventDefault();
              var id = target.getAttribute('data-smelt-replay-id');
              var position = selected.indexOf(id);
              if (position === -1) { selected.push(id); target.classList.add('smelt-selected'); }
              else { selected.splice(position, 1); target.classList.remove('smelt-selected'); }
              document.getElementById('smelt-selection').textContent =
                  ' roots: [' + selected.join(', ') + ']';
          });

          function frameFor(bannerRoot) {
              // The frame record follows the banner root. An iframe clicked
              // as an extra root does not move the banner into a frame.
              if (bannerRoot !== null && frameIds[bannerRoot]) {
                  return {state: 'unknown', frame_id: null, element_id: bannerRoot};
              }
              return {state: 'top', frame_id: null, element_id: null};
          }

          function labelJson() {
              var hasBanner = selected.length > 0;
              return {
                  id: captureId,
                  group: group,
                  label_status: 'reviewed',
                  has_banner: hasBanner,
                  acceptable_roots: selected.slice(),
                  banner_root: hasBanner ? selected[0] : null,
                  banner_kind: hasBanner ? kind.value : 'unknown',
                  jurisdiction: jurisdiction.value,
                  frame: frameFor(hasBanner ? selected[0] : null),
                  evidence: hasBanner ? [{kind: 'geometry',
                      value: 'root selected by human review in the positioned viewer',
                      element_id: selected[0]}] : [],
                  confidence: Number(confidence.value),
                  review_notes: notes.value
              };
          }

          function legacyCopy(text) {
              var area = document.createElement('textarea');
              area.value = text;
              area.style.position = 'fixed';
              area.style.top = '0';
              document.body.appendChild(area);
              area.focus();
              area.select();
              var ok = false;
              try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
              area.remove();
              return ok;
          }

          button.addEventListener('click', function () {
              var text = JSON.stringify(labelJson(), null, 2);
              // Always show the JSON, so the reviewer can check it and copy it
              // by hand when the clipboard is unavailable.
              jsonBox.hidden = false;
              jsonBox.textContent = text;
              var report = function (ok) {
                  button.textContent = ok ? 'Copied ' + selected.length + ' root(s)'
                      : 'Clipboard blocked - copy the JSON below';
                  setTimeout(function () { button.textContent = 'Copy label JSON'; }, 2500);
              };
              if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(text).then(function () { report(true); },
                      function () { report(legacyCopy(text)); });
              } else {
                  report(legacyCopy(text));
              }
          });

          positionAll();
          // The bar grows when its text wraps or the viewport narrows, so
          // re-measure and re-place on bar and viewport size changes.
          if (window.ResizeObserver) new ResizeObserver(positionAll).observe(bar);
          window.addEventListener('resize', positionAll);
      }

      // Elements that the serializer placed after </body> are moved into
      // <body> while the parser finishes, after any inline script runs. Wait
      // for the full document, so frame blanking covers them too.
      if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', start);
      } else {
          start();
      }
  })();
</script>
`;

// Expand every placeholder in one pass. A later pass could otherwise
// substitute a token that an earlier value carried into the page.
function expandOverlay(values) {
    return OVERLAY.replace(/__[A-Z_]+__/g, token =>
        Object.prototype.hasOwnProperty.call(values, token) ? values[token] : token);
}

// The serialized page would fetch and apply everything the live page
// referenced: tracker iframes, images, stylesheets, preload links. The
// browser starts fetching as soon as the parser inserts the element, so
// waiting for DOMContentLoaded is too late. Strip every loading attribute
// before serialization: nothing remote ever reaches the page, and no
// remote stylesheet can reshape the replayed layout. Anchors keep their
// href because anchors fetch nothing and the click handler blocks their
// navigation.
const LOADER_ATTRIBUTES = ['src', 'srcset', 'poster', 'ping', 'background'];
const LINK_LOADER_TAGS = new Set(['link', 'base']);

function neutralizeRemoteLoads(snapshot) {
    const clone = structuredClone(snapshot);
    for (const element of clone.elements ?? []) {
        const attributes = element.attributes;
        if (!attributes) continue;
        for (const name of LOADER_ATTRIBUTES) delete attributes[name];
        if (element.tagName === 'iframe' || element.tagName === 'frame') {
            delete attributes.srcdoc;
        }
        if (LINK_LOADER_TAGS.has(element.tagName)) delete attributes.href;
        if (element.tagName === 'meta'
                && String(attributes['http-equiv'] ?? '').toLowerCase() === 'refresh') {
            delete attributes.content;
        }
        if (typeof attributes.style === 'string') {
            attributes.style = attributes.style.replace(/url\([^)]*\)/gi, 'none');
        }
    }
    return clone;
}

function viewerPage(item, snapshot, features, metadata, labelStub) {
    const html = snapshotToHtml(neutralizeRemoteLoads(snapshot));
    // The crawl recipe's jurisdiction wins; the egress location is the
    // fallback when the recipe recorded none or an unknown value.
    const recipeJurisdiction = metadata?.targetMetadata?.jurisdiction;
    const jurisdiction = ['eea', 'us', 'unknown'].includes(recipeJurisdiction)
        ? recipeJurisdiction : egressJurisdiction(metadata?.egressLocation);
    // The labels file owns the group and the notes context: the copied
    // record must not rewrite either when the queue disagrees.
    const group = labelStub?.group ?? item.group ?? '';
    const overlay = expandOverlay({
        __CAPTURE_ID__: escapeHtml(item.capture_id),
        __GROUP__: escapeHtml(group),
        __URL_TEXT__: escapeHtml(metadata?.url ?? ''),
        __URL__: escapeHtml(metadata?.url ?? '#'),
        __CAPTURE_JSON__: jsonLiteral(item.capture_id),
        __GROUP_JSON__: jsonLiteral(group),
        __JURISDICTION_JSON__: jsonLiteral(jurisdiction),
        __NOTES_JSON__: jsonLiteral(labelStub?.review_notes ?? ''),
        __LAYOUT_JSON__: jsonData(layoutMap(features))
    });
    const bodyEnd = html.lastIndexOf('</body>');
    requireValue(bodyEnd !== -1, `Snapshot has no body element: ${item.capture_id}`);
    return `${html.slice(0, bodyEnd)}${overlay}${html.slice(bodyEnd)}`;
}

function indexPage(items, stubs) {
    const statusOf = item => stubs.get(item.capture_id)?.label_status;
    // Progress counts and ordering apply only when label stubs were read;
    // without a labels directory the index stays a plain queue listing.
    const known = items.some(item => stubs.has(item.capture_id));
    const pending = items.filter(item => statusOf(item) !== 'reviewed');
    const reviewed = items.filter(item => statusOf(item) === 'reviewed');
    const row = item => `        <li><a href="${escapeHtml(item.capture_id)}.html">${escapeHtml(item.capture_id)}</a>`
        + ` · ${escapeHtml(item.group ?? '')} · ${escapeHtml(item.reason ?? '')}`
        + (statusOf(item)
            ? ` · <span class="${statusOf(item) === 'reviewed' ? 'done' : 'open'}">`
                + `${statusOf(item) === 'reviewed' ? 'reviewed' : 'unresolved'}</span>`
            : '')
        + '</li>';
    const rows = (known ? [...pending, ...reviewed] : items).map(row).join('\n');
    const intro = known
        ? `${items.length} captures, ${reviewed.length} reviewed, ${pending.length} remaining.`
        : `${items.length} captures.`;
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Smelt review queue</title>
    <style>
        body { font: 14px/1.6 sans-serif; max-width: 60em; margin: 2em auto; }
        li { margin: 2px 0; }
        .done { color: #080; }
        .open { color: #a60; }
    </style>
</head>
<body>
    <h1>Smelt review queue</h1>
    <p>${intro} Open a capture, click the banner root, and copy the label JSON
    into your records file; labels:apply writes it into the labels files.</p>
    <ol>
${rows}
    </ol>
</body>
</html>
`;
}

// Existing label stubs carry the human review context: notes the reviewer
// may have added, and the group the labels file records. One map across all
// three splits, because a page id is unique across the corpus.
async function readLabelStubs(labelsDir) {
    const stubs = new Map();
    for (const split of ['train', 'development', 'test']) {
        const file = path.join(labelsDir, `${split}.labels.json`);
        try {
            const dataset = JSON.parse(await readFile(file, 'utf8'));
            for (const page of dataset.pages ?? []) stubs.set(page.id, page);
        } catch {
            // A missing or unreadable split file just means no prefill.
        }
    }
    return stubs;
}

/**
 * Write one standalone HTML page per queued capture, plus an index.
 *
 * Each page renders the top-frame DOM of the capture and positions every
 * replayed element at its captured rectangle, composed through nested
 * ancestors. The reviewer clicks roots; the copy button produces a complete
 * reviewed label record that validates against ``validateConsentLabels``
 * after pasting over the page's stub in the split label file. The record
 * carries the clicked roots, banner kind, jurisdiction (prefilled from the
 * crawl recipe or the capture egress location), confidence, notes (prefilled
 * from the existing label stub), and the frame element when the banner root
 * is an iframe. Frame hosts are blanked and covered with clickable
 * overlays, so pages fetch nothing and frame roots stay selectable.
 *
 * @param {object} input {items, capturesDir, outDir, labelsDir}.
 * @returns {Promise<object>} Written file counts and paths.
 */
export async function buildReviewViewer(input) {
    const items = input?.items;
    const capturesDir = input?.capturesDir;
    const outDir = input?.outDir;
    requireValue(Array.isArray(items) && items.length > 0, 'Expected review queue items.');
    requireValue(typeof capturesDir === 'string' && capturesDir.length > 0,
        'Expected a captures directory.');
    requireValue(typeof outDir === 'string' && outDir.length > 0,
        'Expected an output directory.');
    const labelStubs = typeof input.labelsDir === 'string' && input.labelsDir.length > 0
        ? await readLabelStubs(input.labelsDir) : new Map();
    const seen = new Set();
    await mkdir(outDir, {recursive: true});
    let pages = 0;
    for (const item of items) {
        requireValue(typeof item?.capture_id === 'string' && item.capture_id.length > 0,
            'Every queue item needs a capture_id.');
        requireValue(!seen.has(item.capture_id), `Duplicate queue capture: ${item.capture_id}`);
        seen.add(item.capture_id);
        const base = path.join(capturesDir, item.capture_id);
        const [snapshot, features, metadata] = await Promise.all([
            readJson(`${base}.snapshot.json`),
            readJson(`${base}.features.json`),
            readFile(`${base}.metadata.json`, 'utf8')
                .then(text => JSON.parse(text))
                .catch(() => null)
        ]);
        await writeFile(path.join(outDir, `${item.capture_id}.html`),
            viewerPage(item, snapshot, features, metadata, labelStubs.get(item.capture_id)));
        pages++;
    }
    const indexPath = path.join(outDir, 'index.html');
    await writeFile(indexPath, indexPage(items, labelStubs));
    return {pages, indexPath};
}

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}
