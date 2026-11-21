# ADR-0080: Stock-screening relevance tiers, compact candidate output, planning leads and round logging

**Status:** Accepted · **Date:** 2026-11-21 · **Amends:** [ADR-0071](0071-stored-stock-retrieval-tool.md)

## Context

In development runs `run_a1bdc0c76576dc6b848c46e7` and `run_3900b5fdad5b00ad94cb9d26` (Sarashina API, Rust runner), the owner asked:
「造船で純利益率が高い日本の銘柄を調査してください」. Both runs ended with `NO_EVIDENCE_COLLECTED` / `TOOLS_RETURNED_NOTHING` even though J-Quants revenue and net income statements for Japanese shipbuilders (内海造船 `JP:7018`, 名村造船所 `JP:7014`, 三井Ｅ＆Ｓ `JP:7003`) were stored in D1.

Replaying the runs exposed five interacting causes, plus a sixth verification gap during live end-to-end validation:

1. **Context-only overviews filled the 6,000-byte model-text ceiling.** Each stored Japanese AI overview is up to 2,400 characters (~7,200 UTF-8 bytes before truncation), so `stocks.search {"query":"造船","kind":"company","limit":12}` showed only 2 of its 12 hits to the planner.
2. **Company search ordered hits by `retrieved_at DESC` alone ([ADR-0071](0071-stored-stock-retrieval-tool.md) "newest-first") and omitted Japanese `local_name` from AI overview titles.** Companies whose name or themes matched `造船` (such as 名村造船所) ranked behind newer body-only mentions, and AI overview titles showed only the English directory name (`Naikai Zosen Corporation`) without `内海造船`.
3. **Context-only candidates vanished from the planning digest after one round.** `digestLinesFor` kept one line per citeable evidence item and collapsed context-only calls to `stocks.search: 0 record(s), no evidence`.
4. **Repeated calls wasted a round silently, and pre-final rounds gave no guidance before `FINAL_ROUND_NO_SEARCH` ([ADR-0078](0078-final-round-reads-pages-and-parallel-page-reads.md)).** Round 2 repeated Round 1 with no progress event or reminder, and Round 3 requested `web.search` when search results could no longer be opened. In addition, the screening prompt instructed `"<ticker> 純利益" ... only` without `"<ticker> 売上高"` for margin screens (`純利益率`).
5. **Ticker and numeric terms matched as arbitrary substrings.** `"7018 純利益"` matched unrelated companies whose decimal values or internal ids contained `7018`.
6. **Financial `Passage:` text omitted the company's ticker and name.** Because `stocks.search` placed `market:symbol` and `name` only in `Title:` while independent verification sees only the attached `supports` quotes, quoting a financial `Passage:` line (`metric=...; fiscalYear=...; value=...`) left the verifier unable to link the figure to the named company.

## Decision

1. **Compact context-only hits and reserve short-form space in `stocks.search` (tool version `1.1.0`, both runners).**
   - Every context-only hit (`aiGenerated` or `sourceUrl === null`) emits a single JSON line: `{"reference":"Context only; no citeable evidence","kind","recordId","title","snippet"}`, where `snippet` is an 80-code-point single-line window starting 20 code points before the first ASCII-folded query-term match (or the first 80 code points when none matches in the body).
   - Every citeable hit has a full form (JSON reference header plus dated metadata and passage) and a short form (JSON header plus `(passage not shown in full; narrow the query or select a kind)`). Walking hits in order against `MODEL_TEXT_BUDGET_BYTES` (5,981 UTF-8 bytes before `boundModelText`'s truncation trailer), a citeable hit emits its full form only while the remaining budget still covers the short forms of all later hits plus trailing notices; otherwise it emits its short form so every returned `recordId` stays visible.

2. **Company relevance tiers, Japanese local names, token-bounded numeric/ticker terms, and `issuer=` in financial passages (`packages/adapters/src/sql/stockResearch.ts`).**
   - `company` search ranks matches by `CASE WHEN <all terms in lower(name_text)> THEN 0 WHEN <all terms in lower(theme_text)> THEN 1 ELSE 2 END, d.retrieved_at DESC, d.record_id DESC`, amending [ADR-0071](0071-stored-stock-retrieval-tool.md)'s newest-first rule for the company corpus. `financials` and `news` keep `d.retrieved_at DESC, d.record_id DESC` so SQLite continues to use `idx_articles__owner_id_retrieved_at_article_id` without a full sort.
   - AI overview titles format `market:symbol` followed by `local_name (name)` when `stock_directory.local_name` is present (for example `JP:7018 内海造船 (Naikai Zosen Corporation) AI-written company overview`).
   - Any query term matching `/^(?=.*[0-9])[0-9a-z:.-]+$/` (such as `7018`, `130a`, `jp:7018` or `2025`) must both match `instr(h, ?)` on `h = lower(d.title || char(10) || d.text)` and have non-`[0-9a-z]` characters immediately before and after its first occurrence (`substr(h, instr(h, ?) - 1, 1) NOT GLOB '[0-9a-z]'` and `substr(h, instr(h, ?) + length(?), 1) NOT GLOB '[0-9a-z]'`).
   - Stored `financials` passages start with `issuer=<market>:<symbol> <name>; metric=...` so a single verbatim `Passage:` quote carries the issuer identity into independent verification.

3. **Planning leads in `ToolOutput` (both runners).**
   - `ToolOutput` adds `planningLeads: readonly string[]` (`planning_leads: Vec<String>` in Rust), capped at 12 lines of at most 200 UTF-8 bytes cut on a code-point boundary.
   - `stocks.search` populates `lead (no evidence): <title>` for each context-only hit. When `output.evidence` is empty and `planningLeads` is non-empty, `digestLinesFor` keeps those lead lines in later planning prompts under the existing `PLANNING_DIGEST_MAX` / `PLANNING_DIGEST_MAX_LINES` budget. Planning leads never enter `evidence`, claims, analysis prompts, verification prompts or published bundles.

4. **Repeat recovery, pre-final guidance, margin screening prompt (`research-v11`), and explicit 3-round stall note (both runners).**
   - Duplicate tool calls within or across rounds emit `reporter.tool(label, "denied", "REPEATED_REQUEST")`. When every call in a round is dropped as a repeat, the next planning round receives `PLANNING_REPEAT_NOTE` directing the planner to request candidate financials by ticker (`kind "financials"`, `"<ticker> 純利益"`, plus `"<ticker> 売上高"` for margins), another theme term, or `web.search`. A repeat-only round still counts toward the three-round cap.
   - On the round immediately before the final round (`step + 2 === Math.min(collectionSteps, 3)`), when `collected.evidence` is empty and `web.search` is permitted and untried, `PLANNING_SEARCH_BEFORE_FINAL_NOTE` tells the planner to fetch stored financials by ticker if candidate tickers were listed above, or otherwise request `web.search` now while one round remains to open its leads.
   - Prompt `research-v11` instructs stage-1 theme discovery with `limit 12` (never re-running the same theme query with another limit), stage-2 single-metric financial queries including `"<ticker> 売上高"` / `"<ticker> revenue"` for margin screens, and `profit / revenue * 100` inference rules in analysis without asserting unquoted business details from AI-only overviews.
   - Ending three planning rounds with zero citeable evidence records `"Collection ended after three planning rounds without citeable evidence."`

5. **Planner round logging (`research_planning_round`, both runners).**
   - Both runners log an `info` event `research_planning_round` per completed planning round with `runId`, `leaseGeneration`, `round` (1-based), `finalRound`, `requestedToolIds` (comma-separated in plan order, duplicates kept, validated against `^[a-z][a-z0-9._-]{0,39}$` or `"invalid"`), `executed`, `repeated`, `denied` and `refusedFinalRoundSearch`. Tool arguments and question text are never logged ([logging rule](../rule/logging.md)).

## Trade-offs and Consequences

- **First-occurrence token boundary in SQL:** SQLite `instr` inspects only the first match of a token-bounded term in `lower(title || char(10) || text)`. Because `market:symbol` appears at the very start of `title`, a company's own ticker always passes; a document whose first occurrence of a digit token sits inside a longer alphanumeric token while a later whole-token match exists in the body will be missed. This avoids recursive CTE tokenization across full corpora and requires no schema migration.
- **No embeddings or numeric screening endpoint:** Retrieval remains deterministic lexical SQLite/D1 search; arithmetic comparisons and margin calculations stay verified agent inferences over quoted J-Quants and SEC financial records.
- **Measured hot-path latency:** On `bun run bench` (`node:sqlite`), `stocks.search` over 20,000 news articles stayed at `0.963 ms` (40 ms budget) by keeping the `CASE` rank expression scoped to `kind === "company"`, and the new 11,400-row Japanese AI company summary benchmark (`query: "造船"`) measured `21.234 ms` against a 50 ms budget.
