# Tests

This folder contains test-only tooling for performance/resource analysis.

## Stack

- `playwright` (Chromium automation for browser-based UI workload)
- shell sampling (`ps`, `pgrep`) for CPU/RSS/thread telemetry on macOS

## Prerequisites

1. Install test dependencies:
   - `bun --cwd tests install`
2. Install Chromium for Playwright:
   - `bunx playwright install chromium`

## Run

From repo root:

- Full suite (UI workload + process sampling):
  - `bun run test:perf`
- UI workload only:
  - `bun run test:perf:ui`

Artifacts are written under `tests/perf/outputs/<run-id>/`.

## Notes

- v1 targets macOS process sampling.
- The workload harness is external and lives entirely under `tests/`.
- App code in `src/` is not modified for tests.
