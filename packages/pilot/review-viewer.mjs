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

const OVERLAY = `
<style>
  html, body { margin: 0; }
  body { position: relative; width: __VIEWPORT_WIDTH__px; height: __VIEWPORT_HEIGHT__px;
      font: 14px/1.4 sans-serif; }
  [data-smelt-replay-id]:hover { outline: 2px dashed #d33; }
  .smelt-selected { outline: 2px solid #0a0 !important; background: rgba(0, 170, 0, .1); }
  #smelt-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      background: #16161d; color: #eee; font: 12px/1.5 monospace; padding: 8px 12px;
      border-bottom: 1px solid #444; }
  #smelt-bar a { color: #8cf; }
  #smelt-bar button { font: 12px monospace; margin-left: 8px; padding: 2px 8px; }
  #smelt-hover { position: fixed; z-index: 2147483647; background: #000; color: #fff;
      font: 11px monospace; padding: 2px 6px; pointer-events: none; display: none; }
</style>
<div id="smelt-bar">
  <strong>__CAPTURE_ID__</strong> · group __GROUP__ · <a href="__URL__">__URL_TEXT__</a><br>
  Click the banner root. Click extra acceptable roots to add them. Click a
  selected element again to remove it. If the banner sits inside an iframe,
  click the iframe and note it in the review notes.
  <button id="smelt-copy" type="button">Copy label JSON</button>
  <span id="smelt-selection"></span>
</div>
<div id="smelt-hover"></div>
<script>
  (function () {
      var layout = __LAYOUT_JSON__;
      var selected = [];
      var bar = document.getElementById('smelt-bar');
      var barHeight = bar.offsetHeight;
      document.body.style.paddingTop = barHeight + 'px';
      var marked = document.querySelectorAll('[data-smelt-replay-id]');
      marked.forEach(function (element) {
          var box = layout[element.getAttribute('data-smelt-replay-id')];
          if (!box) return;
          element.style.position = 'absolute';
          element.style.left = box.x + 'px';
          element.style.top = (box.y + barHeight) + 'px';
          element.style.width = box.w + 'px';
          element.style.height = box.h + 'px';
          if (box.z !== null && box.z !== undefined) element.style.zIndex = box.z;
          if (box.d === 'none') element.style.display = 'none';
          if (box.v === 'hidden') element.style.visibility = 'hidden';
      });
      var hover = document.getElementById('smelt-hover');
      document.addEventListener('mousemove', function (event) {
          var target = event.target.closest
              ? event.target.closest('[data-smelt-replay-id]') : null;
          if (!target) { hover.style.display = 'none'; return; }
          hover.style.display = 'block';
          hover.style.left = event.clientX + 12 + 'px';
          hover.style.top = event.clientY + 12 + 'px';
          hover.textContent = target.getAttribute('data-smelt-replay-id')
              + ' <' + target.tagName.toLowerCase() + '>';
      });
      document.addEventListener('click', function (event) {
          var target = event.target.closest
              ? event.target.closest('[data-smelt-replay-id]') : null;
          if (!target) return;
          event.preventDefault();
          var id = target.getAttribute('data-smelt-replay-id');
          var position = selected.indexOf(id);
          if (position === -1) { selected.push(id); target.classList.add('smelt-selected'); }
          else { selected.splice(position, 1); target.classList.remove('smelt-selected'); }
          document.getElementById('smelt-selection').textContent =
              ' roots: [' + selected.join(', ') + ']';
      });
      document.getElementById('smelt-copy').addEventListener('click', function () {
          var label = {
              has_banner: selected.length > 0,
              acceptable_roots: selected.slice(),
              banner_root: selected[0] !== undefined ? selected[0] : null,
              label_status: 'reviewed',
              review_notes: ''
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(JSON.stringify(label, null, 2));
          }
          this.textContent = 'Copied ' + selected.length + ' root(s)';
          var button = this;
          setTimeout(function () { button.textContent = 'Copy label JSON'; }, 1500);
      });
  })();
</script>
`;

async function readJson(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}

function viewerPage(item, snapshot, features, metadata) {
    const html = snapshotToHtml(snapshot);
    const overlay = OVERLAY
        .replaceAll('__VIEWPORT_WIDTH__', Number(features.viewport?.width ?? 1200))
        .replaceAll('__VIEWPORT_HEIGHT__', Number(features.viewport?.height ?? 900))
        .replaceAll('__CAPTURE_ID__', escapeHtml(item.capture_id))
        .replaceAll('__GROUP__', escapeHtml(item.group ?? ''))
        .replaceAll('__URL_TEXT__', escapeHtml(metadata?.url ?? ''))
        .replaceAll('__URL__', escapeHtml(metadata?.url ?? '#'))
        .replaceAll('__LAYOUT_JSON__', JSON.stringify(layoutMap(features)));
    const bodyEnd = html.lastIndexOf('</body>');
    requireValue(bodyEnd !== -1, `Snapshot has no body element: ${item.capture_id}`);
    return `${html.slice(0, bodyEnd)}${overlay}${html.slice(bodyEnd)}`;
}

function indexPage(items, outDir) {
    const rows = items.map(item => `        <li><a href="${escapeHtml(item.capture_id)}.html">${escapeHtml(item.capture_id)}</a>`
        + ` · ${escapeHtml(item.group ?? '')} · ${escapeHtml(item.reason ?? '')}</li>`).join('\n');
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Smelt review queue</title>
    <style>
        body { font: 14px/1.6 sans-serif; max-width: 60em; margin: 2em auto; }
        li { margin: 2px 0; }
    </style>
</head>
<body>
    <h1>Smelt review queue</h1>
    <p>${items.length} captures. Open a capture, click the banner root, and copy
    the label JSON into the labels file.</p>
    <ol>
${rows}
    </ol>
</body>
</html>
`;
}

/**
 * Write one standalone HTML page per queued capture, plus an index.
 *
 * Each page renders the top-frame DOM of the capture, positions every
 * replayed element at its captured rectangle, and lets the reviewer click
 * elements to collect acceptable-root IDs. The copy button produces a label
 * stub in the labels-file shape.
 *
 * @param {object} input {items, capturesDir, outDir}.
 * @returns {Promise<object>} Written file counts and paths.
 */
export async function buildReviewViewer(input) {
    const items = input?.items;
    const capturesDir = input?.capturesDir;
    const outDir = input?.outDir;
    requireValue(Array.isArray(items) && items.length > 0, 'Expected review queue items.');
    requireValue(typeof capturesDir === 'string' && capturesDir.length > 0,
        'Expected a captures directory.');
    requireValue(typeof outDir === 'string' && outDir.length > 0, 'Expected an output directory.');
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
            viewerPage(item, snapshot, features, metadata));
        pages++;
    }
    const indexPath = path.join(outDir, 'index.html');
    await writeFile(indexPath, indexPage(items, outDir));
    return {pages, indexPath};
}
