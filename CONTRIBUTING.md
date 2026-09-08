# Contributing

## Local setup

1. Install Node.js 24. If you use nvm, run `nvm use` in this directory.
2. Run `npm ci` from the repository root.
3. Run `npm run verify` before submitting changes.
4. Run `npm run pilot:demo` to inspect the evaluation output.

Use `npm test` for all workspace tests. Use
`npm test --workspace @smelt-oss/runtime` or
`npm test --workspace @smelt-oss/pilot` for a specific package.

## Capture pages locally

The local crawler reproduces the Steel capture format without credentials:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run local:fixture-crawl --workspace @smelt-oss/capture
```

The crawler writes the same snapshot, feature, and metadata files as the Steel
adapter. See [the capture README](packages/capture/README.md). Playwright is
optional; `npm ci` and `npm run verify` do not need it.

## Boundaries

The runtime is plain JavaScript with no runtime dependencies. Read
[its contract](packages/runtime/CONTRACTS.md) before changing the engine.
The current engine has little space below its 2,000-line limit; remove unnecessary
code when adding behavior. Do not bypass the size or line-count checks.

The consent package is a placeholder. Do not describe its example API as a
working trained detector. The pilot evaluator only scores supplied predictions.

Keep captures in `corpus/` and experiment outputs in `runs/`. Both directories
are ignored by Git. Commit only synthetic fixtures or approved public artifacts.
Never commit credentials or customer-session content. Use development data for
iteration; keep unseen release labels outside agent inputs.

Accepted decision records are immutable. Record a correction in a new file in
`decisions/`. Follow the root project instructions for writing and commit messages.

## Adoption signals

Smelt sends no telemetry, ever. The only adoption signals are opt-in:

- Issues whose title starts with `[quickstart]`, opened from the link that
  `smelt quickstart` prints. Triage them like any other issue; they need no
  answer beyond thanks.
- Entries in [ADOPTERS.md](ADOPTERS.md), added by pull request.

Never add a network call to measure usage. Counts from these signals are
lower bounds and must be labeled as such wherever they appear.
