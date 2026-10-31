# Widget database refactor — review and validation

2026-10-31. Independent reviewer: the installed Claude Code CLI, invoked read-only with `--permission-mode plan --allowedTools Read Glob Grep`. The initial review audited browser, API, runner and Home MCP paths. Its report is outside the repository at `~/.claude/plans/review-architecture-read-only-user-precious-music.md`. A second review covers the implementation.

## Initial review dispositions

| Finding | Disposition |
|---|---|
| Notebook optimistic content | Fixed: pending content is private write state; displayed widgets come only from server database readback. |
| Drag preview | Presentation state over persisted widget bodies; no new data is displayed. |
| Line-chart range selector | Fixed: Shoelace's internal selection returns to the stored range until readback. |
| Starter templates | Templates are persisted and read back before display; existing owner-edit behavior remains. |
| Default Home constant | Fixed: initialize once in SQL, read back, preserve version-zero first-save semantics. |
| Market metadata fallback | Fixed: no catalog substitution for stored titles; missing metadata has no fabricated source link; orphan observations fail closed. Ingestion may store provider configuration as attribution, which is subsequently read from storage. |
| Earnings attribution constants | Fixed: additive migration stores provider attribution; widget and ICS reads use database rows. |
| Clipboard snapshots | Write proposals only; paste is saved and read back before display. No direct localStorage rendering. |
| Inline values | Legitimate persisted widget documents; normalization into separate dataset tables is not needed for the database-read invariant. |
| Task/result caches | Previously read database snapshots; no provider bypass. Existing Notebook market-poll failure presentation could be clearer; this is a separate freshness issue. |
| Home Undo memory | Write proposal only; restored content is saved and read back before display. |
| Agent-invented values | Evidence correctness is distinct from database routing. Existing server-side `chartSourceProblem` checks remain on Home and Notebook writes; this refactor adds no provenance bypass. |

The implementation also fixes task-creation and workspace-command responses that returned an in-memory object after committing instead of reading it back.

## Execution record

- `bun run formal:check`: passed; Lean proofs and conformance vectors current. No domain algorithm changed.
- `bun run bench`: passed all budgets; market response assembly including validation measured 6.104 ms against 15 ms.
- Targeted web, application, API SQLite and Workers/D1 tests: passed during implementation; final verification recorded below.
- `bun run test:real widgetDatabaseReal.spec.ts`, Chrome: passed fresh development owner-edit/readback/restart check, then passed the populated schema-17 → 18 upgrade variant. Uses isolated directories and ports, actual `bun run dev`, actual SQLite and runner. Owner-created template data; no model or external provider required for this path. The upgrade checks the saved Notebook and the new earnings attribution API and Home widget.
- An initial full Chrome UI review began before migration 0018 was introduced. Six specs passed; the two Watchlist specs failed after API hot reload against its pre-migration database. The supported restart/migration path is covered by the real upgrade check; the affected UI reviews are rerun from a fresh migrated test database.

No owner's operational database was migrated or seeded. This work does not claim a live-model research run or new live-provider coverage; neither is needed to test these owner-write/readback changes.

## Follow-up review

Claude Code's second pass found a stale Notebook reload race, the failed-conflict-read queue path, Google Calendar's remaining attribution constant, and untyped missing-source errors. Fixed all four: shared read tickets fence old loads (with a version check), failed conflict reads explicitly refuse every waiting change rather than sending an incomplete stale body, Google sync uses the same persisted reference rows, and Watchlist/ICS return an actionable typed failure. Regression tests cover save/Undo versus a held reload, queued failure, stored Google attribution and missing rows.

`bun run verify` passed on main (6,615 tests; 14 opt-in tests skipped), including vectors, Rust checks/tests and all builds. After the review fixes, the affected web/application/API/migration tests were rerun (52 passed), as were checks, typechecking and the builds. Fresh and populated-upgrade real development checks both passed (Chrome; 2 tests, 1.7 minutes).

Targeted Chat, Home, Watchlist and Watchlist-list/widget UI reviews passed on Chrome and WebKit (five tests per engine). Firefox could not launch: the installed Playwright Firefox reports “Could not find profile folder,” including with a dedicated short `/tmp` profile. Firefox rendering remains unverified. Screenshots confirm database-backed Home and earnings content. Existing advisory findings include small targets, disclosure/modal occlusion and heading skips. A 2 px WebKit Settings overflow found during this review was traced to the credential fields' minimum flex widths; the fields now use a shrinkable flex basis and the Settings tests pass. The Watchlist/Settings WebKit review was rerun to check it.

One E2E start attempt collided with the UI review's shared isolated D1 directory, producing a migration-ledger uniqueness error before tests ran. These suites must run sequentially; the E2E run is retried after the review exits.

Final Claude Code read-only pass: no remaining concrete defects in the four fixes; the reviewer confirmed the new regression coverage and did not execute tests itself. The WebKit Settings rerun passed (one test, 46 seconds), with the horizontal-overflow finding eliminated (eight remaining advisory findings). The real development screenshots show the saved Notebook after restart and the earnings widget after upgrade.

Final Chrome E2E: Home's 21 tests passed. Notebook initially exposed two assertions that expected an immediate optimistic DOM reorder; both now wait for the confirmed order before testing persistence. The complete Notebook rerun passed (13 tests, 39.5 seconds), including assistant edits, Undo, cross-reload drag order and a 200-widget notebook. These deterministic E2E flows use `scripted/alpha`; they are separate from the actual-development owner-edit checks. Final Biome, typechecking and whitespace checks pass. No review finding remains unresolved in the implementation; the Firefox launch limitation and advisory UI findings above remain explicitly recorded.
