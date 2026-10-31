# External API: SEC EDGAR

## 1. Overview

| Property | Value |
|---|---|
| Provider | U.S. Securities and Exchange Commission (SEC), EDGAR system |
| Purpose | The US half of the Watchlist's stock directory ([ADR-0034](../../adr/0034-stock-directory-search.md)); two research tools: `finance.sec_company_financials` (latest fiscal-year revenue, net income, diluted EPS and net margin from XBRL company facts, FR-006) and `filings.sec_13f_holdings` (the two latest Form 13F-HR holdings of an investment manager and the change in reported positions, FR-008); and the US half of the financial-statement sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md)): the 10-K / 10-K/A filings of each tracked US company and their annual XBRL facts, stored as the as-filed history behind the Equities page and the financial-statement widgets. |
| Hosts | `www.sec.gov`, `data.sec.gov` |
| Endpoints | `GET /files/company_tickers_exchange.json` — ticker, CIK, name and exchange of every SEC registrant with a ticker (`www.sec.gov`); `GET /api/xbrl/companyfacts/CIK##########.json` — every XBRL fact a company reported (`data.sec.gov`); `GET /submissions/CIK##########.json` — a filer's identity and recent filing index (`data.sec.gov`); `GET /Archives/edgar/data/{cik}/{accession-folder}/{accession}.txt` — the complete submission text file of one filing (`www.sec.gov`) |
| Authentication | None (SEC: "These APIs do not require any authentication or API keys"). SEC's fair-access policy requires a declared `User-Agent` naming the requester and a contact e-mail; it comes from `SEC_USER_AGENT` in `apps/runner/.env`. Without a usable value (8–200 printable ASCII characters containing an e-mail-shaped `x@y.z`) the client sends nothing: the tools fail with `NOT_CONFIGURED` (the runner logs `sec_tools_disabled` at start), the US directory refresh with `DIRECTORY_NOT_CONFIGURED`, and a US company's `financial-sync` job with `FINANCIAL_SOURCE_NOT_CONFIGURED`. |
| Configuration | None besides `SEC_USER_AGENT`. |
| Usage Limits | SEC: "Current max request rate: 10 requests/second", and SEC "reserves the right to limit request rates" ([accessing EDGAR data](https://www.sec.gov/os/accessing-edgar-data)). Ours: a paced SEC client spaces request starts at least 125 ms apart (8 per second) — in Rust one client for every SEC caller, in TypeScript one per area (section 7); the directory refresh also takes a grant from the pacer window `sec` (8 starts per 1 s) before its request; no automatic retries; the ticker directory is cached 12 h for the financials tool and, separately, for the financial sync, and parsed 13F filings are cached by accession (section 4). A financial sync sends at most 3 requests per job — the ticker directory only while the company's CIK is unknown, the submissions index always, the company facts only when an annual filing is new or pending or the claim asks for a full check — each first taking a grant from the pacer window `sec`; one `financial-sync` job exists at a time. |
| Called By | Rust runner (default) and TypeScript runner (rollback): `stock-directory-refresh` jobs for market `US` (queued by "Update stock list" or by the Watchlist when the US list is missing or older than 7 days); the research tools `finance.sec_company_financials` and `filings.sec_13f_holdings` during research runs; and `financial-sync` jobs of tracked companies with market `US`, created at claim time when a company is due (every 24 h, at once after a completion that left work, or after "Sync now"). The API Worker and the browser never call SEC; the browser only opens a stored filing link on the owner's click. |
| Code | `crates/research-finance/src/sec_client.rs`, `crates/research-finance/src/sec_directory.rs`, `crates/research-finance/src/sec_financials.rs`, `crates/research-finance/src/sec_13f.rs`, `crates/research-finance/src/sec_annual.rs`, `crates/research-finance/src/equity_sync.rs`, `crates/research-finance/src/sec_xml.rs`, `crates/research-feed/src/info_table.rs`, `crates/research-tools/src/sec.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-runner/src/config.rs`, `crates/research-runner/src/composition.rs`, `crates/research-runner/src/job_execution.rs`, `packages/adapters/src/finance/secClient.ts`, `packages/adapters/src/finance/secDirectory.ts`, `packages/adapters/src/finance/secFinancials.ts`, `packages/adapters/src/finance/sec13f.ts`, `packages/adapters/src/finance/secAnnualFilings.ts`, `packages/adapters/src/finance/equitySync.ts`, `packages/adapters/src/tools/secTools.ts`, `packages/adapters/src/finance/stockDirectory.ts`, `apps/runner/src/marketPacing.ts`, `apps/runner/src/config.ts`, `apps/runner/src/main.ts`, `apps/runner/src/jobExecution.ts`; the claim (CIK, known and pending accessions, `filedSince`, `fullCheck`) is built by `packages/application/src/equitySync.ts` |
| Official Documentation | [EDGAR application programming interfaces](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [Accessing EDGAR data](https://www.sec.gov/os/accessing-edgar-data) (fair access, `User-Agent`, ticker files, archive paths), [Webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions), [Form 13F XML Technical Specification 2.0](https://www.sec.gov/submit-filings/technical-specifications) (September 2026, `eis_13FDocument.xsd` and samples), [EDGAR PDS Technical Specification](https://www.sec.gov/files/info/edgar/specifications/pds_dissemination_spec.pdf) (document tags of a disseminated submission), [Form 13F FAQ](https://www.sec.gov/rules-regulations/staff-guidance/division-investment-management-frequently-asked-questions/frequently-asked-questions-about-form-13f) |
| Last Verified | 2026-10-31, spec and fixture; no live SEC call (owner decision; `SEC_USER_AGENT` is not set) (section 7) |

A US directory refresh downloads `company_tickers_exchange.json` once and turns it into the `stock-directory-refreshed` completion (rows on Nasdaq, NYSE, Cboe and Texas SE only). `finance.sec_company_financials` reads the same file (cached 12 h) to resolve the ticker to a CIK, then downloads that company's XBRL company facts and selects the latest annual 10-K figures. `filings.sec_13f_holdings` downloads the manager's submissions index, picks the two latest distinct report periods filed on form `13F-HR`, and downloads each filing's complete submission text file to read its information table. A `financial-sync` job of a US company resolves the company's CIK from the same ticker file while it is unknown, reads the company's submissions index, and — when a 10-K or 10-K/A filed in the last six years is new or pending, or on a full check — downloads the company facts once: they list every fact once per filing that reported it (`accn`), so one document gives each annual filing's as-filed facts, including older annual filings the submissions index no longer lists. The annual facts of the new and pending filings go to the API in the `financial-synced` completion. Every request goes through a paced SEC client pinned to the two SEC hosts. The SEC press-release feed `https://www.sec.gov/news/pressreleases.rss` in `packages/application/src/recommendedCatalog.ts` is a recommended news source, fetched as a feed ([Web feeds and pages](web-feeds-and-pages.md)), not through this client.

## 2. Input Parameters

Every endpoint is sent by the SEC client (`packages/adapters/src/finance/secClient.ts`, `crates/research-finance/src/sec_client.rs`) through the runner's safe fetcher, which sets these headers (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`). Redirects (at most 5) are followed only to `www.sec.gov` or `data.sec.gov`.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `User-Agent` | header | string | Yes (SEC fair-access policy) | — ; we send `SEC_USER_AGENT` verbatim | 8–200 printable ASCII characters containing `x@y.z`; SEC's format "Sample Company Name AdminContact@<sample company domain>.com" | Declares who is fetching. The client refuses to send without a usable value (`NOT_CONFIGURED`). |
| `Accept` | header | string | No | We send `application/json` (JSON endpoints) or `text/plain` (submission text file) | Printable ASCII | SEC serves each path in one format; the header documents what we expect. |
| `Accept-Encoding` | header | string | No | SEC recommends `gzip, deflate`; we send `gzip` | `gzip` | Compressed transfer; the encoded bytes count against the size cap. |
| `Host` | header | string | Yes | We send the URL's host (`www.sec.gov` or `data.sec.gov`) | — | SEC's guidance names it explicitly; the transport always sends it. |

### GET /files/company_tickers_exchange.json

No path or query parameters. Built from `SEC_TICKER_DIRECTORY_URL` (`packages/adapters/src/finance/secFinancials.ts`, `crates/research-finance/src/sec_financials.rs`); only the headers above.

### GET /api/xbrl/companyfacts/CIK##########.json

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `CIK##########` | path | string | Yes | — ; we send the CIK found in the ticker directory | `CIK` followed by 10 digits, zero-padded ("including leading zeros") | The company. The ticker the tool was given (`^[A-Za-z0-9.-]{1,12}$`, dots read as SEC's hyphen: `BRK.B` → `BRK-B`) is looked up in the ticker directory first; a ticker SEC does not list fails with `NOT_FOUND` before this request. Financial sync: the claim's CIK (`equity_company.source_company_id` once resolved), else the CIK the ticker directory gives for the company's listing symbol (a symbol SEC does not list fails with `FINANCIAL_COMPANY_NOT_FOUND`). |

### GET /submissions/CIK##########.json

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `CIK##########` | path | string | Yes | — ; we send the tool's `managerCik` normalised, or the financial sync's company CIK | `CIK` followed by 10 digits, zero-padded; the tool accepts `^(CIK)?\d{1,10}$` (case-insensitive) and refuses an all-zero CIK (`INVALID_IDENTIFIER`); the sync sends the claim's 10-digit CIK or the one resolved from the ticker directory, as for company facts | The investment manager filing Form 13F, or the tracked company. |

### GET /Archives/edgar/data/{cik}/{accession-folder}/{accession}.txt

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `{cik}` | path | string | Yes | — ; we send the manager's CIK without leading zeros | Decimal digits | SEC's archive folder of the filer. |
| `{accession-folder}` | path | string | Yes | — ; we send the accession number without dashes | 18 digits | SEC's "alternate path with the accession number without dashes" (post-EDGAR 7.0 filings). |
| `{accession}` | path | string | Yes | — ; we send the accession number from the submissions index | `##########-##-######` | The file name of the complete submission text file (`<accession>.txt`). |

## 3. Output Parameters

### GET /files/company_tickers_exchange.json

`application/json`: a column-oriented table. Columns are located by name, never by position. About 0.5 MB (measured 2026-10-24: 10,429 rows); the download is capped at 8,000,000 bytes.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.fields` | array of string | No | No | Yes | Column names; observed `["cik","name","ticker","exchange"]`. All four must be present or the file is `UNEXPECTED_RESPONSE`. |
| `$.data` | array of array | No | No | Yes | One row per ticker, in SEC's order. A row whose CIK, name or ticker is unusable is skipped; the first row of a ticker wins. |
| `$.data[*][cik]` | number | No | No | Yes | Central Index Key, a positive integer without padding (`320193`). |
| `$.data[*][name]` | string | No | No | Yes | EDGAR conformed company name (`Apple Inc.`, `TOYOTA MOTOR CORP/`). |
| `$.data[*][ticker]` | string | No | No | Yes | Ticker as SEC writes it; share classes use a hyphen (`BRK-B`). |
| `$.data[*][exchange]` | string | Yes | No | Yes | Exchange text: observed `Nasdaq`, `NYSE`, `CBOE`, `TXSE`, `OTC`; `null` when SEC states none. |

### GET /api/xbrl/companyfacts/CIK##########.json

`application/json`. SEC describes it as "all the company concepts data for a company" with "a separate array of facts for each units on measure". SEC publishes no field-level schema; the field names below are those the parser reads plus the fields SEC is known to send, not observed in this document (no live call; section 7). Large filers' documents run to tens of megabytes; the download is capped at 48,000,000 bytes.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.cik` | number | No | No | No | The company's CIK, unpadded. |
| `$.entityName` | string | No | No | No | Company name (validated as a string when present, otherwise unused). |
| `$.facts` | object | No | No | Yes | Taxonomies keyed by prefix: `dei`, `us-gaap`, `ifrs-full`, `srt`, … Only `us-gaap` is read; a document without it reports every figure unavailable ("may report under IFRS") for the tool, and no facts for any filing (each `not-available`) for the sync. A document without an object `facts` fails the sync (`FINANCIAL_PARSE_FAILED`). |
| `$.facts.<taxonomy>.<concept>` | object | No | Yes | Yes (`us-gaap` only) | One concept. The tool reads `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, `RevenueFromContractWithCustomerIncludingAssessedTax`, `SalesRevenueNet`, `NetIncomeLoss`, `EarningsPerShareDiluted`. The sync reads the concepts its claim names (`equityConceptsOfProvider("sec")`: the revenue concepts above, `GrossProfit`, `OperatingIncomeLoss`, `NetIncomeLoss`, `Assets`, `Liabilities`, `StockholdersEquity`, `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`, `CashAndCashEquivalentsAtCarryingValue`, `NetCashProvidedByUsedIn{Operating,Investing,Financing}Activities`, `PaymentsToAcquirePropertyPlantAndEquipment`). |
| `$.facts.<taxonomy>.<concept>.label` | string | Yes | No | No | Taxonomy label. |
| `$.facts.<taxonomy>.<concept>.description` | string | Yes | No | No | Taxonomy definition text. |
| `$.facts.<taxonomy>.<concept>.units` | object | No | No | Yes | Fact arrays keyed by unit: `USD`, `JPY`, … (3-letter code) for amounts, `USD/shares` for per-share figures, `shares`, `pure`, … The tool ignores other units; the sync keeps any unit key of 1–40 characters (the API checks the currency later). |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].start` | string | No | Yes | Yes | Period start `YYYY-MM-DD`; absent for instant facts. The tool never uses instants; the sync reads them as balance-sheet values (section 6). An invalid date skips the entry in the sync. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].end` | string | No | No | Yes | Period end (or instant) `YYYY-MM-DD`. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].val` | number | No | No | Yes | The reported value; must be finite. The sync keeps it only when its JavaScript text (`Number#toString`) is canonical decimal text — every integer below 10^21, but not an exponent form. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].accn` | string | No | No | Yes | Accession number of the filing that reported the fact (1–40 characters for the tool; `##########-##-######` for the sync). The same period appears once per filing that reported it. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].fy` | number | Yes | No | Yes (tool) | Fiscal year of the FILING (not of the fact's period); lineage only. Must be an integer when present. The sync does not read it. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].fp` | string | Yes | No | Yes (tool) | Fiscal period of the filing (`FY`, `Q1`–`Q3`); the tool's annual facts need `FY`. The sync does not read it (the 350–380-day rule decides). |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].form` | string | No | No | Yes | Form type; annual facts need `10-K` or `10-K/A` (both callers; any other form skips the entry). The sync marks an accession `10-K/A` when any of its entries says so. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].filed` | string | No | No | Yes | Filing date `YYYY-MM-DD`; breaks ties between restatements (tool); the earliest of an accession is its filing date when the submissions index no longer lists it (sync). |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].frame` | string | No | Yes | No | Calendar frame the fact was assigned to (`CY2024`, `CY2024Q4I`); present on one fact per frame only. |

A malformed fact entry is skipped; a concept whose `units` is not an object of arrays is treated as absent.

### GET /submissions/CIK##########.json

`application/json`. SEC describes the content ("current name, former name, and stock exchanges and ticker symbols", a "compact columnar data array" of at least one year or 1,000 of the most recent filings, and `files` for older ones) but publishes no field list. The read fields are checked by the parser; the others are the fields SEC is known to send, not observed in this document (section 7). Capped at 8,000,000 bytes.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.cik` | string | No | No | No | CIK without padding. |
| `$.entityType` | string | No | No | No | Entity type (`operating`, `other`, …). |
| `$.sic`, `$.sicDescription` | string | No | No | No | Standard Industrial Classification code and text (may be empty). |
| `$.ownerOrg` | string | Yes | Yes | No | SEC office reviewing the filer. |
| `$.insiderTransactionForOwnerExists`, `$.insiderTransactionForIssuerExists` | number | No | No | No | `0` or `1`. |
| `$.name` | string | No | No | Yes | Current EDGAR conformed name. 13F tool: must be non-empty; trimmed, it becomes the investor name of the filing records. Sync: trimmed, the company's name when 1–200 characters, else null. |
| `$.tickers`, `$.exchanges` | array of string | No | No | No | Tickers and their exchanges (empty for most managers). |
| `$.fiscalYearEnd` | string | Yes | No | Yes (sync) | Fiscal year end as `MMDD` (`0928`); the sync turns a valid month and day into `MM-DD`, anything else into null. |
| `$.ein`, `$.lei`, `$.description`, `$.website`, `$.investorWebsite`, `$.category`, `$.stateOfIncorporation`, `$.stateOfIncorporationDescription`, `$.phone`, `$.flags` | string | Yes | No | No | Descriptive filer data. |
| `$.addresses.mailing`, `$.addresses.business` | object | No | No | No | Address objects (street, city, state or country, zip code, foreign-location flags). |
| `$.formerNames[*]` | object | No | No | No | `name`, `from`, `to` of earlier names. |
| `$.filings.recent` | object of arrays | No | No | Yes | The recent filings as parallel arrays of equal length; index `i` of each array describes filing `i`, newest first. Every array the parser reads must hold only strings; the sync also fails the document (`FINANCIAL_PARSE_FAILED`) when the six arrays it reads differ in length. |
| `$.filings.recent.accessionNumber[*]` | string | No | No | Yes | `##########-##-######`; a value of another shape skips that filing. |
| `$.filings.recent.filingDate[*]` | string | No | No | Yes | Filing date `YYYY-MM-DD`. The sync keeps annual rows filed on or after the claim's `filedSince`. |
| `$.filings.recent.reportDate[*]` | string | No | No | Yes | Period of report `YYYY-MM-DD` (the 13F quarter end; a 10-K's fiscal year end); `""` for forms without one. A 10-K / 10-K/A row whose report date is not a valid date is stored only when company facts list its accession (section 6). |
| `$.filings.recent.acceptanceDateTime[*]` | string | No | No | Yes (sync) | EDGAR acceptance instant, ISO 8601 UTC (`2025-11-05T21:04:11.000Z`); kept when it is a valid instant, else null. |
| `$.filings.recent.form[*]` | string | No | No | Yes | Form type. 13F tool: only exactly `13F-HR` (`13F-HR/A`, `13F-NT`, `13F-CTR` are ignored). Sync: only exactly `10-K` and `10-K/A` (`10-KT`, `10-K405`, `20-F`, `40-F`, `10-Q`, … are ignored). |
| `$.filings.recent.primaryDocument[*]` | string | No | No | Yes (sync) | The filing's main document (`synd-20250930.htm`); a plain file name (`[A-Za-z0-9._-]{1,200}`) is appended to the filing's archive folder for its link, anything else links the folder. |
| `$.filings.recent.act[*]`, `.fileNumber[*]`, `.filmNumber[*]`, `.items[*]`, `.core_type[*]`, `.size[*]`, `.isXBRL[*]`, `.isInlineXBRL[*]`, `.primaryDocDescription[*]` | string or number | No | No | No | Other per-filing columns. |
| `$.filings.files[*]` | object | No | No | No | `name`, `filingCount`, `filingFrom`, `filingTo` of older filing pages; never fetched, so a 13F-HR older than the recent window is not found. The sync finds older annual filings in the company facts instead (by accession). |

### GET /Archives/edgar/data/{cik}/{accession-folder}/{accession}.txt

`text/plain`: the complete disseminated submission — a header, then one `<DOCUMENT>` block per document, each with `<TYPE>`, `<SEQUENCE>`, `<FILENAME>`, optional `<DESCRIPTION>` and `<TEXT>`; XML documents sit between `<XML>` and `</XML>` inside `<TEXT>` (PDS specification §3.3.2). Capped at 16,000,000 bytes: a larger information table is refused rather than half-read.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| Submission header (before the first `<DOCUMENT>`) | text | No | No | No | Accession number, submission type, period, filer data. |
| `<DOCUMENT>` … `</DOCUMENT>` | text block | No | No | Yes | Split on `<DOCUMENT>`; the first block whose `<TYPE>` (rest of the line, trimmed, upper-cased) is `INFORMATION TABLE` is used. None is `UNEXPECTED_RESPONSE`. |
| `<TYPE>` | text | No | No | Yes | Conformed document type (`13F-HR`, `INFORMATION TABLE`, …). |
| `<SEQUENCE>`, `<FILENAME>`, `<DESCRIPTION>` | text | No | `<DESCRIPTION>`: Yes | No | Document number, file name, description. |
| `<XML>` … `</XML>` | text | No | No | Yes | The information table XML, trimmed. |
| `informationTable` | element | No | No | Yes | Root, namespace `http://www.sec.gov/edgar/document/thirteenf/informationtable`; filers use any prefix (`ns1:`), which the parser strips. Up to 250,000 `infoTable` rows. |
| `infoTable/nameOfIssuer` | string ≤ 150 | No | No | Yes | Issuer name; the parser accepts 1–300 characters after trimming (entities decoded). |
| `infoTable/titleOfClass` | string ≤ 150 | No | No | No | Class title (`COM`, `SPONSORED ADS`). |
| `infoTable/cusip` | string | No | No | Yes | `[A-Za-z0-9]{9}`; upper-cased. A row without a readable CUSIP is unreadable and marks the whole filing incomplete. |
| `infoTable/figi` | string | No | Yes | No | 12-character FIGI. |
| `infoTable/value` | integer ≤ 16 digits | No | No | Yes | Market value: whole dollars for filings made on or after 2023-01-03, thousands of dollars before (Form 13F FAQ 36 and 62). |
| `infoTable/shrsOrPrnAmt/sshPrnamt` | integer ≤ 16 digits | No | No | Yes | Number of shares or principal amount. |
| `infoTable/shrsOrPrnAmt/sshPrnamtType` | enum | No | No | Yes | `SH` (shares) or `PRN` (principal amount). `PRN` rows are excluded and counted. |
| `infoTable/putCall` | enum | No | Yes | Yes | `Put` or `Call` on option rows; any value excludes the row (counted). |
| `infoTable/investmentDiscretion` | enum | No | No | No | `SOLE`, `DFND`, `OTR`. |
| `infoTable/otherManager` | string ≤ 100 | No | Yes | No | Other included managers. |
| `infoTable/votingAuthority/Sole`, `/Shared`, `/None` | integer | No | No | No | Voting authority by kind. |

## 4. Error Handling

### HTTP status codes

The client translates the safe fetcher's result (`translateFetchError` in `packages/adapters/src/finance/secClient.ts`, `translate` in `crates/research-finance/src/sec_client.rs`); SEC's status travels unchanged as `upstreamStatus` beside every code ([§4a](../../rule/error_handling.md)). The error body is never read. The US directory refresh then maps the tool codes to directory codes (`failureOf` in `packages/adapters/src/finance/secDirectory.ts`, `failure_of` in `crates/research-finance/src/sec_directory.rs`).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200 | Document served | Parsed (section 3) | — |
| 301, 302, 303, 307, 308 | Redirect | Followed up to 5 hops, only to `www.sec.gov` / `data.sec.gov`; any other host fails the fetch | `FETCH_FAILED` (off-host); directory `DIRECTORY_SOURCE_FAILED` |
| 403 | SEC refuses the request (no or undeclared `User-Agent`, request rate above the limit) | Stops, not retryable; the detail asks the owner to check `SEC_USER_AGENT` and the request rate | `ACCESS_DENIED`; directory `DIRECTORY_SOURCE_FAILED` |
| 404 | No document at the address (unknown CIK, accession) | Stops, not retryable | `NOT_FOUND`; directory `DIRECTORY_SOURCE_FAILED` |
| 429 | Rate limit | Stops, `retryable: true`; no automatic retry | `RATE_LIMITED`; directory `DIRECTORY_RATE_LIMITED` |
| 5xx | SEC server failure | Stops, `retryable: true` | `FETCH_FAILED`; directory `DIRECTORY_SOURCE_FAILED` |
| Other non-2xx | Any other refusal | Stops, not retryable | `FETCH_FAILED`; directory `DIRECTORY_SOURCE_FAILED` |
| — (no answer) | Timeout, network error, caller stopped the job | Stops, `retryable: true`, `upstreamStatus` null | `FETCH_FAILED`; directory `DIRECTORY_SOURCE_FAILED` |

Our own failures, with no SEC status: `NOT_CONFIGURED` (no usable `SEC_USER_AGENT`; nothing sent; directory `DIRECTORY_NOT_CONFIGURED`), `INVALID_IDENTIFIER` (13F `managerCik` is not a CIK), `NOT_FOUND` (ticker not in the ticker directory), `RESPONSE_TOO_LARGE` (body over the cap), `UNEXPECTED_RESPONSE` (not JSON, wrong shape, no information table, information table not well-formed XML; directory `DIRECTORY_PARSE_FAILED`), `NO_DATA` (no `13F-HR` in the recent window). The directory also fails as `DIRECTORY_PARSE_FAILED` when fewer than 1,000 or more than 10,000 rows remain (`finishDirectory`), so a changed file can never replace a good stored list. The financials tool fails as `SECURITY_NOT_IDENTIFIABLE` when SEC's exchange text has no contract venue: an exchange text the directory keeps maps through the directory's own table (`Nasdaq` → `NASDAQ`, `NYSE` → `NYSE`, `CBOE` → `Cboe BZX`, `TXSE` → `TXSE`), any other text must name a contract US venue (`NYSE`, `NASDAQ`, `NYSE American`, `NYSE Arca`, `Cboe BZX`, `TXSE`); both compared trimmed and case-insensitively.

The financial sync maps the client's result to its own codes (`equitySyncFailureOfSec` in `packages/adapters/src/finance/secAnnualFilings.ts`, `equity_sync_failure_of_sec` in `crates/research-finance/src/sec_annual.rs`): SEC's status decides whenever SEC answered with one (`equitySyncCodeOfStatus`), and `failureUpstreamStatus` keeps it unchanged. Rate limited and source failures are retryable (the API re-queues the job while attempts remain); the rest need the owner.

| Status or condition | Request | What the sync does | Our error code |
|---|---|---|---|
| 200 | any | Parsed (section 3) | — |
| 401, 403 | any | The job fails, not retryable | `FINANCIAL_ACCESS_DENIED` |
| 404 | ticker directory | SEC cannot name the company | `FINANCIAL_COMPANY_NOT_FOUND` (status 404) |
| 404 | submissions | The job fails, retryable (a missing submissions file is SEC's problem, not proof the company does not exist) | `FINANCIAL_SOURCE_FAILED` (status 404) |
| 404 | company facts | Not a failure: SEC has no XBRL facts for the filer, so every new and pending filing is `not-available` | — |
| 429 | any | The job fails, retryable | `FINANCIAL_RATE_LIMITED` |
| 5xx, other non-2xx | any | The job fails, retryable | `FINANCIAL_SOURCE_FAILED` |
| — (no answer, off-host redirect, job stopped while waiting for a pacing grant) | any | The job fails, retryable, status null | `FINANCIAL_SOURCE_FAILED` |
| Ticker not in the directory | ticker directory | The job fails, not retryable | `FINANCIAL_COMPANY_NOT_FOUND` |
| No usable `SEC_USER_AGENT` | — | Nothing is sent | `FINANCIAL_SOURCE_NOT_CONFIGURED` |
| Body over its cap, not JSON, or not the documented shape (submissions arrays of different lengths, company facts without `facts`) | submissions, company facts | The job fails, not retryable | `FINANCIAL_PARSE_FAILED` |

### Provider error codes and body

None used: SEC documents no error body for these endpoints, and the code reads only the status. SEC's webmaster FAQ mentions an "Undeclared Automated Tool" message for scripted access without a declared user agent.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s per request including redirects and the body (`SEC_TIMEOUT_MS`; Rust `fetch_options`). Tool budgets: `finance.sec_company_financials` 90 s, `filings.sec_13f_holdings` 120 s. Byte caps: ticker directory 8,000,000; company facts 48,000,000; submissions 8,000,000; submission text file 16,000,000. | `packages/adapters/src/finance/secClient.ts`, `crates/research-finance/src/market_fetch.rs` |
| Retries | Client: none (retry ceiling 0); errors carry `retryable`. Transport: a request that fails before any answer (connection refused, unreachable address family) is tried on the next validated DNS address, at most 3 addresses (`MAX_CONNECT_ATTEMPTS`, both runners). Rust only: a GET sent on an idle keep-alive connection that the server closed before answering is sent once more on a fresh connection. Job: a `stock-directory-refresh` job has at most 3 attempts (`MAX_JOB_ATTEMPTS`); the runner marks only `DIRECTORY_SOURCE_FAILED` retryable, and the API re-queues it while attempts remain; a rate limit is not retried at once. A `financial-sync` job also has at most 3 attempts; the runner marks `FINANCIAL_RATE_LIMITED` and `FINANCIAL_SOURCE_FAILED` retryable, and after a terminal failure the company is due again after 30 min × 2^(n−1), at most 24 h. A tool failure is returned to the model as the tool's result. | `crates/research-net/src/transport.rs`, `packages/application/src/equitySync.ts`, `crates/research-net/src/pinned.rs`, `packages/adapters/src/node/index.ts`, `packages/application/src/stockDirectory.ts`, `packages/application/src/researchRuns.ts`, `packages/application/src/runnerJobs.ts`, `apps/runner/src/jobExecution.ts`, `crates/research-runner/src/job_execution.rs` |
| Rate limit | One client-wide queue: each request start takes the next 125 ms slot (≤ 8/s against SEC's 10/s); a stopped job stops waiting. The directory refresh and every request of a financial sync first take a grant from the shared pacer window `sec` (8 per 1,000 ms); a refused grant (job stopped) sends nothing more. In TypeScript the financial sync has its own client and so its own 125 ms queue (section 7). No response header is read. | `packages/adapters/src/finance/secClient.ts`, `crates/research-finance/src/sec_client.rs`, `apps/runner/src/marketPacing.ts`, `crates/research-finance/src/pacing.rs` |
| Cache | Ticker directory, one cache for the financials tool and another for the financial sync (each source builds its own `createSecTickerDirectory` / `SecTickerDirectory`): process-local, 12 h, one copy, single-flight: concurrent misses share the one download in progress and its outcome, a failure included; the slot is cleared when it settles, so a later call downloads again. The download has its own cancellation: a caller stopped while waiting leaves at once (failing like a cancelled SEC fetch) without cancelling it for the others, and the last waiter to leave cancels it. Only the caller that starts a download asks its pacing gate and counts a request; a caller that joins it takes no grant, and a starter's refusal is its own (the joiners try again through their own gates). Parsed 13F filings: 32 entries keyed by CIK and accession number, no TTL (a filing never changes); a cache hit still fails when the job was stopped. The submissions index and company facts are never cached; the directory refresh always downloads. The financial sync instead avoids the company facts (up to 48 MB) unless a 10-K / 10-K/A row filed since `filedSince` with a valid report date is not stored yet, a filing is pending, or the claim sets `fullCheck`; a sync with nothing new is one submissions request. Each job reports its request count (`financial_sync_completed.requests`; cache hits are not requests). | `packages/adapters/src/finance/secAnnualFilings.ts`, `packages/adapters/src/finance/secFinancials.ts`, `packages/adapters/src/finance/sec13f.ts`, `crates/research-finance/src/sec_financials.rs`, `crates/research-finance/src/sec_13f.rs` |
| Fallback | None. The tool returns its error code to the model; the Watchlist keeps the previously stored US list and shows the failure code (for `DIRECTORY_NOT_CONFIGURED`, the instruction to set `SEC_USER_AGENT`); the financial widgets keep showing the stored values and the Equities page shows the company's last failure code and SEC's status. | `packages/adapters/src/tools/secTools.ts`, `apps/web/src/watchlist/watchlistModel.messages.ts` |

## 5. Examples

The SEC hosts were not called while writing this document (owner decision). Request URLs are produced by the code's own URL builders in `packages/adapters/test/finance/secEdgarDocExamples.test.ts`; CIKs `9999991` and `9999993` and their accession numbers are the synthetic values of `examples/fixtures/sec/`, not real filers. No response status line was captured: `HTTP/1.1` is written because both runners speak HTTP/1.1 only (no ALPN, `crates/research-net/src/tls.rs`), and no response headers are shown because none were recorded.

### GET /files/company_tickers_exchange.json

Request:

```http
GET /files/company_tickers_exchange.json HTTP/1.1
Host: www.sec.gov
Accept: application/json
User-Agent: <SEC_USER_AGENT>
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://www.sec.gov/os/accessing-edgar-data (path `/files/company_tickers_exchange.json`, `User-Agent` format, `Accept-Encoding`, `Host`). Headers as `packages/adapters/src/node/pinnedConnect.ts` sends them.

Response:

```http
HTTP/1.1 200 OK
```

<!-- example: sec-edgar-company-tickers-exchange -->
```json
{
  "fields": ["cik", "name", "ticker", "exchange"],
  "data": [
    [1045810, "NVIDIA CORP", "NVDA", "Nasdaq"],
    [320193, "Apple Inc.", "AAPL", "Nasdaq"],
    [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"],
    [789019, "MICROSOFT CORP", "MSFT", "Nasdaq"],
    [1018724, "AMAZON COM INC", "AMZN", "Nasdaq"],
    [1326801, "Meta Platforms, Inc.", "META", "Nasdaq"],
    [2070829, "Contemporary Amperex Technology Co., Limited/ADR", "CYATY", "OTC"],
    [887028, "RIO TINTO LTD", "RTNTF", "OTC"],
    [2156068, "InoBat B.V.", "INBT", null],
    [2133037, "SB Energy, Inc.", "SBE", null],
    [1374310, "Cboe Global Markets, Inc.", "CBOE", "CBOE"],
    [1708646, "Goldman Sachs Physical Gold ETF", "AAAU", "CBOE"],
    [1276187, "Energy Transfer LP", "ET", "TXSE"],
    [1552275, "Sunoco LP", "SUN", "TXSE"],
    [1094517, "TOYOTA MOTOR CORP/", "TM", "NYSE"]
  ]
}
```

Verified: fixture, 2026-10-31, `packages/adapters/test/finance/fixtures/sec-company-tickers-exchange-trimmed.json` (rows copied from the 2026-10-24 download). 15 of 10,429 rows kept; re-indented. The fixture holds the body only; the status line is not from the capture (see above).

### GET /api/xbrl/companyfacts/CIK##########.json

Request:

```http
GET /api/xbrl/companyfacts/CIK0009999991.json HTTP/1.1
Host: data.sec.gov
Accept: application/json
User-Agent: <SEC_USER_AGENT>
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://www.sec.gov/search-filings/edgar-application-programming-interfaces (path pattern and 10-digit zero-padded CIK). Synthetic CIK.

Response:

```http
HTTP/1.1 200 OK
```

<!-- example: sec-edgar-companyfacts -->
```json
{
  "cik": 9999991,
  "entityName": "Synthetic Alpha Devices Inc.",
  "facts": {
    "dei": {
      "EntityCommonStockSharesOutstanding": {
        "label": "Entity Common Stock, Shares Outstanding",
        "units": {
          "shares": [
            { "end": "2025-07-31", "val": 100000000, "accn": "0009999991-25-000010", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-08-20" }
          ]
        }
      }
    },
    "us-gaap": {
      "Revenues": {
        "label": "Revenues",
        "description": "Synthetic.",
        "units": {
          "USD": [
            { "start": "2023-07-01", "end": "2024-06-30", "val": 1600000000, "accn": "0009999991-24-000009", "fy": 2024, "fp": "FY", "form": "10-K", "filed": "2024-08-21", "frame": "CY2023" },
            { "start": "2024-07-01", "end": "2025-03-31", "val": 1450000000, "accn": "0009999991-25-000004", "fy": 2025, "fp": "Q3", "form": "10-Q", "filed": "2025-05-08" },
            { "start": "2024-07-01", "end": "2025-06-30", "val": 2000000000, "accn": "0009999991-25-000010", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-08-20", "frame": "CY2024" }
          ]
        }
      },
      "NetIncomeLoss": {
        "label": "Net Income (Loss) Attributable to Parent",
        "units": {
          "USD": [
            { "start": "2024-07-01", "end": "2025-06-30", "val": 250000000, "accn": "0009999991-25-000010", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-08-20" }
          ]
        }
      },
      "EarningsPerShareDiluted": {
        "label": "Earnings Per Share, Diluted",
        "units": {
          "USD/shares": [
            { "start": "2024-07-01", "end": "2025-06-30", "val": 2.5, "accn": "0009999991-25-000010", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-08-20" }
          ]
        }
      }
    }
  }
}
```

Verified: unverified, 2026-10-31, no live call allowed and SEC publishes no field-level schema for company facts; values are the synthetic ones of `examples/fixtures/sec/companyfacts-CIK0009999991.synthetic.json`. Its `_fixture` note removed, fact arrays shortened (Revenues 3 of 8, NetIncomeLoss 1 of 3, EarningsPerShareDiluted 1 of 2), two concepts left out. Verify live with `SEC_LIVE_TEST_USER_AGENT` and `packages/adapters/test/finance/secLive.test.ts`.

**Financial sync.** The same endpoint, read by a `financial-sync` job for the company's annual filings (synthetic filer `9999981` of `examples/fixtures/equity-sync/`):

```http
GET /api/xbrl/companyfacts/CIK0009999981.json HTTP/1.1
Host: data.sec.gov
Accept: application/json
User-Agent: <SEC_USER_AGENT>
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://www.sec.gov/search-filings/edgar-application-programming-interfaces (path pattern and 10-digit zero-padded CIK). Synthetic CIK; URL as `secCompanyFactsUrl` builds it.

```http
HTTP/1.1 200 OK
```

<!-- example: sec-edgar-companyfacts-annual -->
```json
{
  "cik": 9999981,
  "entityName": "Synthetic Devices Inc.",
  "facts": {
    "us-gaap": {
      "NetIncomeLoss": {
        "label": "Net Income Loss",
        "description": "Synthetic.",
        "units": {
          "USD": [
            { "start": "2022-10-01", "end": "2023-09-30", "val": 51000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "start": "2023-10-01", "end": "2024-09-30", "val": 54000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "start": "2024-10-01", "end": "2025-09-30", "val": 57000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "start": "2024-10-01", "end": "2025-09-30", "val": 56200000000, "accn": "0009999981-26-000005", "fy": 2025, "fp": "FY", "form": "10-K/A", "filed": "2026-01-15" }
          ]
        }
      },
      "Assets": {
        "label": "Assets",
        "description": "Synthetic.",
        "units": {
          "USD": [
            { "end": "2024-09-30", "val": 440000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "end": "2025-09-30", "val": 460000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "end": "2025-09-30", "val": 460000000000, "accn": "0009999981-26-000005", "fy": 2025, "fp": "FY", "form": "10-K/A", "filed": "2026-01-15" },
            { "end": "2025-03-31", "val": 455000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" }
          ]
        }
      },
      "StockholdersEquity": {
        "label": "Stockholders Equity",
        "description": "Synthetic.",
        "units": {
          "USD": [
            { "end": "2022-09-30", "val": 160000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "end": "2023-09-30", "val": 168000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "end": "2024-09-30", "val": 176000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" },
            { "end": "2025-09-30", "val": 184000000000, "accn": "0009999981-25-000110", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-11-05" }
          ]
        }
      }
    }
  }
}
```

Verified: unverified, 2026-10-31, no live call allowed (owner decision until `SEC_USER_AGENT` is set) and SEC publishes no field-level schema for company facts; the entries are copied from the synthetic `examples/fixtures/equity-sync/sec-companyfacts-CIK0009999981.synthetic.json` (not SEC data): 3 of its 13 `us-gaap` concepts and 12 of its 306 `us-gaap` entries kept, the `dei` taxonomy and the `_fixture` note left out, entries re-indented one per line. Verify live with `bun run test:real tests/real/equitySyncReal.spec.ts` once `SEC_USER_AGENT` is set. `packages/adapters/test/finance/secAnnualDocExamples.test.ts` syncs it with the submissions example below: the 10-K keeps three income years and the two balance-sheet ends (the interim instant 2025-03-31 and the equity statement's opening balances 2022-09-30 and 2023-09-30 are dropped); the 10-K/A restates FY2025 net income.

### GET /submissions/CIK##########.json

Request:

```http
GET /submissions/CIK0009999993.json HTTP/1.1
Host: data.sec.gov
Accept: application/json
User-Agent: <SEC_USER_AGENT>
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://www.sec.gov/search-filings/edgar-application-programming-interfaces (path pattern and 10-digit zero-padded CIK). Synthetic CIK.

Response:

```http
HTTP/1.1 200 OK
```

<!-- example: sec-edgar-submissions -->
```json
{
  "cik": "9999993",
  "entityType": "other",
  "name": "Synthetic Capital Management LP",
  "tickers": [],
  "exchanges": [],
  "filings": {
    "recent": {
      "accessionNumber": ["0009999993-26-000004", "0009999993-26-000003", "0009999993-26-000002", "0009999993-26-000001", "0009999993-26-000000"],
      "filingDate": ["2026-08-14", "2026-06-01", "2026-05-20", "2026-05-15", "2026-02-13"],
      "reportDate": ["2026-06-30", "2026-03-31", "", "2026-03-31", "2025-12-31"],
      "form": ["13F-HR", "13F-HR/A", "SC 13G", "13F-HR", "13F-HR"],
      "primaryDocument": ["xslForm13F_X02/primary_doc.xml", "xslForm13F_X02/primary_doc.xml", "sc13g.htm", "xslForm13F_X02/primary_doc.xml", "xslForm13F_X02/primary_doc.xml"]
    },
    "files": []
  }
}
```

Verified: unverified, 2026-10-31, no live call allowed and SEC publishes no field list for submissions; this is `examples/fixtures/sec/submissions-CIK0009999993.synthetic.json` with its `_fixture` note removed. The fixture omits most of the fields listed in section 3 (`sic`, `addresses`, `formerNames`, the other `recent` columns, …), which the parser does not read. Verify live as above.

**Financial sync.** The same endpoint, read by a `financial-sync` job for the company's identity and its recent 10-K / 10-K/A filings:

```http
GET /submissions/CIK0009999981.json HTTP/1.1
Host: data.sec.gov
Accept: application/json
User-Agent: <SEC_USER_AGENT>
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://www.sec.gov/search-filings/edgar-application-programming-interfaces (path pattern and 10-digit zero-padded CIK). Synthetic CIK; URL as `secSubmissionsUrl` builds it.

```http
HTTP/1.1 200 OK
```

<!-- example: sec-edgar-submissions-annual -->
```json
{
  "cik": "9999981",
  "entityType": "operating",
  "sic": "3571",
  "name": "Synthetic Devices Inc.",
  "tickers": ["SYND"],
  "exchanges": ["Nasdaq"],
  "fiscalYearEnd": "0930",
  "filings": {
    "recent": {
      "accessionNumber": ["0009999981-26-000040", "0009999981-26-000005", "0009999981-25-000110", "0009999981-24-000108"],
      "filingDate": ["2026-08-03", "2026-01-15", "2025-11-05", "2024-11-04"],
      "reportDate": ["2026-06-30", "2025-09-30", "2025-09-30", "2024-09-30"],
      "acceptanceDateTime": ["2026-08-03T20:31:07.000Z", "2026-01-15T16:12:09.000Z", "2025-11-05T21:04:11.000Z", "2024-11-04T21:01:36.000Z"],
      "act": ["34", "34", "34", "34"],
      "form": ["10-Q", "10-K/A", "10-K", "10-K"],
      "fileNumber": ["001-99981", "001-99981", "001-99981", "001-99981"],
      "primaryDocument": ["synd-20260630.htm", "synd-20250930a.htm", "synd-20250930.htm", "synd-20240930.htm"],
      "primaryDocDescription": ["10-Q", "10-K/A", "10-K", "10-K"]
    },
    "files": [
      { "name": "CIK0009999981-submissions-001.json", "filingCount": 412, "filingFrom": "1999-01-04", "filingTo": "2024-10-31" }
    ]
  }
}
```

Verified: unverified, 2026-10-31, no live call allowed (owner decision until `SEC_USER_AGENT` is set) and SEC publishes no field list for submissions; rows 1, 5, 7 and 10 of the 10 `recent` rows of the synthetic `examples/fixtures/equity-sync/sec-submissions-CIK0009999981.synthetic.json` (not SEC data), its `_fixture` note removed; it omits fields a real index has (`addresses`, `formerNames`, `filmNumber`, `items`, `size`, `isXBRL`, …), which the parser does not read. Verify live with `bun run test:real tests/real/equitySyncReal.spec.ts` once `SEC_USER_AGENT` is set. Of these rows the sync uses the 10-K/A and the two 10-Ks; the FY2024 10-K (`0009999981-24-000108`) has no entry in the company facts example above, so it is reported `not-available`.

### GET /Archives/edgar/data/{cik}/{accession-folder}/{accession}.txt

Request:

```http
GET /Archives/edgar/data/9999993/000999999326000004/0009999993-26-000004.txt HTTP/1.1
Host: www.sec.gov
Accept: text/plain
User-Agent: <SEC_USER_AGENT>
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://www.sec.gov/os/accessing-edgar-data (the dashless-folder path, e.g. `/Archives/edgar/data/1122304/000119312515118890/0001193125-15-118890.txt`). Synthetic CIK and accession.

Response:

```http
HTTP/1.1 200 OK
```

<!-- example: sec-edgar-13f-submission-text -->
```text
…
<DOCUMENT>
<TYPE>13F-HR
<SEQUENCE>1
<FILENAME>primary_doc.xml
<TEXT>
<XML>
…
</XML>
</TEXT>
</DOCUMENT>
<DOCUMENT>
<TYPE>INFORMATION TABLE
<SEQUENCE>2
<FILENAME>information_table.xml
<TEXT>
<XML>
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<informationTable
	xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
	<infoTable>
		<nameOfIssuer>AT&amp;T INC</nameOfIssuer>
		<titleOfClass>COM</titleOfClass>
		<cusip>00206R102</cusip>
		<figi>00206R107854</figi>
		<value>452</value>
		<shrsOrPrnAmt>
			<sshPrnamt>79296</sshPrnamt>
			<sshPrnamtType>SH</sshPrnamtType>
		</shrsOrPrnAmt>
		<investmentDiscretion>SOLE</investmentDiscretion>
		<votingAuthority>
			<Sole>0</Sole>
			<Shared>0</Shared>
			<None>79296</None>
		</votingAuthority>
	</infoTable>
	<infoTable>
		<nameOfIssuer>ADOBE INC</nameOfIssuer>
		<titleOfClass>COM</titleOfClass>
		<cusip>00724F101</cusip>
		<value>7423</value>
		<shrsOrPrnAmt>
			<sshPrnamt>22507</sshPrnamt>
			<sshPrnamtType>SH</sshPrnamtType>
		</shrsOrPrnAmt>
		<investmentDiscretion>SOLE</investmentDiscretion>
		<votingAuthority>
			<Sole>0</Sole>
			<Shared>0</Shared>
			<None>22507</None>
		</votingAuthority>
	</infoTable>
	<!-- … -->
</informationTable>
</XML>
</TEXT>
</DOCUMENT>
```

Verified: spec, 2026-10-31, https://www.sec.gov/files/info/edgar/specifications/pds_dissemination_spec.pdf (§3.3.2 document tags, `<XML>` indicator) and the sample `information_table.xml` of the Form 13F XML Technical Specification 2.0 (https://www.sec.gov/submit-filings/technical-specifications). The submission header and the primary document's XML are omitted (`…` lines); 2 of the sample's 169 `infoTable` rows kept, verbatim, and the rest marked `<!-- … -->`. The sample's values are SEC's illustration, not a real filing.

### Error response

```http
HTTP/1.1 403 Forbidden
```

Verified: unverified, 2026-10-31, SEC documents neither the status nor the body it returns for a refused request (undeclared `User-Agent`, rate above 10/s) and the code reads only the status line. Would be verified by one request without a contact `User-Agent` (e.g. `curl -A "test" https://www.sec.gov/files/company_tickers_exchange.json`, expecting 403) once the owner allows live calls.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `company_tickers_exchange.json` `ticker` | Trimmed, upper-cased; kept when `us:<ticker>` is a valid stock id and the ticker was not seen before | `StockDirectoryEntry.symbol` (`packages/contracts/src/stockDirectory.ts`) | [`stock_directory.symbol`](../../database/tables/stock_directory.md) |
| `company_tickers_exchange.json` `name` | Trimmed; a row whose name is not 1–200 UTF-16 units is dropped and counted | `StockDirectoryEntry.name` | [`stock_directory.name`](../../database/tables/stock_directory.md) (`local_name` NULL) |
| `company_tickers_exchange.json` `exchange` | Exact text: `Nasdaq` → `nasdaq`, `NYSE` → `nyse`, `CBOE` → `cboe`, `TXSE` → `txse`; every other value (`OTC`, `null`) drops the row | `StockDirectoryEntry.listing` | [`stock_directory.listing`](../../database/tables/stock_directory.md) |
| (whole file) | SEC states no list date; the runner's download time | `StockDirectoryData.asOf` = null; completion `fetchedAt` | [`stock_directory_meta.as_of`](../../database/tables/stock_directory_meta.md) NULL, [`stock_directory_meta.retrieved_at`](../../database/tables/stock_directory_meta.md) |
| `company_tickers_exchange.json` `cik` | Zero-padded to 10 digits | `Security.issuerIdentifier` `{ scheme: "CIK" }` (`packages/contracts/src/records.ts`) | [`research_records.body_json`](../../database/tables/research_records.md) (`security`) |
| `company_tickers_exchange.json` `ticker`, `name`, `exchange` | Ticker as listed; name cut to 300; exchange through the directory's table (`SEC_EXCHANGES` / `sec_contract_venue`: `Nasdaq` → `NASDAQ`, `NYSE` → `NYSE`, `CBOE` → `Cboe BZX`, `TXSE` → `TXSE`), otherwise matched case-insensitively to `EXCHANGES_BY_COUNTRY.US`; `listingCurrency` `USD`; `listingVerification` `source-verified` | `Security.ticker`, `.issuerName`, `.exchange` | [`research_records.body_json`](../../database/tables/research_records.md) (`security`) |
| companyfacts `us-gaap` revenue concepts, `NetIncomeLoss`, `EarningsPerShareDiluted` `.units.<unit>[*]` | Annual facts only (`10-K`/`10-K/A`, `fp` `FY`, 350–380-day period); latest period end, then latest `filed`, then highest `accn`; the unit holding the latest period decides the currency (two currencies for that period → unavailable); revenue concept with the latest period end, ties by precedence | `FinancialObservation` `revenue`, `net-income`, `eps-diluted`: `value` = `val`, `currency` = unit code, `period` = `{ fiscalYear: end year, fiscalPeriod: "FY", periodStart: start, periodEnd: end }`, `accountingStandard` `US-GAAP`; unavailable → `value` null with the reason | [`research_records.body_json`](../../database/tables/research_records.md) (`financial-observation`) |
| (derived) | `net income / revenue` by the domain's `computeNetProfitMargin` (same period and currency) | `FinancialObservation` `net-profit-margin` | [`research_records.body_json`](../../database/tables/research_records.md) |
| companyfacts `filed`, `end` of the latest figure | `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00.000Z` | `Evidence.publishedAt`, `.effectiveAt` | [`evidence.body_json`](../../database/tables/evidence.md) |
| submissions `name` | Trimmed, cut to 300 | `InvestorFiling.investorName` (`packages/contracts/src/records.ts`) | [`research_records.body_json`](../../database/tables/research_records.md) (`investor-filing`) |
| submissions `accessionNumber`, `reportDate`, `filingDate` | The two latest distinct `reportDate`s of form `13F-HR` | `InvestorFiling.reportPeriodEnd`, `.filedAt`; `filingUrl` = the fetched text file URL | [`research_records.body_json`](../../database/tables/research_records.md) |
| `infoTable` `cusip`, `nameOfIssuer`, `sshPrnamt` | `SH` rows without `putCall` summed per CUSIP; a CUSIP with an unreadable row is left out and the filing is not compared | `InvestorFiling.holdings[].cusip`, `.issuerName`, `.reportedShares` (at most 60 per filing) | [`research_records.body_json`](../../database/tables/research_records.md) |
| `infoTable` `value` | Summed per CUSIP; × 1000 for filings made before 2023-01-03 | `InvestorFiling.holdings[].reportedValueUsd` (whole dollars) | [`research_records.body_json`](../../database/tables/research_records.md) |
| (two filings) | Domain `classifyReportedPositionChange` per CUSIP | `InvestorFiling.holdings[].changeFromPriorFiling` | [`research_records.body_json`](../../database/tables/research_records.md) |
| Fetched URL, text excerpt | SHA-256 of the retrieved text; publisher `U.S. Securities and Exchange Commission (EDGAR)` | `Evidence` (`sourceClass` `other` for the directory, `regulatory-filing` for facts and filings) | [`evidence.body_json`](../../database/tables/evidence.md) |

**Financial sync** (`secSyncResult`, `indexSecCompanyFacts`, `parseSecSubmissions` in `packages/adapters/src/finance/secAnnualFilings.ts`; `crates/research-finance/src/sec_annual.rs`). Which filings a completion carries: the claim's pending filings (with their stored metadata, echoed unchanged); the submissions index's 10-K / 10-K/A rows filed on or after `filedSince` (the claim's date: today in UTC minus 6 years) that the claim does not store; and, when the company facts were read, the 10-K / 10-K/A accessions only they list, filed since `filedSince`. Facts are taken only for those (new and pending) accessions. Then newest first (filing date, then accession) while within 60 filings and 3,000 facts; anything cut sets `more`, and the next claim sets `fullCheck`.

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| (the requested CIK) | The CIK in the request path, 10 digits; `$.cik` itself is not read (the claim's, or the ticker directory's `cik` zero-padded) | completion `identity.sourceCompanyId` | [`equity_company.source_company_id`](../../database/tables/equity_company.md) |
| submissions `$.name` | Trimmed; null when empty or over 200 characters | completion `identity.name` | [`equity_company.name`](../../database/tables/equity_company.md) |
| submissions `$.fiscalYearEnd` | `MMDD` → `MM-DD`; null unless a valid month and day | completion `identity.fiscalYearEnd` | [`equity_company.fiscal_year_end`](../../database/tables/equity_company.md) |
| submissions `form[i]` / facts `form` | `10-K` or `10-K/A` as is (an accession only company facts list is `10-K/A` when any entry says so) | `EquityFilingResult.form` (`packages/contracts/src/equityFinancials.ts`) | [`equity_report_filing.form`](../../database/tables/equity_report_filing.md) |
| submissions `accessionNumber[i]` / facts `accn` | As is, `##########-##-######` | `EquityFilingResult.sourceDocumentId` | [`equity_report_filing.source_document_id`](../../database/tables/equity_report_filing.md) |
| submissions `filingDate[i]` / facts `filed` | As is; for an accession only company facts list, its earliest `filed` | `EquityFilingResult.filedOn` | [`equity_report_filing.filed_on`](../../database/tables/equity_report_filing.md) |
| submissions `acceptanceDateTime[i]` | As is when a valid ISO instant, else null; null for an accession only company facts list | `EquityFilingResult.submittedAt` | [`equity_report_filing.submitted_at`](../../database/tables/equity_report_filing.md) |
| submissions `reportDate[i]` / facts | The report date when valid. A row whose `reportDate` is not a valid date does not by itself trigger the company-facts request; it is stored only when company facts list its accession, with the latest end of an annual duration among its facts as its period end (else the latest end of any of its facts). Without facts it is not reported: no period end is inferred, since SEC does not state which 10-K an amendment amends. An accession only company facts list takes its period end the same way | `EquityFilingResult.periodEnd` (`periodStart` always null) | [`equity_report_filing.period_end`](../../database/tables/equity_report_filing.md) |
| submissions `primaryDocument[i]`, CIK, accession | `https://www.sec.gov/Archives/edgar/data/{CIK without leading zeros}/{accession without dashes}/{primaryDocument}` (`secFilingUrl`); the folder URL ending `/` when the document is not a plain file name or unknown | `EquityFilingResult.sourceUrl` | [`equity_report_filing.source_url`](../../database/tables/equity_report_filing.md) |
| (none) | SEC names no amended filing | `EquityFilingResult.amendsSourceDocumentId` = null | [`equity_report_filing.amends_source_document_id`](../../database/tables/equity_report_filing.md) |
| company facts entries of the accession | Any entry of a claimed concept → `extracted` with `accountingStandard` `US-GAAP`; none (company facts lag a new filing, a text-only amendment, a 404) → `not-available`. The API keeps a not-available filing pending for 7 days after its filing date, then records it unavailable | `EquityFilingResult.factsStatus`, `.accountingStandard` | [`equity_report_filing.facts_status`](../../database/tables/equity_report_filing.md), [`equity_report_filing.accounting_standard`](../../database/tables/equity_report_filing.md) |
| facts `$.facts.us-gaap.<concept>` | `us-gaap:` + concept name | `EquityExtractedFact.concept` | [`equity_reported_fact.concept`](../../database/tables/equity_reported_fact.md); the API adds [`equity_reported_fact.metric_code`](../../database/tables/equity_reported_fact.md) |
| facts `.units.<unit>` | The unit key as is (`USD`) | `EquityExtractedFact.unit` | [`equity_reported_fact.unit`](../../database/tables/equity_reported_fact.md) |
| facts `start`, `end` | With `start`: `duration`; without: `instant` (start null). Every fact is `consolidated` (company facts carry no dimensions) | `EquityExtractedFact.periodType`, `.periodStart`, `.periodEnd`, `.scope` | [`equity_reported_fact.period_type`](../../database/tables/equity_reported_fact.md), [`equity_reported_fact.period_start`](../../database/tables/equity_reported_fact.md) (`''` for an instant), [`equity_reported_fact.period_end`](../../database/tables/equity_reported_fact.md), [`equity_reported_fact.scope`](../../database/tables/equity_reported_fact.md); the API derives [`equity_reported_fact.fiscal_year`](../../database/tables/equity_reported_fact.md) |
| facts `val` | `Number#toString` text, kept only when canonical decimal (an exponent form is skipped, never expanded); USD base units, sign as reported | `EquityExtractedFact.valueDecimal` | [`equity_reported_fact.value_decimal`](../../database/tables/equity_reported_fact.md) |
| (the annual filter) | Per accession, exact repeats removed and canonical order (`annualFactsInOrder`); durations of 350–380 days inclusive; durations kept for every annual year the filing reports; instants only at the filing's own fiscal-year end and the immediately preceding one — the latest two ends of the annual durations it reports, the two balance-sheet columns (`secFilingFacts`). Opening balances in the statement of stockholders' equity, two or three years back, and interim instants are not taken from that filing | the filing's `facts` | [`equity_reported_fact.value_decimal`](../../database/tables/equity_reported_fact.md) (only kept facts are stored) |

## 7. Maintenance

### Known differences between the runners

- Transport: the Rust fetcher keeps a keep-alive connection pool (an address with an idle connection is tried first) and resends a GET once on a fresh connection when the pooled one was closed before answering; the TypeScript fetcher opens a fresh socket per request (`agent: false`) and never resends. Both try up to 3 validated addresses (`crates/research-net/src/pinned.rs`, `crates/research-net/src/transport.rs`, `packages/adapters/src/node/pinnedConnect.ts`, `packages/adapters/src/node/index.ts`).
- Revenue tie-break on equal period end and filing date compares accession numbers by byte order in Rust and by `localeCompare` in TypeScript (recorded in `crates/research-finance/src/sec_financials.rs`); accession numbers are ASCII digits and dashes, so the order agrees in practice.
- Rust parses the large JSON and XML documents off the async worker (`crate::cpu::offload`); the result is the same.
- SEC clients: Rust builds one paced client per runner and hands it to the tools, the directory refresh and the financial sync, so their requests share one 125 ms queue. TypeScript builds one for the two research tools (`packages/adapters/src/tools/index.ts`), one for the directory refresh and one inside the financial-sync source (`createSecAnnualFilingsSource`), each with its own queue; what they share is the pacer window `sec`, which the tools do not use. Both runners give the financial sync its own 12-hour ticker cache, separate from the financials tool's.
- Shared vectors (`vectors/finance/`) replay the submissions and company-facts parsers, the annual filter and the sync result of the TypeScript reference in Rust.

### Open issues

- The company-facts, submissions and error-response examples are `unverified`, the financial sync's two (`sec-edgar-companyfacts-annual`, `sec-edgar-submissions-annual`) included: the SEC hosts may not be called and SEC publishes no field-level schema for these JSON documents. The non-read fields in section 3 are listed from SEC's description and known responses, not observed. Re-verify all examples live once `SEC_USER_AGENT` is set (ADR-0047).
- Only `filings.recent` is read; a manager whose last two 13F-HR filings are older than the recent window gets `NO_DATA` or no comparison. Amendments (`13F-HR/A`) are ignored, so a restated quarter is not reflected.
- Financial sync: only `filings.recent` is read too; older 10-K / 10-K/A filings are found through the company facts (their `accn`), which carry no acceptance time or primary document, so those filings link the archive folder. A 10-K / 10-K/A row whose report date is not a valid date does not by itself make the sync download the company facts (up to 48 MB); it is stored the next time the facts are read for another reason if they list it, its period end taken from its facts, and is never reported without them (SEC does not state which 10-K an amendment amends, so no period end is inferred). `10-KT` (transition) and other annual forms (`20-F`, `40-F`) are not read.
- Financial sync: a filing that company facts do not list yet is `not-available`; the API offers it again for 7 days after its filing date and then records it unavailable, so facts SEC adds later than that are not fetched.
- Financial sync: `val` is a JSON number; values beyond 2^53 lose exactness when parsed (ADR-0048 §Consequences); no current filer's annual amounts come near that.
- The 13F value-unit cutover follows the filing date (`FORM_13F_WHOLE_DOLLAR_FROM` = 2023-01-03), which Form 13F FAQ 62 confirms ("All Form 13F reports that are filed on or after January 3, 2023"). Filers that use the wrong unit cannot be detected.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-24 | live | `company_tickers_exchange.json` downloaded; rows copied to the trimmed fixture; row counts (10,429; 7,691 listed) | Directory implementation (ADR-0034) |
| 2026-10-31 | spec | URL patterns, CIK padding, recent-window size, fair-access limit and `User-Agent` format (EDGAR API page, accessing EDGAR data, webmaster FAQ); 13F information table elements and enums against `eis_13FDocument.xsd` of the 13F XML Technical Specification 2.0; document tags against the PDS specification; value units against Form 13F FAQ 36 and 62 | Claude (external API documents, ADR-0047) |
| 2026-10-31 | spec | Financial sync (ADR-0048): submissions and company-facts URLs against the EDGAR API page; the fields the sync reads (section 3) against the code; the marked `sec-edgar-submissions-annual` and `sec-edgar-companyfacts-annual` examples (synthetic, `unverified`) synced by `parseSecSubmissions`, `indexSecCompanyFacts` and `secSyncResult` (`packages/adapters/test/finance/secAnnualDocExamples.test.ts`). No request to SEC. | Claude (external API documents, ADR-0047) |
| 2026-10-31 | fixture | `sec-edgar-company-tickers-exchange` parsed by `parseTickerDirectory` / `secDirectoryEntries`; the other marked examples parsed by `selectAnnualFinancials`, `selectRecent13FFilings`, `extractInformationTableXml` and `parseInformationTable` (`packages/adapters/test/finance/secEdgarDocExamples.test.ts`) | Claude |
