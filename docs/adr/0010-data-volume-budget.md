# ADR-0010: Data-volume budget for model prompts and the app API

**Status:** Accepted · **Date:** 2026-10-12

## Context

The owner requires: "Design the system to minimize data volume when sending data to the API." The API that matters most is the language-model API: every prompt byte is paid for in quota, money or latency (FR-016). The pipeline's adapters are stateless (text in, text out, ADR-0003), so each turn re-sends its whole prompt — repetition, not content, is the cost driver. Before this change each planning prompt re-sent all earlier tool output via `tail(log, 40_000)`, and the analysis evidence pack carried exact duplicates twice.

## Decision

**Planning prompts show each tool output fully once, then as a digest.** The next planning prompt after a collection step carries that step's full `modelText`; every later planning prompt represents older results by one digest line per evidence item (`[<evidenceId>] <title> — <publisher>; <publishedAt or "undated">`, or `<toolId>: <n> record(s), no evidence` when a result produced none). Denial and failure notes are already one line each and persist through the digest, so the model does not repeat a refused call. The digest keeps the most recent lines that fit `PLANNING_DIGEST_MAX` bytes via `recentCountWithinBudget` (no second selection loop) and says `(n older entries omitted)` when lines drop. Fresh and digest sections stay inside the single fenced untrusted-data block (AGT-007): evidence titles come from retrieved pages and are untrusted too. `collected.log: string[]` became per-tool-call entries (step number, full text, digest lines); `tail` and `COLLECTED_TEXT_WINDOW` are deleted. Prompt text changed, so `PROMPT_VERSION` is `research-v4`.

**The evidence pack carries each text once.** Items whose `checksum` matches an item already packed are skipped; a skipped duplicate is not shown and therefore cannot be cited (only shown evidence may be cited) — the first copy carries the citation. The skipped-duplicate count is reported in the existing omitted-evidence progress note.

**Nothing is sent that the run cannot use.** The planning prompt already listed only permitted tools; now the "Subscribed news sources" list is also omitted when no permitted tool takes a `sourceId` (detected from the tools' `argsHint`), and the conversation-context block stays absent when there is no context (as before).

## Model-API payload budget

| Payload | Contains | Hard ceiling | Enforced by |
|---|---|---|---|
| Planning prompt | Ground rules, request, optional context, permitted-tool catalog, optional sources, previous step's full tool text once, digest of older steps, one fence | 76,000 bytes (`PLANNING_PROMPT_BUDGET_BYTES`) | Fixed overhead 4,000 + tool catalog 4,000 (never drops a tool) + sources 8,000 (titles cut to 80 chars, most relevant that fit, `(n more sources not listed; use the ids above)`) + context 4,000 (newest that fit) in `prompts.ts`; fresh 48,000 UTF-8 bytes + digest 8,000 via `recentCountWithinBudget` in `pipeline.ts`; the builder fits collected into the remainder so the ceiling holds by construction, and the collection loop refuses to send a prompt over budget (fail closed) |
| Analysis prompt | Ground rules, request, optional context, evidence pack, record summary, dataset guide, canvas summaries | Pack ≤ 150,000 bytes; prompt ≈ 170,000 bytes worst case | `EVIDENCE_PACK_MAX`, `EVIDENCE_ITEM_MAX` (4,000), checksum dedupe (`pipeline.ts`); record summary sliced to 8,000 chars; components ≤ 60 (`packages/contracts/src/jobs.ts`); context ≤ `CONVERSATION_CONTEXT_LIMITS` |
| Analysis repair | Same as analysis plus one `repairNote` line | Same as analysis | One repair attempt only, then a typed failure (ADR-0003) |
| Verification prompt | Ground rules plus, per supported claim, its text and supporting quotes only | ~230,000 bytes worst case (40 claims × ≤ 5,800 chars) | Claims ≤ 40, links ≤ 12, quotes ≤ 400 chars (`draft.ts` `analysisDraftSchema`); only `supported` claims are sent |

## Measured before/after

Scenario (`packages/application/test/promptVolume.test.ts`): 5 collection steps × 2 tool calls, each returning 5,000 bytes of `modelText` and 3 evidence items of 3,000 characters; one item per step after the first exactly duplicates a previous step's item (same text, same URL, same checksum); then analysis and verification succeed.

| Payload | Before (bytes) | After (bytes) |
|---|---|---|
| Planning prompt 1–5 | 1,321 · 11,459 · 21,509 · 31,559 · 41,411 (sum 107,259) | 1,246 · 11,978 · 12,439 · 12,906 · 13,374 (sum 51,943) |
| Analysis prompt | 98,666 | 86,167 |
| Verification prompt | 1,275 | 1,275 |
| **Total** | **207,200** | **139,385 (67.3%)** |

The 60% target from the task brief was not reached, and the scenario was deliberately not weakened to reach it: the previous step's full output alone is ~10 kB per prompt (required — it is shown exactly once), and all 26 unique evidence items must stay in the pack to remain citable. The remaining repetition is load-bearing, not avoidable.

## Page-to-Markdown fixture saving

The div-layout article fixture in `packages/adapters/test/tools/htmlToMarkdownHeuristics.test.ts` (two skip links, a site-title `<h1>`, a 70-entry tag menu, the article, a 12-entry statistics farm, a footer `<div>`) converts from 6,428 characters before the heuristics to 769 characters after (12% of before; the task budget was 60%), because the skip links, the site title, both link farms, the footer and every block before the article `<h1>` are dropped and counted instead of sent to the model API.

## The app's own HTTP API

| Payload | Contains | Ceiling | Enforced by |
|---|---|---|---|
| Polled routes (runs, run detail, workspace view, messages, conversations) | JSON body or an empty 304 | Body size of one page; 304 sends nothing | `conditionalJson` + `fingerprint` (`apps/api/src/http.ts`), validators in `apps/api/src/app.ts` |
| Workspace view | State, datasets, sources and assets in one round trip (no N+1) | Resolved reference closure | `workspaceViewSchema` (`packages/contracts/src/api.ts`), `workspaces.view` (`packages/application/src/workspaces.ts`) |
| Conversation messages | One page plus a `hasEarlier` flag from one extra row | `limit` 1–200, default 200 | `MESSAGE_LIMIT` (`workspaces.ts`), handler clamp + ETag over page params (`app.ts`) |
| Conversation previews | First 160 characters of the last message | 160 chars, cut in SQL | `substr(last.text, 1, 160)` (`packages/adapters/src/sql/repositories.ts`), `lastMessagePreview` max 160 (`contracts`) |
| Request bodies | Any owner/runner JSON body | 1,000,000 bytes | `MAX_REQUEST_BODY_BYTES` (`contracts/src/api.ts`) via `bodyLimit` → `PAYLOAD_TOO_LARGE` (`app.ts`) |
| Conversation context into prompts | Most recent messages that fit | 6 messages, 600 chars each, 2,400 bytes | `CONVERSATION_CONTEXT_LIMITS` (`contracts/src/jobs.ts`), `buildConversationContext` (`application/src/research/conversationContext.ts`) |

## What was deliberately NOT done

- **No summarisation by a model.** It would cost a model call and could drop a quotable passage or an evidence id the analysis must cite; the digest is mechanical and lossless for citations.
- **The analysis repair still re-sends the evidence pack.** Adapters hold no session, so a repair turn cannot reference "the pack from last time".
- **No truncation of unique evidence.** Items that do not fit `EVIDENCE_PACK_MAX` are omitted and reported, never cut mid-passage in a way that breaks verbatim quotes.
- **The last collection step's tool text never appears in a planning prompt.** There is no next prompt; it reaches the model through the analysis pack. This falls out of "shown once in the next prompt" and is covered by the digest rule for every step that has a later prompt.
- **The verification prompt keeps its shape.** It already sends only claim texts and their quotes; there was no repetition to remove.
