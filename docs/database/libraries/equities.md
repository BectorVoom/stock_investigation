# Equities: annual financial statements from SEC EDGAR and J-Quants

The Stocks page (`#/stocks`, its Financial statements and Company tabs, ADR-0049) and the two financial widgets show the annual
financial statements of every stock in the stock directory — every
exchange-listed US and Japanese stock, whether or not it is on the Watchlist
(ADR-0058 §3; there is no separate track or Sync now). Stocks with nothing
stored are synced first. The runner fetches them from
**SEC EDGAR** (free) for US issuers and the **J-Quants API** (the owner's
Free plan, the earnings summaries 決算短信) for Japanese issuers — and the API
stores them in the database. Every page and widget reads only the database;
nothing in the browser or in an API read ever contacts SEC or J-Quants.
Decision records:
[ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md),
[ADR-0059](../../adr/0059-japanese-statements-from-jquants.md) (J-Quants
replaced EDINET for Japan; migration 0027 deleted the EDINET-era Japanese
rows and made every Japanese company due again).
Naming: [naming conventions](../naming.md). Broader roadmap: [equities database design](equities-design.md).

Table definitions (columns, constraints, indexes, lifecycle) of the sync's
tables: [database README, section 13](../README.md#13-financial-statements-synced-from-sec-and-j-quants).

There is no manual upload any more: the normalized-file import of ADR-0041 was
removed. Its `equity_*` ledger tables (migrations 0014/0015,
[database README, section 12](../README.md#12-equities-library-retired-adr-0041-import))
are left in the database unchanged: no code writes or reads them since
ADR-0048. Export them with `wrangler d1 export` before removing them through a
separate administrative operation.

## Setup

Add to `apps/runner/.env` (the runner reads it at start; `bun run dev`
restarts the runner when the file changes only if you restart it yourself):

| Variable | What it is |
|---|---|
| `SEC_USER_AGENT` | Your name and contact e-mail, e.g. `Jane Doe jane@example.com`. SEC's fair-access policy requires it. Without it US companies fail with `FINANCIAL_SOURCE_NOT_CONFIGURED`. |
| `JQUANTS_API_KEY` | The J-Quants API key (the same key the Japanese stock prices use, ADR-0058 §2; the Free plan is enough). Without it Japanese companies fail with `FINANCIAL_SOURCE_NOT_CONFIGURED`, and the Japanese stock list is stored without company profiles. |

No paid service is needed.

## What happens automatically

1. When the runner asks for work, the API matches the tracked companies to
   the stock directory (ADR-0058 §3): up to 500 untracked directory stocks per
   check — Watchlist stocks first, then US before JP, then by symbol — are
   tracked and due at once, and a company whose listing left a stored
   directory is untracked (its data stays; listed again, it is tracked again
   and due at once). A market whose directory is not stored is never
   untracked. The directory is scanned again only after a stored list
   changed (a new download), so a settled owner costs one small read per
   check. (Before ADR-0058 the companies followed the Watchlist, at most 50.)
2. The API schedules one `financial-sync` job at a time: a company never
   checked before every company being refreshed, then the one due first. A
   new company is due at once; after a successful sync it is due again in 24
   hours for a Watchlist company (or while a filing waits for its facts) and
   in 7 days for every other company (`directorySyncIntervalHours`), at once
   when the sync left work for a next job, and in 30 days when the company has
   no annual report at all (SEC funds and SPACs; Japanese ETFs, REITs without
   XBRL and delisted codes, which J-Quants answers with no summary;
   `notFoundRetryDays`). US and Japanese companies are scheduled alike. After a
   failure it waits 30 minutes, doubling up to 24 hours — 30 days for an
   identity conflict (GOOG / GOOGL) or a ticker SEC does not know. When the
   queue refuses the job (the owner's unfinished-run cap), the company is
   looked at again 5 minutes later, not at every runner poll.
3. **US (SEC)**: the first sync resolves the ticker to its CIK (SEC's ticker
   list), reads the submissions list and the company facts, and stores every
   annual report filed in the last six years — 10-K, or 20-F / 40-F for a
   foreign private issuer (ADR-0058 §5), with amendments — with its annual
   facts (US GAAP or IFRS, as the filing's own facts are tagged). Later syncs
   read only the submissions list (one small request) and fetch the company
   facts only when a new annual filing appeared.
4. **Japan (J-Quants)** (ADR-0059 §2): the claim names the company's
   5-character J-Quants code (the JPX code plus `0`: `7203` → `72030`,
   `130A` → `130A0`) and the disclosure number (`DiscNo`) of every summary
   already stored. The runner asks `GET /v2/fins/summary?code=` once (every
   page; at most 60 requests a minute, its own limit, separate from the
   price requests) and keeps the full-year summaries (`DocType`
   `FYFinancialStatements_…`): the first of a fiscal year is an
   `earnings-report`, a later one of the same year (a correction) an
   `amended-earnings-report` that amends the one before it. Each new summary
   becomes one filing with its stated items as facts (`jquants:Sales`,
   `jquants:OP`, …, in yen). The Free plan keeps two years, about 12 weeks
   behind: about two fiscal years per company. A Japanese company has no
   business description (J-Quants has no business text); its Company tab
   shows the J-Quants company profile the JP stock-directory job stores
   ([`stock_company_profile`](../tables/stock_company_profile.md)).
5. The API stores new filings and facts, recomputes only the metric-years they
   touch, and changes a stored value only when it really changed. A sync with
   nothing new changes no financial row.

No page makes a company due (ADR-0054: there is no Sync now). A company
re-tracked while its job runs is kept due: that job's end does not push the next sync ahead. Retrying a
failed sync from its run is scheduled like any other sync. Terminal sync jobs
are deleted with their transitions and events after 7 days (at most once an
hour, 500 at a time; the newest job of each kind and state is kept).

## What is stored

| Table | Meaning |
|---|---|
| `equity_company` | Tracked companies: market, symbol, and once resolved the issuer identity (SEC CIK / J-Quants issue code), name, fiscal year end. |
| `equity_report_filing` | Every annual filing seen: form (10-K, 20-F, 40-F and their `/A` amendments; `earnings-report`, `amended-earnings-report`), filing date, fiscal period, accounting standard, the filing it amends, link, whether its facts were extracted, and its primary scope (consolidated, or separate for a filer without subsidiaries). |
| `equity_reported_fact` | **As-filed history.** Every annual fact of every filing exactly as reported: concept, scope (consolidated / separate), period, unit, exact value. A filing that reports one item twice with different values keeps both. Never updated or deleted by a sync. |
| `equity_metric_value` | **Current values.** One row per company, metric and fiscal year: the authoritative value with its filing, or the reason it is unavailable. This is what the widgets read. |
| `equity_sync_state` | Schedule (never-checked companies first), last check and success, last failure (code and the provider's HTTP status). |
| `equity_business_description` | A US company's business section of its newest annual report (ADR-0053). |
| `stock_company_profile` | A Japanese stock's J-Quants company profile: English name, 17- and 33-sector, scale category, market segment (ADR-0059 §3). |
| `equity_sync_meta` | Unused since ADR-0054 (when the former default companies were added). |

One definition document per table: [`equity_company`](../tables/equity_company.md),
[`equity_report_filing`](../tables/equity_report_filing.md),
[`equity_reported_fact`](../tables/equity_reported_fact.md),
[`equity_metric_value`](../tables/equity_metric_value.md),
[`equity_sync_state`](../tables/equity_sync_state.md),
[`equity_business_description`](../tables/equity_business_description.md),
[`stock_company_profile`](../tables/stock_company_profile.md),
[`equity_sync_meta`](../tables/equity_sync_meta.md).
The definitions are section 13 of `db/schema.sql` and migration
`infra/migrations/0021_equity_financial_sync.sql`, whose header lists every
index (`uq_equity_company__owner_id_market_symbol`,
`uq_equity_company__owner_id_provider_source_company_id`,
`idx_equity_report_filing__owner_id_company_id_filed_on_filing_id`,
`idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal`,
`idx_equity_sync_state__owner_id_next_due_at`) with the read it serves and its
measured plan; migration `infra/migrations/0026_edinet_document_index.sql`
adds the never-checked probe's
`idx_equity_sync_state__owner_id_last_checked_at_next_due_at`
([DATABASE_CONVENTIONS.md](../conventions.md) §8, "Index review of migration
0021"); migration `infra/migrations/0027_jquants_financials.sql` (ADR-0059)
moves Japan to J-Quants, drops the EDINET index tables and adds
`stock_company_profile`. `equity_metric_value` is keyed (owner, company,
fiscal year, metric) and has no secondary index.

Historical data is kept permanently. A listing that leaves the directory
stops its company's syncs and keeps its data (listed again, it shows at
once and resumes syncing).

## Metrics

| Statement | Metric | US GAAP concept(s) (SEC) | J-Quants item (Japan; JGAAP, IFRS and US GAAP filers) |
|---|---|---|---|
| Income statement | Revenue | `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, `…IncludingAssessedTax`, `SalesRevenueNet` (first found in the filing) | `jquants:Sales` (売上高 / 売上収益 / 営業収益) |
| | Gross profit | `GrossProfit` | — (not in the summary: "not reported") |
| | Operating income | `OperatingIncomeLoss` | `jquants:OP` |
| | Ordinary income (経常利益) | — (Japanese only) | `jquants:OdP` (JGAAP filers only) |
| | Profit attributable to owners | `NetIncomeLoss` | `jquants:NP` |
| Balance sheet | Total assets | `Assets` | `jquants:TA` |
| | Total liabilities | `Liabilities` | — (not in the summary) |
| | Total equity | `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`, else `StockholdersEquity` | `jquants:Eq` (純資産 / 資本合計) |
| | Cash and cash equivalents | `CashAndCashEquivalentsAtCarryingValue` | `jquants:CashEq` |
| Cash flow | Net cash from operating / investing / financing activities | `NetCashProvidedByUsedIn…Activities` | `jquants:CFO` / `jquants:CFI` / `jquants:CFF` |
| | Capital expenditures (positive) | `PaymentsToAcquirePropertyPlantAndEquipment` | — (not in the summary) |
| | Free cash flow (derived) | operating cash flow − capital expenditures, both from the same filing | "not derivable" (no capital expenditures) |

The IFRS concepts SEC's foreign filers tag (`ifrs-full:`, ADR-0058 §5) are
listed in `EQUITY_CONCEPT_MAPPINGS` (`packages/domain/src/finance/financialStatements.ts`).
A J-Quants item is one fact per stated (non-empty) item: durations
(`Sales`, `OP`, `OdP`, `NP`, `CFO`, `CFI`, `CFF`) over the summary's
`CurPerSt`–`CurPerEn`, balances (`TA`, `Eq`, `CashEq`) at `CurPerEn`; the
`NC…` items of a consolidated summary are its non-consolidated figures,
stored under the same concept with scope `separate`.

Values are exact decimal text in the reporting currency's base unit (USD,
JPY); the widgets show whole millions. A missing value is shown as "not
reported" (or the specific reason) — never 0.

## Rules that keep the numbers right

- **Annual only.** A duration must last 350–380 days (calendar or 52/53-week
  year); quarters, year-to-date and transition periods are dropped. A balance
  must be at the end of an annual period of the same filing.
- **SEC**: facts only from annual reports (10-K, 20-F, 40-F and their
  amendments), from the `us-gaap` or `ifrs-full` taxonomy. **J-Quants**: only
  full-year summaries (`FYFinancialStatements_…`); quarterly summaries and
  forecast revisions carry no annual actuals and are not stored. Only the
  current fiscal year's figures of a summary are stated, so each fiscal year
  comes from its own summary (and its corrections).
- **Fiscal year** = the calendar year the period ends in (a 52/53-week year
  ending 1–7 January counts as the year before). The period end is shown with
  every value because a company's own label can differ (some retailers).
- **One scope per filing.** A filing's values come from its consolidated
  statements when it has any consolidated fact, else from its separate ones
  (a filer without subsidiaries). A consolidated filer's parent-only figure is
  kept in the history but never shown as a value: a metric its consolidated
  statements lack reads "not reported".
- **Current value** = consolidated if any, from the most recently filed filing
  that reports the year, its best-ranked concept. Two different values for that
  concept in one filing are both stored and the cell reads `ambiguous` — never
  a guess, and never an older filing's or a lower-ranked concept's figure
  standing in for the conflicting one.
- **Revisions**: a later report that restates a year, or an amendment, becomes
  the current value; the earlier filing's value stays in the as-filed history.
- **Unreadable documents**: an SEC filing whose facts are not available yet is
  offered again for 7 days from its filing date (company facts lag a new
  10-K), then recorded as unavailable. A J-Quants summary carries its
  figures, so it is never pending.
  The widget marks such values "Revised"; the revision dialog lists every
  reported value with its filing.
- **Unmapped standards**: mappings are reviewed per provider and standard —
  SEC maps US-GAAP and IFRS (`ifrs-full`, ADR-0058 §5); J-Quants normalises
  its summary items across standards, so its items are mapped for JGAAP,
  IFRS and US-GAAP filers alike (ADR-0059 §2). A filing under a standard a
  provider has no reviewed mapping for (SEC: Japanese GAAP) is stored and its
  metrics read `no-mapping-for-standard`; a J-Quants summary whose `DocType`
  names another standard (`_JMIS`) is stored without a standard, and its
  metrics read "not reported".

## HTTP API (owner-authenticated, under `/api/v1`)

| Method / path | Purpose |
|---|---|
| `GET /equities/companies` | Tracked companies with sync status: Watchlist companies first, at most 200. |
| `GET /equities/companies/:companyId` | One company with its sync status. |
| `GET /equities/companies/:companyId/statements/:statement?years=5` | `income-statement`, `balance-sheet` or `cash-flow`: the newest *years* fiscal years, oldest first, every metric row, the cited filings. |
| `GET /equities/companies/:companyId/metrics?metric=revenue&years=10` | One metric over fiscal years. |
| `GET /equities/companies/:companyId/revisions?metric=revenue&fiscalYear=2024` | Every as-filed value of one metric-year beside the current value. |
| `GET /equities/companies/:companyId/filings` | Every stored filing of the company, newest first (filing date, then id), with its extraction status (`pending`, `extracted`, `unavailable`), fact count and the document it amends; superseded originals included (at most 500). |

Reads support `If-None-Match` (ETag). US and Japanese companies answer the
same schemas: [`equityFinancials.ts`](../../../packages/contracts/src/equityFinancials.ts).
The API only reads: the track, stop-tracking and Sync now endpoints were
removed by ADR-0054 (the companies follow the stock directory, ADR-0058 §3).

## Sync failures

The company view's `sync.failure` carries a stable code and, for a provider
error, the provider's HTTP status unchanged. The runner's codes
(`EQUITY_SYNC_FAILURE_CODES`): `FINANCIAL_SOURCE_NOT_CONFIGURED`,
`FINANCIAL_COMPANY_NOT_FOUND`, `FINANCIAL_RATE_LIMITED`,
`FINANCIAL_ACCESS_DENIED`, `FINANCIAL_SOURCE_FAILED`, `FINANCIAL_PARSE_FAILED`.
The API's own codes (`EQUITY_SYNC_API_FAILURE_CODES`):

| Code | Meaning | What to do |
|---|---|---|
| `FINANCIAL_IDENTITY_CONFLICT` | The issuer the source reported is already another tracked company's — two listings of one issuer (GOOGL and GOOG), or a ticker that now names another issuer — or differs from the issuer this company resolved to. Nothing of that sync is stored: merging two companies' figures would be worse than none. | Nothing: the second listing is checked again after 30 days (`notFoundRetryDays`) and the first keeps syncing. A ticker change resolves itself when the directory drops the old ticker (its company is untracked). |
| `RETRY_CEILING_REACHED` | Every attempt's lease expired (the runner stopped mid-sync). | Nothing: the company backs off and is tried again. Check the runner if it repeats. |
| `INTERNAL` | The stored rows could not form a valid claim, so the job failed before it ran. | Report it; the company backs off like after any failure. |

## Limitations

- Annual statements only; no quarterly data.
- **Japan: about two fiscal years** (the J-Quants Free plan keeps two years,
  about 12 weeks behind), from earnings summaries (決算短信), not the audited
  annual securities report; gross profit, total liabilities, capital
  expenditures and free cash flow are not available for Japanese stocks, and
  Japanese stocks have no business description (their Company tab shows the
  J-Quants company profile).
- Amendments to old fiscal years filed outside a backfill window before a
  company's first sync are not searched for; a company that changes its fiscal
  year end can miss earlier backfill windows.
- One sync job runs at a time and can delay a research question queued
  behind it by about a minute; a first pass over 11,400 companies is 11,400
  jobs (several hours for the US; about an hour of J-Quants requests for the
  3,700 Japanese companies at 60 a minute, plus the job overhead).
- SEC company-facts numbers above 2^53 would lose exactness (no annual amount
  of a current filer comes near).
- `GET /equities/companies` lists at most 200 companies (Watchlist first),
  so the financial widget dialog offers the Watchlist's companies first.
- **A change of tagged concept moves older years too.** The current value is
  the latest filing's best-ranked concept. If a company switches the concept
  it tags for a metric (say from `Revenues` to
  `RevenueFromContractWithCustomerExcludingAssessedTax`), an older year that
  the newer filing reports as a comparative takes the newer filing's concept
  and figure, and is marked revised when the figures differ. This is
  deliberate — the latest presentation wins, as for a restatement — and the
  revision dialog (`/revisions`) still shows every as-filed value with its
  concept and filing.
- **Stored filings are not re-read when the mapping registry grows.** A
  filing's facts are fetched once, for the concept list of that day, and each
  fact's `metric_code` is fixed when it is stored. A new mapping (a concept,
  or a standard such as IFRS) therefore applies to filings synced afterwards
  only. To apply it to a company's stored filings, re-extract them — an
  administrative operation; export first (`wrangler d1 export`, see
  [operations](../operations.md)):

  ```sql
  -- :owner and :company are the owner id and the company id (eqc_…).
  DELETE FROM equity_reported_fact WHERE owner_id = :owner AND company_id = :company;
  DELETE FROM equity_metric_value WHERE owner_id = :owner AND company_id = :company;
  UPDATE equity_report_filing
  SET facts_status = 'pending', fact_count = 0, primary_scope = NULL
  WHERE owner_id = :owner AND company_id = :company AND facts_status = 'extracted';
  ```

  For a Japanese company, delete its `equity_report_filing` rows as well
  (after its facts and values): the J-Quants claim names every stored
  summary as known, so only summaries that are not stored are returned
  again. Then make the company due — `UPDATE equity_sync_state SET next_due_at =
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE owner_id = :owner AND
  company_id = :company;` (there is no Sync now since ADR-0054), or wait for
  its daily sync. The next sync offers those filings
  as pending (newest first, 20 per sync; later syncs take the rest), the
  runner fetches their facts with the current concept list, and the API
  stores them and recomputes the values. Filings stay listed throughout; the
  statements are empty until that sync completes. The as-filed history comes
  back from the source unchanged (`apps/api/test/equitySync.test.ts`,
  "re-extracts stored filings by the documented procedure").
