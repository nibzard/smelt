# @smelt-oss/consent-banners

Consent-banner detection for the first Smelt task.

## Browser benchmark

Run the detector latency benchmark against frozen captures:

```sh
npm run bench --workspace @smelt-oss/consent-banners -- \
  --manifest path/to/bench.json \
  --set ci-50 \
  --out runs/bench.json
```

The command supports the named probe sets `ci-50`, `dev-1000`, and
`frozen-1000`. It opens each frozen DOM in Playwright Chromium, patches layout
from the feature file, and runs `detect(document)` in the page.

Each page gets one first-call measurement, three warm-ups, and 30 measured
repeated calls. The JSON report includes initialization, first-call, p50, and
p95 latency.

Manifest format:

```json
{
  "schemaVersion": 1,
  "probeSets": {
    "ci-50": [
      {
        "id": "example",
        "group": "example.com",
        "snapshot": "captures/example.snapshot.json",
        "features": "captures/example.features.json"
      }
    ]
  }
}
```
