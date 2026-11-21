# Plan: stock-screening questions that end with no evidence

Status: **implemented and verified 2026-11-21 (see [ADR-0080](../adr/0080-stock-screening-relevance-and-planning-leads.md) and [REQUIREMENTS_STATUS.md](../REQUIREMENTS_STATUS.md)).**

## 1. The failure

Question: 造船で純利益率が高い日本の銘柄を調査してください (Sarashina API, Rust runner, development).
Runs `run_a1bdc0c76576dc6b848c46e7` and `run_3900b5fdad5b00ad94cb9d26` both failed with
`NO_EVIDENCE_COLLECTED` / `TOOLS_RETURNED_NOTHING`. The last progress note,
"Collection stopped after three planning rounds.", is the end of the loop, not the cause.

A replay through the real TypeScript pipeline failed identically. The replay used the same prompts and the same SQL
as the Rust runner's API, Sarashina, a copy of the development database, and logged every tool call.

| Round | Planner request | What happened |
| --- | --- | --- |
| 1 | `stocks.search {"query":"造船","kind":"company","limit":12}` | 12 hits, 0 evidence. Only **2 of 12** reached the planner: JP:3168 MERF (copper recycler) and US:HII. |
| 2 | the same request again | Dropped as a repeat ("not repeated" entry). No progress event and no reminder. |
| 3 (final) | `web.search {"query":"日本の造船会社 純利益率 高い"}` | Refused: `FINAL_ROUND_NO_SEARCH` (ADR-0078). |

The data needed to answer was stored: `stocks.search {"query":"内海造船 純利益","kind":"financials"}`
returns 2 citeable J-Quants evidence items. 名村造船所, 内海造船 and 三井Ｅ＆Ｓ have FY2025/2026 revenue and net
income with filing links.

## 2. Root causes

1. **The tool output hides almost every candidate (main cause).** The model text of every tool is capped at
   6,000 bytes (`MAX_MODEL_TEXT_BYTES`, `packages/adapters/src/tools/shared.ts`, `crates/research-tools/src/shared.rs`).
   A stocks.search passage can be 2,400 characters. An AI-written overview is Japanese JSON, at about 3 bytes a
   character, so one or two hits fill the budget.
2. **Company hits are ordered by recency, not relevance.** `ORDER BY d.retrieved_at DESC`
   (`packages/adapters/src/sql/stockResearch.ts`, ADR-0071 "newest-first"). 名村造船所 is not in the top 12.
   The AI overview title uses only the English directory name (`sd.name`). The Japanese name
   (`stock_directory.local_name`, e.g. 内海造船) is not in the title.
3. **Candidates are lost after one round.** `digestLinesFor` / `digest_lines_for` keeps one line per evidence item.
   A context-only result leaves just `stocks.search: 0 record(s), no evidence`.
4. **A repeated request silently wastes a round**, and nothing tells the planner to use `web.search` while a later
   round can still open its results.
5. **(Secondary) Ticker terms match as substrings.** `"7018 純利益"` returns 6 financial hits, 4 of them other
   companies, because "7018" occurs inside their values or ids.

## 3. Owner decisions (2026-11-21)

- Fixes 1, 2, 3 and 4 approved. Fix 2's relevance tiers amend ADR-0071's "newest-first" rule.
- **Also log which tools the planner requests** (§4.5). Log tool ids only, never arguments: arguments can contain the
  owner's question text.
- A round made only of repeats still counts toward the three-round cap. This was the recommended default and the
  owner raised no objection.

Non-goals: no embeddings or relevance model beyond the fixed tiers, and no numeric screening endpoint. The three-round
cap, the 6,000-byte limit and ADR-0078's final-round rule stay as they are. AI-written context stays non-citeable.
No schema migration.

## 4. Design

### 4.1 Fix 1: compact context-only hits in the stocks.search output (both runners)

Files: `packages/adapters/src/tools/stockResearch.ts`, `crates/research-runner/src/stock_research.rs`,
`packages/adapters/test/tools/stockResearch.test.ts`, the Rust tests in `stock_research.rs`, tool-output vectors.

Algorithm. Byte counts are UTF-8 and each line adds 1 byte for its newline. Both runners must produce the same bytes.

1. For every hit, build its **short form**.
   - A context-only hit (`aiGenerated`, or `sourceUrl === null`) gets one JSON line:
     `{"reference":"Context only; no citeable evidence","kind","recordId","title","snippet"}`.
     No dates and no passage.
   - A citeable hit's short form is its usual JSON header line plus the line
     `(passage not shown in full; narrow the query or select a kind)`.
2. `snippet`: fold ASCII to lowercase, as SQLite `lower` does. Find the first query term in the hit's text, counted in
   **code points** (TS `Array.from`, Rust `chars()`). Start 20 code points before it, take 80 code points,
   and replace newlines with spaces. If no term is found, use the first 80 code points.
3. Walk the hits in order, with `reserve` = the bytes of the short forms of all later hits plus the trailing lines.
   A citeable hit's full form is its header line and the full passage (as today). Emit the full form when
   `used + full + reserve <= budget`, otherwise its short form. Context-only hits always emit their short form.
4. Keep `boundModelText` as the final guard. Bump the tool version `1.0.3` → `1.1.0` in both runners.

Tests:
- 12 Japanese AI-overview hits: all 12 `recordId`s are in the text, which is at most 6,000 bytes.
- Mixed results: citeable passages are whole while they fit, then appear as short forms.
- Rust output equals TypeScript output for the same API response (existing tool-output vector mechanism).

### 4.2 Fix 2: relevance tiers, Japanese names and ticker terms (SQL; one implementation behind the API)

File: `packages/adapters/src/sql/stockResearch.ts`. The Rust runner calls the same endpoint.
Tests: `packages/adapters/test/sqlite/stockResearch.test.ts` (canonical and migrated layouts),
`apps/api/test/stockResearch.test.ts` (node:sqlite and local D1).
Fixtures: `packages/adapters/test/sql/stockResearchFixtures.ts`. Add JP rows with `stock_directory.local_name`,
for example a 名村造船所-like name match, a newer body-only 造船 mention, and a financial value containing "7018".

- **New columns in every `DOCUMENTS` branch:** `market`, `symbol`, `name_text` and `theme_text`.
  - Company, AI branch: `scs.market`, `scs.symbol`, `coalesce(sd.local_name,'') || ' ' || coalesce(sd.name,'')`,
    and `scs.theme_names`.
  - Company, SEC branch: `eco.market`, `eco.symbol`, `eco.name`, NULL.
  - Financials: `eco.market`, `eco.symbol`, NULL, NULL.
  - News: all NULL.
- **Rank:** `CASE WHEN <all terms in lower(name_text)> THEN 0 WHEN <all terms in lower(theme_text)> THEN 1 ELSE 2 END`.
  Order by `rank, retrieved_at DESC, record_id DESC`. Financials and news always get 2, so their order is unchanged.
  The terms are bound again for each `instr`. Only constants enter the SQL, as now.
- **AI overview title:** `market:symbol` followed by `local_name (name)`, falling back to `name`. Example:
  `JP:7018 内海造船 (Naikai Zosen Corporation) AI-written company overview`.
- **Token-bounded terms.** This replaces "symbol equals term", which would break years such as `2025`.
  - Scope: a term made only of ASCII `[0-9a-z:.-]` that contains a digit, such as `7018`, `130a`, `jp:7018` or `2025`.
  - Rule: the term still matches with `instr` on the folded haystack (`lower(title || char(10) || text)`). In addition,
    the characters just before and just after its **first** occurrence must not be `[0-9a-z]`. In SQL:
    `substr(h, instr(h,?)-1, 1) NOT GLOB '[0-9a-z]'` and `substr(h, instr(h,?)+length(?), 1) NOT GLOB '[0-9a-z]'`.
    At the start or end of the haystack, `substr` returns an empty string, which counts as a boundary.
  - Trade-off, recorded in the ADR: only the first occurrence is checked. The title comes first in the haystack, so a
    company's own ticker always passes. A row whose first occurrence sits inside a number but which has a later
    whole-token occurrence is missed.
- **Tests:**
  - A name match ranks above a newer body-only mention.
  - The Japanese local name is in the title.
  - `"7018 純利益"` returns only 7018's rows.
  - `"<ticker> 2025 純利益"` still finds FY2025.
  - The existing all-term, owner-isolation, SQL-metacharacter, limit and interleave tests still pass.
- **Performance:** baseline `bun run bench` on main `ea590a1a`, 2026-11-21: "stocks.search across stored corpora with
  20,000 news articles (node:sqlite)" took **1.250 ms** against its 40 ms budget. The run already exits 1 **before
  any change**, because three unrelated cases are SLOW: "normalize a 100-item feed" 3.182/3 ms, "check 12 assistant
  commands…" 11.164/10 ms, and "assemble GET /home/data…" 24.480/22 ms. Those are pre-existing; record them, and
  don't treat them as regressions from this work.
  Add a company-corpus case to `scripts/bench.ts`: about 11,400 AI summaries with Japanese theme text and the query
  `造船`. Set its budget from the measurement.

### 4.3 Fix 3: candidates survive in the planning digest (both runners)

Files: `packages/agent-core/src/tools.ts` (`ToolOutput`, `EMPTY_TOOL_OUTPUT`) and `crates/research-agent-core/src/tools.rs`
(`ToolOutput`, `Default`); both stocks.search tools;
`packages/application/src/research/pipeline.ts` (`digestLinesFor`, about line 267) and
`crates/research-application/src/research/collect.rs` (`digest_lines_for`).

- Add `planningLeads: readonly string[]` (Rust `planning_leads: Vec<String>`): at most 12 lines of at most 200 UTF-8
  bytes, cut on a code-point boundary. Planning context only. They are never evidence and never appear in the
  analysis or verification prompts.
- stocks.search adds `lead (no evidence): <title>` for each context-only hit.
- `digestLinesFor`: when there is no evidence and there are leads, return the lead lines instead of
  `N record(s), no evidence`. `PLANNING_DIGEST_MAX` and `PLANNING_DIGEST_MAX_LINES` still apply.
- Every tool constructing `ToolOutput` gets an empty list. In TS that comes through `EMPTY_TOOL_OUTPUT` spreads, so
  grep for object literals that build `ToolOutput` without it. In Rust it comes through `Default`.
- Tests: in a scripted run, the round-3 planning prompt names the round-1 candidates. Leads never become evidence
  ids, claims or sources. Re-export the pipeline vectors (`node scripts/vectors/index.ts --check pipeline`; regenerate
  as the README says). Run `UPDATE_VECTORS=1 cargo test -p research-runner golden_outgoing_payloads_are_current`
  if a golden changes.

### 4.4 Fix 4: a repeat or an evidence-free round becomes a next step (both runners and prompts)

Files: `packages/application/src/research/pipeline.ts`, `packages/application/src/research/prompts.ts`,
`crates/research-application/src/research.rs` (the repeat branch is near "was not repeated", about line 630; the
reminders are near line 800), `crates/research-application/src/research/prompts.rs`,
`crates/research-application/src/research/templates/planning-tail.txt`.

- **`PLANNING_REPEAT_NOTE`:** when every call in a round was dropped as a repeat, the next prompt's reminder says:
  your last request repeated an earlier call and its result is above; request the candidates' financials by ticker
  (`kind "financials"`, query `"<ticker> 純利益"`), a different theme term, or `web.search`.
  Also report the repeat as a progress event: `reporter.tool(label, denied, "REPEATED_REQUEST")`.
- **`PLANNING_SEARCH_BEFORE_FINAL_NOTE`:** applies to the round just before the final one, when nothing citeable has
  been collected, `web.search` is permitted, and `web.search` has not been requested yet. Append: one round remains
  after this one; if stored records gave no citeable evidence, request `web.search` now so its leads can be opened in
  the final round.
- **Prompt sentence** in the screening paragraph of `planning-tail.txt` and `prompts.ts`: a theme search lists
  candidates only; do not repeat it; next, request the relevant candidates' financials by ticker.
- **Prompt version:** `PROMPT_VERSION` is `research-v10` on main (commit `ea590a1a`). Bump it to `research-v11`.
- **No-evidence note:** when collection ends with no evidence, the final note is "Collection ended after three planning
  rounds without citeable evidence." The note's text in `pipeline.test.ts` (about line 2442) and the Rust tests must
  change with it. Also grep `tests/real` and `tests/e2e` for the old text.
- **Tests:** a scripted planner replays this run (company search, the same search, then `web.search`). It must receive
  the repeat note in round 2 and the search note before round 3. A planner that follows the notes reaches analysis
  with J-Quants evidence. The ADR-0078 tests (the final round refuses search) stay green. Update
  `packages/application/test/prompts.test.ts` and the Rust prompt tests.

### 4.5 Log the planner's tool requests (both runners)

- Add a new info event `research_planning_round` with `runId`, `leaseGeneration`, `round` (1-based),
  `finalRound`, `requestedToolIds` (in plan order, duplicates kept), and the counts `executed`, `repeated`,
  `denied` and `refusedFinalRoundSearch`. **No arguments and no question text.**
- Emit it through a new optional reporter hook, following the `analysisAttempt` pattern added in `ea590a1a`:
  - TS: `PipelineReporter.planningRound?(fields)` in `pipeline.ts`, logged in `apps/runner/src/jobExecution.ts`.
  - Rust: `fn planning_round(&self, _: PlanningRound) {}` in `crates/research-application/src/reporter.rs`, logged in
    `crates/research-runner/src/job_execution.rs`.
  - Add the event to `SHELL_EVENTS` in `crates/research-runner/src/log_events.rs` (array length 27 → 28) and to the
    TS logger's event list if there is one (grep `research_analysis_attempt`).
- Document it in `docs/rule/logging.md` next to "Research analysis attempts", with a `jq` example.
- Tests: mirror the `research_analysis_attempt` tests in `apps/runner/test/jobExecution.test.ts` and
  `crates/research-runner/src/job_tests.rs`. Assert that the log line contains tool ids but not the query.

## 5. Commit order

Each step is one commit with its tests. The order follows the risk: 4.1 and 4.2 alone would have fixed this question.

1. 4.2 SQL (TS only, behind the API), with the bench before and after.
2. 4.1 tool output (TS and Rust, tool version 1.1.0, vectors).
3. 4.3 planning leads (contract change in both runners, pipeline vectors).
4. 4.4 notes and prompt (`research-v11`, pipeline vectors).
5. 4.5 logging.
6. Docs: a new ADR-0080, with a status note in ADR-0071 pointing at it (tiers, tool 1.1.0, token-bounded terms,
   planning leads). Also: an AGENTS.md pointer line, `docs/REQUIREMENTS_STATUS.md`, `docs/rule/logging.md`.
   Check `ls docs/adr` on main for the next free number right before committing.

## 6. Verification

- `bun run verify`. `cargo test -p research-application -p research-runner -p research-agent-core --locked`.
- `node scripts/vectors/index.ts --check pipeline` and the tool-output vectors.
- `bun run formal:check`: no Lean change is expected, because matching lives in the SQL adapter and
  `interleaveSearchResults` is unchanged. If any of the logic moves into `packages/domain`, it gets a Lean model and
  vectors first.
- `bun run bench` before and after 4.2.
- Real environment (owner's rule): on development, with the real launcher and the Rust runner, ask the same question
  with Sarashina and with one more backend. The run must complete, cite J-Quants statements of real shipbuilders
  (内海造船, 名村造船所), show no wasted repeat, and log `research_planning_round` lines. Repeat once with
  `RESEARCH_RUNNER=node`. Run `tests/real/stockResearch.live.spec.ts`.
- Quick check without the UI: the replay approach in §7. It needs about 1.6 GB of free disk for the database copy.

## 7. Replay harness (from the investigation)

The script was `…/scratchpad/replay/replay.ts` in session `ee2b0b5e`. The scratchpad may be cleared; if it is gone,
rebuild it as follows. Run it with `node --env-file=apps/runner/.env replay.ts <db copy> <request.json>`.

- Agent: `createAgentRuntimes` from `packages/adapters/src/providers/index.ts`, picking `request.agentId`.
  Wrap its `run` to print the planner reply, which arrives as the `text.delta` events of each turn.
- Tools: `createResearchTools` without `web.fetch_page`, plus `createStockResearchTool`, whose search calls
  `createStockResearchRepository(openNodeSqlite(copy)).search("owner@localhost", q)`.
  Wrap each tool's `execute` to print its arguments, its evidence count and the start of its model text.
- Pipeline: run `runResearchPipeline` with the job's `request_json`, `EMPTY_USAGE` and a printing reporter.
- Copy the database with `sqlite3 <dev db> ".backup <copy>"`. The dev D1 file is
  `data-dev/d1/v3/d1/miniflare-D1DatabaseObject/bcbc…aa9.sqlite`. The copy takes a few minutes while the dev server
  runs.

## 8. Where to resume

- Main is at `ea590a1a`. The other session's research-latency work, which touched the same files, is committed.
  The working tree was clean except for this plan.
- Disk had about 3 GB free (`target/` is 4.9 GB), so there was no room for a separate worktree with its own
  `node_modules`. Work in the main checkout, keep each step small, and remember that the owner's `bun run dev` serves
  this checkout: a half-edited Worker file can stop the dev stack. Alternatively, free disk first and use a worktree
  under `../stock_investigation.worktrees`.
- Next action: step 1 of §5. Extend the fixtures, write the failing SQL tests, then change `DOCUMENTS` and the outer
  `SELECT` in `packages/adapters/src/sql/stockResearch.ts`.
