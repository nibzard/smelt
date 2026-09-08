# @smelt-oss/capture

Frozen DOM snapshot capture for Smelt corpora.

## Steel capture

Run the Steel adapter with a JSON config:

```sh
npm run steel:capture --workspace @smelt-oss/capture -- path/to/steel-capture.json
```

Example config:

```json
{
  "outDir": "corpus/captures",
  "browser": {
    "name": "chromium",
    "wsEndpoint": "wss://example.steel.dev/browser"
  },
  "viewport": {
    "width": 1280,
    "height": 720,
    "deviceScaleFactor": 1
  },
  "egressLocation": "eu-west",
  "storageState": null,
  "observationMs": 1500,
  "navigationTimeoutMs": 30000,
  "pages": [
    {
      "id": "example-home",
      "url": "https://example.com/",
      "group": "example.com"
    }
  ]
}
```

Set `STEEL_BROWSER_WS_ENDPOINT` instead of `browser.wsEndpoint` when you do
not want the endpoint in the config file. The adapter accepts `chromium` and
`firefox`. It writes three files per page:

- `<id>.snapshot.json`
- `<id>.features.json`
- `<id>.metadata.json`

Keep generated captures in `corpus/`. Do not commit Steel credentials,
customer-session content, or raw crawl output.

## Steel session crawl

Run a whole crawl without handling sessions by hand. The crawler reads
`STEEL_API_KEY`. It creates a cloud session per page chunk and captures
each page in an isolated browser context. It then releases the session and
writes a cost report:

```sh
node packages/capture/session-cli.mjs path/to/crawl.json
```

Run the command from the repository root. Relative paths in the config
resolve against the directory you invoke it from.

The config replaces `browser.wsEndpoint` with a `session` block:

```json
{
  "outDir": "corpus/captures",
  "egressLocation": "eu-de-residential",
  "session": {"proxyCountry": "DE", "chunkSize": 20},
  "pages": [{"id": "example-home-eu", "url": "https://example.com/", "group": "example.com"}]
}
```

- `region` places the browser in `iad` or `lax`. It does not change the
  egress IP that pages see.
- `proxyCountry` routes the session through a Steel residential proxy in
  that country. The proxy is billed per GB. This is how you capture from an
  EU location.
- `respectRobots` is on by default. The crawler honors the `robots.txt`
  group that names `SmeltCorpusBot`, or the `*` group. Blocked paths are
  skipped and recorded.
- One failed page does not stop the crawl. Page failures land in the
  report.
- A failed session chunk is recorded under `chunkErrors`. The crawler still
  releases that session and exits with code 1.
- Each page gets a fresh browser context, so third-party consent cookies
  cannot leak between captures.

The report lands in `corpus/sessions/` with per-session page counts,
credits, proxy bytes, and browser duration. Session WebSocket URLs carry
credentials. Never write them into a config file or commit them.

## Local capture

Run the same capture pipeline without Steel credentials. The local crawler
launches a Playwright browser on your machine:

```sh
npm run local:capture --workspace @smelt-oss/capture -- path/to/local-capture.json
```

The config matches the Steel format, with two differences:

- `browser` has a `name` only. A `wsEndpoint` is rejected.
- A page can use `file` with a path relative to the config file, for local
  fixture pages. The `url` field accepts HTTP, HTTPS, and `file:` URLs.
- `storageState` accepts an object or a path to a saved state file, relative
  to the config file.

The crawler writes the same three files per page, with `"backend": "local"`.

To crawl the bundled fixtures without credentials, install Playwright and its
Chromium build, then run the fixture crawl:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run local:fixture-crawl --workspace @smelt-oss/capture
```

The crawl needs no network access to public pages. Output lands in
`packages/capture/corpus/fixtures/`, which Git ignores.

## Frozen replay

Use `@smelt-oss/capture/replay` to run Node rules against a stripped snapshot
with captured layout values:

```js
import {runFrozenSnapshot} from '@smelt-oss/capture/replay'

const {run, elementsById} = runFrozenSnapshot(rules, snapshot, features)
```

The replay shim patches `getBoundingClientRect()`, `getComputedStyle()`,
`innerWidth`, `innerHeight`, and `devicePixelRatio` with values from the
feature file. `compareFrozenReplay()` compares browser and Node vectors for
CI fixtures.
