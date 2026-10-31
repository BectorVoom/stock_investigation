# Materials database/widget review — 2026-10-29

Reviewer: independent Claude Code CLI, read-only. Reviewed the import contracts, SQLite/D1 migration and repository, shared widget read model/catalog, runner filtering, TypeScript/Rust identifiers and Material details UI. Two review rounds plus a focused final Unicode check were completed.

Resolved findings: catalog title bounds; Unicode-safe description truncation (using existing `truncateText`, with astral-character regression); per-owner capacity without silent truncation; canonical observation ordering for replays; atomic conflicts; separate exact source values/update timestamps in widget details; grade/basis disclosure; future-date checks; missing-series source handling; small normalized metadata reads; explicit UNION columns; immutable row identity; JSON size-limit responses. Reviewer confirmed owner isolation, atomic conflicts, refresh exclusion and current-series read bounds. SQLite/D1's short GLOB-pattern limit required removing the long timestamp GLOB from the unshipped migration 0015 as well as 0016; a fixed-length canonical `strftime` round-trip check supplies the format check without that runtime failure. The final focused review confirmed its Unicode blocker was resolved.

Supported scope and deliberate remaining work are in [materials library guide](../libraries/materials.md): owner imports and manual widget selection work; automatic source ingestion, full revision-ledger semantics and imported-catalog discovery by the Notebook assistant remain deferred.

Validation on main:

- Full TypeScript suite: 6,595 passed, 14 opt-in tests skipped. A first-run JSON-parsing architecture violation was fixed using the existing `bodyOf`/`parseJsonColumn` helpers; its 12 tests pass. The final material API suite also passes all 16 cases across Node SQLite and Workers D1, including audit metadata.
- Type checking, Biome, generated-vector drift check, Rust formatting/Clippy, Rust workspace tests and production build pass. A stale runner prompt-byte-count golden was regenerated with `UPDATE_VECTORS=1`; its Rust test and all 34 TypeScript outgoing-payload contract tests pass.
- `bun run formal:check` passes; the imported namespace has a Lean 4 model/proofs and exported conformance vectors. Benchmarks passed before and after within their budgets.
- Chrome and WebKit: `REVIEW_BROWSER=<engine> bun run review:ui -- materialsReview.spec.ts` passes, including exact source detail disclosure and lazy rendering. Screenshots inspected; detail-table spacing was improved after inspection.
- Actual development environment: `bunx playwright test --config tests/real/playwright.config.ts materialsReal.spec.ts` passes with the real `bun run dev`, pristine working-tree copy, throwaway SQLite/ports and launcher restart. Model: none. Data: explicitly synthetic owner import. This verifies the supported import/read/render path, not an external metals feed or an agent research turn.
- Firefox could not start (“Could not find profile folder”), including a `TMPDIR=/tmp` retry; Playwright reports no missing browser download. Firefox behavior remains unverified. No operational owner database or data directory was used.

## Playwright rerun — 2026-10-30

At the owner's request, reran `E2E_BROWSER=chrome bunx playwright test --config tests/e2e/playwright.config.ts materials.spec.ts` (1 passed, 13.3 s), the same spec with `E2E_BROWSER=webkit` (1 passed, 18.7 s), and `bunx playwright test --config tests/real/playwright.config.ts materialsReal.spec.ts` (1 passed, 1.1 min). Confirmed chart/indicator values, exact source details/update timestamps, catalog selection, reload and persistence after the actual development launcher restart. Inspected the refreshed Chrome detail screenshot. The real-environment run used synthetic owner-import data, no model and no external metals feed, in isolated test directories. Firefox was not rerun; its previously recorded browser-launch limitation remains.

## Running-development schema repair — 2026-10-30

The owner's running development API returned HTTP 500 for `/home/data`. Read-only schema inspection found that 0016 was already recorded as applied but `metal_series` still had its early four-column layout and `metal_observation` did not exist. Fresh-install tests had not covered that previously applied draft schema.

Added additive migration `0017_material_series_upgrade.sql`, preserving snapshot JSON, commit timestamps and existing observation rows while rebuilding the normalized projections. It supports both early and current 0016 layouts; applied migration history is unchanged. Applied 0017 to the affected local development DB to restore the app. Home data and catalog now return HTTP 200.

Regression validation: two SQLite upgrade cases pass (early/current schemas, existing data, repeated application, exact values/source timestamps and foreign-key integrity); 16 API tests pass across Node SQLite and Workers D1; the isolated materials Playwright spec passes. Additionally, a read-only Playwright Chrome check against the actual running `http://localhost:3000/#/home` with Japanese locale confirmed HTTP 200 and absence of the reported market-data error, saving `test-results/materials-live-repair.png`. Model: none; no provider or model request was needed. Test fixtures stayed in isolated databases; the live-page check only read the owner's data.

Claude Code reviewed the 0017 repair read-only and reported no serious defects. Its suggested regression coverage was added: preserved commit time, owner isolation, all four immutability triggers, and an existing child observation absent from the JSON snapshot (proving that restoration preserves child rows rather than only re-deriving them).
