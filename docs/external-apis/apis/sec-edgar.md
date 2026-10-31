# External API: SEC EDGAR

## 1. Overview

| Property | Value |
|---|---|
| Provider | U.S. Securities and Exchange Commission (SEC), EDGAR system |
| Purpose | The US half of the Watchlist's stock directory ([ADR-0034](../../adr/0034-stock-directory-search.md)), and two research tools: `finance.sec_company_financials` (latest fiscal-year revenue, net income, diluted EPS and net margin from XBRL company facts, FR-006) and `filings.sec_13f_holdings` (the two latest Form 13F-HR holdings of an investment manager and the change in reported positions, FR-008). |
| Hosts | `www.sec.gov`, `data.sec.gov` |
| Endpoints | `GET /files/company_tickers_exchange.json` — ticker, CIK, name and exchange of every SEC registrant with a ticker (`www.sec.gov`); `GET /api/xbrl/companyfacts/CIK##########.json` — every XBRL fact a company reported (`data.sec.gov`); `GET /submissions/CIK##########.json` — a filer's identity and recent filing index (`data.sec.gov`); `GET /Archives/edgar/data/{cik}/{accession-folder}/{accession}.txt` — the complete submission text file of one filing (`www.sec.gov`) |
| Authentication | None (SEC: "These APIs do not require any authentication or API keys"). SEC's fair-access policy requires a declared `User-Agent` naming the requester and a contact e-mail; it comes from `SEC_USER_AGENT` in `apps/runner/.env`. Without a usable value (8–200 printable ASCII characters containing an e-mail-shaped `x@y.z`) the client sends nothing: the tools fail with `NOT_CONFIGURED` (the runner logs `sec_tools_disabled` at start) and the US directory refresh with `DIRECTORY_NOT_CONFIGURED`. |
| Configuration | None besides `SEC_USER_AGENT`. |
| Usage Limits | SEC: "Current max request rate: 10 requests/second", and SEC "reserves the right to limit request rates" ([accessing EDGAR data](https://www.sec.gov/os/accessing-edgar-data)). Ours: one SEC client per runner spaces request starts at least 125 ms apart (8 per second) across every SEC caller; the directory refresh also takes a grant from the pacer window `sec` (8 starts per 1 s) before its request; no automatic retries; the ticker directory is cached 12 h for the financials tool and parsed 13F filings are cached by accession (section 4). |
| Called By | Rust runner (default) and TypeScript runner (rollback): `stock-directory-refresh` jobs for market `US` (queued by "Update stock list" or by the Watchlist when the US list is missing or older than 7 days), and the research tools `finance.sec_company_financials` and `filings.sec_13f_holdings` during research runs. The API Worker and the browser never call SEC. |
| Code | `crates/research-finance/src/sec_client.rs`, `crates/research-finance/src/sec_directory.rs`, `crates/research-finance/src/sec_financials.rs`, `crates/research-finance/src/sec_13f.rs`, `crates/research-finance/src/sec_xml.rs`, `crates/research-feed/src/info_table.rs`, `crates/research-tools/src/sec.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-runner/src/config.rs`, `crates/research-runner/src/composition.rs`, `packages/adapters/src/finance/secClient.ts`, `packages/adapters/src/finance/secDirectory.ts`, `packages/adapters/src/finance/secFinancials.ts`, `packages/adapters/src/finance/sec13f.ts`, `packages/adapters/src/tools/secTools.ts`, `packages/adapters/src/finance/stockDirectory.ts`, `apps/runner/src/marketPacing.ts`, `apps/runner/src/config.ts`, `apps/runner/src/main.ts` |
| Official Documentation | [EDGAR application programming interfaces](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [Accessing EDGAR data](https://www.sec.gov/os/accessing-edgar-data) (fair access, `User-Agent`, ticker files, archive paths), [Webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions), [Form 13F XML Technical Specification 2.0](https://www.sec.gov/submit-filings/technical-specifications) (September 2026, `eis_13FDocument.xsd` and samples), [EDGAR PDS Technical Specification](https://www.sec.gov/files/info/edgar/specifications/pds_dissemination_spec.pdf) (document tags of a disseminated submission), [Form 13F FAQ](https://www.sec.gov/rules-regulations/staff-guidance/division-investment-management-frequently-asked-questions/frequently-asked-questions-about-form-13f) |
| Last Verified | 2026-10-31, spec and fixture; no live SEC call (owner decision; `SEC_USER_AGENT` is not set) (section 7) |

A US directory refresh downloads `company_tickers_exchange.json` once and turns it into the `stock-directory-refreshed` completion (rows on Nasdaq, NYSE, Cboe and Texas SE only). `finance.sec_company_financials` reads the same file (cached 12 h) to resolve the ticker to a CIK, then downloads that company's XBRL company facts and selects the latest annual 10-K figures. `filings.sec_13f_holdings` downloads the manager's submissions index, picks the two latest distinct report periods filed on form `13F-HR`, and downloads each filing's complete submission text file to read its information table. Every request goes through one paced SEC client pinned to the two SEC hosts. The SEC press-release feed `https://www.sec.gov/news/pressreleases.rss` in `packages/application/src/recommendedCatalog.ts` is a recommended news source, fetched as a feed ([Web feeds and pages](web-feeds-and-pages.md)), not through this client.

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
| `CIK##########` | path | string | Yes | — ; we send the CIK found in the ticker directory | `CIK` followed by 10 digits, zero-padded ("including leading zeros") | The company. The ticker the tool was given (`^[A-Za-z0-9.-]{1,12}$`, dots read as SEC's hyphen: `BRK.B` → `BRK-B`) is looked up in the ticker directory first; a ticker SEC does not list fails with `NOT_FOUND` before this request. |

### GET /submissions/CIK##########.json

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `CIK##########` | path | string | Yes | — ; we send the tool's `managerCik` normalised | `CIK` followed by 10 digits, zero-padded; the tool accepts `^(CIK)?\d{1,10}$` (case-insensitive) and refuses an all-zero CIK (`INVALID_IDENTIFIER`) | The investment manager filing Form 13F. |

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
| `$.facts` | object | No | No | Yes | Taxonomies keyed by prefix: `dei`, `us-gaap`, `ifrs-full`, `srt`, … Only `us-gaap` is read; a document without it reports every figure unavailable ("may report under IFRS"). |
| `$.facts.<taxonomy>.<concept>` | object | No | Yes | Yes (`us-gaap` only) | One concept. Read: `Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, `RevenueFromContractWithCustomerIncludingAssessedTax`, `SalesRevenueNet`, `NetIncomeLoss`, `EarningsPerShareDiluted`. |
| `$.facts.<taxonomy>.<concept>.label` | string | Yes | No | No | Taxonomy label. |
| `$.facts.<taxonomy>.<concept>.description` | string | Yes | No | No | Taxonomy definition text. |
| `$.facts.<taxonomy>.<concept>.units` | object | No | No | Yes | Fact arrays keyed by unit: `USD`, `JPY`, … (3-letter code) for amounts, `USD/shares` for per-share figures, `shares`, `pure`, … Other units are ignored. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].start` | string | No | Yes | Yes | Period start `YYYY-MM-DD`; absent for instant facts (which are never annual). |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].end` | string | No | No | Yes | Period end (or instant) `YYYY-MM-DD`. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].val` | number | No | No | Yes | The reported value; must be finite. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].accn` | string | No | No | Yes | Accession number of the filing that reported the fact (1–40 characters). |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].fy` | number | Yes | No | Yes | Fiscal year of the FILING (not of the fact's period); lineage only. Must be an integer when present. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].fp` | string | Yes | No | Yes | Fiscal period of the filing (`FY`, `Q1`–`Q3`); annual facts need `FY`. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].form` | string | No | No | Yes | Form type; annual facts need `10-K` or `10-K/A`. |
| `$.facts.<taxonomy>.<concept>.units.<unit>[*].filed` | string | No | No | Yes | Filing date `YYYY-MM-DD`; breaks ties between restatements. |
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
| `$.name` | string | No | No | Yes | Current EDGAR conformed name; must be non-empty. Trimmed, it becomes the investor name of the filing records. |
| `$.tickers`, `$.exchanges` | array of string | No | No | No | Tickers and their exchanges (empty for most managers). |
| `$.ein`, `$.lei`, `$.description`, `$.website`, `$.investorWebsite`, `$.category`, `$.fiscalYearEnd`, `$.stateOfIncorporation`, `$.stateOfIncorporationDescription`, `$.phone`, `$.flags` | string | Yes | No | No | Descriptive filer data. |
| `$.addresses.mailing`, `$.addresses.business` | object | No | No | No | Address objects (street, city, state or country, zip code, foreign-location flags). |
| `$.formerNames[*]` | object | No | No | No | `name`, `from`, `to` of earlier names. |
| `$.filings.recent` | object of arrays | No | No | Yes | The recent filings as parallel arrays of equal length; index `i` of each array describes filing `i`. Every array the parser reads must hold only strings. |
| `$.filings.recent.accessionNumber[*]` | string | No | No | Yes | `##########-##-######`; a value of another shape skips that filing. |
| `$.filings.recent.filingDate[*]` | string | No | No | Yes | Filing date `YYYY-MM-DD`. |
| `$.filings.recent.reportDate[*]` | string | No | No | Yes | Period of report `YYYY-MM-DD` (the 13F quarter end); `""` for forms without one. |
| `$.filings.recent.form[*]` | string | No | No | Yes | Form type; only exactly `13F-HR` is used (`13F-HR/A`, `13F-NT`, `13F-CTR` are ignored). |
| `$.filings.recent.acceptanceDateTime[*]`, `.act[*]`, `.fileNumber[*]`, `.filmNumber[*]`, `.items[*]`, `.core_type[*]`, `.size[*]`, `.isXBRL[*]`, `.isInlineXBRL[*]`, `.primaryDocument[*]`, `.primaryDocDescription[*]` | string or number | No | No | No | Other per-filing columns. |
| `$.filings.files[*]` | object | No | No | No | `name`, `filingCount`, `filingFrom`, `filingTo` of older filing pages; never fetched, so a 13F-HR older than the recent window is not found. |

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

### Provider error codes and body

None used: SEC documents no error body for these endpoints, and the code reads only the status. SEC's webmaster FAQ mentions an "Undeclared Automated Tool" message for scripted access without a declared user agent.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s per request including redirects and the body (`SEC_TIMEOUT_MS`; Rust `fetch_options`). Tool budgets: `finance.sec_company_financials` 90 s, `filings.sec_13f_holdings` 120 s. Byte caps: ticker directory 8,000,000; company facts 48,000,000; submissions 8,000,000; submission text file 16,000,000. | `packages/adapters/src/finance/secClient.ts`, `crates/research-finance/src/market_fetch.rs` |
| Retries | Client: none (retry ceiling 0); errors carry `retryable`. Transport: a request that fails before any answer (connection refused, unreachable address family) is tried on the next validated DNS address, at most 3 addresses (`MAX_CONNECT_ATTEMPTS`, both runners). Rust only: a GET sent on an idle keep-alive connection that the server closed before answering is sent once more on a fresh connection. Job: a `stock-directory-refresh` job has at most 3 attempts (`MAX_JOB_ATTEMPTS`); the runner marks only `DIRECTORY_SOURCE_FAILED` retryable, and the API re-queues it while attempts remain; a rate limit is not retried at once. A tool failure is returned to the model as the tool's result. | `crates/research-net/src/transport.rs`, `crates/research-net/src/pinned.rs`, `packages/adapters/src/node/index.ts`, `packages/application/src/stockDirectory.ts`, `packages/application/src/researchRuns.ts`, `packages/application/src/runnerJobs.ts`, `apps/runner/src/jobExecution.ts`, `crates/research-runner/src/job_execution.rs` |
| Rate limit | One client-wide queue: each request start takes the next 125 ms slot (≤ 8/s against SEC's 10/s); a stopped job stops waiting. The directory refresh first takes a grant from the shared pacer window `sec` (8 per 1,000 ms). No response header is read. | `packages/adapters/src/finance/secClient.ts`, `crates/research-finance/src/sec_client.rs`, `apps/runner/src/marketPacing.ts`, `crates/research-finance/src/pacing.rs` |
| Cache | Ticker directory for the financials tool: process-local, 12 h, one copy, single-flight: concurrent misses wait for the one download in progress (Rust holds the lock across it, TypeScript waits on the in-flight download); a failed download caches nothing and the next waiter downloads with its own cancellation. Parsed 13F filings: 32 entries keyed by CIK and accession number, no TTL (a filing never changes); a cache hit still fails when the job was stopped. The submissions index and company facts are never cached; the directory refresh always downloads. | `packages/adapters/src/finance/secFinancials.ts`, `packages/adapters/src/finance/sec13f.ts`, `crates/research-finance/src/sec_financials.rs`, `crates/research-finance/src/sec_13f.rs` |
| Fallback | None. The tool returns its error code to the model; the Watchlist keeps the previously stored US list and shows the failure code (for `DIRECTORY_NOT_CONFIGURED`, the instruction to set `SEC_USER_AGENT`). | `packages/adapters/src/tools/secTools.ts`, `apps/web/src/watchlist/watchlistModel.messages.ts` |

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

## 7. Maintenance

### Known differences between the runners

- Transport: the Rust fetcher keeps a keep-alive connection pool (an address with an idle connection is tried first) and resends a GET once on a fresh connection when the pooled one was closed before answering; the TypeScript fetcher opens a fresh socket per request (`agent: false`) and never resends. Both try up to 3 validated addresses (`crates/research-net/src/pinned.rs`, `crates/research-net/src/transport.rs`, `packages/adapters/src/node/pinnedConnect.ts`, `packages/adapters/src/node/index.ts`).
- Revenue tie-break on equal period end and filing date compares accession numbers by byte order in Rust and by `localeCompare` in TypeScript (recorded in `crates/research-finance/src/sec_financials.rs`); accession numbers are ASCII digits and dashes, so the order agrees in practice.
- Rust parses the large JSON and XML documents off the async worker (`crate::cpu::offload`); the result is the same.

### Open issues

- The company-facts, submissions and error-response examples are `unverified`: the SEC hosts may not be called and SEC publishes no field-level schema for these JSON documents. The non-read fields in section 3 are listed from SEC's description and known responses, not observed. Re-verify all examples live once `SEC_USER_AGENT` is set (ADR-0047).
- Only `filings.recent` is read; a manager whose last two 13F-HR filings are older than the recent window gets `NO_DATA` or no comparison. Amendments (`13F-HR/A`) are ignored, so a restated quarter is not reflected.
- The 13F value-unit cutover follows the filing date (`FORM_13F_WHOLE_DOLLAR_FROM` = 2023-01-03), which Form 13F FAQ 62 confirms ("All Form 13F reports that are filed on or after January 3, 2023"). Filers that use the wrong unit cannot be detected.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-24 | live | `company_tickers_exchange.json` downloaded; rows copied to the trimmed fixture; row counts (10,429; 7,691 listed) | Directory implementation (ADR-0034) |
| 2026-10-31 | spec | URL patterns, CIK padding, recent-window size, fair-access limit and `User-Agent` format (EDGAR API page, accessing EDGAR data, webmaster FAQ); 13F information table elements and enums against `eis_13FDocument.xsd` of the 13F XML Technical Specification 2.0; document tags against the PDS specification; value units against Form 13F FAQ 36 and 62 | Claude (external API documents, ADR-0047) |
| 2026-10-31 | fixture | `sec-edgar-company-tickers-exchange` parsed by `parseTickerDirectory` / `secDirectoryEntries`; the other marked examples parsed by `selectAnnualFinancials`, `selectRecent13FFilings`, `extractInformationTableXml` and `parseInformationTable` (`packages/adapters/test/finance/secEdgarDocExamples.test.ts`) | Claude |
