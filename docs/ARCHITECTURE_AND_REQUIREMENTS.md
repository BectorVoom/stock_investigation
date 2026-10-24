# Personal AI Research Workspace — Architecture and Requirements

**Status:** Accepted baseline
**Version:** 1.7
**Date:** 2026-10-24
**Companion:** [ENGINEERING_DESIGN_RULES.md](ENGINEERING_DESIGN_RULES.md)

**Change note (1.6 → 1.7):** FR-021 (scheduled tasks) is a new Must
requirement (ADR-0033): a research question saved with a schedule runs by
itself in its own conversation, on the agent saved in Settings → AI agent;
tasks are managed on a new Tasks page (`#/tasks`) and shown by a new
`scheduled-tasks` widget on Home and in the Notebook. A task fires when a
runner claims work (no cron; ADR-0004 stands), missed times collapse into
one run, and a refused occurrence is skipped with its reason. The journey
list gains step 10 and the endpoint list the five task routes.

**Change note (1.5 → 1.6):** at the owner's request (ADR-0022) the calendar
settings — the Google Calendar card, the `.ics` download and the
subscription feed — moved from the Watchlist page to Settings → Calendar
(`#/settings/calendar`), and the Watchlist page's month calendar was
removed: the Home/Notebook `earnings-calendar` widget is the only month
grid, and its announcement days link to the Watchlist page. FR-018 and
FR-019 acceptance text changed accordingly; no endpoint changed.

**Change note (1.4 → 1.5):** FR-020 (Chat-first to Notebook-first
workspace) is a new Must requirement (ADR-0020): every conversation keeps a
versioned Notebook of widgets built on `@research/widget-grid`, the Chat page
has exactly two states, and a notebook assistant — a new job kind that reads
no fetched text — edits that one notebook through validated widget commands.
The endpoint list gains the four notebook routes. ADR-0003 §6 and ADR-0019
are amended for that job kind only; research runs are unchanged.

**Change note (1.3 → 1.4):** FR-019 (earnings month calendar and Google
Calendar sync) is a new Must requirement with its journey step, endpoints and
vendor decision (ADR-0018); the Home earnings-calendar widget is glanceable
after the Apple widget guidelines and deep-links to the Watchlist calendar;
the endpoint list gains the three Google Calendar routes; the references gain
the Google Calendar and OAuth documentation. That decision changed no other
requirement.

**Change note (1.2 → 1.3):** FR-018 (watchlist + earnings-date calendar) is
a new Must requirement with its journey, endpoints and vendor decision
(ADR-0016); "Out of scope" keeps automated scraping in conflict with
publisher restrictions out while JPX's published schedule fetched on request
is in; the endpoint list gains the watchlist, feed and runner earnings
routes; the references gain the two earnings sources.
That decision changed no other requirement.

**Change note (1.1 → 1.2):** approved images are withdrawn in full by the
owner's decision of 2026-10-13 (ADR-0013): FR-011 no longer names images, the
V1 component list drops `image-gallery` (nine types), the `/assets` endpoints
and the `approved_assets` table are gone, and stored pre-removal galleries are
stripped on read. That decision changed no other requirement.
Also in 1.2: FR-017 (Home dashboard) is a new Must requirement with its
journey, endpoints and vendor decision (ADR-0014); "Out of scope" now keeps
streaming / real-time market feeds out while end-of-day and periodic series
retrieved on request are in; the endpoint list gains the Home routes; the
Shoelace-on-Home decision is ADR-0015.

**Change note (1.0 → 1.1):** the deployment section now describes the local-first
default and the two local environments (ADR-0006, ADR-0011) instead of a
Cloudflare-first layout; the agent protocol notes the request's `webAccess` and
the claimed job's conversation context; the endpoint list matches the route
table; the repository structure lists the current packages, adapter, test and
rule directories. No requirement changed.

## 1. Purpose, scope, and constraints

Build a **single-user**, agent-driven research web application that discovers current news, develops evidence-based hypotheses about products and services likely to experience demand growth over a **three-to-five-year horizon**, and identifies Japanese and US listed companies capable of supplying them. An agent can compose and update tables, charts and source lists in a persistent chat workspace. The application is a research instrument, **not an autonomous securities trading system or an investment-advice guarantee**.

### Non-negotiable constraints

- **Very low recurring budget:** default to Cloudflare Workers Free and D1, with a local computer performing CLI agent execution. No always-on paid container, Kubernetes cluster, or mandatory paid LLM API.
- **Personal use:** one authenticated owner; no public signup, organizational tenancy, or multi-user RBAC in V1. Owner authentication is still mandatory.
- **Technology:** SolidJS + TypeScript + Vite SPA, Hono on Cloudflare Workers, D1; add R2 when artifact size warrants it.
- **Agent backends:** OpenCode, Codex, Claude Code and OpenRouter are supported through distinct adapters. Local CLI operation is permitted **only according to each provider's supported authentication methods, plan limits, and terms**; a subscription is not assumed to be an unrestricted API entitlement.
- **Future extensibility:** additional UI components, research tools and data sources must be installable without rewriting the chat, orchestration or evidence domains.
- **Evidence and reproducibility:** no unreferenced factual financial claims, silently invented market data, or fabricated URLs.

### Out of scope for V1

Automatic order placement, brokerage credentials, multi-user collaboration, autonomous code editing by research agents, unbounded web crawling, automated scraping in conflict with publisher restrictions, streaming / real-time market feeds (end-of-day and periodic series retrieved on request by the local runner are in scope, FR-017), and self-hosted GPU inference.

## 2. Primary user journeys

1. **Configure sources:** enter a news URL, inspect site and feed metadata, validate safety/licensing, subscribe or remove it; browse recommended editorial sources and register them.
2. **Ask a research question:** request emerging demand areas over three to five years, choose agent backend, maximum effort and budget, and view running progress in chat.
3. **Inspect evidence:** read supporting and contradictory sources, publication dates, data-as-of dates, URL links and methodological assumptions.
4. **Map suppliers:** discover specific Japanese and US companies, their relevant goods/services, business exposure, pricing power and financial metrics.
5. **Inspect positions and investors:** show Japanese margin buy/sell balances; show US short interest separately; surface investor filings with dates and properly qualified conclusions.
6. **Manipulate research UI:** ask the agent to create/update/remove tables, graphs and timelines. Reopen an existing workspace without rerunning research.
7. **Continue without local compute:** when the local runner is offline, browse prior findings and queue research; pending jobs resume when a valid runner reconnects.
8. **Check market prices at a glance:** arrange Home widgets over market series and queue a market-data refresh for the local runner; every number shows its unit, as-of date and source link.
9. **Follow earnings dates:** register US and Japanese stocks on the Watchlist — each add queues its own earnings-date refresh, and opening Watchlist or Home with dates never fetched or more than a day old queues one refresh (once per visit) — browse the month calendar, keep a dedicated Google calendar in step (connect once, then sync on request or automatically when the dates drift), keep the dates in your own calendar (`.ics` download, per-date links, secret subscription feed), and watch the window on Home; an unknown date is "unavailable (reason)", never a guess.
10. **Schedule a research question:** save a question with a schedule (once, daily, weekdays, weekly, monthly, in a time zone) on the Tasks page; it runs by itself on the agent saved in Settings, its answers collect in the task's own conversation, and a Scheduled tasks widget on Home or in a Notebook shows the next runs and the latest results with Pause and Run now.

The page for each journey step is mapped in [PAGES.md](PAGES.md).

## 3. Requirements catalog

| ID | Requirement | Priority | Acceptance condition |
|---|---|---|---|
| FR-001 | Register, preview, update and remove RSS/Atom/API/eligible HTML news sources | Must | Invalid/unsafe targets rejected; records persisted |
| FR-002 | Offer a curated, editable recommendation catalog | Must | Owner can preview and subscribe without automatic silent enrollment |
| FR-003 | Discover and deduplicate new news items | Must | Repeated ingestion does not create duplicate canonical articles |
| FR-004 | Analyze 3–5 year demand scenarios for services/products | Must | Explicit drivers, counterevidence, units, dates and scenario assumptions |
| FR-005 | Associate suppliers with Japanese and US securities | Must | Identifier, exchange, business exposure and evidence for supplier relationship |
| FR-006 | Report PER and net profit margin | Must | Defined formula, accounting period, currency and market-data timestamp |
| FR-007 | Show Japanese margin buy/sell balances and US short interest | Must | Market-specific labels; no fabricated US stock-level margin-buy equivalent |
| FR-008 | Show notable investor holdings/filings | Must | Filing links, reporting period, filing date; 13F not described as real-time purchase |
| FR-009 | Analyze firms with successful pricing changes | Must | Price realization distinguished from margins, mix, volume, FX and input costs |
| FR-010 | Conversational, persistent research and source hyperlinks | Must | Linked claims and stored chat survive reload |
| FR-011 | Agent-driven tables/charts (approved images withdrawn by the owner's decision of 2026-10-13, ADR-0013 — not silently rewritten: the image half of this requirement is struck, the rest stands) | Must | Only validated registry commands render; no executable generated code |
| FR-012 | Choose OpenCode, Codex, Claude Code or OpenRouter (plus OpenRouter free models and the Claude API, ADR-0031) | Must | Adapter capability negotiation; unavailable backend surfaced honestly |
| FR-013 | Add components/tools/providers later | Must | Example extension passes contract tests without changing orchestrator core |
| FR-014 | Cancel, retry and resume research jobs | Must | State machine and lease recovery tested |
| FR-015 | Export/import a portable research record | Should | Versioned JSON/Markdown including citations; invalid files rejected |
| FR-016 | Explain cost and show current job resource limits | Must | Max calls/time/spend visible; no paid fallback without consent |
| FR-017 | Home dashboard: arrange widgets over market series with unit, as-of date and source on every number | Must | Owner-arranged widgets show FRED / Twelve Data series refreshed on request by the local runner; arrangement stored on the server and surviving reload; nothing fabricated |
| FR-018 | Watchlist and earnings-date calendar: register US/JP stocks, refresh their announcement dates automatically and on request, keep them in your own calendar | Must | Watchlist page (`#/watchlist`) with add/remove/refresh and per-date Google/Outlook links; Settings → Calendar (`#/settings/calendar`) with the `.ics` download and a secret-token subscription feed; Home `earnings-calendar` widget over a day window with its own refresh button; Finnhub (US, keyed) + JPX schedule (JP, keyless) refreshed by the local runner — each add queues its own refresh, and a view with dates never fetched or more than a day old queues one refresh per mount; arrangement and dates stored on the server and surviving reload; unknown dates "unavailable (reason)", never fabricated |
| FR-019 | Earnings month calendar and Google Calendar sync: browse announcement dates on a month grid and keep a dedicated Google calendar in step | Must | Settings → Calendar (`#/settings/calendar`) with the Google Calendar card (connect, sign-in link, sync, disconnect, fixed failure sentences); Home `earnings-calendar` widget glanceable after the Apple widget guidelines and the only month grid (announcement days link to the Watchlist page, at most 3 next announcements, one status line, Refresh + Open Watchlist; amended by ADR-0022, which removed the Watchlist page's full month calendar); runner-side loopback OAuth holding the only `calendar.app.created` scope, deterministic idempotent sync with `inSync` derived from the current digest, automatic sync only while no failure is on record and at most once per watchlist ETag, no automatic retry of a Google step, a grant that is not kept is revoked; unknown dates "unavailable (reason)", never fabricated |
| FR-021 | Scheduled tasks: research questions that run on a schedule (ADR-0033) | Must | Tasks page (`#/tasks`): create, edit, pause/resume, run now and delete (with confirmation) tasks with a title, question, horizon, markets, schedule (once / daily / weekdays / weekly / monthly at a local time) and time zone; at most 10 active and 30 stored; each task has its own conversation where its runs' questions and answers land; a task fires when a runner claims work, with at most one unfinished run per task, missed times collapsing into one run, a skipped occurrence recorded with its reason, and a metered backend only with the task's own spend consent (AGT-012); `scheduled-tasks` widget on Home and in the Notebook (next runs, latest results, Pause/Resume, Run now, New task, Open Tasks); stored on the server and surviving reload |
| FR-020 | Chat-first to Notebook-first workspace: think in Chat, keep results as widgets, organise them in a Notebook the AI can also edit | Must | Chat page (`#/chat/<id>`) in exactly two states — Chat-first and Notebook-first, switched directly, remembered per conversation; a per-conversation Notebook (text, metric, chart, table and research widgets; S/M/L sizes; drag to reorder; edit, duplicate, remove with confirmation; 20-step undo) persisted with compare-and-set; "Add to Notebook" on answers and research results; a notebook assistant that creates, edits, moves, resizes and duplicates widgets of the selected context through validated commands, proposes removals for the owner to confirm, and shows every change with Undo (ADR-0020) |

## 4. Deployment and component architecture

The workspace runs on the owner's PC by default (local-first, ADR-0006), in two
separate local environments (ADR-0011): **production** (`bun run prod`, the built
release on http://localhost:8787, data in `data/`) and **development**
(`bun run dev`, the working tree live with hot reloading, data in `data-dev/`).
Deploying the same Worker code to Cloudflare is optional and currently
postponed; see [OPERATIONS.md](OPERATIONS.md). What follows is the component
shape, which is the same in every environment: locally the Worker API runs
under `wrangler dev` with a SQLite-backed D1, so no second server
implementation exists.

```text
                        Browser (single owner)
                 SolidJS SPA + component registry
                           |
                    HTTPS authenticated
                           v
             Cloudflare Worker / Hono thin API
             auth | validation | jobs | events
                           |
                          D1
          sources | articles | claims | jobs | UI state
                           ^
                           | authenticated outbound HTTPS
                           | claim/lease/heartbeat/results
                           |
           Local Agent Runner (on PC; Rust, ADR-0030)
             scheduler | policy | tool registry
                           |
      +--------------------+----------------------+----------------+
      |                    |                      |                |
  OpenCode SDK       Codex CLI/App        Claude Code CLI/SDK  OpenRouter
  (local process)    Server (local)       (local process)      (HTTPS)
      +--------------------+----------------------+----------------+
                           |
          restricted news/search/finance/evidence tools
```

Cloudflare Workers must **never be expected to spawn local CLI binaries**. The runner initiates connections to the Worker; no inbound home-network port or direct browser-to-CLI connection is required. Do not expose an OpenCode server to the public Internet. R2 is optional for larger exported reports. KV, Queues, Durable Objects and Workflows are **deferred** until a measured need arises. Persistence sits behind two seams (ADR-0008), so the same API suite passes on D1 and on `node:sqlite`.

### Layer boundaries

- **Presentation:** SolidJS rendering, UI events, ephemeral interaction state; no LLM credentials, SQL or finance calculation.
- **Hono API:** session authentication, CSRF/origin policy, runtime validation, owner scoping, route mapping, rate limits; thin handlers.
- **Application:** use-case orchestration, job state transitions, evidence linking, approval gates and workspace actions.
- **Domain:** pure calculations, policies, normalized article and company data, validated command state transitions.
- **Ports:** typed interfaces for agent runtime, news source, market data, claim store, job repository, clock and artifact store.
- **Adapters:** D1, RSS/API fetch, financial data source, local CLI runtime and OpenRouter implementation; no reverse dependencies into domain.

## 5. Cost control and runtime behavior

1. **V1 minimum:** Workers + D1 + outbound-polling local runner. Use static assets bundled with Worker deployment. Avoid unnecessary per-second browser polling; use adaptive intervals, document visibility handling and conditional ETags.
2. **Queue semantics:** D1-backed jobs with transactional claiming (compare-and-set), short-lived lease, heartbeat, attempt count, immutable run ID, idempotency key and retry ceiling. The server must not grant one active lease to multiple runners. Stale results from superseded lease generations are rejected.
3. **Failure:** if the runner stops, a lease expires and job returns to eligible state; stored workspace remains available. Side effects must remain idempotent under crash/retry.
4. **Explicit budget:** owner sets max agent steps, tool calls, wall-clock time, input size and API spend where available. No auto-paid fallback. When cost cannot be estimated for subscription-based CLI access, label as **unknown/plan-limited** rather than $0.
5. **Billing reality:** API/data licensing fees may dominate hosting cost. Record provider, data license, request counts and available metering; avoid unsupported claims about ongoing free access.
6. **Resource ceilings:** constrain article count, downloaded bytes, article extraction time, parallelism, payload size, stored snapshots and retention.

## 6. Agent execution protocol

### 6.1 Common contract

```ts
type AgentId = 'opencode' | 'codex' | 'claude-code' | 'openrouter';
type Capability = 'stream' | 'cancel' | 'tool-calls' | 'structured-output' | 'image-input';
interface AgentCapabilities { supported: readonly Capability[]; model?: string; }
interface AgentRequest {
  runId: string;
  conversationId: string;
  prompt: string;
  permittedToolIds: readonly string[];
  maxToolCalls: number;
  deadline: string;
  /** Whether the `web.fetch_page` tool is on this run's allowlist. */
  webAccess: 'off' | 'public-web';
}
type AgentEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.request'; toolId: string; args: unknown; callId: string }
  | { type: 'tool.result'; callId: string; resultRef: string }
  | { type: 'ui.command'; command: unknown }
  | { type: 'usage'; knownCostUsd: number | null }
  | { type: 'completed' }
  | { type: 'failed'; code: string; retryable: boolean };
```

Provider-specific controls can be narrower than the common contract. The adapter must reject unsupported capabilities, not pretend that a process kill equals reliable cancellation or that text parsing equals guaranteed structured output. Persist a provider session reference independently from canonical chat history. No CLI receives database credentials or Cloudflare owner authentication secrets.

A claimed research job carries, beside the request, the run's bounded
conversation context (at most 6 earlier messages, 600 characters each, 2,400
UTF-8 bytes in total, read at the run's context anchor so later messages cannot
push the question out — `conversationContextSchema` in
`packages/contracts/src/jobs.ts`), the prior usage a retry continues from, and
summaries of what is already on the canvas. Web access is per request: the
pipeline excludes every tool whose network allowlist is `public-web` unless the
request says `webAccess: "public-web"`, and the planning prompt lists only
permitted tools (ADR-0009).

`Retry run` (`POST /api/v1/research-runs/:id/retry`) queues a new run with the
original question, horizon and markets on the agent choice saved in Settings →
AI agent at the moment of the retry — backend, model, effort, web access and
spend ceiling — under the fixed limits (`RUN_LIMITS`, ADR-0029), so a failure
such as an overloaded model is fixed by choosing another model and retrying.
With nothing saved the original request is replayed. A retry onto a metered
backend is accepted only when backend, model and spend ceiling equal the
original run's, whose consent it repeats; otherwise it is refused
with `SPEND_CONSENT_REQUIRED` and the question must be asked again from the
composer (AGT-012). A saved OpenCode or OpenRouter (free models) backend
without a model is refused with `VALIDATION_FAILED`.

### 6.2 Tool policy

All tools have stable ID/version, input/output schemas, timeout, permission, cost category, side-effect classification and network allowlist. Research agents run with **no shell execution, arbitrary file write or unbounded network access by default**. Where a CLI cannot reliably enforce tool restrictions, isolate it in a disposable OS/container sandbox with restricted mounts, network and process privileges, or mark that backend unsupported for untrusted-source research.

### 6.3 Research lifecycle

`pending -> claimed -> planning -> collecting -> analyzing -> verifying -> publishing -> completed`

Legal terminal/exception states include `failed`, `cancelled`, `partial`, and `waiting_approval`; the exact state transition matrix belongs in the shared contracts package. Each transition is validated against current version/lease and appended to an audit trail.

## 7. Agent-driven UI: declarative protocol

Agent output is **data**, never executable JavaScript, arbitrary JSX or raw HTML. UI operations are a tagged union validated in Hono and again at the frontend trust boundary:

```json
{
  "protocolVersion": 1,
  "commandId": "cmd_123",
  "workspaceId": "ws_1",
  "expectedWorkspaceVersion": 4,
  "operation": "component.create",
  "componentId": "demand_table_1",
  "componentType": "data-table",
  "schemaVersion": 1,
  "props": {
    "title": "Demand scenarios",
    "datasetRef": "dataset_20",
    "sourceIds": ["source_11"]
  }
}
```

Allowed baseline operations: `component.create`, `component.update`, `component.remove`, `component.focus`, `component.select`, `layout.update`, `dataset.bind`, `dataset.refresh` and allowlisted `navigation.open`. Persistent source registration, deletion and research execution are **separate authorized backend tools**, not hidden UI commands.

Registry entries define `componentType`, `schemaVersion`, `propsSchema`, `renderer`, `capabilities`, permission requirements and migrations. V1 types: `data-table`, `financial-table`, `line-chart`, `bar-chart`, `candlestick-chart`, `news-card`, `source-list`, `company-profile` and `research-report` (nine; `image-gallery` was withdrawn by the owner's decision of 2026-10-13, ADR-0013). Components must handle absent data, provenance badges, loading/error states and accessibility. Charts may only use validated dataset references.

Store domain state, workspace layout, command IDs and monotonic versions on the server; keep hover/scroll/dialog state local. Apply validated changes atomically and idempotently. Persist command history or compact checkpoints sufficient for recovery; **full event sourcing is not mandatory**.

## 8. Research and financial data integrity

### 8.1 Core records

- `NewsSource`: canonical URL, source type, license policy, trust classification, feed status, timestamps.
- `Article`: canonical URL, publisher, publication/retrieval timestamps, stable content fingerprint and extracted references.
- `Evidence`: source URL, title, publisher, published/retrieved/effective timestamps, excerpt if permitted, checksum and source class.
- `Claim`: claim text, claim type (`observation`, `inference`, `hypothesis`, `forecast`), status, linked evidence with `supports`/`contradicts`/`context` relation.
- `DemandScenario`: product/service, unit, base/target years, baseline, bear/base/bull assumptions, derived CAGR (nullable), contrary evidence, methodology.
- `Security`: country, ticker **and exchange**, issuer identifier, listing and reporting currency; track ticker changes.
- `FinancialObservation`: metric code, value or unavailable reason, unit, accounting standard/period, actual-vs-estimate, market data as-of, source.
- `PositionObservation`: jurisdiction, metric definition, shares/unit, reporting/as-of date and dissemination date.
- `InvestorFiling`: investor/reporting entity, form, reported quarter/date, filing URL, securities and reported quantities.
- `ResearchRun`: normalized request, model/provider, tool/prompt versions, data cutoffs, evidence and output IDs, verification status, resource usage.

### 8.2 Definitions and caveats

- **PER:** specify trailing or forward EPS, price time, earnings period and corporate-action adjustments. Missing/non-positive EPS => N/A, not a meaningful positive PER.
- **Net profit margin:** net income / revenue for the *same* reporting period; preserve accounting basis, continuing operations policy and unit.
- **Japan:** margin purchase and margin sale balances (credit trading) with the exchange/source-specific reporting definition.
- **United States:** short interest by security, **not** a direct equivalent of Japan's margin-sale balance; aggregate margin debt is not security-level margin-buy balance.
- **Notable investor purchases:** 13F reports end-of-quarter holdings, not execution timestamps. Say *newly reported holding* or *increase in reported position*, not verified recent purchase unless direct transaction evidence exists.
- **Pricing power:** corroborate realized price increases against volume, product mix, input prices, FX, gross/operating margin and management commentary. Do not treat margin improvement alone as proof.
- **Forecasts:** distinguish unit demand from revenue and nominal price growth; provide baselines, drivers, barriers, alternatives and falsifying observations. Do not present qualitative confidence as a calibrated probability.

Unlicensed content must not be copied wholesale into D1/R2. Unknown/missing records are `null` plus an explicit reason, never plausible-looking values. Date-sensitive measurements are immutable observations, not silently overwritten current values.

## 9. Trust and security boundaries

1. Authenticate the owner (no anonymous mutation); use HttpOnly/Secure/SameSite session cookies and CSRF protection for cookie-authenticated write operations.
2. Never expose LLM API keys, CLI session tokens, Worker secrets or database credentials to the browser or language-model prompts.
3. Enforce authorization on **every** API operation and resource ID, despite single-user assumptions. Bind runner identity to restricted capabilities.
4. Treat news articles, search results, LLM output and URL submissions as untrusted. Prompt text is not authorization.
5. For URL fetching: allow `https`, forbid credentials/private or loopback destinations and sensitive ports; enforce redirects per hop, byte/time limits and **network-level egress protections** against DNS rebinding/TOCTOU. If connection-time restrictions are unavailable, use an egress proxy/approved-host allowlist rather than relying on string checks.
6. Avoid `innerHTML` and executable generated snippets; sanitize any approved Markdown/HTML. Apply CSP and safe URL policies.
7. Constrain agent filesystem/network/process privileges; disable unsafe CLI auto-approval modes; use per-job scratch directories and discard them.
8. Validate source citations against fetched source IDs; verify claim support independently and show unsupported/conflicting claims explicitly.
9. Apply per-owner job and fetch rate limits, budget ceilings, output size limits and audit traces with sensitive content redaction.
10. Retain content subject to copyright/terms, and prevent unsafe reuse of externally hosted content.

## 10. API and persistence sketch

The versioned endpoints, exactly as implemented in `apps/api/src/app.ts`
(owner routes need the owner session plus CSRF defence; runner routes need the
bearer credential and refuse browsers):

```text
GET    /api/v1/session
GET    /api/v1/version
POST   /api/v1/sources/preview
GET    /api/v1/sources/recommended
POST   /api/v1/sources/refresh
GET    /api/v1/sources
POST   /api/v1/sources
PATCH  /api/v1/sources/:id
DELETE /api/v1/sources/:id
GET    /api/v1/articles?sourceId=...&cursor=...
GET    /api/v1/agents
POST   /api/v1/research-runs
GET    /api/v1/research-runs?workspaceId=...
GET    /api/v1/research-runs/:id
GET    /api/v1/research-runs/:id/records
POST   /api/v1/research-runs/:id/cancel
POST   /api/v1/research-runs/:id/retry
POST   /api/v1/research-runs/:id/approve
GET    /api/v1/workspaces
POST   /api/v1/workspaces/import
POST   /api/v1/workspaces
PATCH  /api/v1/workspaces/:id
DELETE /api/v1/workspaces/:id
GET    /api/v1/workspaces/:id
GET    /api/v1/workspaces/:id/events?after=...
POST   /api/v1/workspaces/:id/commands
GET    /api/v1/workspaces/:id/messages?before=...&limit=...
GET    /api/v1/workspaces/:id/notebook
PUT    /api/v1/workspaces/:id/notebook
POST   /api/v1/workspaces/:id/notebook/undo
POST   /api/v1/workspaces/:id/notebook/assist
GET    /api/v1/workspaces/:id/notebook/market-data
GET    /api/v1/conversations
GET    /api/v1/workspaces/:id/export
GET    /api/v1/runner-credentials
POST   /api/v1/runner-credentials
DELETE /api/v1/runner-credentials/:id
GET    /api/v1/settings/agent
PUT    /api/v1/settings/agent
GET    /api/v1/home/dashboard
PUT    /api/v1/home/dashboard
POST   /api/v1/home/dashboard/reset
GET    /api/v1/home/data
GET    /api/v1/home/catalog
POST   /api/v1/home/refresh
GET    /api/v1/watchlist
POST   /api/v1/watchlist/stocks
DELETE /api/v1/watchlist/stocks/:stockId
POST   /api/v1/watchlist/refresh
GET    /api/v1/watchlist/calendar.ics
POST   /api/v1/watchlist/feed
DELETE /api/v1/watchlist/feed
POST   /api/v1/google-calendar/connect
POST   /api/v1/google-calendar/sync
POST   /api/v1/google-calendar/disconnect
GET    /api/v1/calendar-feed/:token/earnings.ics
GET    /api/v1/scheduled-tasks
POST   /api/v1/scheduled-tasks
PATCH  /api/v1/scheduled-tasks/:id
DELETE /api/v1/scheduled-tasks/:id
POST   /api/v1/scheduled-tasks/:id/run
GET    /api/v1/runner/credential
POST   /api/v1/runner/credentials/renew
POST   /api/v1/runner/jobs/claim
POST   /api/v1/runner/jobs/:id/heartbeat
POST   /api/v1/runner/jobs/:id/events
POST   /api/v1/runner/jobs/:id/complete
```

`GET /api/v1/workspaces/:id/messages` accepts optional `before` (a message `seq`;
only messages with a smaller `seq` are returned) and `limit` (1..200, default 200),
and reports `hasEarlier` when older messages exist. `GET /api/v1/conversations`
lists one summary per workspace (message count, last-message preview cut to 160
characters, last-activity sort key), newest activity first. `PATCH
/api/v1/workspaces/:id` renames the conversation without touching the canvas
version; `DELETE /api/v1/workspaces/:id` removes the conversation with
everything it solely owns, atomically, and refuses with 409 while one of its
runs is unfinished. A research question accepted for a still-untitled
conversation without messages names it from the question's first line.

Each conversation keeps one versioned Notebook document (ADR-0020): `GET`
serves it with its version, the latest assistant turns and whether an undo
is available; `PUT` saves it with compare-and-set (`expectedVersion`), so a
stale tab or a concurrent assistant turn answers 409 instead of overwriting;
`POST …/notebook/undo` restores the body kept before the on-screen version
as a new version (the last 20 bodies are kept); `POST …/notebook/assist`
stores the instruction as the owner's chat message and queues one
`notebook-assist` job (at most one active per conversation, `Idempotency-Key`
required). `GET …/notebook/market-data` serves the live series of that
conversation's notebook market widgets (`market-metric`, `line-chart`,
`stock-table`, `indicator-table`) in the Home data shape with the same
conditional ETag as `/home/data`; the market refresh fetches the union of the
Home dashboard's series (first) and every notebook's series, at most 60, and
a Home save keeps stored series a notebook still names. Deleting a
conversation deletes its notebook, revisions and turns
with everything else it solely owns.

Home dashboards and notebooks hold widgets of one specification (ADR-0024,
`packages/contracts/src/widgets.ts`): the same types, fields, title rule and
sizes. The Home document is `schemaVersion: 2` (its live single-series widget
is `market-metric`); a stored version-1 document is upgraded when it is read,
and the API accepts only version 2.

All inputs and stored JSON are runtime-validated. Browser calls do not expose runner endpoints. Runner authentication is separately scoped, renewable and revocable. Maintain uniqueness constraints on canonical article IDs, command IDs, and job idempotency keys, and use conditional updates for leases/workspace versions.

## 11. Initial repository structure

```text
apps/
  web/                         # SolidJS SPA
  api/                         # Hono/Workers
  runner/                      # the TypeScript runner (the RESEARCH_RUNNER=node rollback, to be removed; ADR-0030)
  mcp/                         # stdio MCP server through which AI agents arrange Home (ADR-0019)
packages/
  contracts/                   # schema versions, API/UI/job contracts
  domain/                      # pure calculations and policies
  application/                 # use cases, state coordination
  agent-core/                  # agent port, tool policy and event mapping
  effects/                     # the one Effect logger, error bridge (ADR-0007)
  ui-registry/                 # typed registry and renderers
  adapters/                    # D1, RSS, finance, providers — split by runtime
                               # (`sql/` driver interface, `sqlite/` node:sqlite driver,
                               #  worker/node/fetchers beside them)
crates/                        # the Rust runner, a Cargo workspace (ADR-0030); one binary `research-runner`
  research-js/                 #   JavaScript semantics (UTF-16, whitespace, numbers, JSON)
  research-effects/            #   the one logger, CPU bridge
  research-domain/             #   pure calculations, ported from packages/domain
  research-contracts/          #   wire types and zod-parity decoders
  research-widget-grid/        #   widget document model
  research-agent-core/         #   agent runtime port, tool policy, registry
  research-application/        #   ports, research pipeline, ingest, notebook
  research-net/ -html/ -feed/  #   pinned HTTPS transport, HTML to Markdown, feed parsing
  research-tools/ -providers/  #   research tools; agent backends and process spawning
  research-finance/ -google/   #   market and earnings data; Google Calendar
  research-runner/             #   composition root: config, API client, poll loop, job shell
  research-runner-testkit/     #   E2E seams, never a dependency of the production binary
Cargo.toml, Cargo.lock         # the workspace (builds use --locked); build cache in target/
vectors/                       # conformance vectors exported from the TypeScript, replayed by cargo test
infra/                         # Cloudflare configuration/migrations
examples/                      # recorded fixtures, not production claims
tests/                         # unit, integration, architecture, e2e, security,
                               # `real/` (network, no quota), `ui-review`,
                               # `live/` (plan quota), `formal/`
formal/                        # Lean 4 proofs and conformance vectors
docs/adr/                      # architectural decision records
docs/rule/                     # logging, error handling, UI review, real-environment testing
docs/PAGES.md                  # the MECE page split (checked against apps/web/src/pages.ts)
AGENTS.md                      # compact entry to engineering rules
ENGINEERING_DESIGN_RULES.md    # canonical engineering rules
```

Code runs in two runtimes (Worker and local PC); do not accidentally import Node-only libraries into Worker bundles. Contracts and pure domain packages must be usable in both runtimes. The local PC runtime is Rust (the default since 2026-10-19, ADR-0030): the Worker and the Rust runner share the wire contract through conformance vectors instead of shared code. The launcher builds and starts either runner (`RESEARCH_RUNNER=rust|node`, default rust; see [OPERATIONS.md](OPERATIONS.md)).

## 12. Delivery plan and gates

| Phase | Deliverable | Exit gate |
|---|---|---|
| 0 | Repo, strict TS, CI, auth, threat model, migrations | all quality gates pass; no exposed secrets |
| 1 | Chat, Registry, validated UI commands, D1 workspace | create/update/reload/reject invalid commands E2E |
| 2 | D1 job queue, local runner (Rust, ADR-0030), OpenCode adapter | lease/retry/offline/idempotency failure injection |
| 3 | Codex, Claude Code and OpenRouter adapters | capability and auth compatibility tests; fail closed |
| 4 | Source catalog/URL validation/news retrieval | safe ingestion, canonicalization and deduplication |
| 5 | Evidence graph, demand scenarios, supplier mapping | evidence checks and counterevidence evaluation |
| 6 | JP/US finance, positions, filings, pricing power | deterministic formulas, source/date/definition tests |
| 7 | Export, observability, performance and backups | restore drill, bounded cost, representative E2E |

**Required CI:** formatting, lint, strict typecheck, import-boundary checks, unit/property tests, schema/contract tests, adapter mocks, security tests, production build and browser E2E. Evaluate LLM factual accuracy on a versioned research benchmark separately from deterministic CI. Do not claim financial data completeness when licenses or sources cannot support it.

## 13. Open design decisions / defaults

- **Owner identity:** choose an established auth method before implementation; do not create bespoke password cryptography.
- **Market data vendors:** decided by ADR-0014 — FRED plus Twelve Data, keyed, fetched on request by the local runner behind source-neutral ports; metrics neither covers stay unavailable.
- **Images:** withdrawn in full by the owner's decision of 2026-10-13 (ADR-0013); the earlier plan (external link/display by permission first, R2 for licensed retained assets later) no longer applies.
- **Runner OS:** macOS/Windows/WSL supported by capability tests rather than assuming identical CLI interfaces. The Rust runner's process-group and signal handling is POSIX (macOS, Linux/WSL); a native Windows runner is not built.
- **Backups:** define periodic D1 export and restore test before storing valuable production-only research.
- **Provider terms:** check per-backend authentication and automation rules at implementation and after major updates. No bypassing provider usage controls.

## 14. References (official documentation; accessed 2026-10-11, vendor terms 15–17 accessed 2026-10-12)

1. Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
2. Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
3. Cloudflare SPA routing: https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
4. Hono RPC: https://hono.dev/docs/guides/rpc
5. OpenCode SDK: https://docs.opencode.ai/docs/sdk/
6. OpenCode server: https://dev.opencode.ai/docs/server/
7. Codex documentation: https://developers.openai.com/codex/
8. Claude Code documentation: https://code.claude.com/docs/en/overview
9. OpenRouter API: https://openrouter.ai/docs
10. SolidJS effects: https://docs.solidjs.com/reference/basic-reactivity/create-effect
11. SEC 13F FAQ: https://www.sec.gov/divisions/investment/13ffaq
12. FINRA short interest: https://www.finra.org/finra-data/browse-catalog/equity-short-interest/data
13. JPX margin statistics: https://www.jpx.co.jp/english/markets/statistics-equities/margin/
14. OWASP LLM Top 10: https://genai.owasp.org/llm-top-10/
15. FRED API terms of use: https://fred.stlouisfed.org/docs/api/terms_of_use.html
16. Twelve Data terms of service: https://twelvedata.com/terms
17. Twelve Data API credits and limits: https://support.twelvedata.com/en/articles/5194820-api-credits-limits
18. Finnhub stock fundamentals (earnings calendar, company profile): https://finnhub.io/
19. JPX scheduled dates for earnings announcements (index linking the quarterly workbooks): https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html
20. Google Calendar API (calendars and events): https://developers.google.com/calendar/api/v3/reference/
21. Google OAuth 2.0 for native/desktop apps (loopback redirect, PKCE): https://developers.google.com/identity/protocols/oauth2/native-app
22. Google Calendar API auth scopes: https://developers.google.com/calendar/api/auth

**Reference URLs are starting points, not an assertion that every vendor's pricing, SDK version, CLI subscription rights, or financial-data license remains unchanged. Verify before implementing each adapter.**
