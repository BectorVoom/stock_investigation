# Equities implementation: review and validation

> **Historical (2026-10-31):** this reviews the ADR-0041 import library, which ADR-0048 replaced with automatic SEC/EDINET sync; its code, tests and the `Equities.lean` model were removed. Current behaviour: [EQUITIES_DATABASE.md](../libraries/equities.md).

Date: 2026-10-29. Branch under test: `main`, with the working changes. Scope: the implemented normalized owner-import library, naming conventions, SQL/API/application integration and Equities page. [Usage and supported scope](../libraries/equities.md) · [Design baseline](../libraries/equities-design.md) · [ADR-0041](../../adr/0041-equities-library-and-naming.md).

## Claude Code reviews

The owner requested Claude Code as reviewer. Two independent read-only Claude Code CLI reviews ran with version 2.1.312 and its configured default model; the exact model ID was not captured. Only `Read` and `Glob` were enabled, with MCP disabled. The reviewer could not edit files or execute commands. It read the listed implementation files and reported no critical/blocking defects. The second review confirmed closure of the principal first-review findings and identified the commit-clock improvement described below. Neither review ran tests or approved the later author changes automatically; the author applied the fixes and validated them separately.

Invocation pattern:

```sh
claude -p --tools 'Read,Glob' --allowedTools 'Read,Glob' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --no-session-persistence --output-format text
```

## Finding dispositions

| Finding | Final disposition |
| --- | --- |
| Body/normalized size limits and SQL payload volume | Import-specific streaming middleware limits raw input to 750,000 bytes before parsing; the normalized payload has the same limit. Projection inserts bind only their own record kind, not the entire payload repeatedly. Remote production D1 capacity is not claimed. |
| Ambiguous identifiers/listings/venues | Per-file checks and transactional SQL guards reject assignments to different issuers and overlapping venue/symbol episodes. Venue/country validation uses the reviewed ISO registry. Unknown interval bounds are open; dates are inclusive. |
| Retrieval time versus visibility model | Future retrieval times are rejected against one captured receipt time. The final SQL stamp is at least that receipt time and parent stamps; SQL/domain tests cover public/system cutoffs. |
| Import history ordering | Ordered by commit stamp descending then ID, with a validated composite cursor and matching index. |
| Amendments / no implicit latest selection | All eligible observations remain separate and the UI labels original/amended filings. No derived aggregation or conflict resolution is claimed. |
| Error codes | Key reuse uses `IDEMPOTENCY_KEY_REUSED`; stored identity races use 409 `CONFLICT`; internally invalid files use 422 `INTEGRITY_VIOLATION`. This distinction is documented. |
| Dimension identity / exactness | Dimension keys are sorted and values are bounded strings, including textual typed members. Key reordering replays identically; financial amounts are never doubles. |
| Missing read paths | Owner-authenticated `GET /equities/records` reads every catalog kind, including FX and source/metric/document records. |
| UI races / state | Separate failure scopes, applied search/filter state, guarded generations and per-action pending state. New pages use the pinned ingestion version; a refresh does not silently apply unsubmitted filters. |
| Database-level test gaps | Added concurrent retry, SQL identity-guard, FK rollback, ambiguous identity/listing, history, future time, size, large import and pinned-version tests on both SQLite and Workers D1. A pre-0014 SQLite upgrade test preserves existing rows and then imports the catalog. |
| Application clock before actual commit | Resolved after the follow-up review: owner commit sequences are allocated inside the transaction; final timestamps are stamped near the end of the batch using database time, receipt time and prior stamp + 1 ms as lower bounds. `ingestionVersion` pins exact repeatable snapshots independently of physical-clock sampling. The clock stamp is not claimed to be a nanosecond-accurate commit instant. |
| Metric/document natural identity | Metric code/version has one definition ID, checked in the transaction and by a unique constraint. Source documents are deliberately immutable captured observations: a source/external ID can have distinct captures and retrieval metadata. No implicit latest-document selection is claimed. |
| Additional cross-record assertions | OHLC, listing currency and listing date bounds are checked. Facts inherit currency from their statement, so there is no contradictory independent fact currency. Comparative and forecast periods can differ from a filing's headline reporting period; equality is deliberately not imposed. Source interpretation remains owner-supplied until a reviewed provider parser exists. |
| Narrow venue registry | Documented 15-code initial registry, not full venue/OTC/PTS coverage; future changes must retain historical codes for stored-record decoding. |
| Ignored search parameters | Only company search accepts `q`; other lists use cursor-only schemas and reject it. ASCII case folding and exact Japanese substring behavior are documented; general Unicode transliteration is not claimed. |
| Clipboard usability | A compact, source-referenced prefix fits within 1,800 UTF-8 bytes for Chat, using the existing Lean-verified budget selector. Exact numbers are retained and omissions/version/cutoffs are explicit. |
| Phone visual review | Replaced digit-breaking financial cells with intact values in a focusable horizontal table; date filters stack on narrow screens. |

## Validation outcomes

| Command / check | Outcome and limits |
| --- | --- |
| `bun run verify` | Passed: formatting/lint, strict typechecks, **6,573 tests passed; 14 opt-in tests skipped**, vector drift, Rust formatting/Clippy/tests and application/runner/Worker builds. This was followed by the focused checks below for the final layout/sample-fixture changes. |
| Focused equities contract/formal/UI/API suites | **40 passed** across Node, web, SQLite and Workers D1. A broader focused run including architecture/page/i18n checks had **46 passed**. |
| `bunx vitest run --project node packages/adapters/test/sqlite/equitiesUpgrade.test.ts` | **1 passed**: pre-equities migration upgrade, preserved existing audit rows, repeated migration safety and actual repository import/read. This is a SQLite integration test, not a real-network claim. |
| `bun run formal:check` | Passed. 500 timestamp + 441 decimal-order + 16 version vectors; no unproved obligations. Existing unused-variable/simp warnings in unrelated Lean models remain warnings. |
| `bun run bench` before and after | All **49** existing performance budgets passed both times. A separate 1,000-fact import plus 200-row read case took roughly 105–165 ms across the two local adapters in a focused run; this is a host measurement, not a remote D1 quota guarantee. |
| `bunx playwright test --config tests/e2e/playwright.config.ts equities.spec.ts` | Chrome passed: actual file import, exact value, source provenance, date filters, both markets, download and viewport overflow checks. |
| `E2E_BROWSER=webkit bunx playwright test --config tests/e2e/playwright.config.ts equities.spec.ts` | Passed the same flow. |
| `REVIEW_BROWSER=chrome bun run review:ui equitiesReview.spec.ts` and WebKit equivalent | Passed. Four states × four viewport sizes per engine, screenshots under `test-results/ui-review/<engine>/equities/`; no page-overflow/page-error findings. The phone layout was corrected after inspecting the earlier screenshots. |
| Firefox E2E and UI review | **Unverified / environment failure before page load.** The installed Firefox and a newly downloaded clean Firefox 157 / Playwright build 1555 both exited with `Could not find profile folder`, using both the normal temporary directory and `/private/tmp`. The explicit Firefox UI review also failed at browser launch. No Firefox application behavior is claimed. No global browser installation or user profile was changed. |
| `RUN_LIVE_AGENT=claude-code bun run test:real:live` | Actual development launcher, runner and real Claude Code backend: **6 passed, 6 unrelated opt-in tests skipped**. Included the real public feed/page/search paths, fresh settings, upgraded settings and the Equities import/read/filter flow. Configured default model; exact model ID not captured. |
| Final fresh/upgraded live rerun (command below) | **2 passed (2.1 min)** on the final versioned database/API implementation, with Equities import, exact source inspection and filters in both starting states. Financial input is explicitly synthetic normalized owner data, not a mock backend or a claim of SEC/EDINET ingestion. The real research backend/network is exercised by the surrounding fresh/upgraded journeys. |
| Final static checks | Typecheck, repository check and whitespace/link checks passed. Existing application chunks still produce Vite's large-chunk advisory; the Equities view loads lazily and adds no dependency. |

Final selected live command:

```sh
RUN_LIVE_AGENT=claude-code bunx playwright test --config tests/real/playwright.config.ts live.spec.ts --grep 'fresh state: notice|upgraded state:'
```

No operational owner database was changed to run tests. Test launches used throwaway directories, explicit test-owned runner settings and test ports. No production release, remote database migration or paid data-provider subscription was activated. The new migration is applied by the normal launcher on restart. Automatic SEC/EDINET parsing, raw-source archival, price licensing and remote D1 production budgets remain outside this implemented release.

The original implementation reviews follow verbatim. Their line numbers refer to the source at the time of each review.

## Original implementation review (verbatim)

I've finished reading and am now writing up the review. I did not run, build or test anything, and I made no edits. Everything below comes from reading the 13 requested files, plus `apps/api/src/http.ts`, `packages/domain/src/finance/equityVisibility.ts` and `packages/adapters/src/sqlite/index.ts`.

## Summary

I found no critical defects. Owner isolation, import atomicity and decimal handling look sound. The issues are one medium problem in input limits and several medium-to-low gaps in data integrity, historical semantics, UI state and test coverage.

## What checked out

- **Owner isolation:** every query binds `owner_id`. Every foreign key is composite on `(owner_id, …)`, so a cross-owner reference can't be stored. The reads and the per-issuer joins in `listFacts` all filter by owner.
- **Atomicity and concurrency:**
  - `commit` runs as one `db.batch`. `node:sqlite` wraps it in `BEGIN IMMEDIATE`, and D1 batches are transactional.
  - Every follow-up statement is guarded by `EXISTS(import_id)`. A concurrent same-key import therefore loses on `ON CONFLICT DO NOTHING` and writes no records. It is then re-read as a replay or a conflict.
  - The SQL-level identity guard (`record_type <>` / `body_json <>`) backs up the application's immutability check, so the validate-then-commit window is safe because records are never updated or deleted.
- **Insert order:** the `EQUITY_TABLES` order satisfies the foreign keys within one batch. The `predecessors` check forces revision parents to appear earlier in the same insert.
- **Decimals:** the schema regex plus the 100-significant-digit and 30-fractional-digit limits are consistent. `compareEquityDecimals` handles mixed scales and negatives correctly (I traced `-0.5`).
- **Price rules:** the OHLC checks imply high ≥ low.
- **SQLite compatibility:** the `INSERT … SELECT … WHERE … ON CONFLICT` shape is unambiguous for SQLite's parser. `listIssuerRecords` uses numbered placeholders consistently, which the node driver rewrites.

## Defects

### Medium

1. **The byte limit is applied after the whole body is read and parsed.**
   - Path: `apps/api/src/http.ts:171` (`readJson` calls `c.req.json()`), then `packages/application/src/equities.ts:300-302`.
   - Failure: an authenticated client posts a 40 MB JSON body. The Worker buffers it, parses it and runs Zod over it before `PAYLOAD_TOO_LARGE` can fire. The check also measures the re-serialized parsed payload, with defaults added and whitespace dropped, not the request body.
   - Fix: check `Content-Length` and the streamed size before parsing.
   - The same payload (up to 750 KB) is bound to about 16 statements in one batch. It is also stored twice, as `payload_json` and again as per-record `body_json`. A 2,000-record import on D1 could hit statement or CPU limits. I could not verify D1's limits, because I didn't run anything.

2. **Identifiers and listings are not unique, so a symbol or CIK lookup can be ambiguous.**
   - Path: `0014_equities.sql:71` and `:93`.
   - Failure: two issuers can each hold identifier `(cik, 0000320193)`. The index is non-unique and the application only checks the format. Two listings can also share `(JP, XTKS, 7203)` with overlapping dates. Symbol search then returns both issuers and the data has no single owner.
   - The listing `market` is also never checked against `venueMic`. `JP` with `XNAS` is accepted.

3. **The ingestion cutoff disagrees with the domain model.**
   - Path: `packages/adapters/src/sql/equities.ts:190` and `packages/domain/src/finance/equityVisibility.ts:8-13`.
   - SQL requires `knownAt <= cutoff AND d.retrieved_at <= cutoff`. The tested `equityFactVisible` function, which the Lean model presumably mirrors, uses `committedAt` only.
   - `retrievedAt` is owner-supplied and never checked against `committedAt`. A document imported with `retrievedAt` in the future is hidden under any cutoff before that date, even when the import was committed earlier. The test passes only because the fixture's `retrievedAt` is early.
   - I did not open the Lean file, so the Lean comparison is an assumption.

### Low

4. **Import history order is probably not chronological, and I haven't confirmed it.**
   - Path: `sql/equities.ts:255` (`ORDER BY import_id`).
   - If `ids.newId("eqimp")` is random (UUID-like), the "history" list and its cursor are in arbitrary order. I did not read the ID generator. `equity_import_by_history` duplicates the primary key and adds nothing.

5. **An as-of query returns both an original filing's facts and its amendment's facts.**
   - Path: `listFacts`, confirmed by the test at `equities.test.ts:205`, where `latest.facts` has length 2.
   - Each row carries `amendmentOfFilingId`, so a caller can tell them apart. Nothing marks which one is current, so a naive consumer double-counts. This is acceptable only because the docs disclaim derived calculations. The UI table shows both rows without a superseded marker.
   - The same applies to price, action and guidance supersession forks: several records may supersede one predecessor.

6. **The idempotency conflict uses the wrong error code.**
   - Path: `equities.ts:308-309`, `:334-335`.
   - Reusing a key with different data returns `CONFLICT`, though `IDEMPOTENCY_KEY_REUSED` exists in `STATUS`. Both map to 409, but clients that switch on the code get a different answer than from the other endpoints.
   - Also, the service comment says `INVALID_REQUEST`, which doesn't exist. The code actually returns `INTEGRITY_VIOLATION` (422).

7. **Key order inside `dimensions` is part of a fact's identity.**
   - Path: `application/equities.ts:131`, `adapters/sql/equities.ts:54`.
   - Failure: re-importing the same fact with `{"a":1,"b":2}` re-ordered to `{"b":2,"a":1}` gives 409 `CONFLICT`.
   - `dimensions` also accepts arbitrary JSON numbers, which are doubles and are not covered by the exact-decimal guarantee.

8. **Several records can't be read through the API except by downloading the import.**
   - Path: `listIssuerRecords`, `adapters/sql/equities.ts:224-233`.
   - Source, document, statement, metric, fact and fx records never appear in the "Other data" list. FX has no read path at all, only the import download.

9. **UI races in `EquitiesView.tsx`.**
   - `loadImports` has no generation guard (`:93-106`). Click "more" and then complete an import. The refresh replaces the list, then the stale page appends to it, giving duplicates or out-of-order rows.
   - `importFile` calls `loadFacts()` (`:206`), which re-reads the cutoff text boxes (`:111-114`). A half-typed, unapplied cutoff silently becomes the applied snapshot and replaces the facts shown.
   - One `failure` signal is shared by all loaders. A late `loadImports` error overwrites or clears another panel's error, because `loadCompanies` and `loadFacts` call `setFailure(null)`.
   - `downloadImport` and the "more" buttons for records and imports can run concurrently without any guard.

10. **Test gaps.**
    - No test exercises the SQL-level identity guard, the atomic rollback of a failed batch, or two concurrent same-key imports.
    - The `listIssuerRecords` call at `equities.test.ts:34` makes no assertion.
    - There are no tests for an oversized body, duplicate identifiers or listings, or `retrievedAt` after `committedAt`.
    - The invalid-reference test only covers the application pre-validation, not foreign-key failures reaching the database.

## Limitations

- I did not run tests, typechecks or SQL, and I contacted no external services. Every finding is from reading the code.
- I did not read `docs/*.md`, `formal/ResearchFormal/Equities.lean`, `ids.newId`, the auth and CSRF middleware, or the fixture. That includes the Lean-versus-SQL comparison in item 3 and the ID ordering in item 4. The test file's 401/403 assertions are my only evidence that the routes sit behind authentication and CSRF.
- D1 size and CPU limits are from memory, not checked against the live service.
- I did not assess the claim that parsing and derived calculations are out of scope, beyond noting that item 5 is consistent with it.


## Follow-up review (verbatim)

I found no confirmed defects that block this. The earlier items are mostly closed, and what's left is medium-to-low. This is a read-only review: I ran no tests, builds or SQL, and I made no edits.

## Earlier findings now fixed in the source

- **Body size:** the import route now has `bodyLimit` at `apps/api/src/equities.ts:86` and returns 413.
- **Uniqueness:**
  - The application checks duplicate identifiers and overlapping listings within a payload.
  - The SQL guard at `sql/equities.ts:56-63` checks them against stored rows.
  - Listings must match the `EQUITY_VENUE_MARKETS` registry.
- **`retrievedAt`:** a future value is rejected at `application/equities.ts:339`. That check runs before the later `committedAt`, so a stored `retrievedAt` can no longer exceed its import's `committedAt`.
- **Import history:** it now sorts by `committed_at DESC, import_id DESC` with a validated cursor.
- **Error code:** key reuse now returns `IDEMPOTENCY_KEY_REUSED`.
- **Dimensions:** values are strings with sorted keys, so reordered keys no longer change the hash.
- **UI:**
  - Failures are tracked per scope.
  - Facts use applied cutoffs.
  - Loads carry generation guards.
- **Zod extend:** `equityFactSchema.extend(...)` at `contracts/src/equities.ts:314` is legal in the installed zod 4.6.5. `extend` at `core/util.js:449` only throws when new keys overwrite existing ones, and these are new keys.

## Remaining findings

### Medium

1. **`committedAt` is assigned in the application before the commit (`application/equities.ts:354`), not in the transaction.** *Confirmed by reading; severity is an assumption.*
   - Two concurrent imports, or Workers with clock skew, can commit in the opposite order to their timestamps. The earlier-stamped import then appears after a later one.
   - A given `ingestionCutoff` can then return different facts depending on when you ask. That defeats the point of an as-ingested cutoff.
   - The same stamp drives history ordering.
   - A fix would be a monotonic commit sequence, or stamping `max(now, latest committed_at + 1ms)` inside the batch. At minimum, document the limitation.

### Low

2. **Metric and document identity is not unique.** *Confirmed in `0014_equities.sql:123` and `:50`.*
   - Two metric records can share `(metric_code, version)` with different definitions. Two documents can share `(source_id, external_id)` under different IDs.
   - The docs call duplicate identifiers "explicit observations". They say nothing about metrics or documents, so a consumer cannot tell which definition applies.

3. **Some cross-record consistency is not validated.** *Confirmed in `importProblem`.*
   - A price `tradingOn` is not checked against the listing's `listedOn`/`delistedOn`.
   - A statement `periodEnd` is not checked against its filing's `periodEnd`.
   - Fact currency is not checked against the statement's reporting currency.
   - This may be acceptable under the "owner-supplied assertions" disclaimer, but the docs list price checks without saying these are excluded.

4. **The venue registry is narrow.** *Confirmed in `equityVenues.ts`.*
   - Cboe BZX and BYX variants, EDGA and EDGX, `XBOS`, `LTSE` and Japanese PTS venues are all rejected. OTC ADRs are rejected too.
   - Contract validation applies on every read, so only additions are safe later. That is a product limit, not a data-loss bug.

5. **Conflict reporting is inconsistent.**
   - An in-payload duplicate identifier or listing overlap returns 422 `INTEGRITY_VIOLATION`.
   - The same conflict against stored data returns 409 `CONFLICT`. The test at `equities.test.ts:132` encodes this, and the docs table (`EQUITIES_DATABASE.md:44`) says only "409 identity/key conflict".
   - The generic 409 message for a failed SQL guard cannot say which rule failed.

6. **The size check measures two different things.** *Assumption on the mapped status.*
   - `bodyLimit` measures raw bytes. The service measures `JSON.stringify` of the parsed payload, which adds `[]` defaults and drops whitespace.
   - A request just under the raw limit can still hit `PAYLOAD_TOO_LARGE` from the service. The UI pre-check uses `file.size`.
   - I did not verify what status the service path returns for that code.

7. **Search is case-sensitive for non-ASCII legal names.** *From SQLite behaviour I recall.* `lower()` only folds ASCII, so `instr(lower(legal_name), lower(?))` misses cases like "É". Local names are deliberately case-sensitive.

8. **`q` is accepted but ignored on the records and imports endpoints.** The page-query schema is reused (`equityRecordQuerySchema`, `equityImportPageQuerySchema`), so a `q` parameter passes validation and does nothing.

9. **UI nits in `EquitiesView.tsx`.**
   - `loadRecords` (`:150-170`) sets `recordsLoading(true)` before the `id === undefined` early return. `importFile` calls it unconditionally, so with nothing selected the flag sticks at true. It is invisible because the section is hidden, and `choose` clears it.
   - `importFile` calls `loadCompanies()`, which applies the current, possibly unsubmitted search text.
   - `choose` loads with the previously applied cutoffs, which can differ from what the cutoff inputs show.
   - `selected()` holds the issuer summary from selection time, so its `factCount` goes stale after an import. The facts table itself refreshes.

10. **The docs are slightly stale.**
    - `EQUITIES_DATABASE.md:34` says the hash "preserves array/object-data order". Fact `dimensions` keys are now sorted by the schema, so reordering them no longer changes the hash.
    - It also lists conflicts as 409 only (see item 5).

11. **Test coverage gaps I can see from the file.**
    - Nothing covers reordered `dimensions` replaying cleanly.
    - Nothing covers an in-payload overlapping listing or a venue/market mismatch.
    - Nothing covers duplicate metrics or documents.
    - Nothing checks that `retrievedAt` stays at or before `committedAt`.
    - The oversize test sends `{padding}`, which fails at `bodyLimit` on size alone. It does not show rejection before parsing.
    - The load test passes or fails under the test harness, which does not enforce D1's production limits. Whether a 750 KB bound parameter plus the per-table subset copies fits D1's real limits is unverified.

## Not verified

- I did not run anything, so I make no claim that tests pass.
- I did not read `http.ts` (error-status mapping and `readJson`), the Lean model, the test fixture, `equityPorts.ts`, or the SQLite/D1 batch adapters. That includes whether `PAYLOAD_TOO_LARGE` maps to 413 in the service path.
- I did not check that `meta.changes` is reported correctly on both drivers. The `results[0]?.meta.changes === 1` test in `commit` depends on it.
- D1 limits are from memory.
