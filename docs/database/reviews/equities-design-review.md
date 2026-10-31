# Equities database: Claude Code review record

Date: 2026-10-29. Scope: design only. Reviewer: installed Claude Code CLI 2.1.312, using its configured default model (model identity was not captured). Built-in tools and MCP servers were disabled. The reviewer received the full proposal, AGENTS.md, ADR-0004 and ADR-0034 as input, with a request for an independent critical review.

Reviewed draft SHA-256: `0053e9c0163b9c4721c87117f3c3b0bc4c4faed19776dc055d653e0f695670e3`.

The initial sandbox invocation could not access sign-in. The authorized invocation outside the sandbox completed successfully with exit code 0. No reviewer edit tools were enabled.

```sh
claude -p --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --no-session-persistence --output-format text < /private/tmp/equities-database-review-input.txt > /private/tmp/equities-database-claude-review.txt
```

The temporary input/output paths are execution details; the verbatim review is preserved below. The final proposal is [equities database design](../libraries/equities-design.md). The author revised the draft after review; Claude Code has not independently approved those revisions. Dispositions describe design changes, not passing implementation tests.

## Finding dispositions

| Finding | Disposition in the revised design |
| --- | --- |
| 1. Staging uniqueness | Separate `stg_*` tables scoped to ingest; only committed successful parses reserve final idempotency keys. Promotion is bounded and transactional. |
| 2. Completeness manifest | Sealed chunk counts, ordered hashes and per-table counts; lease checks on every write; coverage and manifest updated in the same guarded transaction. Oversize partitions fail explicitly. |
| 3. Parser-dependent fact identity | Stable source occurrences plus immutable interpreted facts, parse membership and append-only activation; unchanged interpretations reuse IDs, old research keeps pinned versions. |
| 4. Components treated as totals | Total/component mappings distinguished; reviewed composition is required before components can supply a total; no ID-based selection of conflicting totals. |
| 5. Concurrent invariant checks | Partition CAS, transactional cross-row assertions, composite same-filing FKs, foreign-key enforcement and ordered inserts are explicit implementation gates. |
| 6. Decimal ordering | Canonical zeros/trailing zeros, digit/scale bounds, exact decimal core and scaled integer screening projections with exact refinement and overflow fallback. |
| 7. Rounding / mixed precision | Formula output scale, half-even rounding, coarsest-input precision propagation and explicit mixed-precision policy; unsafe differences unavailable. |
| 8. Mutable historical knowledge | Append-only identity assertions and filing-availability observations; system knowledge starts at commit; corrected-current public history distinguished from replay. |
| 9. Historical access paths | Versioned historical candidate projection with availability and commit keys; query-plan verification required. Mutable availability is not copied over immutable facts. |
| 10. Restatement vintage | Explicit filing relations, comparability basis/vintage and stored selection policies; unproved vintage compatibility fails closed. |
| 11. Taxonomy upgrades | Exact version-specific mappings retained; reviewed lineage can generate mappings, unknown versions visibly fail mapping coverage. No blanket equivalence across taxonomy versions. |
| 12. Share basis | Explicit share-basis registry and action links; required for per-share/share-count comparability and valuation. |
| 13. Owner replication | Deployment explicitly single-owner, matching project requirements. Shared multi-owner catalog remains out of scope. |
| 14. Archive / XML threats | Expanded archive/XML/resource limits, disabled entities, path/root validation, owner-scoped artifact keys and hash verification. |
| 15. Directory compatibility | Separate identity-ingestion job and payload; existing replace-all search-directory completion stays unchanged. |
| 16. Nullable unique keys | Explicit discriminators/COALESCE expression indexes plus rejection tests required. |
| 17. Historical aliases | New research pins listing ID and resolution date; legacy ambiguous aliases cannot silently attach to a reused symbol. |
| 18. Accounting / fiscal transitions | Comparability breaks; growth and TTM require reviewed comparable inputs. |
| 19. Untrusted text | Bounded, quoted agent data and sanitized rendering; source HTML never rendered directly. |
| 20. Rights propagation | Source rights follow fact/derived lineage and gate display, research linkage and exports. Provider enablement waits for those checks. |
| 21. Derived growth / cycles | Persist saved snapshots only; caches for transient screens. Monotonic dependency sequence and transactional security-relation cycle checks. |
| 22. D1 write costs | Local SQLite is the initial target; D1 separately gated. Budgets include staging, raw facts, contexts, presentations and index writes. |

Deferred review notes were also incorporated: explicit ingest document reference and successful-parse partial uniqueness; canonicalization version; source revision sequences; restricted garbage collection and atomic-promotion deployment limits. Scope/dimension agreement remains part of mapping/context validation and must receive a rejection test. The review's mention of an undecided Axum API branch was not established by the supplied project documents and is not adopted as a requirement. Existing Hono/API and repository ports remain the reference.

## Verification and limits

Documentation checks cover local Markdown targets, code fences, trailing whitespace and `git diff --check`. No executable migration, application feature, provider ingestion, Lean proof or runtime performance claim is delivered. Consequently no live development/production positive-path run or database adapter test was run for this proposal. All release gates in the proposal remain required before implementation ships.

## Original reviewer output (verbatim)

# Review: Japanese and US equities database (`docs/EQUITIES_DATABASE_DESIGN.md`, proposed 2026-10-29)

**Scope.** This is a design-only review of the supplied text. I did not read the repository, run anything, or check provider or Cloudflare limits.

**Overall.** The three-axis time model, the separation of statutory filings from TDnet releases, fail-closed mapping and the identity model are sound. The blockers below sit where the design meets ADR-0004's constraints (no interactive transactions, 1 MB bodies, `batch()` only) and where the same economic fact can be represented more than once.

Severity: **Blocker** means the design cannot meet its own acceptance criteria as written. **High** means wrong or irreproducible data, or a security gap, is likely. **Medium** means fix before the phase that needs it. **Deferred** is implementation detail.

---

## Blockers

### 1. Natural-key uniqueness collides with staged-but-invisible rows
- **Severity:** Blocker
- **Section:** "Ingestion, performance and recovery" step 5, plus the unique keys on `equity_filing`, `financial_fact`, `financial_statement` and `normalized_fact`.
- **Failure:** A runner stages chunks 1–3 of a 10-K under `ingest_id=A`, then crashes. The job is retried as `ingest_id=B`. Chunk 1 violates `UNIQUE(filing_document_id, fact_locator, parser_version)` against the invisible rows from A. Either the retry fails permanently, or the rows are deduplicated onto A's never-committed rows, which are then garbage-collected.
- **Correction:** Pick one model and state it.
  - **(a)** Stage into separate `stg_*` tables keyed by `(owner_id, ingest_id, …)` and promote with a set-based `INSERT … SELECT`. Promotion must fit the batch/statement budget, so this fits only small partitions.
  - **(b)** Keep one table but make every unique key include `ingest_id`, and resolve duplicates at read time through the committed manifest. This is cheaper to write and more expensive to read.
  - Whichever is chosen, define the idempotency key for a retry (`ingest_item` already points that way) and what happens to the earlier attempt's rows.

### 2. The manifest cannot prove a partial ingest is complete
- **Severity:** Blocker
- **Section:** "Ingestion" step 5 and the `ingest_run` row.
- **Failure:** `ingest_run` has no chunk count, per-table row counts or content digest. A replayed or buggy commit request after only 3 of 5 chunks landed flips the state to `committed`. A statement with its balance-sheet facts missing is now visible, violating "no partially imported statement is visible."
- **Correction:** The `staged` transition records `expected_chunk_count`, per-table expected row counts and a digest over the ordered chunk hashes. Chunks are unique on `(ingest_id, chunk_no)` and carry their own hash. The commit statement in the guarded batch is `UPDATE … SET state='committed' WHERE version=? AND (SELECT count(*) …)=expected` for each table, so a mismatch writes nothing. Chunk writes must also present the lease generation, not only the manifest commit. Otherwise a stale runner keeps writing.
- **Related:** Step 6 updates coverage *after* commit. A crash between the two leaves visible statements marked `not_requested`. Coverage rows for the partition belong in the same guarded commit. Only the "current metric" projections can be rebuilt afterwards.

### 3. Fact identity is tied to `parser_version`, so reparsing duplicates facts and breaks stable links
- **Severity:** Blocker
- **Section:** `financial_fact` (unique key), `normalized_fact` (unique `(source_fact_id, mapping_id)`), and "Storage decision" ("reference stable financial fact IDs").
- **Failure:** Parser 1.1 re-extracts the same Toyota FY2025 revenue fact and gets a new `fact_id`. `normalized_fact` now has two rows for the same period, and selection reports a conflict between two identical values. `research_fact_link` still points at the old fact. Garbage-collecting parse 1.0 either violates the FK or orphans the saved research.
- **Correction:** Make the source fact's identity `(artifact sha256, fact_locator)`, independent of parser version. Record each parse as a separate `parse_run`. Keep an explicit `active_parse` per document, and have selection read only the active parse. A reparse that yields an equal lexical value and context reuses the fact ID. A different value creates a new fact linked to the earlier one, flagged as a parser change. `research_fact_link` should be `ON DELETE RESTRICT`.

### 4. 1:1 concept→metric mappings cannot represent component metrics
- **Severity:** Blocker
- **Section:** `metric_mapping`, `normalized_fact`, and the initial metrics "current/noncurrent debt", "capital expenditure", "cost of sales".
- **Failure:** A JP issuer tags bonds, long-term loans and lease obligations separately. All three map to `noncurrent_debt`, giving three `normalized_fact` rows with the same issuer/metric/period/scope. The design says multiple valid disclosures "remain separate observations," so selection flags a conflict. If it breaks the tie "by stable ID," it silently reports one component as total debt.
- **Correction:**
  - Give each mapping a `kind` of `total` (the concept is the full metric) or `component`.
  - Components feed a versioned `metric_composition` rule that produces a derived normalized observation with typed inputs, using the presentation hierarchy so a parent and its children are never summed together.
  - Until a composition rule exists, map only total concepts. Count unmapped components in `coverage`.
  - Never use stable-ID tie-breaking between different concepts. Tie-breaking is acceptable only among observations of the same concept.

### 5. Cross-row invariants are validated outside the guarded commit
- **Severity:** Blocker
- **Section:** "Schema conventions", the composite-FK paragraph under `normalized_fact` ("validate it before the guarded commit"), and the non-overlap rules on identifiers, symbols and relations.
- **Failure:**
  - Two ingests each check "no overlapping `JP:7203` symbol interval" against the same empty state and both commit.
  - A `json_each` insert cannot see sibling rows in the same statement, so a batch containing two overlapping intervals passes any `NOT EXISTS` guard.
  - Pre-commit app validation is a time-of-check/time-of-use gap, which ADR-0004's CAS design exists to avoid.
- **Correction:**
  - Put an assertion in the same D1 batch after the inserts. Either a trigger with `RAISE(ABORT)` or a trailing statement that deliberately violates a constraint when `EXISTS(overlap)`. A D1 batch error rolls the whole batch back.
  - For same-filing consistency, add redundant `UNIQUE(owner_id, filing_id, id)` keys on `fact_context`, `financial_statement` and `filing_document`, and reference them as `(owner_id, filing_id, context_id)`. SQLite can then enforce this declaratively.
  - Guard each partition with a CAS on a partition version row, so concurrent ingests serialize.
  - State that every local SQLite connection must run `PRAGMA foreign_keys=ON` (it is off by default per connection), and add a test that fails if it is off. State the FK insert ordering for self-referential tables (`supersedes_*`, `derived_input`).

---

## High

### 6. Decimal text cannot be sorted, ranged or aggregated in SQL
- **Severity:** High
- **Section:** "Schema conventions" (exact numerics), and "Serve … cross-sectional current screens … parameterized set queries."
- **Failure:** In `ORDER BY decimal_value`, `"9"` sorts above `"10"`. A screen like "operating margin > 10%" or "revenue top 50" cannot run in SQL. Canonicalization is also underspecified: `"1.50"` vs `"1.5"` is a different unique key unless a rule is stated, and `-0`, `0.0` and leading zeros are unaddressed.
- **Correction:** Store `mantissa` (integer or text) plus `scale` as authoritative. Add a clearly non-authoritative sort key for the projection tables only: an `INTEGER` scaled value where it fits, or a fixed-width sortable encoding. State one canonical form (trailing-zero rule, zero sign) and keep reported precision in separate columns. Specify a maximum digit count and scale so the TypeScript (BigInt) and Rust (e.g. `rust_decimal` has a fixed digit limit) implementations agree. Add overflow to the conformance vectors.

### 7. Derived values have no rounding or precision rule, and mixed-source subtraction is unsafe
- **Severity:** High
- **Section:** "Calculation rules" (standalone quarter, ratios), `derived_observation`.
- **Failure:** The design says "exact decimal/rational," but ratios and EPS division are non-terminating and are stored as decimal text. Q4 = FY (EDINET, exact yen) − 9M YTD (TDnet 決算短信, rounded to millions of yen) yields a value that looks precise to the yen but is only good to about ±¥1M.
- **Correction:** Add `precision_scale` and a rounding mode to the metric/formula definition. Propagate the coarser input's decimals into the derived value, and store them on `derived_observation`. Refuse or flag differences between inputs of different reported precision unless the policy allows it. Add these cases to the Lean model and vectors.

### 8. Availability and "system knowledge" are not append-only
- **Severity:** High
- **Section:** `equity_filing` (`public_available_at`, `availability_precision`), `equity_listing` (`delisted_on`), `issuer_identifier` and "Time, amendments and point-in-time queries."
- **Failure:**
  - The `public_available_at` of a filing is later corrected from a date-only bound to a precise time by editing the row. A "system replay" at the earlier cutoff now sees the corrected time and produces a different answer than it did then.
  - `equity_listing.delisted_on` is learned months after the event, with no `known_at`, so replay leaks the future.
- **Correction:** Treat availability as versioned observations: `filing_availability(filing_id, available_at, precision, basis, known_at, source_document_id)`. Give `equity_listing` and `equity_issuer` the same `known_at` and effective-interval treatment as the profile tables, or make those columns derived views over versioned events. Define "known" as the manifest commit time (`ingest_run.completed_at`), not row `created_at`, because staged rows exist before commit.

### 9. As-of selection has no denormalized availability on the hot table
- **Severity:** High
- **Section:** `normalized_fact` and the index list.
- **Failure:** The planned index is `issuer/metric/period_end/scope/standard/unit/dimensions`. Every historical lookup must join `equity_filing` for `public_available_at` and the manifest for commit time, and sort after the join. A historical screen over thousands of issuers degrades to per-row joins on the 19.2M-row table.
- **Correction:** `normalized_fact` is immutable, so copy `available_at`, `available_precision` and `committed_at` into it, and make the index `(owner, issuer, metric, period_end, scope, standard, available_at)`. Define how "joined to a committed manifest" is evaluated: a small `committed_ingest` lookup, or an `EXISTS` verified with `EXPLAIN QUERY PLAN`, not an assumption.

### 10. "Coherent restatement vintage" is used but never defined
- **Severity:** High
- **Section:** "Calculation rules" (Q4 = FY − nine-month YTD), `financial_statement`, selection policy.
- **Failure:** FY2024 is restated in the FY2025 10-K, while the 9M figure available is the original from the Q3 filing. The subtraction produces a Q4 that matches neither version. The design says "coherent" but gives no key for it.
- **Correction:** Define a vintage key explicitly, for example `(issuer, filing lineage root)` or "all inputs from filings whose `public_available_at` ≤ the latest input's and linked by amendment/comparative-period edges." Add a `filing_relation` table (with `known_at`) for amendment, replacement and cross-provider reviewed links. The design mentions these relationships but has no table for them. Persist selection policies in a `selection_policy` table with versions, since replay needs the exact policy.

### 11. Mapping is bound to a per-version taxonomy concept
- **Severity:** High
- **Section:** `xbrl_concept` (unique namespace/version/local name) and `metric_mapping.concept_id`.
- **Failure:** Mappings are reviewed against `us-gaap/2023` `Revenues`. FY2025 filings reference the 2025 taxonomy's concept row, which has no mapping, so revenue silently vanishes for those filings. Alternatively, every annual taxonomy release forces a full re-review.
- **Correction:** Map on a concept lineage `(namespace family, local_name)` with a taxonomy-version range, and track renames and deprecations explicitly. Count unmapped facts per filing in `coverage` so absence is visible, not silent.

### 12. Per-share facts carry no share basis
- **Severity:** High
- **Section:** "Schema conventions" ("per-share basis … travel with every number") against `financial_fact`, `normalized_fact` and `derived_observation`, which carry only a unit.
- **Failure:** A 1:3 split is effective after the FY2024 report. Its EPS is in pre-split shares, while the FY2025 comparative is restated. Joining them gives a 3× EPS growth artefact. The design requires "documented identical share basis" but has nowhere to record it.
- **Correction:** Add `share_basis` (as-of split-vintage reference or the `action_id` set applied) to per-share facts and normalized facts. Make per-share compatibility part of the semantic group in selection.

### 13. Every public record is replicated per owner
- **Severity:** High
- **Section:** "Schema conventions" (`owner_id` first in every PK and FK).
- **Failure:** SEC and EDINET filings are public. With N owners, the 12,000 × 10 × 4 × 40 scenario is N × 19.2M normalized rows plus facts and artifacts, even though only coverage and entitlements differ per owner. Cross-owner dedupe is also lost.
- **Correction:** Decide and state the deployment model. If it is strictly single-owner, say so and drop the multiplier from the sizing. Otherwise split a shared public catalog (`owner_id`-free, rights-tagged) from owner-scoped tables (watchlist, coverage, research links, licensed-provider data). The isolation argument for per-owner rows applies mainly to *licensed* data, which can be a per-source flag instead.

### 14. Untrusted archive and XML parsing is under-specified
- **Severity:** High (security)
- **Section:** "Ingestion" step 3–4 (only "bounded response sizes").
- **Failure:** EDINET delivers zips and iXBRL/XML. A crafted or corrupted package can cause zip bombs, path traversal in entry names, XML entity expansion (billion laughs) or external entities (XXE), exhausting runner memory or reading local files.
- **Correction:**
  - Cap decompressed bytes, entry count and compression ratio.
  - Ignore archive entry names for storage; store by hash.
  - Disable DTDs and external entity resolution.
  - Cap element depth and fact count.
  - Run the parser with memory and time limits.
  - Specify the artifact path scheme so the locator cannot escape the store root and sha256 is re-verified on read.
  - Include owner (or "shared catalog") in the storage key so one owner's `retention_until` deletion cannot remove bytes another owner references.

### 15. Phase 1 contradicts the "do not change directory contracts" rule
- **Severity:** High (compatibility)
- **Section:** "Implementation sequence" step 1 versus the last paragraph of "Ingestion, performance and recovery", and ADR-0034.
- **Failure:** "Retain official IDs in directory ingestion" means adding a CIK per row to the `stock-directory-refreshed` payload. That changes the contract and spends the 1,000,000-byte budget. ADR-0034 records US at about 530 KB with a stated ~80% growth limit. The directory refresh also replaces a market's rows wholesale, which is incompatible with append-only identity history.
- **Correction:** Either relax the "no contract change" sentence, or ingest identity in a separate job and payload kind that does not touch the existing completion. Re-measure the payload size. Identity writes must be append-only, never driven by "replace this market's rows." JPX `data_j.xlsx` has no EDINET code, so the join must come from the EDINET code list and go through the resolution queue.

---

## Medium

### 16. NULL handling in unique keys
- **Severity:** Medium
- **Section:** `financial_statement`, `financial_fact`, `fact_context` (nullable `period_start`, etc.).
- **Failure:** SQLite treats NULLs in a `UNIQUE` as distinct, so duplicate instant-period statements are accepted.
- **Correction:** Use unique expression indexes with `COALESCE`, or a stored discriminator column such as `period_start_or_sentinel`. Add a rejection test.

### 17. Historical alias resolution
- **Severity:** Medium
- **Section:** last paragraph ("`US:AAPL` / `JP:7203` compatibility IDs map to a listing through a dated alias").
- **Failure:** A widget saved in 2025 holds `JP:XXXX`. The code is later reused by another company. Resolution "as of now" attaches old research to the new company.
- **Correction:** Resolve at save time and store `listing_id` plus the alias date on new research links. Keep alias-only resolution for legacy widgets, with an ambiguity flag.

### 18. Transitions in accounting standard or fiscal year end
- **Severity:** Medium
- **Section:** `financial_statement`, "Calculation rules".
- **Failure:** An issuer moves from J-GAAP to IFRS, or changes its fiscal year end. The growth series splices incomparable periods with no warning.
- **Correction:** Add a `comparability_break` or series-segment marker derived from standard, scope and fiscal-year changes. Growth and TTM calculations fail closed across a break. The `transition` period kind already exists, so use it.

### 19. Untrusted text reaches the agent and the UI
- **Severity:** Medium
- **Section:** `financial_fact.text_value`, notes and text blocks, "Evidence."
- **Failure:** An iXBRL text block containing instructions is placed in the research agent's context. HTML text blocks rendered in the notebook are an XSS risk.
- **Correction:** Mark `text_value` as untrusted and size-bounded, and return it to the agent as quoted data per the existing threat model (T22). Never render source HTML. Sanitise to text or a restricted subset.

### 20. Rights metadata stops at the artifact
- **Severity:** Medium
- **Section:** `artifact.rights_policy_version`, `price_bar`, "Providers and coverage."
- **Failure:** Licensed prices are stored with `source_id`, but nothing blocks them flowing into chart widgets, `.ics` subscription output or saved research that is later exported.
- **Correction:** Define a rights class per source and have `research_fact_link` and export paths check it. This can be deferred until a licensed provider is enabled.

### 21. Derived observation growth and cycle checks
- **Severity:** Medium
- **Section:** `derived_observation`, `derived_input`, `security_relation`.
- **Failure:**
  - `information_cutoff` is part of the digest, so a daily historical screen persists a new row per day per formula.
  - Cycle rejection cannot be a SQLite constraint.
- **Correction:**
  - Persist derived rows only for saved research or snapshots, and compute the rest on read.
  - Enforce acyclicity by construction: an input must have a smaller monotonic sequence than its output, via a checked column or a trigger.

### 22. D1 and free-tier write cost is not budgeted
- **Severity:** Medium
- **Section:** "Capacity planning is an implementation gate."
- **Failure:** The gate counts only normalized rows. A 10-K carries thousands of facts plus contexts and presentation rows, each with several indexes. D1 bills index entries as row writes, so even one issuer-year may be expensive under the Free plan's limits. Those limits were not verified for this review; check current figures.
- **Correction:** State the target (local SQLite, which `bun run prod` uses today, or remote D1) and add a per-filing write budget, in rows and index entries, to the acceptance list. Count `financial_fact`, `fact_context` and `fact_presentation` in the sizing, not just `normalized_fact`.

---

## Deferred (not blockers)

- **Canonical JSON and hashing:** name the canonicalization (e.g. RFC 8785) and use a SHA-256 key. The "check hash collisions against full content" step becomes unnecessary.
- **`ingest_item` key:** the listed columns omit `source_document_id`. Make the successful-parse uniqueness an explicit partial index.
- **Price revisions:** use `(listing, date, source, revision_no)` instead of walking `supersedes_bar_id` chains.
- **`scope` vs dimensions:** `fact_context.scope` duplicates the consolidated/non-consolidated dimension. Derive one from the other or assert they agree.
- **Garbage collection of failed manifests:** needs ordered deletes and `ON DELETE RESTRICT` on committed references.
- **D1 batch limits:** statement count and bound-parameter limits per batch should be confirmed before settling the chunk size.
- **API port:** repository ports must stay neutral between the Hono and Axum API branches, which are still undecided.

---

## Limitations

- This review covers the supplied text only. I did not inspect existing migrations, repository ports, `research_records` or the Rust/TypeScript runners.
- I did not run or prove anything. D1 and SQLite behaviour (trigger aborts rolling back a batch, FK defaults, NULL semantics in unique keys) is stated from general knowledge and must be confirmed with tests on both local SQLite and Workers D1.
- I did not verify provider terms, EDINET or TDnet scope, or current Cloudflare quotas.
- Quantitative claims, such as the effect of the payload size on the 1 MB cap, rest on figures quoted in ADR-0034. I did not re-measure them.
- There may be further defects in areas I did not weigh, such as banks and insurers, 52/53-week calendars and the Lean model scope.
