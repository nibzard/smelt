# @smelt-oss/cli

The `smelt` command surface: a thin Node launcher (IDEA.md 3.5.2). It
provisions a uv-managed Python factory environment on first use, then
dispatches each command to the workspace tool that implements it.

## Commands

```text
smelt crawl <config> [--steel]   Capture pages; --steel routes to Steel cloud.
smelt train <manifest> <out>     Run the consent trainer.
smelt loop <manifest> <log>      Run the bounded rules agent loop.
smelt test                       Run the size and export gates.
smelt bench <args>               Run the browser latency benchmark.
smelt export <args>              Build the npm dist.
smelt --version                  Print the CLI version.
```

Pass `--no-python` to skip provisioning and use the system Python.

## The Python factory

The LightGBM trainer needs Python packages. On first use, the launcher runs
`uv sync --locked` against `pyproject.toml` and the committed `uv.lock` in
this package, which pins `lightgbm==4.7.0` and `numpy==2.2.6`. The command
then runs with the virtual environment's executables first on `PATH`, so the
trainer's `python3` call resolves to the pinned interpreter. A warm no-op
sync takes about 40 ms; a first run on this repository's machine took about
113 seconds, dominated by the managed CPython download.

Without uv, the launcher degrades to the system Python with a warning that
names the exact pins, and continues.

## smelt test

The gates run in the fixed order from IDEA.md 2.6: size, latency, F1. Today
`smelt test` enforces the size budget and the export gates (smoke detection,
integrity, and size). The frozen-set latency and F1 gates report as pending
until the release corpus exists.
