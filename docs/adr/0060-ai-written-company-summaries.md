# ADR-0060: AI-written company descriptions and investment themes

Status: accepted, 2026-11-02. Builds on ADR-0020 (one agent turn with no
tools, the notebook assistant's pattern), ADR-0051 and ADR-0054 (the
server queues every sync at claim time), ADR-0053 (the US business
description) and ADR-0059 §3 (a Japanese stock's J-Quants profile).

## Context

The owner asked (2026-11-02): "Please add company descriptions to the
company info section and thema." The Stocks page's Company tab shows a US
stock's annual-report business section (ADR-0053) and a Japanese stock's
J-Quants sectors (ADR-0059 §3), but no description of a Japanese company —
J-Quants has none, and EDINET was removed — and no investment themes for
any company.

Asked on 2026-11-02 (AskUserQuestion), the owner chose:

- **Source:** an AI-written summary — the AI agent chosen in Settings → AI
  agent writes it, stored with its date (over bringing EDINET back or
  Wikipedia's lead paragraph).
- **Themes:** investment themes — tags such as AI, 半導体, EV, 防衛,
  インバウンド — shown as chips on the Company tab (over the sector
  classification or tags the owner types).

## Decision

### 1. What is written

For each stock, one `CompanySummary` (`packages/contracts/src/companySummary.ts`):
a description of 2 to 4 sentences (at most 1,000 characters) of what the
company does and where it earns its revenue, and 1 to 8 investment themes
(at most 40 characters each) — every text in English **and** Japanese, so
the Company tab shows the UI's language without a second turn. No advice,
price targets or forecasts.

### 2. The `company-summary` job

A new runner job kind, `company-summary`, one agent turn per stock, like
the notebook assistant (ADR-0020): no tools (`permittedToolIds: []`,
`maxToolCalls: 0`), no network, the job's own scratch directory, the
backend's tool isolation enforced unless the owner allowed unverified
isolation. The prompt (`companySummaryPrompt`, first line `COMPANY SUMMARY
TURN v1`) asks for one JSON object; the reply is validated with
`companySummarySchema`; one repair turn names what was wrong; a second
invalid reply fails the job `COMPANY_SUMMARY_REPLY_INVALID` (not retried).
Over 32,000 prompt bytes fails `COMPANY_SUMMARY_PROMPT_TOO_LARGE`.

The claim carries the facts the server has stored
(`companySummaryFactsSchema`), so the summary rests on them rather than on
the model's memory alone: the directory's English and local names and
listing, a Japanese stock's J-Quants 33- and 17-sector names, and the
first 4,000 characters of a US stock's annual-report business section.
Each fact travels fenced as untrusted data (AGT-007).

The stored request is `{ stockId, agent }`; the agent choice is nested
(never a top-level `agentId`), so the claim never reads the job as a
research request. The claim waits for a runner that has the agent
available. Both runners run the kind (TypeScript `runCompanySummaryTurn`,
Rust `research-application`), with the same prompt.

### 3. When the server queues it

At claim time (ADR-0051, ADR-0054), at most once a minute per owner
(`COMPANY_SUMMARY_CHECK_INTERVAL_MS`, the claim-time gate), while
`SERVER_DATA_SYNC` is on and an AI agent is chosen in Settings (a backend
that needs a model — OpenCode, OpenRouter Free — only with one chosen) and
the claiming runner has it available: the first Watchlist stock, in
Watchlist order, that has no `stock_company_summary` row, or whose row was
queued more than 24 hours ago and holds no summary or one older than 90
days. One `company-summary` job at a time (the INSERT refuses a second
unfinished one, like `financial-sync`); it is a server sync kind, outside
the cap on the owner's unfinished runs, pruned like the other sync jobs
and left out of the run list. Queueing sets the row's `queued_at`, so a
failing stock is tried again a day later at the earliest and never in a
loop.

Each summary is one agent turn: on a plan-limited backend it uses the
plan's quota, on a metered one it costs that turn's tokens (reported as the
job's usage). With 12 Watchlist stocks that is 12 turns once, then 12
every 90 days.

### 4. Storage and read

`stock_company_summary` (migration 0028,
[table document](../database/tables/stock_company_summary.md)): one row per
stock — `queued_at`, both descriptions, the themes as JSON, the agent and
model that wrote them and `generated_at` — written in the completion's
guarded batch. No foreign key: a summary stays when its stock leaves the
Watchlist. `GET /api/v1/stocks/:stockId` returns it as `summary`
(`companySummaryViewSchema`) or null.

### 5. The Company tab

A first section, "About the company" (企業の説明): the description in the
UI language, the themes as a list of chips under "Themes" (テーマ), and the
line "Written by AI (claude-code, <model>) on Nov 2, 2026. It may contain
mistakes." — the summary is always marked as written by AI. With none
stored, one sentence says the server asks the agent chosen in Settings to
write one for each Watchlist stock. The Listing, Business (US) and Company
profile (JP) groups follow unchanged.

## Consequences

- Every Watchlist stock gets a description and themes in both languages
  without the owner asking, once an AI agent is chosen; a Japanese
  company finally has a description.
- The text is the model's, not a filing's: it can be wrong or out of date.
  The tab says so on every summary, keeps the filing's own words (US) and
  J-Quants' sectors (JP) beside it, and rewrites it every 90 days.
- It spends model quota or tokens in the background (one turn per stock).
  Choosing no agent in Settings, or `SERVER_DATA_SYNC=off`, stops it.
- Runner builds older than this ADR cannot decode the new kind: the claim
  answer fails validation in them. Update the runner with the server.
- Rollback: migration 0028's header (drop the table, delete the
  `company-summary` jobs) before starting an older build.
