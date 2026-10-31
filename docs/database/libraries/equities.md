# Equities: annual financial statements from SEC EDGAR and EDINET

The Equities page (`#/equities`) and the two financial widgets show the annual
financial statements of the companies you track. The runner fetches them from
the official free APIs — **SEC EDGAR** for US issuers and **EDINET API v2** for
Japanese issuers — and the API stores them in the database. Every page and
widget reads only the database; nothing in the browser or in an API read ever
contacts SEC or EDINET. Decision record:
[ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md).
Naming: [naming conventions](../naming.md). Broader roadmap: [equities database design](equities-design.md).

Table definitions (columns, constraints, indexes, lifecycle) of the `equity_*` tables: [database README, section 12](../README.md#12-equities-library).

There is no manual upload any more: the normalized-file import of ADR-0041 was
removed. Its `equity_*` ledger tables (migrations 0014/0015) are left in the
database unchanged and unread.

## Setup

Add to `apps/runner/.env` (the runner reads it at start; `bun run dev`
restarts the runner when the file changes only if you restart it yourself):

| Variable | What it is |
|---|---|
| `SEC_USER_AGENT` | Your name and contact e-mail, e.g. `Jane Doe jane@example.com`. SEC's fair-access policy requires it. Without it US companies fail with `FINANCIAL_SOURCE_NOT_CONFIGURED`. |
| `EDINET_API_KEY` | EDINET API v2 subscription key. Free: register on the EDINET API page of the Financial Services Agency (e-mail and SMS verification), then copy the primary key. Without it Japanese companies fail with `FINANCIAL_SOURCE_NOT_CONFIGURED` and the runner logs `edinet_disabled` once at start. |

No paid service is used.

## What happens automatically

1. The first time the runner asks for work, the API adds the default companies
   for the owner: **AAPL, MSFT, KO** (US) and **7974 Nintendo, 8035 Tokyo
   Electron, 6367 Daikin** (Japan). Removing one is permanent (it is not added
   again).
2. The API schedules one `financial-sync` job at a time: the tracked company
   that is due first. A new company is due at once; after a successful sync it
   is due again in 24 hours, or at once when the sync left work for a next job.
   After a failure it waits 30 minutes, doubling up to 24 hours.
3. **US (SEC)**: the first sync resolves the ticker to its CIK (SEC's ticker
   list), reads the submissions list and the company facts, and stores every
   10-K / 10-K/A filed in the last six years with its annual facts. Later syncs
   read only the submissions list (one small request) and fetch the company
   facts only when a new annual filing appeared.
4. **Japan (EDINET)**: EDINET lists documents by date, not by company. The
   first syncs find the latest 有価証券報告書 (looking at the June filing peak
   first), then the reports of the five earlier fiscal years (30–100 days after
   each year end), downloading each report's official XBRL-to-CSV. Later syncs
   list only the dates since the last one, which also finds amendments (訂正).
   Each job lists at most 40 dates (one request per second) and downloads at
   most 8 reports, so a first sync takes a few jobs.
5. The API stores new filings and facts, recomputes only the metric-years they
   touch, and changes a stored value only when it really changed. A sync with
   nothing new changes no financial row.

You can press **Sync now** on the Equities page to make a company due at once;
the runner picks it up at its next poll (seconds).

## What is stored

| Table | Meaning |
|---|---|
| `equity_company` | Tracked companies: market, symbol, and once resolved the issuer identity (SEC CIK / EDINET code), name, fiscal year end. |
| `equity_report_filing` | Every annual filing seen: form (10-K, 10-K/A, `securities-report`, `amended-securities-report`), filing date, fiscal period, accounting standard, the filing it amends, link, and whether its facts were extracted. |
| `equity_reported_fact` | **As-filed history.** Every annual fact of every filing exactly as reported: concept, scope (consolidated / separate), period, unit, exact value. Never updated or deleted by a sync. |
| `equity_metric_value` | **Current values.** One row per company, metric and fiscal year: the authoritative value with its filing, or the reason it is unavailable. This is what the widgets read. |
| `equity_sync_state` | Schedule, last check and success, last failure (code and the provider's HTTP status), EDINET scan phase. |
| `equity_edinet_scanned_day` | EDINET dates already listed for a company. |
| `equity_sync_meta` | When the default companies were added. |

Historical data is kept permanently. Untracking a company stops its syncs and
keeps its data (tracking it again shows it at once and resumes syncing).

## Metrics

| Statement | Metric | US GAAP concept(s) | Japanese GAAP concept(s) |
|---|---|---|---|
| Income statement | Revenue | `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, `…IncludingAssessedTax`, `SalesRevenueNet` (first found in the filing) | `NetSales`, `OperatingRevenue1` |
| | Gross profit | `GrossProfit` | `GrossProfit` |
| | Operating income | `OperatingIncomeLoss` | `OperatingIncome` |
| | Ordinary income (経常利益) | — (Japanese only) | `OrdinaryIncome` |
| | Profit attributable to owners | `NetIncomeLoss` | `ProfitLossAttributableToOwnersOfParent` (consolidated), `ProfitLoss` (separate) |
| Balance sheet | Total assets | `Assets` | `Assets` |
| | Total liabilities | `Liabilities` | `Liabilities` |
| | Total equity | `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`, else `StockholdersEquity` | `NetAssets` (純資産合計, includes share acquisition rights) |
| | Cash and cash equivalents | `CashAndCashEquivalentsAtCarryingValue` | `CashAndCashEquivalents` |
| Cash flow | Net cash from operating / investing / financing activities | `NetCashProvidedByUsedIn…Activities` | `NetCashProvidedByUsedIn…Activities` |
| | Capital expenditures (positive) | `PaymentsToAcquirePropertyPlantAndEquipment` | `PurchaseOfPropertyPlantAndEquipmentInvCF` (sign reversed) |
| | Free cash flow (derived) | operating cash flow − capital expenditures, both from the same filing | same |

Values are exact decimal text in the reporting currency's base unit (USD,
JPY); the widgets show whole millions. A missing value is shown as "not
reported" (or the specific reason) — never 0.

## Rules that keep the numbers right

- **Annual only.** A duration must last 350–380 days (calendar or 52/53-week
  year); quarters, year-to-date and transition periods are dropped. A balance
  must be at the end of an annual period of the same filing.
- **SEC**: facts only from 10-K and 10-K/A filings. **EDINET**: only the
  current-year and prior-year contexts of the main report, consolidated or
  separate (`_NonConsolidatedMember`); segment and other dimensional contexts
  are ignored; period dates come from the report's DEI.
- **Fiscal year** = the calendar year the period ends in (a 52/53-week year
  ending 1–7 January counts as the year before). The period end is shown with
  every value because a company's own label can differ (some retailers).
- **Current value** = consolidated if any, from the most recently filed filing
  that reports the year, its best-ranked concept. Two different values for that
  concept in one filing are reported as `ambiguous`, not guessed.
- **Revisions**: a later report that restates a year, or an amendment, becomes
  the current value; the earlier filing's value stays in the as-filed history.
  The widget marks such values "Revised"; the revision dialog lists every
  reported value with its filing.
- **Unmapped standards**: IFRS and US-GAAP filers on EDINET are stored (their
  filings) but their metrics read `no-mapping-for-standard` until reviewed
  mappings are added.

## HTTP API (owner-authenticated, under `/api/v1`)

| Method / path | Purpose |
|---|---|
| `GET /equities/companies` | Tracked companies with sync status. |
| `POST /equities/companies` `{"stockId":"us:AAPL"}` | Track a US or JP listed stock (at most 20). 409 if already tracked, 422 at the limit. |
| `DELETE /equities/companies/:companyId` | Stop tracking (data kept). |
| `POST /equities/companies/:companyId/sync` | Make the company due now (202). |
| `GET /equities/companies/:companyId` | One company with its sync status. |
| `GET /equities/companies/:companyId/statements/:statement?years=5` | `income-statement`, `balance-sheet` or `cash-flow`: the newest *years* fiscal years, oldest first, every metric row, the cited filings. |
| `GET /equities/companies/:companyId/metrics?metric=revenue&years=10` | One metric over fiscal years. |
| `GET /equities/companies/:companyId/revisions?metric=revenue&fiscalYear=2024` | Every as-filed value of one metric-year beside the current value. |

Reads support `If-None-Match` (ETag). US and Japanese companies answer the
same schemas: [`equityFinancials.ts`](../../../packages/contracts/src/equityFinancials.ts).

## Limits

- Annual statements only; no quarterly data.
- IFRS / US-GAAP filers on EDINET: filings stored, no normalized metrics yet.
- Amendments to old fiscal years filed outside a backfill window before a
  company's first sync are not searched for; a company that changes its fiscal
  year end can miss earlier backfill windows.
- EDINET date listings are scanned one per second; a Japanese company's first
  sync spreads over several jobs (minutes). One sync job runs at a time and can
  delay a research question queued behind it by about a minute.
- SEC company-facts numbers above 2^53 would lose exactness (no annual amount
  of a current filer comes near).
- At most 20 tracked companies (a proof-of-concept bound).
