# External API: EDINET API v2

## 1. Overview

| Property | Value |
|---|---|
| Provider | Financial Services Agency of Japan (金融庁 企画市場局 企業開示課), EDINET — the electronic disclosure system for securities reports |
| Purpose | The Japanese half of the financial-statement sync ([ADR-0048](../../adr/0048-financial-statements-synced-from-sec-and-edinet.md)): find the annual securities reports (有価証券報告書, docTypeCode 120) and their amendments (訂正有価証券報告書, 130) of each tracked Japanese company, download their XBRL-to-CSV rendering, and send the annual facts to the API, which stores them as the as-filed history and the current values the Equities page and the financial-statement widgets read. |
| Hosts | `api.edinet-fsa.go.jp` |
| Endpoints | `GET /api/v2/documents.json` — every document submitted on one date, with metadata (書類一覧 API; we ask `type=2`); `GET /api/v2/documents/{docID}` — the files of one document (書類取得 API; we ask `type=5`, the ZIP of CSV files converted from the document's XBRL) |
| Authentication | API key as the query parameter `Subscription-Key` on every request (spec §3-1-1, §3-2-1: the API has no header form). It comes from `EDINET_API_KEY` in the runner's environment file: 8–200 printable ASCII characters without spaces (`^[\x21-\x7e]{8,200}$`, checked at start), percent-encoded as `encodeURIComponent` does. Because the key is in the URL, a URL of this API is never logged, stored or shown (logs carry ids, codes and counts only). Without the variable the runner logs `edinet_disabled` once at start and every Japanese company's job fails with `FINANCIAL_SOURCE_NOT_CONFIGURED` before any request. The key is issued free on EDINET's API key page after creating an account (spec §2-3); EDINET deletes a key unused for two years and invalidates the old key on reissue (§2-3-2-2, §2-3-2-3). Operator steps: [OPERATIONS.md](../../OPERATIONS.md). |
| Configuration | None besides `EDINET_API_KEY`. |
| Usage Limits | EDINET publishes no numeric quota. The spec's status 429 means "一定時間内に大量のリクエストを受信しました" and asks to retry after enough time and to review the request interval (§3-3); the [terms of use](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0030.html) prohibit "短時間における大量のアクセスその他のAPI機能の運用に支障を与える行為" (§3.2), let the FSA restrict access according to load (§2.1) and suspend a user's API access without notice. Ours: every request start takes a grant from the runner's pacer window `edinet` (1 start per 1,000 ms, listings and downloads alike); requests are sequential; a job lists at most 40 dates and downloads at most 8 documents (`EQUITY_FINANCIAL_LIMITS.maxScanDays`, `.maxDocumentsPerJob`); only one `financial-sync` job exists at a time; a date's annual rows are cached 24 h (section 4). |
| Called By | Rust runner (default) and TypeScript runner (rollback): `financial-sync` jobs of tracked companies with market `JP`, created at claim time when a company is due (every 24 h, at once after a completion that left work, or after "Sync now"). The API Worker and the browser never call EDINET; the browser only opens a filing's viewer link on the owner's click. |
| Code | `crates/research-finance/src/edinet_documents.rs`, `crates/research-finance/src/edinet_csv.rs`, `crates/research-finance/src/edinet_sync.rs`, `crates/research-finance/src/equity_sync.rs`, `crates/research-finance/src/zip_reader.rs`, `crates/research-finance/src/bounded_cache.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-runner/src/composition.rs`, `crates/research-runner/src/config.rs`, `crates/research-runner/src/startup.rs`, `crates/research-runner/src/job_execution.rs`, `packages/adapters/src/finance/edinetDocuments.ts`, `packages/adapters/src/finance/edinetCsv.ts`, `packages/adapters/src/finance/edinetSync.ts`, `packages/adapters/src/finance/equitySync.ts`, `packages/adapters/src/finance/boundedCache.ts`, `packages/adapters/src/node/zipReader.ts`, `apps/runner/src/marketPacing.ts`, `apps/runner/src/config.ts`, `apps/runner/src/main.ts`, `apps/runner/src/jobExecution.ts`; the claim (dates to scan, known and pending documents) is planned by `packages/application/src/equitySync.ts` with `edinetScanPlan` in `packages/domain/src/finance/financialStatements.ts` |
| Official Documentation | [EDINET API仕様書（Version 2）](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf) (2026年6月, rev. 2.9: §2-3 API key, §3-1 書類一覧 API, §3-2 書類取得 API, §3-3 ステータスコード, §4-1 code lists); its [別紙2 提出書類一覧のデータ出力例](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140328.xlsx) (withdrawal, information edits, non-disclosure); [書類閲覧操作ガイド](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140133.pdf) (2026年6月, 1章 3-2-1: the XBRL-to-CSV columns and file format); [報告書インスタンス作成ガイドライン](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140112.pdf) (2025年11月, §4-2 instance file names, §5-4 context IDs, §5-6-2-3 the "-" bar, §5-6-2-4 "-0"); [タクソノミ要素リスト](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140114.xlsx) (sheet 1, DEI elements); [利用規約](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0030.html); all on the [EDINET documents page](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0110.html) |
| Last Verified | 2026-10-31, spec; no live call (no `EDINET_API_KEY` yet) (section 7) |

EDINET has no per-company search: the 書類一覧 API lists every document submitted on one date. The API plans which dates a company still has to list (`edinetScanPlan`: discovery of the latest annual report in the last 400 days with the 15–30 June peak first, then 30–100 days after each of six fiscal year ends, then every weekday since the newest report up to yesterday in Japan time; weekends and dates already listed are skipped; at most 40 per job). For each date the runner asks `documents.json?type=2` (or uses its 24-hour cache), keeps the not-withdrawn 120/130 rows whose `secCode` is the company's JPX code + `0`, and plans the downloads: pending filings first, then new documents oldest first; a document with `csvFlag` `0` is "not available" without a request; at most 8 are downloaded and the rest are "deferred" to the next job; an amendment (130) whose row states no period takes its original's period or its report's DEI fiscal year. Each download (`documents/{docID}?type=5`) is a ZIP; the runner reads the main report's CSV under `XBRL_TO_CSV/` (the `jpcrp…` file), takes the DEI rows and the claimed concepts' rows of the four year contexts, keeps the annual facts and sends them in the `financial-synced` completion.

## 2. Input Parameters

Both endpoints go through the runner's safe fetcher (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`), pinned to `api.edinet-fsa.go.jp` for the request and every redirect (at most 5), over TLS 1.2 or later (the spec requires TLS 1.2+). The query is built in the spec's order (`date`, `type`, `Subscription-Key`; `type`, `Subscription-Key`) by `edinetDocumentListUrl` / `edinetDocumentUrl` (`packages/adapters/src/finance/edinetDocuments.ts`) and `edinet_document_list_url` / `edinet_document_url` (`crates/research-finance/src/edinet_documents.rs`). These headers are the same on both endpoints; `Accept` differs as stated.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Accept` | header | string | No | We send `application/json` (list) or `application/octet-stream, application/zip, application/json` (document) | Printable ASCII | What we expect: the document endpoint answers a ZIP on success and JSON on an error (spec §3-2-2). |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` | Printable ASCII | The runner's fixed identification (`DEFAULT_USER_AGENT`). The spec names no header. |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | Compressed transfer; the encoded bytes count against the size cap. |
| `Host` | header | string | Yes | We send `api.edinet-fsa.go.jp` | — | Sent by the transport. |

### GET /api/v2/documents.json

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `v2` | path | string | Yes | — ; we send `v2` | `v` + integer (spec §3-1-1 バージョン) | API version; this document covers version 2 only. |
| `date` | query | string | Yes | — ; we send one date of the claim's `scanDays` | `YYYY-MM-DD`; on or before today and not past ten years at 24:00 of the latest business day (spec §3-1-1 \*1; weekends and holidays allowed). The plan sends only weekdays before today in Japan time, within six fiscal years + 400 days. | ファイル日付: the date whose list is returned — documents submitted that day, plus information edits and non-disclosure changes registered that day. A paper or disk filing appears under the date it was processed, not its submission date. |
| `type` | query | string | No | `1` (metadata only); we send `2` | `1` or `2` | `2` = 提出書類一覧及びメタデータ: the documents and the metadata. |
| `Subscription-Key` | query | string | Yes | — ; we send `EDINET_API_KEY`, percent-encoded | The key shown on EDINET's API key page | Authentication (spec §2-3-2-1). A secret: the URL is never logged. |

### GET /api/v2/documents/{docID}

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `v2` | path | string | Yes | — ; we send `v2` | `v` + integer | API version. |
| `{docID}` | path | string | Yes | — ; we send a `docID` from a date's list, or a pending filing's stored document id | 8 characters, `S[0-9A-Z]{7}` (`edinetDocIdSchema`); the spec: 書類管理番号 as listed, documents not open for viewing cannot be fetched | 書類管理番号: the document. |
| `type` | query | string | Yes | — ; we send `5` | `1` 提出本文書及び監査報告書 (ZIP), `2` PDF, `3` 代替書面・添付文書 (ZIP), `4` 英文ファイル (ZIP), `5` CSV (ZIP) | `5` = the document's XBRL converted to CSV; available when the list row's `csvFlag` is `"1"` (spec §3-2-1 \*3). |
| `Subscription-Key` | query | string | Yes | — ; we send `EDINET_API_KEY`, percent-encoded | As above | Authentication. |

## 3. Output Parameters

### GET /api/v2/documents.json

`application/json; charset=utf-8`, UTF-8 JSON (spec §3-1-2-2); dates and times are Japan time. A few hundred kilobytes even at the late-June peak; read up to 8,000,000 bytes. EDINET answers an error with this same HTTP 200 and an error body (spec §3-3, section 4). Field digits are the spec's 桁数.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.metadata` | object | No | No | Yes | Metadata. Missing, or without a string `status`, fails the list (`FINANCIAL_PARSE_FAILED`). |
| `$.metadata.title` | string (18) | No | No | No | API name, `提出された書類を把握するためのAPI`. |
| `$.metadata.parameter.date` | string `YYYY-MM-DD` | No | No | No | The requested date. |
| `$.metadata.parameter.type` | string (1) | No | No | No | The requested `type`. |
| `$.metadata.resultset.count` | number (≤ 5 digits) | No | No | No | Number of rows of the date. |
| `$.metadata.processDateTime` | string `YYYY-MM-DD hh:mm` | No | No | No | When the list was last rebuilt (it is rebuilt even when nothing changed). |
| `$.metadata.status` | string (3) | No | No | Yes | `"200"` on success; any other value is an error carrying that status (section 4). |
| `$.metadata.message` | string (≤ 21) | No | No | No | `OK` on success, else the status message. |
| `$.results` | array | No | No (with `type=2`) | Yes | The rows, in `seqNumber` order. Absent on a `"200"` answer fails the list. A row that does not have the shape below, or is not a kept annual row, is dropped. |
| `$.results[*].seqNumber` | number (≤ 5) | No | No | No | Per-date serial, never reassigned; new rows get higher numbers. |
| `$.results[*].docID` | string (8) | No | No | Yes | 書類管理番号. Must match `S[0-9A-Z]{7}`, else the row is dropped. Kept even when a row is cleared by withdrawal or expiry. |
| `$.results[*].edinetCode` | string (6) | Yes | No | Yes | Filer's EDINET code; must match `E\d{5}`. As of the row's creation (spec §3-1-8). |
| `$.results[*].secCode` | string (5) | Yes | No | Yes | Filer's securities code: JPX code + check digit `0` (`79740`); `null` for unlisted filers. Compared with the claim's `secCode`. |
| `$.results[*].JCN` | string (13) | Yes | No | No | Corporate number. |
| `$.results[*].filerName` | string (≤ 128) | Yes | No | Yes | Filer name, as of the row's creation. |
| `$.results[*].fundCode` | string (6) | Yes | No | No | Fund code. |
| `$.results[*].ordinanceCode` | string (3) | Yes | No | No | 府令コード (`010` 企業内容等の開示に関する内閣府令, …, spec §4-1). |
| `$.results[*].formCode` | string (6) | Yes | No | No | 様式コード (別紙1). |
| `$.results[*].docTypeCode` | string (3) | Yes | No | Yes | 書類種別コード (spec §4-1). Kept: `120` 有価証券報告書, `130` 訂正有価証券報告書; every other code (`140` 四半期報告書, `160` 半期報告書, `180` 臨時報告書, …) and `null` drop the row. |
| `$.results[*].periodStart` | string `YYYY-MM-DD` | Yes | No | Yes | 期間（自）: the fiscal year for 有価証券報告書 and 半期報告書; "その他の書類種別では期間は出力されません" (spec §3-1-2-2 \*3). An invalid date is read as `null`. |
| `$.results[*].periodEnd` | string `YYYY-MM-DD` | Yes | No | Yes | 期間（至）, as above. A `120` row without a valid period end is not stored; a `130` row without one takes its period from its original or its report (section 6). |
| `$.results[*].submitDateTime` | string `YYYY-MM-DD hh:mm` | Yes | No | Yes | Submission time, Japan time. Must match `YYYY-MM-DD HH:MM` with a valid date, else the row is dropped. |
| `$.results[*].docDescription` | string (≤ 147) | Yes | No | No | The text EDINET's search results show (`有価証券報告書－第75期(…)`). |
| `$.results[*].issuerEdinetCode`, `.subjectEdinetCode` | string (6) | Yes | No | No | Issuer (large-holding reports) and target (tender offers). |
| `$.results[*].subsidiaryEdinetCode` | string (≤ 69) | Yes | No | No | Up to 10 subsidiary codes joined by `,`. |
| `$.results[*].currentReportReason` | string (≤ 1000) | Yes | No | No | Reasons of an extraordinary report, joined by `,`. |
| `$.results[*].parentDocID` | string (8) | Yes | No | Yes | 親書類管理番号: for an amendment, the document it amends (when set at submission); also on withdrawals and other related documents (spec §4-1). Read only when it is a valid document id. |
| `$.results[*].opeDateTime` | string `YYYY-MM-DD hh:mm` | Yes | No | No | When an FSA information edit, a non-disclosure change or a paper/disk filing was processed. |
| `$.results[*].withdrawalStatus` | string (1) | No | No | Yes | `"0"` normal, `"1"` a withdrawal notice (取下書), `"2"` a withdrawn document (its other fields become `null` after the daily update, spec §3-1-5). Only `"0"` is kept. |
| `$.results[*].docInfoEditStatus` | string (1) | No | No | No | `"1"` the row recording an FSA information edit (listed on the edit's date, same `docID`), `"2"` the edited document, `"0"` otherwise (spec §3-1-6). |
| `$.results[*].disclosureStatus` | string (1) | No | No | No | `"1"` non-disclosure started, `"2"` not disclosed, `"3"` non-disclosure lifted, `"0"` otherwise (spec §3-1-7). |
| `$.results[*].xbrlFlag` | string (1) | No | No | No | `"1"` the document has XBRL. |
| `$.results[*].pdfFlag`, `.attachDocFlag`, `.englishDocFlag` | string (1) | No | No | No | PDF, attachments, English files present. |
| `$.results[*].csvFlag` | string (1) | No | No | Yes | `"1"` the XBRL-to-CSV (`type=5`) exists. Any other value: the filing is reported not available without a request. |
| `$.results[*].legalStatus` | string (1) | No | No | No | `"1"` 縦覧中, `"2"` extended viewing period, `"0"` viewing period over (then every field but `seqNumber` and `docID` is `null` and the flags `"0"`, spec §3-1-4). An annual securities report stays viewable ten years (spec §1-2-2). |

### GET /api/v2/documents/{docID}

On success `application/octet-stream`: a ZIP (spec §3-2-2); on an error `application/json; charset=utf-8` with the error body of section 4. The code does not read `Content-Type`: a body starting with the ZIP signature `PK\x03\x04` is the archive, anything else is parsed as the error JSON. Downloads are read up to 16,000,000 bytes; one inflated entry up to 64,000,000 bytes. With `type=5` the archive holds the folder `XBRL_TO_CSV` with the CSV conversions of the report's XBRL and of the audit reports (spec §3-2-2 圧縮ファイルの構成); the file names follow the XBRL instance names of 報告書インスタンス作成ガイドライン §4-2 (the API spec does not name the files).

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `XBRL_TO_CSV/jpcrp…csv` | ZIP entry | No | No | Yes | The report itself (`jp{府令略号}{様式番号}-{報告書略号}-…`, e.g. `jpcrp030000-asr-001_E10001-000_2023-03-31_01_2023-06-12.csv`). Chosen: an entry directly under `XBRL_TO_CSV/` whose file name starts `jpcrp` and ends `.csv`; when several do, the first in code-unit order. None is `NO_REPORT_ENTRY` (section 4). |
| `XBRL_TO_CSV/jpaud…csv` | ZIP entry | No | Yes | No | Independent auditor's reports. |
| Other entries | ZIP entry | — | Yes | No | Never inflated. |
| CSV encoding | text | No | No | Yes | UTF-16LE (書類閲覧操作ガイド 1章 3-2-1); a leading byte-order mark `FF FE` is dropped; an odd byte count or an unpaired surrogate fails (`ENCODING`). |
| CSV format | text | No | No | Yes | Tab-separated; every field in `"…"`, a `"` inside written `""`; lines end CRLF (the parser also accepts LF and lone CR). A quoted field may hold tabs and line breaks (text blocks). Values over 30,000 characters are cut at 30,000 (numbers never are). |
| Column 1 `要素ID` | string | No | No | Yes | The element: `jpdei_cor:…` (DEI), `jppfs_cor:…` (financial statements), `jpcrp_cor:…` (report body), filer extensions. Row 1 must be the nine column names exactly, in this order, else `MISSING_HEADER`. |
| Column 2 `項目名` | string | No | No | No | Japanese label (blank for filer-defined elements). |
| Column 3 `コンテキストID` | string | No | No | Yes | The context (報告書インスタンス作成ガイドライン §5-4-1: `{相対期間又は時点}{期間又は時点}(_{メンバー}…)(_{連番})`). Read only: `CurrentYearDuration`, `Prior1YearDuration`, `CurrentYearInstant`, `Prior1YearInstant`, each alone (consolidated) or with exactly `_NonConsolidatedMember` (separate). Every other context — interim, `FilingDateInstant`, segment and other members, a `_002` serial — is skipped for concepts. |
| Column 4 `相対年度` | string | No | No | No | The context's relative year as EDINET labels it (e.g. `当期`, `前期末`). |
| Column 5 `連結・個別` | string | No | No | No | `連結` or `個別` for `jppfs` elements, `その他` for all others (guide 1章 3-2-1). The scope is taken from the context ID instead. |
| Column 6 `期間・時点` | string | No | No | No | `期間` or `時点`. The period type is taken from the context ID. |
| Column 7 `ユニットID` | string | No | No | Yes | Unit: `JPY` for yen amounts; `-` when the item has none. A concept row with an empty unit or one over 40 characters is skipped. |
| Column 8 `単位` | string | No | No | No | Unit label (`円`). |
| Column 9 `値` | string | No | No | Yes | The value: decimal text in base units (yen), `-` for a negative amount (`-61000000`). `-` alone is the "bar" (xsi:nil: no value, or zero before rounding, instance guideline §5-6-2-3; the guide reads it as an explicit zero), `-0` is △0 (§5-6-2-4); both, and any text that is not canonical decimal (`isCanonicalDecimal`: no exponent, no leading zeros, no trailing fractional zeros, ≤ 64 characters), skip the row. |
| Row `jpdei_cor:AccountingStandardsDEI` | DEI | Yes | No | Yes | `Japan GAAP`, `US GAAP` or `IFRS` (タクソノミ要素リスト, DEI); nil when the report has no financial statements. |
| Rows `jpdei_cor:CurrentFiscalYearStartDateDEI`, `…CurrentFiscalYearEndDateDEI`, `…PreviousFiscalYearStartDateDEI`, `…PreviousFiscalYearEndDateDEI` | DEI | Yes | Yes | Yes | The fiscal years as `YYYY-MM-DD` (the consolidated year when it differs from the separate one). They date the facts: `CurrentYear…` from the current start/end, `Prior1Year…` from the previous ones; a fact whose dates are missing or invalid is skipped. |
| Other DEI rows (`jpdei_cor:EDINETCodeDEI`, `…SecurityCodeDEI`, `…WhetherConsolidatedFinancialStatementsArePreparedDEI`, …) | DEI | Yes | Yes | No | Filer and report identification. |
| Rows of the claimed concepts | facts | No | Yes | Yes | The JGAAP concepts the claim sends (`equityConceptsOfProvider("edinet")`: `jppfs_cor:NetSales`, `jppfs_cor:OrdinaryIncome`, `jppfs_cor:Assets`, `jppfs_cor:NetAssets`, `jppfs_cor:NetCashProvidedByUsedInOperatingActivities`, `jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF`, …). |
| All other rows | facts, text | — | — | No | Including every text block. |

## 4. Error Handling

### HTTP status codes

EDINET answers an API error (a bad parameter, an unknown document, a server failure) with HTTP 200 and a JSON body whose status says what happened (spec §3-3: "このとき、レスポンスの HTTPステータスは"200"となります"); the gateway's key and rate errors have their own body (below). Either way EDINET's status travels unchanged as `failureUpstreamStatus` beside our code ([§4a](../../rule/error_handling.md)). The failure code of a status is `equitySyncCodeOfStatus` (`packages/adapters/src/finance/equitySync.ts`, `crates/research-finance/src/equity_sync.rs`). On a non-2xx HTTP answer the body is never read; only the status counts.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200, list, `metadata.status` `"200"` | Success | Rows parsed (section 3) and the date's annual rows cached | — |
| 200, document, ZIP body | Success | The main report CSV extracted | — |
| 200 with `metadata.status` `"404"` (document) or HTTP 404 (document) | The document has no CSV, or is not open for viewing (expired, withdrawn, not disclosed) | That filing is reported `not-available` and the job goes on; the API keeps it pending until 7 days after it was first seen, then records it unavailable (an amendment whose period is still unknown is not reported, section 6) | — |
| 200 with `metadata.status` `"401"`, or HTTP 401 / 403 | Invalid or missing key (`Access denied due to invalid subscription key.`) | The job fails, not retryable | `FINANCIAL_ACCESS_DENIED` |
| 200 with `metadata.status` `"429"`, or HTTP 429 | Too many requests in a short time | The job fails, retryable | `FINANCIAL_RATE_LIMITED` |
| 200 with `metadata.status` `"400"` | Bad request (parameter or encoding) | The job fails, retryable | `FINANCIAL_SOURCE_FAILED` |
| 200 with `metadata.status` `"404"` (list), or HTTP 404 (list) | No list for that date | The job fails, retryable | `FINANCIAL_SOURCE_FAILED` |
| 200 with `metadata.status` `"500"`, HTTP 5xx, other non-2xx | Server failure, maintenance ("Sorry" page), other refusal | The job fails, retryable | `FINANCIAL_SOURCE_FAILED` |
| 200, list, body without the list's shape whose `StatusCode` / `statusCode` is 400 or more | The gateway's 401 or 429 body (spec §3-3 B, C) delivered with HTTP 200 | Treated as that status (`edinetErrorStatus`), kept as `failureUpstreamStatus`: 401/403 not retryable, 429 and others retryable | `FINANCIAL_ACCESS_DENIED` (401, 403), `FINANCIAL_RATE_LIMITED` (429), `FINANCIAL_SOURCE_FAILED` (other) |
| 200, document, JSON body with `StatusCode` 401 / 429 | The gateway's 401 or 429 body | As 401 / 429 above, with that status | `FINANCIAL_ACCESS_DENIED` / `FINANCIAL_RATE_LIMITED` |
| 200, list, a `metadata.status` that is not `[1-5]\d{2}` | Undocumented | The job fails, retryable, status null | `FINANCIAL_SOURCE_FAILED` |
| 200, document, neither a ZIP nor JSON stating a status ≥ 400 | An HTML error page, garbage, an undocumented status | That filing is reported `not-available`, the runner logs `financial_sync_document_unreadable` (`problem` `NOT_A_ZIP`) and the job goes on | — |
| 301, 302, 303, 307, 308 | Redirect | Followed up to 5 hops on `api.edinet-fsa.go.jp` only; another host fails the fetch | `FINANCIAL_SOURCE_FAILED` (status null) |
| — (no answer) | Timeout, network error, stopped job | The job fails, retryable, status null | `FINANCIAL_SOURCE_FAILED` |

Our own failures, with no EDINET status: `FINANCIAL_SOURCE_NOT_CONFIGURED` (no `EDINET_API_KEY`; nothing sent); `FINANCIAL_PARSE_FAILED` for a list that is not JSON or lacks `metadata.status` / `results` (and states no error status of 400 or more), and for a list or document over its byte cap. A downloaded document that is not a readable report — a malformed ZIP (`NOT_A_ZIP`), no `XBRL_TO_CSV/jpcrp…csv` entry (`NO_REPORT_ENTRY`), text that is not UTF-16 LE (`ENCODING`), a CSV without the header (`MISSING_HEADER`), or an answer that is neither a ZIP nor an EDINET error status (`NOT_A_ZIP`) — does not fail the job: it is reported `not-available`, the job continues with the other documents, and the runner logs one `financial_sync_document_unreadable` warning (`companyId`, `provider`, `sourceDocumentId`, `problem` = `NOT_A_ZIP` \| `NO_REPORT_ENTRY` \| `ENCODING` \| `MISSING_HEADER`) per such document. The API keeps such a filing pending until 7 days after it was first seen, then records it unavailable. Failing the job instead would plan the same document first on every claim and block the company. Only a failing date list, an HTTP / EDINET error status or a fetch failure fails the job. The runner also refuses to send a completion its contract would reject (`FINANCIAL_PARSE_FAILED`). Rows that fail a row check (shape, document id, filer code, submission time, context, unit, value) are skipped, never repaired.

### Provider error codes and body

The error body (spec §3-3) is either the v2 metadata without `parameter`, `resultset` and `processDateTime` — `{"metadata":{"title":…,"status":"404","message":"Not Found"}}` for 400, 404 and 500 — or the gateway's `{"StatusCode":401,"message":"Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription."}` and `{"StatusCode":429,"message":"Too Many Requests"}`. `edinetErrorStatus` reads `metadata.status` (when it is three digits 1xx–5xx), else `StatusCode` or `statusCode` (an integer 100–599). The message text is never read or stored. Spec statuses and messages: `200 OK`, `400 Bad Request`, `401 Access denied due to invalid subscription key…`, `404 Not Found`, `429 Too Many Requests`, `500 Internal Server Error`.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | List: 30 s, 8,000,000 bytes. Document: 60 s, 16,000,000 bytes; each inflated ZIP entry at most 64,000,000 bytes (`EDINET_ZIP_LIMITS`). Exceeding a byte cap fails as `FINANCIAL_PARSE_FAILED` (a retry would not shrink it). | `packages/adapters/src/finance/edinetSync.ts`, `packages/adapters/src/finance/edinetCsv.ts`, `crates/research-finance/src/edinet_sync.rs`, `crates/research-finance/src/edinet_csv.rs` |
| Retries | Source: none. Transport: a request that fails before any answer is tried on the next validated DNS address, at most 3 (`MAX_CONNECT_ATTEMPTS`, both runners); Rust only resends a GET once when a pooled keep-alive connection was closed before answering. Job: the runner marks `FINANCIAL_RATE_LIMITED` and `FINANCIAL_SOURCE_FAILED` retryable and the API re-queues the job while attempts remain (at most 3, `MAX_JOB_ATTEMPTS`); after a terminal failure the company is due again after 30 min × 2^(n−1), at most 24 h. A failed list fails the job; the dates listed before it stay cached, so the retry is cheap. | `packages/adapters/src/finance/equitySync.ts`, `crates/research-finance/src/equity_sync.rs`, `packages/application/src/runnerJobs.ts`, `packages/application/src/equitySync.ts`, `apps/runner/src/jobExecution.ts`, `crates/research-runner/src/job_execution.rs` |
| Rate limit | Every request start first takes a grant from the pacer window `edinet` (1 per 1,000 ms) through the job's `beforeRequest`; a refused grant (job stopped) sends nothing more and fails the job as `FINANCIAL_SOURCE_FAILED`. Requests are sequential. No response header is read. | `apps/runner/src/marketPacing.ts`, `crates/research-finance/src/pacing.rs` |
| Cache | One process-local cache per runner: a date's not-withdrawn 120/130 rows of every filer (not only the company's), 24 h TTL, at most 1,000 dates (least recently used evicted), keyed by date; a hit sends no request and takes no grant, so companies synced one after another share the listings. A failed list caches nothing. Documents are never cached (each is downloaded once; its facts are stored). | `packages/adapters/src/finance/edinetSync.ts`, `packages/adapters/src/finance/boundedCache.ts`, `crates/research-finance/src/edinet_sync.rs`, `crates/research-finance/src/bounded_cache.rs` |
| Fallback | None. The financial widgets keep showing the stored values and the Equities page shows the company's last failure code and EDINET's status (`equity_sync_state`). | `packages/application/src/equitySync.ts` |

## 5. Examples

No request was sent to EDINET while writing this document: the owner has no `EDINET_API_KEY` yet. The examples are taken from the EDINET API specification (Version 2, 2026年6月), or are illustrative where the spec gives no sample; `HTTP/1.1` is written because both runners speak HTTP/1.1 only. The fixtures under `examples/fixtures/equity-sync/` are synthetic (generated by `scripts/vectors/finance/equitySyncFixtures.ts`), not recordings.

### GET /api/v2/documents.json

Request:

```http
GET /api/v2/documents.json?date=2023-04-03&type=2&Subscription-Key=<EDINET_API_KEY> HTTP/1.1
Host: api.edinet-fsa.go.jp
Accept: application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf (§3-1-1 リクエスト URL sample `…/documents.json?date=2023-04-01&type=2&Subscription-Key=ZZZ…ZZZ`; date of the §3-2-2 sample B). Key replaced by its placeholder; headers as `packages/adapters/src/node/pinnedConnect.ts` sends them; URL as `edinetDocumentListUrl` builds it.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

<!-- example: edinet-documents-list -->
```json
{
    "metadata":
        {
            "title": "提出された書類を把握するためのAPI",
            "parameter":
                {
                    "date": "2023-04-03",
                    "type": "2"
                },
            "resultset":
                {
                    "count": 1
                },
            "processDateTime": "2023-04-03 13:01",
            "status": "200",
            "message": "OK"
        },
    "results": [
        {
            "seqNumber": 1,
            "docID": "S1000001",
            "edinetCode": "E10001",
            "secCode": "10000",
            "JCN": "6000012010023",
            "filerName": "エディネット株式会社",
            "fundCode": "G00001",
            "ordinanceCode": "030",
            "formCode": "04A000",
            "docTypeCode": "030",
            "periodStart": null,
            "periodEnd": null,
            "submitDateTime": "2023-04-03 12:34",
            "docDescription": "有価証券届出書（内国投資信託受益証券）",
            "issuerEdinetCode": null,
            "subjectEdinetCode": null,
            "subsidiaryEdinetCode": null,
            "currentReportReason": null,
            "parentDocID": null,
            "opeDateTime": null,
            "withdrawalStatus": "0",
            "docInfoEditStatus": "0",
            "disclosureStatus": "0",
            "xbrlFlag": "1",
            "pdfFlag": "1",
            "attachDocFlag": "1",
            "englishDocFlag": "0",
            "csvFlag": "1",
            "legalStatus": "1"
        }
    ]
}
```

Verified: spec, 2026-10-31, https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf (§3-1-2-2 書類一覧 API（提出書類一覧及びメタデータ）, sample B "提出書類一覧が 1 件取得できる場合"; the response header from the same section). Body verbatim (the spec's line breaks across pages joined); the status line is not in the spec. The row is a securities registration statement (`030`), which the parser drops: this list yields no annual row.

One row of a list whose document is an annual securities report (`120`), as the spec shows it after an FSA information edit (`docInfoEditStatus` `"2"`, not read):

<!-- example: edinet-documents-row-annual-report -->
```json
{
    "seqNumber": 1,
    "docID": "S1000001",
    "edinetCode": "E10001",
    "secCode": "10000",
    "JCN": "6000012010023",
    "filerName": "エディネット株式会社",
    "fundCode": "G00001",
    "ordinanceCode": "030",
    "formCode": "07A000",
    "docTypeCode": "120",
    "periodStart": "2022-04-01",
    "periodEnd": "2023-03-31",
    "submitDateTime": "2023-06-12 12:34",
    "docDescription": "有価証券報告書（内国投資信託受益証券）－第1期(令和4年4月1日－令和5年3月31日)",
    "issuerEdinetCode": null,
    "subjectEdinetCode": null,
    "subsidiaryEdinetCode": null,
    "currentReportReason": null,
    "parentDocID": null,
    "opeDateTime": null,
    "withdrawalStatus": "0",
    "docInfoEditStatus": "2",
    "disclosureStatus": "0",
    "xbrlFlag": "1",
    "pdfFlag": "1",
    "attachDocFlag": "1",
    "englishDocFlag": "0",
    "csvFlag": "1",
    "legalStatus": "1"
}
```

Verified: spec, 2026-10-31, https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf (§3-1-6 財務局職員による書類情報修正, "修正された書類の情報", the list of 2023-06-12). One element of `results`, verbatim; the `docDescription` was set across two lines in the PDF and is joined here without the spaces the PDF layout adds — re-check the exact text in a live list.

### GET /api/v2/documents/{docID}

Request:

```http
GET /api/v2/documents/S1000001?type=5&Subscription-Key=<EDINET_API_KEY> HTTP/1.1
Host: api.edinet-fsa.go.jp
Accept: application/octet-stream, application/zip, application/json
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: spec, 2026-10-31, https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf (§3-2-1 リクエスト URL sample `…/documents/S1234567?type=1&Subscription-Key=ZZZ…ZZZ`, `type` 5 = CSV). The document id is the one of the row above; key replaced by its placeholder; URL as `edinetDocumentUrl` builds it.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
```

```text
<binary ZIP: XBRL_TO_CSV/jpcrp030000-asr-001_E10001-000_2023-03-31_01_2023-06-12.csv, XBRL_TO_CSV/jpaud-aar-cn-001_E10001-000_2023-03-31_01_2023-06-12.csv>
```

Verified: spec, 2026-10-31, https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf (§3-2-2 レスポンスヘッダ `application/octet-stream` for a ZIP, 圧縮ファイルの構成 for `type` 5: folder `XBRL_TO_CSV`). The body is the archive itself and is not reproduced; the entry names follow 報告書インスタンス作成ガイドライン §4-2 (https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140112.pdf) and are illustrative.

**Decoded main report** — the text of the `jpcrp…csv` entry after UTF-16LE decoding, fields separated by tab characters, one line per row (the file ends each line CRLF):

<!-- example: edinet-xbrl-to-csv-report -->
```text
"要素ID"	"項目名"	"コンテキストID"	"相対年度"	"連結・個別"	"期間・時点"	"ユニットID"	"単位"	"値"
"jpdei_cor:AccountingStandardsDEI"	"会計基準、DEI"	"FilingDateInstant"	"提出日時点"	"その他"	"時点"	"-"	"-"	"Japan GAAP"
"jpdei_cor:CurrentFiscalYearStartDateDEI"	"当事業年度開始日、DEI"	"FilingDateInstant"	"提出日時点"	"その他"	"時点"	"-"	"-"	"2022-04-01"
"jpdei_cor:CurrentFiscalYearEndDateDEI"	"当事業年度終了日、DEI"	"FilingDateInstant"	"提出日時点"	"その他"	"時点"	"-"	"-"	"2023-03-31"
"jpdei_cor:PreviousFiscalYearStartDateDEI"	"前事業年度開始日、DEI"	"FilingDateInstant"	"提出日時点"	"その他"	"時点"	"-"	"-"	"2021-04-01"
"jpdei_cor:PreviousFiscalYearEndDateDEI"	"前事業年度終了日、DEI"	"FilingDateInstant"	"提出日時点"	"その他"	"時点"	"-"	"-"	"2022-03-31"
"jpcrp_cor:BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock"	"経営方針、経営環境及び対処すべき課題等 [テキストブロック]"	"FilingDateInstant"	"提出日時点"	"その他"	"時点"	"-"	"-"	"（1）経営方針
当社は「""開示""の信頼性」を掲げています。"
"jppfs_cor:NetSales"	"売上高"	"CurrentYearDuration"	"当期"	"連結"	"期間"	"JPY"	"円"	"1250000000"
"jppfs_cor:NetSales"	"売上高"	"Prior1YearDuration"	"前期"	"連結"	"期間"	"JPY"	"円"	"1180000000"
"jppfs_cor:NetSales"	"売上高"	"CurrentYearDuration_NonConsolidatedMember"	"当期"	"個別"	"期間"	"JPY"	"円"	"830000000"
"jppfs_cor:NetSales"	"売上高"	"CurrentYearDuration_jpcrp030000-asr_E10001-000MachineryReportableSegmentMember"	"当期"	"連結"	"期間"	"JPY"	"円"	"640000000"
"jppfs_cor:GrossProfit"	"売上総利益"	"CurrentYearDuration"	"当期"	"連結"	"期間"	"JPY"	"円"	"-"
"jppfs_cor:OrdinaryIncome"	"経常利益"	"CurrentYearDuration"	"当期"	"連結"	"期間"	"JPY"	"円"	"152000000"
"jppfs_cor:Assets"	"資産"	"CurrentYearInstant"	"当期末"	"連結"	"時点"	"JPY"	"円"	"2400000000"
"jppfs_cor:Assets"	"資産"	"Prior1YearInstant"	"前期末"	"連結"	"時点"	"JPY"	"円"	"2310000000"
"jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF"	"有形固定資産の取得による支出"	"CurrentYearDuration"	"当期"	"連結"	"期間"	"JPY"	"円"	"-61000000"
```

Verified: unverified, 2026-10-31, no `EDINET_API_KEY` yet; verify with `bun run test:real tests/real/equitySyncReal.spec.ts` once the key is set. The nine column names, the encoding, tab separation, quoting and `""` escape are from 書類閲覧操作ガイド 1章 3-2-1 (https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140133.pdf); the context IDs from 報告書インスタンス作成ガイドライン §5-4; the DEI element names and the `Japan GAAP` value from タクソノミ要素リスト sheet 1; the `-` bar from the guide. The filer, the values, the 相対年度 texts and the segment member are illustrative, and a real report has hundreds more rows. `packages/adapters/test/finance/edinetDocExamples.test.ts` packs this text as UTF-16LE with a BOM and CRLF into a ZIP and extracts it: seven annual facts (the segment row, the `-` row and the text block are skipped).

### Error response

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

<!-- example: edinet-error-not-found -->
```json
{
    "metadata":
        {
            "title": "提出された書類を把握するためのAPI",
            "status": "404",
            "message": "Not Found"
        }
}
```

Verified: spec, 2026-10-31, https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf (§3-3 ステータスコード: errors answer HTTP 200; sample A, the 404 body; §3-2-2: `application/json; charset=utf-8` on an error). Body verbatim. For a document this is "not available"; for a list a retryable `FINANCIAL_SOURCE_FAILED` with status 404.

```http
HTTP/1.1 401 Unauthorized
```

<!-- example: edinet-error-invalid-key -->
```json
{
    "StatusCode": 401,
    "message": "Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription."
}
```

Verified: unverified, 2026-10-31, no `EDINET_API_KEY` yet; the body is the spec's §3-3 sample B (its message joined from two PDF lines), but the spec states no status line for it and says API errors answer HTTP 200, so whether the gateway sends HTTP 401 or HTTP 200 with this body is not known. Verify with one request with a wrong key in `bun run test:real tests/real/equitySyncReal.spec.ts` once a key exists.

```http
HTTP/1.1 429 Too Many Requests
```

<!-- example: edinet-error-too-many-requests -->
```json
{
     "StatusCode": 429, "message": "Too Many Requests"
}
```

Verified: unverified, 2026-10-31, no `EDINET_API_KEY` yet; the body is the spec's §3-3 sample C (added in rev. 2.8, 2026.05), the status line is not in the spec (as for 401). Not provoked on purpose (the terms forbid bursts); record it if a real run meets it.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| list `$.results[*].secCode` | Exact match with the claim's `secCode` (the JPX code + `0`, `edinetSecuritiesCode`); other filers' rows are only cached | (row selection) | Not stored |
| list `docTypeCode` | `120` → `securities-report`, `130` → `amended-securities-report` | `EquityFilingResult.form` (`packages/contracts/src/equityFinancials.ts`) | [`equity_report_filing.form`](../../database/tables/equity_report_filing.md) |
| list `docID` | As is | `EquityFilingResult.sourceDocumentId` | [`equity_report_filing.source_document_id`](../../database/tables/equity_report_filing.md) |
| list `docID` | `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?{docID}` (`edinetViewerUrl`): the filing in the EDINET viewer, a link only | `EquityFilingResult.sourceUrl` | [`equity_report_filing.source_url`](../../database/tables/equity_report_filing.md) |
| list `submitDateTime` | Date part `YYYY-MM-DD` | `EquityFilingResult.filedOn` | [`equity_report_filing.filed_on`](../../database/tables/equity_report_filing.md) |
| list `submitDateTime` | `YYYY-MM-DD HH:MM` (Japan time) → `YYYY-MM-DDTHH:MM:00+09:00` | `EquityFilingResult.submittedAt` | [`equity_report_filing.submitted_at`](../../database/tables/equity_report_filing.md) |
| list `periodStart`, `periodEnd` | Valid dates, else null. A `120` row without a period end is neither downloaded nor reported. A `130` row without a period (the spec outputs one only for 有価証券報告書 and 半期報告書, §3-1-2-2 \*3) takes, in order, its original's (`parentDocID`) period from a row of the same scan, else from the claim's pending or `knownFilings` (stored periods), else, after download, its report's `jpdei_cor:CurrentFiscalYearStartDateDEI` / `…CurrentFiscalYearEndDateDEI`. One whose period cannot be determined is not reported: when deferred, its date stays unscanned; when its download answers 404, its date stays unscanned only while it was submitted fewer than 7 days (`EQUITY_PENDING_FILING_GRACE_DAYS`) before the job's date in Japan, after which the date counts as scanned and it is logged as `financial_sync_document_unreadable` with `problem` `PERIOD_UNKNOWN`; when it has no CSV it is left out; when its document is unreadable or its report states no current fiscal-year end it is logged (`problem` = the report problem or `PERIOD_UNKNOWN`). A period is never guessed | `EquityFilingResult.periodStart`, `.periodEnd` | [`equity_report_filing.period_start`](../../database/tables/equity_report_filing.md), [`equity_report_filing.period_end`](../../database/tables/equity_report_filing.md) |
| list `parentDocID` | A valid document id, else null | `EquityFilingResult.amendsSourceDocumentId` | [`equity_report_filing.amends_source_document_id`](../../database/tables/equity_report_filing.md) |
| list `csvFlag`, document answer | `csvFlag` not `"1"` or a 404 → `not-available`; download cap reached → `deferred`; CSV read → `extracted`. The API stores `pending` (deferred, or not available and first seen fewer than 7 days ago), `unavailable` (not available for longer) or `extracted` | `EquityFilingResult.factsStatus` | [`equity_report_filing.facts_status`](../../database/tables/equity_report_filing.md), [`equity_report_filing.fact_count`](../../database/tables/equity_report_filing.md) |
| list `edinetCode` of the first matching row | As is (the claim's code when this job found no row) | completion `identity.sourceCompanyId` | [`equity_company.source_company_id`](../../database/tables/equity_company.md) |
| list `filerName` of the first matching row | Trimmed; null when blank or over 200 characters | completion `identity.name` | [`equity_company.name`](../../database/tables/equity_company.md) |
| list `periodEnd` of the first matching `120` row | `MM-DD` of the date | completion `identity.fiscalYearEnd` | [`equity_company.fiscal_year_end`](../../database/tables/equity_company.md) |
| (each requested date) | Listed in full by this job (from EDINET or the cache), minus a date whose found filing was cut by the completion caps; the API keeps only dates before today in Japan time | completion `scannedDays` | [`equity_edinet_scanned_day.scanned_on`](../../database/tables/equity_edinet_scanned_day.md) |
| CSV `jpdei_cor:AccountingStandardsDEI` | `Japan GAAP` → `JGAAP`, `IFRS` → `IFRS`, `US GAAP` → `US-GAAP`, anything else → null | `EquityFilingResult.accountingStandard` | [`equity_report_filing.accounting_standard`](../../database/tables/equity_report_filing.md) |
| CSV `要素ID` | As is, only the claimed concepts | `EquityExtractedFact.concept` | [`equity_reported_fact.concept`](../../database/tables/equity_reported_fact.md); the API adds [`equity_reported_fact.metric_code`](../../database/tables/equity_reported_fact.md) from the registry (null when unmapped) |
| CSV `コンテキストID` | No suffix → `consolidated`, `_NonConsolidatedMember` → `separate`; `…Duration` → `duration`, `…Instant` → `instant` | `EquityExtractedFact.scope`, `.periodType` | [`equity_reported_fact.scope`](../../database/tables/equity_reported_fact.md), [`equity_reported_fact.period_type`](../../database/tables/equity_reported_fact.md) |
| CSV DEI fiscal-year dates, by context | `CurrentYearDuration` → current start–end, `Prior1YearDuration` → previous start–end, `CurrentYearInstant` → current end, `Prior1YearInstant` → previous end (instants have no start) | `EquityExtractedFact.periodStart`, `.periodEnd` | [`equity_reported_fact.period_start`](../../database/tables/equity_reported_fact.md) (`''` for an instant), [`equity_reported_fact.period_end`](../../database/tables/equity_reported_fact.md); the API derives [`equity_reported_fact.fiscal_year`](../../database/tables/equity_reported_fact.md) (the year the period ends in; 1–7 January → the year before) |
| CSV `ユニットID` | As is (`JPY`) | `EquityExtractedFact.unit` | [`equity_reported_fact.unit`](../../database/tables/equity_reported_fact.md) |
| CSV `値` | Kept only as canonical decimal text, in yen, sign as reported (capital expenditure is negative; the registry flips it); then the annual filter (`annualFactsOfFiling`: a duration of 350–380 days, an instant at the end of an annual duration of the same filing) and canonical order without repeats (`annualFactsInOrder`) | `EquityExtractedFact.valueDecimal` | [`equity_reported_fact.value_decimal`](../../database/tables/equity_reported_fact.md); the current value per metric and year is then selected by the API into `equity_metric_value` |

## 7. Maintenance

### Known differences between the runners

- Transport: the Rust fetcher keeps a keep-alive connection pool and resends a GET once on a fresh connection when the pooled one was closed before answering; the TypeScript fetcher opens a fresh socket per request (`agent: false`) and never resends. Both try up to 3 validated addresses (`crates/research-net/src/pinned.rs`, `crates/research-net/src/transport.rs`, `packages/adapters/src/node/pinnedConnect.ts`, `packages/adapters/src/node/index.ts`).
- Rust parses a date's list and extracts a report off the async worker (`crate::cpu::offload`) and holds a cached date's rows behind an `Arc`; the results are the same.
- The key is percent-encoded by `encodeURIComponent` in TypeScript and by its port `research_js::uri::encode_uri_component` in Rust; the output is the same.
- Shared vectors (`vectors/finance/`) replay the list parser, the download plan, the CSV parser and the source's request sequence in Rust.

### Open issues

- Every example's live shape is unverified: the owner has no `EDINET_API_KEY` yet. `edinet-xbrl-to-csv-report`, `edinet-error-invalid-key` and `edinet-error-too-many-requests` are `unverified`; the list, row and 404 examples are `spec`. Verify with `bun run test:real tests/real/equitySyncReal.spec.ts` once the key is set, replace the illustrative CSV with an excerpt of a real report (Nintendo, Tokyo Electron or Daikin), and record the status line of a wrong-key answer.
- Whether the gateway's 401/429 answers come as HTTP 200 with the `StatusCode` body or as real HTTP 401/429 is not known; both are handled (a list or document body stating 400 or more is that status).
- **Amendment periods need a live check.** Read literally, the spec (§3-1-2-2 \*3) gives `130` rows no period; the code then takes the original's period or the report's DEI current fiscal year (section 6). A live list must show whether `130` rows carry a period. Since the claim sends the stored filings' periods (`knownFilings`), an amendment of a stored or listed report always gets its original's period; one whose original is unknown and whose report states no period is dropped after the 7-day grace and logged (`PERIOD_UNKNOWN`), not looked for again.
- A document whose archive cannot be read is only logged (`financial_sync_document_unreadable`) and its filing ends `unavailable` 7 days after it was first seen: a malformed CSV EDINET later replaces is not fetched again after that.
- Changes EDINET makes to a stored filing later are not followed: a withdrawal (`withdrawalStatus` `"2"` on the original date's row after the daily update), an FSA information edit (`docInfoEditStatus`, a second row with the corrected fields on the edit's date), non-disclosure (`disclosureStatus`; the CSV of a non-disclosed document cannot be downloaded, spec §3-1-7). A date once listed is never listed again, and a stored filing's metadata is never rewritten.
- The `-` bar is skipped: the operation guide reads it as an explicit zero, the instance guideline as nil ("数値が存在しない又は端数処理以前にゼロ"). Skipping makes the cell "not reported", never 0 (ADR-0048); a report that shows `－` for a mapped line therefore has no value for it. `-0` (△0) is skipped too.
- `Content-Type` is not read; the ZIP signature decides (equivalent to the spec's advice to judge by `Content-Type`, §3-3).
- Yesterday's list read shortly after midnight Japan time may predate the daily update that finalises it (spec §3-1-3-3: the day's list is complete once the next day's file exists); the date is then recorded as scanned. Low risk: the day's list is updated about every minute while documents are submitted.
- The viewer link `WZEK0040.aspx?{docID}` is not in the API spec; it is the form of EDINET's own document links and is verified by opening one stored link.
- IFRS and US-GAAP filers on EDINET get their filings stored but no mapped values (`no-mapping-for-standard`, ADR-0048 §3); the JMIS standard reads as null.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | spec | Both endpoints' URL, parameters, response fields and flags, error bodies and statuses against EDINET API仕様書 Version 2 (2026年6月, rev. 2.9) §2-3, §3-1, §3-2, §3-3, §4-1 and 別紙2; the CSV columns and format against 書類閲覧操作ガイド 1章 3-2-1; context IDs, the bar and file names against 報告書インスタンス作成ガイドライン §4-2, §5-4, §5-6-2; DEI elements against タクソノミ要素リスト; usage terms against 利用規約. Marked examples parsed by `parseEdinetDocumentList`, `edinetFilingMetadata`, `edinetErrorStatus` and `extractEdinetReport` (`packages/adapters/test/finance/edinetDocExamples.test.ts`). No request to EDINET. | Claude (external API documents, ADR-0047) |
| 2026-10-31 | spec | Sections 4, 6 and 7 re-checked against the runners' review fixes (commit 50e5b15): gateway error bodies on a list, unreadable documents reported not available, amendment periods. | Claude |
| 2026-10-31 | spec | Section 6 re-checked against commit ef7c666: `knownFilings` with periods in the claim, 7-day bound on an undatable amendment's 404, `PERIOD_UNKNOWN`. | Claude |
