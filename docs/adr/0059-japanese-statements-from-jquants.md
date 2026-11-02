# ADR-0059: Japanese financial statements and company profiles from J-Quants; EDINET removed

Status: accepted, 2026-11-02. Supersedes the EDINET parts of ADR-0048
(JP statements from EDINET), ADR-0053 (the 事業の内容 of Japanese stocks)
and ADR-0058 §4 (the shared EDINET index, `edinet-index`) and §5's EDINET
IFRS note. ADR-0058 §1 (every directory stock synced, never-stored first)
and §3 (tracking, cadence, never-checked first) stand.

## Context

The owner wrote (2026-11-02): "I can not access edinet. Please use
JQUANTS_API." Without `EDINET_API_KEY` no Japanese company has statements
(3,696 of 3,700 JP companies were never checked on the dev data; the
`edinet-index` job failed `FINANCIAL_SOURCE_NOT_CONFIGURED` every 30
minutes). The owner already holds a J-Quants Free key (`JQUANTS_API_KEY`,
ADR-0058 §2).

Measured with that key on 2026-11-02 (docs/external-apis/apis/jquants.md,
Verification log):

- `GET /v2/fins/summary?code=` answers every earnings summary (決算短信,
  TDnet XBRL) of one company in the Free window — about 8 to 13 records in
  one page, 0.2 s. Eight requests in 1.4 s were all answered: this endpoint
  has its own limit (60 a minute, the docs' "Rate Limits by Endpoint"), not
  the plan's 3–5 a minute.
- Full-year results are the records whose `DocType` starts with
  `FYFinancialStatements_` (`…_Consolidated_JP`, `…_Consolidated_IFRS`,
  `…_Consolidated_US`, `…_NonConsolidated_JP`); quarterly records,
  `EarnForecastRevision` and `DividendForecastRevision` carry no annual
  actuals. A correction is a second full-year record of the same fiscal
  year with a later disclosure (JT 2914: FY2024 on 2025-02-13 and, with a
  different operating profit, 2025-03-10).
- Free keeps 2 years, about 12 weeks behind: about two fiscal years of
  annual figures per company. Items: `Sales`, `OP`, `OdP` (JGAAP only),
  `NP` (attributable to owners), `TA`, `Eq`, `CashEq`, `CFO`, `CFI`, `CFF`,
  and the `NC…` non-consolidated items of consolidated filers. No gross
  profit, liabilities or capital expenditure. Amounts are yen strings; an
  item not stated is `""`.
- `GET /v2/equities/master` (no parameters) answers every listed issue —
  4,444 rows in one page, 1.6 s, as of 12 weeks ago on Free — with English
  name, 17- and 33-sector code and name, scale category and market segment.
  It counts against the plan limit.
- J-Quants has no business description text.

Asked on 2026-11-02, the owner chose (AskUserQuestion): **Free plan**;
**replace EDINET and remove its code**; a Japanese stock's Company tab
shows the **J-Quants company profile**.

## Decision

### 1. Providers

`EQUITY_PROVIDERS` becomes `["sec", "jquants"]`; `EQUITY_PROVIDER_OF_MARKET.JP`
is `"jquants"`. EDINET is removed: the `edinet` provider, the
`edinet-index` job kind and its contracts, `EDINET_API_KEY`, the EDINET
clients and CSV/ZIP readers of both runners, the EDINET concept mappings,
the 有価証券報告書 forms, the tables `edinet_document_index` and
`edinet_index_day`, docs/external-apis/apis/edinet.md and every EDINET
mention that describes current behaviour (history in ADRs stays).

### 2. Japanese statements: `financial-sync` with provider `jquants`

**Claim** (`jquantsSyncRequestSchema`):

| Field | Meaning |
|---|---|
| `provider` | `"jquants"` |
| `code` | the 5-digit J-Quants code of the directory symbol (`1380` → `13800`, `130A` → `130A0`) |
| `knownDisclosures` | `DiscNo` of every stored filing of the company (≤ `maxKnownFilings`) |

A JP company is due like a US company (ADR-0058 §3: never-checked first,
24 h on the Watchlist, else 168 h); the EDINET-index gate is gone.

**Runner.** One query, `GET /v2/fins/summary?code=<code>`, every page
(`pagination_key`, at most 20), paced under the pacer key
`jquants-fins`: 60 starts per 65 s, evenly spaced (one per 1,084 ms),
separate from the `jquants` key of prices and the master. Of the answer
it keeps the records whose `DocType` starts with `FYFinancialStatements_`.
Ordered by (`DiscDate`, `DiscTime`, `DiscNo`), the first record of a
fiscal year (`CurFYSt`, `CurFYEn`) is form `earnings-report`, every later
one `amended-earnings-report` with `amendsSourceDocumentId` = the
`DiscNo` of the record before it — decided over all full-year records of
the answer, known ones included. Each record whose `DiscNo` is not in
`knownDisclosures` becomes one filing:

| Filing field | From |
|---|---|
| `sourceDocumentId` | `DiscNo` (14 digits) |
| `form` | as above |
| `filedOn` | `DiscDate` |
| `submittedAt` | `DiscDate` + `DiscTime`, Asia/Tokyo, as UTC ISO-8601 |
| `periodStart`, `periodEnd` | `CurFYSt`, `CurFYEn` |
| `accountingStandard` | `DocType` suffix: `_JP` → `JGAAP`, `_IFRS` → `IFRS`, `_US` → `US-GAAP`, any other (e.g. `_JMIS`) → null |
| `sourceUrl` | `https://api.jquants.com/v2/fins/summary?code=<code>&date=<DiscDate>` (the record's source; J-Quants keeps no public document page) |
| `factsStatus` | `extracted` (the answer holds the figures; no pending state) |

**Facts.** One fact per stated (non-empty) item, concept `jquants:<Item>`,
unit `JPY` (J-Quants records every amount in yen), the decimal text as
J-Quants states it (canonicalised: leading `+`/zeros removed, a value
that is not a plain decimal is dropped):

| Item | Period |
|---|---|
| `Sales`, `OP`, `OdP`, `NP`, `CFO`, `CFI`, `CFF` | duration `CurPerSt`–`CurPerEn` |
| `TA`, `Eq`, `CashEq` | instant `CurPerEn` |
| `NCSales`, `NCOP`, `NCOdP`, `NCNP`, `NCTA`, `NCEq` | as their non-`NC` item, scope `separate` |

Scope: a `_Consolidated_` record's items are `consolidated`, its `NC…`
items `separate`; a `_NonConsolidated_` record's items are `separate`
(its `NC…` items are empty).

**Identity**: `sourceCompanyId` = the 5-digit code, `name` null,
`fiscalYearEnd` = `MM-DD` of the newest full-year `CurFYEn`, null when
the answer has none. **An empty answer** (ETFs, REITs without XBRL,
delisted codes) is a success with no filings: the company is checked
again after `notFoundRetryDays`, like an SEC company without annual
reports. `400` → `FINANCIAL_PARSE_FAILED` (a code the API should never
build); `401`/`403` → `FINANCIAL_ACCESS_DENIED`; `429` →
`FINANCIAL_RATE_LIMITED` (the pacer holds `jquants-fins` 120 s); a
missing key → `FINANCIAL_SOURCE_NOT_CONFIGURED`.

**Mappings** (`EQUITY_CONCEPT_MAPPINGS`, provider `jquants`, reviewed for
`JGAAP`, `IFRS` and `US-GAAP` — J-Quants normalises the items across
standards; `OdP` for `JGAAP` only, as J-Quants states):

| Metric | Concept |
|---|---|
| revenue | `jquants:Sales` |
| operating-income | `jquants:OP` |
| ordinary-income | `jquants:OdP` (JGAAP) |
| profit-attributable-to-owners | `jquants:NP` |
| total-assets | `jquants:TA` |
| total-equity | `jquants:Eq` |
| cash-and-cash-equivalents | `jquants:CashEq` |
| net-cash-from-operating / investing / financing-activities | `jquants:CFO` / `CFI` / `CFF` |

gross-profit, total-liabilities and capital-expenditures read
`not-reported` for J-Quants filings; free-cash-flow `not-derivable`.
The Lean model's `hasReviewedMappings` follows (`jquants`: JGAAP, IFRS,
US-GAAP).

**Forms.** `EQUITY_REPORT_FORMS` replaces `securities-report` and
`amended-securities-report` with `earnings-report` and
`amended-earnings-report`; `isAmendmentForm` is true for the latter.
`EQUITY_BUSINESS_FORMS` loses `securities-report`. The business
description (ADR-0053) is US-only.

### 3. Company profiles: J-Quants Listed Issue Master

The JP `stock-directory-refresh` job (JPX list, ADR-0034) also asks
J-Quants `GET /v2/equities/master` (every page, pacer key `jquants`) when
`JQUANTS_API_KEY` is set, and its completion carries `profiles`: one
`stockCompanyProfileSchema` per listed issue whose 5-digit code ends in
`0` (common stock; the directory symbol is the first four characters),
or null when the key is missing or the master request failed (the
directory is stored either way; the failure is logged). US completions
carry `profiles: null`.

| Profile field | From |
|---|---|
| `symbol` | `Code` without its trailing `0` |
| `nameEn` | `CoNameEn` (null when empty) |
| `sector17Code`, `sector17Name` | `S17`, `S17Nm` |
| `sector33Code`, `sector33Name` | `S33`, `S33Nm` |
| `scaleCategory` | `ScaleCat` (null for `-`) |
| `marketSegmentCode`, `marketSegmentName` | `Mkt`, `MktNm` |
| `asOf` | `Date` |

The API replaces the market's rows of `stock_company_profile` with them,
keeping only symbols of the stored JP directory (a null `profiles` keeps
the stored rows). `GET /api/v1/stocks/:stockId` returns a JP stock's
stored profile as `companyProfile` (`stockCompanyProfileViewSchema`, with
`retrievedAt`; null when none is stored and for US stocks), and its
`business` is `{ status: "not-provided" }`. The Company tab of a Japanese
stock shows the profile — English name, 33-sector (17-sector), market
segment, scale category, "as of" date, source J-Quants — in place of the
business description, which stays for US stocks.

### 4. Migration 0027 (`0027_jquants_financials.sql`)

- `equity_company` and `equity_report_filing`: `provider` CHECK
  `('sec', 'jquants')`, `equity_report_filing.form` CHECK with the new
  forms (table rebuilds, as 0025 did).
- Every JP company: provider `jquants`, `source_company_id` NULL; its
  EDINET filings, facts, metric values and business description are
  deleted; its sync state is reset to never checked, due now — so the
  never-checked-first rule serves them at once.
- `edinet_document_index` and `edinet_index_day` are dropped; jobs of
  kind `edinet-index` are deleted with their transitions and events.
- `equity_sync_state.edinet_phase` is dropped (the sync view's `phase`,
  EDINET only, is removed from `equitySyncViewSchema`).
- `stock_company_profile` is created (owner, market, symbol primary key;
  the §3 fields; `retrieved_at`).

### 5. Configuration

`EDINET_API_KEY` is removed (both runners, `.env.example`, OPERATIONS).
`JQUANTS_API_KEY` now also enables Japanese statements and profiles;
without it JP `financial-sync` fails `FINANCIAL_SOURCE_NOT_CONFIGURED`
and profiles are null. No new variable: `jquants-fins` is paced at the
endpoint's documented 60 a minute.

## Consequences

- Japanese statements cover about two fiscal years (Free) instead of
  EDINET's six, about 12 weeks behind, from earnings summaries (決算短信),
  not the audited annual securities report; gross profit, liabilities,
  capex and free cash flow are not available for Japanese stocks.
- First pass: about 3,700 one-request jobs, about an hour of requests at
  60 a minute plus the job overhead.
- IFRS and US-GAAP Japanese filers now have statements (EDINET's
  `jpigp_cor` filers had none).
- Japanese stocks show no 事業内容; they show sector and market segment.
- Removing EDINET deletes a large body of code, tests, vectors, Lean
  model parts and docs; reviving it would mean restoring them from git
  (last commit with EDINET: the parent of the ADR-0059 merge).
