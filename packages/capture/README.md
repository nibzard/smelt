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
