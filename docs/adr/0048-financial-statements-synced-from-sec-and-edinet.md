# ADR-0048: Annual financial statements are synchronised from SEC EDGAR and EDINET

Status: accepted, 2026-10-31. Supersedes the owner import of ADR-0041 (its
`equity_*` ledger tables stay in the database, unread).

## Context

The owner asked to replace the manual financial-statement import (ADR-0041:
the owner uploads a normalized JSON file on the Equities page) with automatic
ingestion from the official free APIs — SEC EDGAR for US issuers and EDINET
API v2 for Japanese issuers — stored durably, updated incrementally, never
rewritten wholesale, with revision history kept, and read by reusable
financial statement widgets. The proof of concept tracks three US and three
Japanese companies the owner chose: AAPL, MSFT, KO; 7974 (Nintendo), 8035
(Tokyo Electron), 6367 (Daikin) — all Japanese GAAP with a March year end.

What exists: only the runner reaches outside hosts (ADR-0005, THREAT_MODEL
T22); the runner already reads SEC with a paced client and `SEC_USER_AGENT`
(`research-finance::sec_client`, `packages/adapters/src/finance/secClient.ts`)
and a bounded ZIP reader (JPX). Background work is a job the runner claims;
there is no cron — the only unattended timer is claim time (scheduled tasks,
ADR-0033). Both runners exist: Rust is live, TypeScript is the rollback, and
TypeScript-generated vectors prove parity (ADR-0030). The ADR-0041 tables
keep every value only in JSON bodies with no index on year or metric, and
every local database (development and production) holds no equity row.

## Decision

### 1. Retire the import, keep its rows

The import endpoint, its service, repository, page sections, sample files,
tests and the Lean visibility model are removed. Migration 0021 does not
drop or change the `equity_*` tables of migrations 0014/0015, so an
installation that imported files keeps those rows (exportable with `wrangler
d1 export`; removal is a separate administrative operation). The decimal and
source-timestamp schemas the materials feature shares move to
`packages/contracts/src/exactDecimal.ts`.

### 2. Storage (migration 0021)

Seven owner-scoped tables (comment block of
`infra/migrations/0021_equity_financial_sync.sql` is normative):

| Table | Holds | Written |
|---|---|---|
| `equity_company` | tracked companies; listing (market, symbol) and, once resolved, the issuer identity (CIK / EDINET code) | track/untrack; identity from a sync |
| `equity_report_filing` | every annual filing seen: form, dates, standard, amendment link, source URL, `facts_status` pending/extracted/unavailable, `primary_scope` (§5) | insert; status (with its fact count and primary scope) only pending → final |
| `equity_reported_fact` | the as-filed history: every annual fact of every filing, sign as reported (the value is part of the key, §5) | insert only (`ON CONFLICT DO NOTHING`) |
| `equity_metric_value` | the current authoritative value per (company, metric, fiscal year), or an unavailable reason | upsert only when the selection changed |
| `equity_sync_state` | schedule, last check/success, last failure (code + upstream status), EDINET phase, `more_pending`, `data_updated_at` | each completion |
| `equity_edinet_scanned_day` | EDINET dates already listed for a company | insert only |
| `equity_sync_meta` | when the default companies were added for the owner | once |

Raw history (`equity_reported_fact`) and the read projection
(`equity_metric_value`) are separate; widgets read the projection only. The
company id is opaque; a ticker is never identity.

### 3. Normalized metrics and mappings

`packages/domain/src/finance/financialStatements.ts` is the one registry:
14 metrics in three statements (income statement: revenue, gross profit,
operating income, ordinary income, profit attributable to owners; balance
sheet: total assets, total liabilities, total equity, cash and cash
equivalents; cash flow: net cash from operating / investing / financing
activities, capital expenditures, free cash flow). Each mapping names
(standard, concept, rank, sign, scope). Only concepts whose definition is
the metric's are mapped:

- `ordinary-income` (経常利益) exists only under JGAAP — a source-specific
  metric shown for Japanese filers and "not reported" for US ones;
- `total-equity` is US total equity including non-controlling interests
  (falling back to parent equity, for filers without them) and Japanese
  純資産合計, which also contains share acquisition rights;
- `profit-attributable-to-owners` maps 親会社株主に帰属する当期純利益 for
  consolidated statements and 当期純利益 for separate ones;
- `capital-expenditures` is payments for property, plant and equipment as a
  positive amount (EDINET reports it negative: sign −1);
- `free-cash-flow` is derived: operating cash flow − capital expenditures,
  only when both come from the same filing in the same currency;
- IFRS and US-GAAP filers on EDINET have no reviewed mapping yet: their
  filings are stored and their metrics say `no-mapping-for-standard`.
  Whether mappings exist is decided per provider and standard — a mapping
  counts for a provider only when its concept is one that provider's runner
  extracts — so SEC maps US-GAAP and EDINET maps JGAAP only; an EDINET
  filing under US-GAAP (EDINET's own taxonomy) is unmapped, not
  "not reported".

The claim sends the runner the concept list (`equityConceptsOfProvider`),
so the registry exists once, in TypeScript.

### 4. Annual facts only

A fact is kept only if it is annual: a duration of 350–380 days inclusive
(calendar and 52/53-week years; quarters, year-to-date and transition
periods are dropped), or an instant that is the end of an annual duration
in the same filing (a year-end balance, not an interim one)
(`annualFactsOfFiling`). SEC facts come only from 10-K / 10-K/A filings:
from each, durations are kept for every annual year it reports; instants
only at the filing's own fiscal-year end and the immediately preceding one
— the latest two ends of the annual durations it reports (the two
balance-sheet columns, `secFilingFacts`). Opening balances in the statement
of stockholders' equity, two or three years back, are not taken from that
filing. EDINET facts only from the contexts `CurrentYear…`/`Prior1Year…`
(`Duration`/`Instant`), consolidated or `_NonConsolidatedMember` (separate),
with dates from the report's DEI elements — never segment or other
dimensional contexts. The fiscal year label is the year the period ends in
(a 52/53-week year ending 1–7 January belongs to the year before:
`fiscalYearOfPeriodEnd`), computed by the API, and every value carries its
period end. Values are exact decimal text in base units.

### 5. The authoritative value and revisions

**Stored as filed.** `equity_reported_fact` is keyed by filing, concept,
scope, period, unit *and value*: an exact repeat within a filing collapses,
and a key one filing reports with two different values keeps both rows.
They are never dropped — dropping them would let an older filing, or a
lower-ranked concept of the same filing, stand in for a figure this filing
superseded — so the selection below sees the conflict and answers
`ambiguous`.

**One scope per filing.** Each filing records a `primary_scope` with its
facts: `consolidated` when it reports any consolidated fact, else `separate`
(a filer without subsidiaries). The projection passes the selection only
facts whose scope is their filing's primary scope, so a consolidated filer's
year never shows a parent-only (`_NonConsolidatedMember`) figure beside
consolidated ones: a metric its consolidated statements lack reads
`not-reported`. The separate rows stay stored, and the revisions read lists
them with their scope. (The filter sits in the API's recompute; the
Lean-verified core below is unchanged.)

`selectMetricValue`: among the facts of one company-year mapped to the
metric, prefer consolidated scope, take the latest filing (filing date, then
id), take its best-ranked concept; two different values for that concept
are `ambiguous`; then apply the sign and check the unit (ISO currency) and
the sign. An amendment or a later report that restates a year therefore
becomes the current value while the earlier filing's facts stay stored; the
cell reports how many different values were reported, and the revisions
read lists every as-filed value with its filing. The selection depends only
on the set of facts, so a sync recomputes only the metric-years its new
facts touch and writes a row only when it changed. Proved in Lean (§10).

### 6. Synchronisation: job kind `financial-sync`

One job per company. Nothing outside the runner contacts SEC or EDINET; a
page, widget or API read never does.

**Scheduling (claim time).** Before choosing a job, `claim` runs the
equity-sync materialiser next to `fireDueTasks`: (a) once per owner it adds
`EQUITY_DEFAULT_STOCK_IDS` (seeding can be switched off for tests); (b) when
no `financial-sync` job is pending or leased, it takes the tracked company
with the earliest `next_due_at ≤ now`, builds its plan, and creates one job
(outside the owner's `job-create` allowance; a refusal is a skip, as
ADR-0033 §3: refused for the owner's unfinished-run cap, the company is
looked at again 5 minutes later rather than at every runner poll; refused
because a concurrent claim queued the kind's job first, nothing is written
over that job's schedule). Companies are synced one at a time. While a
scheduler job runs the company is held at `next_due_at` = queue time + 24 h,
a safety net so a job that ends without writing the state (an owner's
cancel) does not start again at once. After a success `next_due_at` is now + 24 h, or now when
the completion said `more`, the EDINET plan still has dates, or a deferred
filing waits. After a terminal failure — a failed completion, the retry
ceiling, or a claim refused because the stored rows cannot form a valid
claim (recorded as `INTERNAL`) — it is now + 30 min × 2^(n−1), at most 24 h,
and the failure is shown on the company. "Sync now" sets
`next_due_at = now` and records the press in `sync_requested_at`. A job's
end compares that with the job's own creation time: a press after the job
was created is kept (the earlier of the press and the job's next time),
anything older is the job's own business. The comparison needs nothing the
job's creator wrote, so a scheduler job and an owner's retry of a failed
sync (a new job, `POST /research-runs/:id/retry`) are scheduled alike — a
successful retry gets now + 24 h, a failed one its own backoff. "Sync now"
while the company's job is still pending (not claimed yet) records nothing:
that job reads the stored rows when it is claimed, so it already serves the
press.

**SEC (US).** Claim: CIK (null until resolved), known and pending
accessions, `filedSince` (today − 6 years), `fullCheck`. Runner: resolve the
CIK from SEC's ticker list if needed; read the submissions JSON (one
request); its 10-K / 10-K/A rows filed since `filedSince` that are new or
pending — or `fullCheck` — trigger one company-facts request; facts are
taken only for new/pending accessions, then filtered by §4. Filing metadata
comes from submissions (filing date, report date, acceptance time, primary
document) and, for older annual filings only the company facts list, from
the facts (`filed`, latest annual period end). A submissions row whose
`reportDate` is not a valid date does not by itself trigger the
company-facts request; it is stored only when company facts list its
accession, with the latest annual period end of its facts as its period
end, and without facts it is not reported — no period end is inferred,
since SEC does not state which 10-K an amendment amends. A filing with no
facts in company facts is `not-available` (company facts lag a new
filing). Filings
are sent newest first while the completion stays within 60 filings and
3,000 facts; anything cut sets `more`.

**EDINET (JP).** EDINET has no per-company search: its documents API lists
all documents of one date. The API plans the dates (`edinetScanPlan`):
discovery of the latest annual report (last 400 days, the 15–30 June peak
first), then backfill windows 30–100 days after each of six fiscal year ends
(newest first), then every weekday since the newest report up to yesterday;
weekends and already-scanned dates are skipped; at most 40 dates per job.
Runner: for each date, `GET /api/v2/documents.json?date=…&type=2`; keep
`docTypeCode` 120 (有価証券報告書) / 130 (訂正) rows whose `secCode` is the
company's (JPX code + "0") and that are not withdrawn; download the
XBRL-to-CSV (`GET /api/v2/documents/{docID}?type=5`) of new and pending ones
(at most 8 per job; the rest are `deferred`); a document without CSV is
`not-available`. A downloaded document that is not a readable report — a
malformed ZIP, no `XBRL_TO_CSV/jpcrp…csv` entry, text that is not UTF-16
LE, a CSV without the header, or an answer that is neither a ZIP nor an
EDINET error status — is `not-available` too: the job continues with the
other documents and the runner logs `financial_sync_document_unreadable`
(`problem` = `NOT_A_ZIP` | `NO_REPORT_ENTRY` | `ENCODING` |
`MISSING_HEADER` | `PERIOD_UNKNOWN`); only a failing date list or an HTTP / EDINET error status
fails the job. A list answer without `metadata` whose `StatusCode` /
`statusCode` is 400 or more is that status (the gateway's HTTP 200 key and
rate errors). A 130 row without a period (the spec outputs one only for
有価証券報告書 and 半期報告書) takes its original's period (`parentDocID`)
from a row of the same scan, else from the claim's pending or known filings
(the claim sends `knownFilings` with their stored periods), else from its
downloaded report's `CurrentFiscalYearStartDateDEI` /
`CurrentFiscalYearEndDateDEI`; one whose period cannot be determined is not
reported — when deferred, or when its download answers 404 within 7 days of
submission, its date stays unscanned; otherwise it is dropped and logged
(`PERIOD_UNKNOWN`). The CSV is UTF-16 LE, tab-separated, columns 要素ID,
項目名, コンテキストID, 相対年度, 連結・個別, 期間・時点, ユニットID, 単位,
値; the main report entry is the `XBRL_TO_CSV/jpcrp…` file. The key travels
as the `Subscription-Key` query parameter; a URL holding it is never logged.

**Completion `financial-synced`.** Identity, `scannedDays`, filings with
`factsStatus` extracted / not-available / deferred and their facts, `more`.
The API, inside the job's guarded batch: updates the identity; inserts new
filings (a deferred one, or a not-available one within 7 days, is
`pending` and offered again in the next claim with its stored metadata,
which the runner echoes; after that a not-available one is `unavailable`).
The 7 days count from the filing date for SEC — company facts lag a new
filing, an old 10-K without facts stays without them, and offering it again
would download the company facts every day — and from when a sync first saw
the filing (`first_seen_at`) for EDINET, where not-available also means a
download that could not be read (a broken ZIP, an HTML page instead of
one), which can be transient: an old report found by a backfill gets its
retries too (the Lean-modelled `filingStaysPending` is unchanged, only its
start date differs); never rewrites a stored filing's metadata; inserts facts of
newly extracted filings with their fiscal year and metric code; recomputes
the touched metric-years and upserts only changed rows; records the scanned
dates; updates the sync state (and `data_updated_at` only when a value
changed). A second sync with nothing new writes only the sync state.

**Failures** (`failed` outcome, ADR-0037 upstream status kept):
`FINANCIAL_SOURCE_NOT_CONFIGURED` (no `SEC_USER_AGENT` / `EDINET_API_KEY`),
`FINANCIAL_COMPANY_NOT_FOUND`, `FINANCIAL_RATE_LIMITED`,
`FINANCIAL_ACCESS_DENIED`, `FINANCIAL_SOURCE_FAILED`,
`FINANCIAL_PARSE_FAILED`. Rate limited, network, timeout and 5xx are
retryable; the rest are not. The API records its own codes on the company
(`EQUITY_SYNC_API_FAILURE_CODES`): `RETRY_CEILING_REACHED`, `INTERNAL` (a
claim refused at claim time) and `FINANCIAL_IDENTITY_CONFLICT` — the issuer
a completion reports is already another tracked company's (two listings of
one issuer, such as GOOGL and GOOG, or a ticker that now names another
issuer) or differs from the issuer this company resolved to. Identities are
never merged: nothing of that completion is stored, and the owner resolves
it by untracking one of the two companies.

**Politeness.** SEC: the existing paced client (≥ 125 ms apart, 8 per
second window). EDINET: one request per second (new `edinet` pacer entry).
The runner caches an EDINET date's matching rows for 24 h, so companies
synced one after another share the listing requests.

### 7. Read API (owner-authenticated, under `/api/v1`)

| Route | Answer |
|---|---|
| `GET /equities/companies` | tracked companies with sync status |
| `POST /equities/companies` `{stockId}` | track a US/JP listed stock (≤ 20) |
| `DELETE /equities/companies/:companyId` | stop tracking; data stays (idempotent: a repeat answers 204 and writes no second audit row) |
| `POST /equities/companies/:companyId/sync` | sync soon (sets `next_due_at`); 202 |
| `GET /equities/companies/:companyId` | one company with sync status |
| `GET /equities/companies/:companyId/statements/:statement?years=` | `income-statement` / `balance-sheet` / `cash-flow`, newest *years* fiscal years oldest first, every metric row, every cited filing |
| `GET /equities/companies/:companyId/metrics?metric=&years=` | one metric over years |
| `GET /equities/companies/:companyId/revisions?metric=&fiscalYear=` | every as-filed value of a metric-year beside the current one |
| `GET /equities/companies/:companyId/filings` | every stored filing, newest `filed_on` first then filing id descending, with extraction status, fact count and the document it amends; pending, unavailable and superseded filings included (≤ 500) |

The statement and metric reads list the newest fiscal years that have a
value or an unavailable reason other than `not-reported`, so an IFRS
filer's years appear with `no-mapping-for-standard` instead of answering
like a company never synced. Reads answer from `equity_metric_value` /
`equity_reported_fact` / `equity_report_filing` with conditional GETs (ETag
from `data_updated_at` and the company view, whose last check moves with
every completion). A cell is a value with
currency, filing, concept, scope, derived flag and reported-value count, or
`null` with a reason — never 0. US and Japanese companies answer the same
schema (`packages/contracts/src/equityFinancials.ts`).

### 8. Widgets and page

Two widget types in the one widget specification (ADR-0024), Home and the
Notebook, owner-placed (agents can move, resize and remove them, not add
them or change their company):

- `financial-statement` `{companyId, statement, years}` — the statement as a
  table, fiscal years side by side (oldest left), metric labels, the unit
  caption (USD millions / 百万円), the newest period end, a statement switch
  (income statement / balance sheet / cash flow) that saves the widget;
  missing cells say "not reported" (never blank or 0); derived and revised
  values are marked; a value links to its filing.
- `financial-history` `{companyId, metric, years}` — one metric as a bar
  chart over fiscal years (`BarPlot`/`ChartShell` from ui-registry, with the
  data-table twin and the filings as sources), a metric switch that saves
  the widget.

Both read only the API above, through a per-(company, …) ETag cache like the
task-result widget. The add dialog picks a tracked company and the statement
or metric. The Equities page lists tracked companies with sync status and
"Sync now", adds companies through the stock directory search (ADR-0034),
removes them (keeping data), shows the three statements and a value's
revision history, and lists filings with links. Up to 20 tracked companies
(a proof-of-concept bound).

### 9. Configuration

`EDINET_API_KEY` (runner env file; 8–200 printable characters, no spaces):
EDINET API v2 subscription key, free from the EDINET API registration page.
Without it the Japanese companies fail with
`FINANCIAL_SOURCE_NOT_CONFIGURED` and the runner warns once
(`edinet_disabled`). `SEC_USER_AGENT` as before. New outside host
`api.edinet-fsa.go.jp`; the EDINET viewer `disclosure2.edinet-fsa.go.jp` is
only a link.

### 10. Verification

Lean (`formal/ResearchFormal/FinancialStatements.lean`): the selection takes
a fact of a latest filing, is invariant under reordering and duplication
(idempotent re-sync), and is unchanged by facts of filings older than the
selected one; the scan plan never repeats a scanned date, never plans today
or later, never plans a weekend, and stays within `maxDays`; annual-period,
fiscal-year and decimal-subtraction vectors replayed in TypeScript and Rust.
Tests: deterministic provider fixtures for both parsers (vectors replayed by
Rust), D1 tests for backfill, no-op re-sync (no row written), new filing,
amendment (history kept, current view updated), duplicate prevention,
rollback of a failed batch, checkpoints; read tests for both markets; widget
tests with no provider request. An opt-in real-environment spec syncs the
companies against the live APIs on `bun run dev` and compares
representative values with the official sources.

## Consequences

- One `financial-sync` job at a time; a backfill job (≤ 40 EDINET dates +
  ≤ 8 documents, about a minute) can delay a research question that is
  queued behind it by that long.
- The first sync of a Japanese company needs a few hundred EDINET listing
  requests over several jobs (discovery and five backfill windows); later
  syncs list only the dates since the last one.
- Limits: annual statements only (no quarters); fiscal year labels can
  differ from a company's own (§4), and a 52/53-week year end drifting
  across 7/8 January gives that year `ambiguous` values; IFRS and US-GAAP filers on EDINET get
  filings but no normalized values; amendments to old years filed outside a
  backfill window before the first sync are not looked for; a company that
  changes its fiscal year end can miss backfill windows; SEC values larger
  than 2^53 lose exactness when SEC's JSON number is read (no current
  filer's annual amounts come near that); a company whose ticker changes is
  matched by CIK once resolved, but tracking starts from the ticker.
- Limitations — a change of tagged concept moves older years too. The
  authoritative value is the latest filing's best-ranked concept (§5). When
  a company changes which concept it tags for a metric between filings (for
  example from `Revenues` to `RevenueFromContractWithCustomerExcludingAssessedTax`),
  an older year that the newer filing also reports as a comparative takes
  the newer filing's concept and figure, and the cell counts it as revised
  when the two values differ. This is by design: the latest presentation
  wins, exactly as for a restatement, because the newer filing is the
  company's current statement of that year. The revisions read shows every
  as-filed value with its concept and filing, so the earlier presentation
  stays visible.
- Limitations — stored filings are not re-read when the mapping registry
  grows. A filing's facts are fetched once, for the claim's concept list of
  that day, and each fact's `metric_code` is fixed when it is stored, so a
  new mapping (a concept, or a standard such as IFRS) applies only to
  filings synced afterwards. To apply it to a company's stored filings an
  administrator re-extracts them: after `wrangler d1 export`, delete the
  company's `equity_reported_fact` and `equity_metric_value` rows, reset its
  `extracted` filings to `facts_status = 'pending'` (`fact_count = 0`,
  `primary_scope = NULL`), then press "Sync now"; the next syncs offer those
  filings as pending (20 per claim, newest first), the runner fetches their
  facts again, and the API recomputes the values. The exact statements are
  in `docs/database/libraries/equities.md` (Limitations), exercised by
  `apps/api/test/equitySync.test.ts`.
- Rollback: see the migration header; the ADR-0041 import cannot be
  restored by configuration.
