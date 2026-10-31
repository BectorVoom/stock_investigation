# External API: JPX

## 1. Overview

| Property | Value |
|---|---|
| Provider | Japan Exchange Group, Inc. (JPX), operator of the Tokyo Stock Exchange — public web pages and Excel workbooks on its website; JPX offers no API |
| Purpose | The Japanese half of the Watchlist's stock directory: the monthly "List of TSE-listed Issues" in Japanese and English ([ADR-0034](../../adr/0034-stock-directory-search.md)); and the earnings-announcement schedule that dates JP watchlist stocks ([ADR-0016](../../adr/0016-earnings-dates-and-calendar-export.md), FR-018). |
| Hosts | `www.jpx.co.jp` |
| Endpoints | `GET /markets/statistics-equities/misc/01.html` — Japanese listed-issues page, links `data_j.xlsx`; `GET /markets/statistics-equities/misc/{folder}/data_j.xlsx` — listed issues, Japanese names and sections; `GET /english/markets/statistics-equities/misc/01.html` — English listed-issues page, links `data_e.xlsx`; `GET /english/markets/statistics-equities/misc/{folder}/data_e.xlsx` — listed issues, English names; `GET /listing/event-schedules/financial-announcement/index.html` — earnings schedule page, links the schedule workbooks; `GET /listing/event-schedules/financial-announcement/{folder}/kessanMM_MMDD.xlsx` — scheduled announcement dates of companies whose quarter or year ended in month `MM` |
| Authentication | None. |
| Configuration | None. |
| Usage Limits | JPX publishes no quota. Its [terms of use](https://www.jpx.co.jp/english/term-of-use/index.html) ask users to "refrain from automatic information retrieval and other operations which may lead to high-load and/or high frequency access" and prohibit "the collection of data or secondary use of information from this website for commercial purposes" without permission. Ours: every request start takes a grant from the shared pacer window `jpx` (6 starts per 60 s, shared by the directory and earnings refreshes); requests are sequential; at most 4 requests per directory refresh and 1 + 6 per earnings refresh; the earnings page is cached 30 min and each schedule workbook by URL (section 4). |
| Called By | Rust runner (default) and TypeScript runner (rollback): `stock-directory-refresh` jobs for market `JP` (queued by "Update stock list" or by the Watchlist when the JP list is missing or older than 7 days), and `earnings-refresh` jobs for JP watchlist stocks. The API Worker and the browser never call JPX; the browser only shows the earnings page URL as attribution. |
| Code | `crates/research-finance/src/jpx.rs`, `crates/research-finance/src/jpx_directory.rs`, `crates/research-finance/src/jpx_workbook.rs`, `crates/research-finance/src/zip_reader.rs`, `crates/research-finance/src/stock_directory.rs`, `crates/research-finance/src/pacing.rs`, `crates/research-runner/src/composition.rs`, `packages/adapters/src/finance/jpxDirectory.ts`, `packages/adapters/src/finance/jpxEarnings.ts`, `packages/adapters/src/finance/jpxWorkbook.ts`, `packages/adapters/src/node/zipReader.ts`, `packages/adapters/src/finance/stockDirectory.ts`, `apps/runner/src/marketPacing.ts`, `apps/runner/src/jobExecution.ts` |
| Official Documentation | [東証上場銘柄一覧](https://www.jpx.co.jp/markets/statistics-equities/misc/01.html), [List of TSE-listed Issues](https://www.jpx.co.jp/english/markets/statistics-equities/misc/01.html), [決算発表予定日](https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html), [Terms of Use](https://www.jpx.co.jp/english/term-of-use/index.html). JPX documents the files only by these pages; the layouts below are as observed. |
| Last Verified | 2026-10-31, live (section 7) |

A JP directory refresh asks the Japanese listed-issues page for its `data_j.xlsx` link, downloads and parses that workbook, then does the same with the English page and `data_e.xlsx`; the Japanese list decides which issues are kept (Prime, Standard and Growth), the English list supplies the English names, and the result is the `stock-directory-refreshed` completion. An earnings refresh asks the schedule page for its `kessanMM_MMDD.xlsx` links (the file name carries the update date), downloads every workbook not already cached, and maps each requested code's rows inside the refresh window to earnings events. Link targets are read from the pages, never hard-coded, because the `…-att` folder can move. Workbooks are read with a bounded ZIP reader: only `xl/worksheets/sheet1.xml` and `xl/sharedStrings.xml` are inflated, and columns are located by header text.

## 2. Input Parameters

Every request goes through the runner's safe fetcher (`packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`), pinned to `www.jpx.co.jp` for the request and every redirect (at most 5). No path or query parameter is ours to choose: each URL is either a fixed page or a link read from a page. The headers are the same on every endpoint; the `Accept` value differs as stated per endpoint.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Accept` | header | string | No | We send `text/html` (pages) or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (workbooks) | Printable ASCII | What we expect; JPX serves each path in one format. |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` | Printable ASCII | The runner's fixed identification (`DEFAULT_USER_AGENT`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | JPX gzips the HTML pages; workbooks arrive as stored. |

### GET /markets/statistics-equities/misc/01.html

No parameters besides the headers above (`Accept: text/html`). URL: `JPX_LISTING_PAGE_URLS.ja` (`packages/adapters/src/finance/jpxDirectory.ts`), `JpxListingLanguage::Ja.page_url()` (`crates/research-finance/src/jpx_directory.rs`).

### GET /markets/statistics-equities/misc/{folder}/data_j.xlsx

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `{folder}` | path | string | Yes | — ; read from the Japanese page | `[A-Za-z0-9_-]+` (observed `tvdivq0000001vg2-att`) | The first `<a href>` on the page that resolves to `https://www.jpx.co.jp` with path `^/markets/statistics-equities/misc/[A-Za-z0-9_-]+/data_j\.xlsx$`; query and fragment are dropped. |

### GET /english/markets/statistics-equities/misc/01.html

No parameters besides the headers above (`Accept: text/html`). URL: `JPX_LISTING_PAGE_URLS.en`, `JpxListingLanguage::En.page_url()`. Asked only after the Japanese workbook parsed.

### GET /english/markets/statistics-equities/misc/{folder}/data_e.xlsx

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `{folder}` | path | string | Yes | — ; read from the English page | `[A-Za-z0-9_-]+` | The first link with path `^/english/markets/statistics-equities/misc/[A-Za-z0-9_-]+/data_e\.xlsx$`. |

### GET /listing/event-schedules/financial-announcement/index.html

No parameters besides the headers above (`Accept: text/html`). URL: `JPX_INDEX_URL` (`packages/adapters/src/finance/jpxEarnings.ts`, `crates/research-finance/src/jpx.rs`).

### GET /listing/event-schedules/financial-announcement/{folder}/kessanMM_MMDD.xlsx

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `{folder}` | path | string | Yes | — ; read from the schedule page | `[A-Za-z0-9_-]+` (observed `tvdivq0000001ofb-att`) | Every link (document order, de-duplicated, at most 6) whose path matches `^/listing/event-schedules/financial-announcement/[A-Za-z0-9_-]+/kessan[0-9]{2}_[0-9]{4}\.xlsx$`. |
| `MM` | path | string | Yes | — | 2 digits | The month in which the listed companies' quarter or fiscal year ended. |
| `MMDD` | path | string | Yes | — | 4 digits | JPX's update date of the file; a new update is a new URL. The page's next-day list `kessan.xlsx` does not match and is not read. |

## 3. Output Parameters

### GET /markets/statistics-equities/misc/01.html

`text/html` (UTF-8, gzip), about 30 kB; read up to 1,000,000 bytes.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `<a href>` | attribute | No | No | Yes | Every `<a … href=…>` in document order (double-, single- or unquoted values); resolved against the page URL. The first that matches the `data_j.xlsx` shape is the workbook. None matching is `DIRECTORY_PARSE_FAILED`. |
| `<th>` beside the link | text | No | No | No | The list's month, e.g. `東証上場銘柄一覧（2026年9月末）`. |
| All other markup | HTML | — | — | No | Navigation, notes, other files. |

### GET /markets/statistics-equities/misc/{folder}/data_j.xlsx

Office Open XML workbook (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`), about 266 kB; capped at 4,194,304 bytes, each inflated entry at 16,777,216. One sheet (`Sheet1`), header in row 1, one row per issue (4,447 data rows on 2026-10-31). The header row is the first row naming all four read headers; a data row whose code is not a JP code (`[0-9][0-9A-Z]{3}`) is skipped.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `A` `日付` | number | No | No | Yes | List date as the number `YYYYMMDD` (`20260930`), not an Excel serial. |
| `B` `コード` | number or string | No | No | Yes | Securities code: numeric (`7203`) or shared string (`130A`). Upper-cased. |
| `C` `銘柄名` | string | No | No | Yes | Japanese issue name (full-width characters as JPX writes them). |
| `D` `市場・商品区分` | string | No | No | Yes | Market section: `プライム（内国株式）`, `プライム（外国株式）`, `スタンダード（内国株式）`, `スタンダード（外国株式）`, `グロース（内国株式）`, `グロース（外国株式）` are kept; `ETF・ETN`, `PRO Market`, `REIT・ベンチャーファンド・カントリーファンド・インフラファンド`, `出資証券` and anything else are dropped. |
| `E` `33業種コード`, `F` `33業種区分` | number / string | No | No | No | 33-sector code and name (`-` for funds). |
| `G` `17業種コード`, `H` `17業種区分` | number / string | No | No | No | 17-sector code and name. |
| `I` `規模コード`, `J` `規模区分` | number / string | No | No | No | TOPIX size code and name. |

### GET /english/markets/statistics-equities/misc/01.html

`text/html`, as the Japanese page.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `<a href>` | attribute | No | No | Yes | The first link matching the `data_e.xlsx` shape. The page also links `jyoujyou(updated)_e.xlsx` (updated issues), which does not match. |
| All other markup | HTML | — | — | No | |

### GET /english/markets/statistics-equities/misc/{folder}/data_e.xlsx

Same container, caps and layout as `data_j.xlsx` (4,447 data rows on 2026-10-31), English headers.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `A` `Effective Date` | number | No | No | Yes | `YYYYMMDD`; read to locate the header, not used (the Japanese list's date is the list date). |
| `B` `Local Code` | number or string | No | No | Yes | The join key with the Japanese list. |
| `C` `Name (English)` | string | No | No | Yes | English issue name; the first row of a code wins. |
| `D` `Section/Products` | string | No | No | Yes | Read to locate the header, not used for selection (`Prime Market (Domestic)`, `Growth Market(Domestic)`, `ETFs/ ETNs`, …). |
| `E` `33 Sector(Code)`, `F` `33 Sector(name)`, `G` `17 Sector(Code)`, `H` `17 Sector(name)`, `I` `Size Code (New Index Series)`, `J` `Size (New Index Series)` | number / string | No | No | No | Sector and size classifications. |

### GET /listing/event-schedules/financial-announcement/index.html

`text/html` (UTF-8, gzip), about 27 kB; read up to 1,000,000 bytes.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `<a href>` | attribute | No | No | Yes | Links matching the `kessanMM_MMDD.xlsx` shape, in document order, at most 6 (two were listed on 2026-10-31: months 08 and 09). No matching link means no workbook and every requested stock `NO_SCHEDULED_DATE`. |
| `<th>` beside each link | text | No | No | No | Bilingual description and "as of" date of each file. |
| All other markup | HTML | — | — | No | Including the next-day list `kessan.xlsx`. |

### GET /listing/event-schedules/financial-announcement/{folder}/kessanMM_MMDD.xlsx

Office Open XML workbook, about 240 kB; same caps as above. One sheet (`List`): rows 1–4 are titles (Japanese and English title, "as of" date), row 5 is the header, data from row 6 (2,961 readable data rows in `kessan09_1030.xlsx`). Header cells are matched on whole lines of their text, so `決算発表予定日\r\nScheduled Dates for Earnings Announcements` matches `Scheduled Dates for Earnings Announcements`; a `日本語 / English` form is accepted too. A missing header fails the workbook.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `A` `決算発表予定日` / `Scheduled Dates for Earnings Announcements` | number or string | No | No | Yes | Announcement date as an Excel serial (`46331`), or the text `未定_Undecided`. |
| `B` `コード` / `Code` | number or string | No | No | Yes | Securities code (`7203`, `254A`). |
| `C` `会社名` | string | No | No | No | Japanese company name. |
| `D` `Issue Name` | string | No | No | Yes | English company name (may carry trailing spaces; trimmed). |
| `E` `決算期末` / `Fiscal Year-end` | number | No | No | Yes | Fiscal year-end as an Excel serial. |
| `F` `業種名`, `G` `Industry` | string | No | No | No | Industry in Japanese and English. |
| `H` `種別` | string | No | No | No | Period kind in Japanese (`第２四半期`). |
| `I` `Fiscal Year/Quarter` | string | No | No | Yes | Period kind in English (`Second quarter`), 1–80 characters. |
| `J` `市場区分`, `K` `Market Segment` | string | No | No | No | Market segment in Japanese and English. |

## 4. Error Handling

### HTTP status codes

JPX's status travels unchanged as `upstreamStatus` beside our code ([§4a](../../rule/error_handling.md)); the error body is never read.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200 | Page or workbook served | Parsed (section 3) | — |
| 301, 302, 303, 307, 308 | Redirect | Followed up to 5 hops on `www.jpx.co.jp` only; another host fails the fetch | Directory `DIRECTORY_SOURCE_FAILED`; earnings `SOURCE_FAILED` |
| 404 | File or page not found (a workbook moved after the page was read) | Stops the refresh | Directory `DIRECTORY_SOURCE_FAILED`; earnings `SOURCE_FAILED` for every requested JP stock |
| 429 | Rate limit (never observed) | Stops the refresh | Directory `DIRECTORY_RATE_LIMITED`; earnings `SOURCE_FAILED` |
| Other non-2xx, 5xx | Refusal or server failure | Stops the refresh | Directory `DIRECTORY_SOURCE_FAILED`; earnings `SOURCE_FAILED` |
| — (no answer) | Timeout, network error, stopped job | Stops, `upstreamStatus` null | Directory `DIRECTORY_SOURCE_FAILED`; earnings `SOURCE_FAILED` |

Our own failures, with no JPX status: no matching workbook link on a listed-issues page, a workbook that is not a readable ZIP or lacks the two entries, missing headers, a bound exceeded (20,000 data rows, 100,000 shared strings, 1,000,000 cells), or fewer than 1,000 / more than 10,000 kept issues → directory `DIRECTORY_PARSE_FAILED`. For the earnings schedule a workbook that does not parse (including a header followed by data rows of which none parses) → `SOURCE_FAILED` for every requested JP stock; a code in no workbook, or with no dated row inside the window, → `NO_SCHEDULED_DATE` (which may still carry the company name). Rows that fail a row check (bad code, date, label, period key) are skipped.

### Provider error codes and body

None: JPX answers errors with plain HTTP statuses and an HTML "ページが見つかりません" page, which the code never reads.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | Pages: 30 s, 1,000,000 bytes. Workbooks: 60 s, 4,194,304 bytes; each inflated ZIP entry at most 16,777,216 bytes. | `packages/adapters/src/finance/jpxDirectory.ts`, `packages/adapters/src/finance/jpxEarnings.ts`, `packages/adapters/src/node/zipReader.ts`, `crates/research-finance/src/zip_reader.rs` |
| Retries | Source: none. Transport: a request that fails before any answer (connection refused, unreachable address family) is tried on the next validated DNS address, at most 3 addresses (`MAX_CONNECT_ATTEMPTS`, both runners). Rust only: a GET sent on an idle keep-alive connection that the server closed before answering is sent once more on a fresh connection. Job: a `stock-directory-refresh` job has at most 3 attempts (`MAX_JOB_ATTEMPTS`); the runner marks only `DIRECTORY_SOURCE_FAILED` retryable, and the API re-queues it while attempts remain; a rate limit or parse failure is not retried. An earnings refresh is not retried for a JPX failure: the failure is stored per stock in a completed job. | `crates/research-net/src/transport.rs`, `crates/research-net/src/pinned.rs`, `packages/adapters/src/node/index.ts`, `packages/application/src/stockDirectory.ts`, `packages/application/src/researchRuns.ts`, `packages/application/src/runnerJobs.ts`, `apps/runner/src/jobExecution.ts`, `crates/research-runner/src/job_execution.rs` |
| Rate limit | Each request start first takes a grant from the pacer window `jpx` (6 per 60,000 ms), shared by directory and earnings refreshes; a refused grant (job stopped) sends nothing more. Requests are sequential; the Japanese workbook is parsed before the English page is asked for, so a broken list costs 2 requests, not 4. No response header is read. | `apps/runner/src/marketPacing.ts`, `crates/research-finance/src/pacing.rs` |
| Cache | Earnings: the schedule page for 30 min, and each parsed workbook by URL for as long as the page lists that URL; cache reads take no grant. Rust holds the cache lock across the downloads, so concurrent refreshes queue. The listed-issues pages and workbooks are never cached; the stored directory is replaced on each successful refresh. | `packages/adapters/src/finance/jpxEarnings.ts`, `crates/research-finance/src/jpx.rs` |
| Fallback | None. The Watchlist keeps the stored JP list and shows the failure code; JP stocks keep their stored earnings dates with the failure code and JPX's status. | `apps/runner/src/jobExecution.ts` |

## 5. Examples

All captured on 2026-10-31 with `curl -A "stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)" -H "Accept: <type>" -H "Accept-Encoding: gzip" --compressed` (the runner's headers), nine requests 4–5 s apart; curl and both runners speak HTTP/1.1, so the status lines are as captured. A workbook response body is the binary file; its decoded cells follow it in a separate block (`readWorkbookRows` in `packages/adapters/src/finance/jpxWorkbook.ts`). The captured workbooks are not in the repository (JPX's terms); the tests rebuild a workbook from the documented cells.

### GET /markets/statistics-equities/misc/01.html

Request:

```http
GET /markets/statistics-equities/misc/01.html HTTP/1.1
Host: www.jpx.co.jp
Accept: text/html
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, `curl` (headers as above).

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Encoding: gzip
Last-Modified: Mon, 05 Oct 2026 10:02:27 GMT
```

<!-- example: jpx-listing-page-ja -->
```html
<!-- … -->
<title>東証上場銘柄一覧 | 日本取引所グループ</title>
<!-- … -->
    <div><p class="component-text">直近月末の東証上場銘柄一覧を掲載しています。</p></div>
    
    <div>
      
<div class="component-file">
  <table width="50%">
    <tr>
          <th width="90%">東証上場銘柄一覧（2026年9月末）</th>
          
                <td width="10%"><a href="/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx" rel="external"><img src="/common/images/icon/icon-xls.png" alt="Excel" title="Excel" width="18" height="18" /></a></td>
              </tr>
  </table>
</div>
<!-- … -->
```

Verified: live, 2026-10-31, `curl`. Lines 29 and 457–469 of the 30,077-byte page kept verbatim; the rest omitted (`<!-- … -->`); other headers omitted.

### GET /markets/statistics-equities/misc/{folder}/data_j.xlsx

Request:

```http
GET /markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx HTTP/1.1
Host: www.jpx.co.jp
Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, `curl`; the URL is the link read from the page above.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Length: 266304
Last-Modified: Mon, 05 Oct 2026 00:00:30 GMT
```

```text
<binary XLSX (Office Open XML ZIP), 266304 bytes>
```

Verified: live, 2026-10-31, `curl`. The body is the workbook file itself; it is not reproduced (JPX's copyright, section 7).

**Decoded workbook contents** — the cells `readWorkbookRows` reads from `data_j.xlsx` (`xl/worksheets/sheet1.xml` with `xl/sharedStrings.xml` resolved), one line per cell as `<cell reference>: <cell text as a JSON string>`:

<!-- example: jpx-listed-issues-ja -->
```text
A1: "日付"
B1: "コード"
C1: "銘柄名"
D1: "市場・商品区分"
E1: "33業種コード"
F1: "33業種区分"
G1: "17業種コード"
H1: "17業種区分"
I1: "規模コード"
J1: "規模区分"
…
A7: "20260930"
B7: "130A"
C7: "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ"
D7: "グロース（内国株式）"
E7: "3250"
F7: "医薬品"
G7: "5"
H7: "医薬品"
I7: "-"
J7: "-"
…
A3276: "20260930"
B3276: "7203"
C3276: "トヨタ自動車"
D3276: "プライム（内国株式）"
E3276: "3700"
F3276: "輸送用機器"
G3276: "6"
H3276: "自動車・輸送機"
I3276: "1"
J3276: "TOPIX Core30"
…
```

Verified: live, 2026-10-31, `curl` capture decoded with `readWorkbookRows`. Sheet rows 1, 7 and 3276 of 4,448 kept (other rows omitted, `…`); numbers shown as their stored text.

### GET /english/markets/statistics-equities/misc/01.html

Request:

```http
GET /english/markets/statistics-equities/misc/01.html HTTP/1.1
Host: www.jpx.co.jp
Accept: text/html
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, `curl`.

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Encoding: gzip
Last-Modified: Mon, 05 Oct 2026 09:38:57 GMT
```

<!-- example: jpx-listing-page-en -->
```html
<!-- … -->
<title>List of TSE-listed Issues | Japan Exchange Group</title>
<!-- … -->
    <div><p class="component-text">List of TSE-listed Issues as of previous month-end is available.</p></div>
    
    <div>
      
<div class="component-file">
  <table width="50%">
    <tr>
          <th width="90%">List of TSE-listed Issues (Sep. 2026)</th>
          
                <td width="10%"><a href="/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx" rel="external"><img src="/english/common/images/icon/icon-xls.png" alt="icon-xls" title="icon-xls" width="18" height="18" /></a></td>
              </tr>
  </table>
</div>
<!-- … -->
<div class="component-file">
  <table width="50%">
    <tr>
          <th width="90%">List of updated issues</th>
          
                <td width="10%"><a href="/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/jyoujyou(updated)_e.xlsx" rel="external"><img src="/english/common/images/icon/icon-xls.png" alt="icon-xls" title="icon-xls" width="18" height="18" /></a></td>
              </tr>
  </table>
</div>
<!-- … -->
```

Verified: live, 2026-10-31, `curl`. Lines 29, 457–469 and 521–529 of the 29,950-byte page kept verbatim; the rest omitted (`<!-- … -->`); other headers omitted.

### GET /english/markets/statistics-equities/misc/{folder}/data_e.xlsx

Request:

```http
GET /english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx HTTP/1.1
Host: www.jpx.co.jp
Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, `curl`; the URL is the link read from the page above.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Length: 263525
Last-Modified: Mon, 05 Oct 2026 00:00:30 GMT
```

```text
<binary XLSX (Office Open XML ZIP), 263525 bytes>
```

Verified: live, 2026-10-31, `curl`. The body is the workbook file itself; it is not reproduced (JPX's copyright, section 7).

**Decoded workbook contents** — the cells `readWorkbookRows` reads from `data_e.xlsx` (`xl/worksheets/sheet1.xml` with `xl/sharedStrings.xml` resolved), one line per cell as `<cell reference>: <cell text as a JSON string>`:

<!-- example: jpx-listed-issues-en -->
```text
A1: "Effective Date"
B1: "Local Code"
C1: "Name (English)"
D1: "Section/Products"
E1: "33 Sector(Code)"
F1: "33 Sector(name)"
G1: "17 Sector(Code)"
H1: "17 Sector(name)"
I1: "Size Code (New Index Series)"
J1: "Size (New Index Series)"
…
A7: "20260930"
B7: "130A"
C7: "Veritas In Silico Inc."
D7: "Growth Market(Domestic)"
E7: "3250"
F7: "Pharmaceutical"
G7: "5"
H7: "PHARMACEUTICAL"
I7: "-"
J7: "-"
…
A3276: "20260930"
B3276: "7203"
C3276: "TOYOTA MOTOR CORPORATION"
D3276: "Prime Market (Domestic)"
E3276: "3700"
F3276: "Transportation Equipment"
G3276: "6"
H3276: "AUTOMOBILES & TRANSPORTATION EQUIPMENT"
I3276: "1"
J3276: "TOPIX Core30"
…
```

Verified: live, 2026-10-31, `curl` capture decoded with `readWorkbookRows`. Sheet rows 1, 7 and 3276 of 4,448 kept (other rows omitted, `…`); numbers shown as their stored text.

### GET /listing/event-schedules/financial-announcement/index.html

Request:

```http
GET /listing/event-schedules/financial-announcement/index.html HTTP/1.1
Host: www.jpx.co.jp
Accept: text/html
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, `curl`.

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Encoding: gzip
Last-Modified: Fri, 30 Oct 2026 07:32:58 GMT
```

<!-- example: jpx-earnings-index -->
```html
<!-- … -->
<title>決算発表予定日 | 日本取引所グループ</title>
<!-- … -->
    <div><h2 class="heading-title-mu" id="heading_0"><span>決算の発表予定会社一覧</span></h2></div>
          
    <div>
      
<div class="component-file">
  <table width="50%">
    
          <tr>
            <th width="90%">2027年3月期第2四半期・2026年9月期本決算（2026年11月2日開示予定分）<br/>
Q2 earnings results for the fiscal year ending in March 2027 or earnings results for fiscal year ending in September 2026 (Scheduled to be disclosed on 2026/11/2)</th>
            
                  <td width="10%"><a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan.xlsx" rel="external"><img src="/common/images/icon/icon-xls.png" alt="Excel" title="Excel" width="18" height="18" /></a></td>
                
          </tr>
        
  </table>
</div>
<!-- … -->
<div class="component-file">
  <table width="50%">
    
          <tr>
            <th width="90%">2026年8月に四半期末又は期末を迎えた会社（2026年10月1日時点）<br/>
Companies whose end of quarters or fiscal years in August 2026 (as of 2026/10/1)</th>
            
                  <td width="10%"><a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan08_1002.xlsx" rel="external"><img src="/common/images/icon/icon-xls.png" alt="Excel" title="Excel" width="18" height="18" /></a></td>
                
          </tr>
        
          <tr>
            <th width="90%">2026年9月に四半期末又は期末を迎えた会社（2026年10月29日時点）<br/>
Companies whose end of quarters or fiscal years in September 2026 (as of 2026/10/29)</th>
            
                  <td width="10%"><a href="/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1030.xlsx" rel="external"><img src="/common/images/icon/icon-xls.png" alt="Excel" title="Excel" width="18" height="18" /></a></td>
                
          </tr>
        
  </table>
</div>
<!-- … -->
```

Verified: live, 2026-10-31, `curl`. Lines 29, 379–395 and 416–436 of the 26,974-byte page kept verbatim; the rest omitted (`<!-- … -->`); other headers omitted.

### GET /listing/event-schedules/financial-announcement/{folder}/kessanMM_MMDD.xlsx

Request:

```http
GET /listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1030.xlsx HTTP/1.1
Host: www.jpx.co.jp
Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
```

Verified: live, 2026-10-31, `curl`; the URL is a link read from the page above.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Length: 239251
Last-Modified: Fri, 30 Oct 2026 06:00:20 GMT
```

```text
<binary XLSX (Office Open XML ZIP), 239251 bytes>
```

Verified: live, 2026-10-31, `curl`. The body is the workbook file itself; it is not reproduced (JPX's copyright, section 7).

**Decoded workbook contents** — the cells `readWorkbookRows` reads from `kessan09_1030.xlsx` (`xl/worksheets/sheet1.xml` with `xl/sharedStrings.xml` resolved), one line per cell as `<cell reference>: <cell text as a JSON string>`:

<!-- example: jpx-earnings-schedule -->
```text
A1: "９月に四半期末又は期末を迎えた決算発表予定会社の一覧"
…
A2: "List of companies scheduled to announce earnings whose end of quarters or fiscal years in September"
…
A3: "2026年10月29日 現在"
…
A4: "As of 2026/10/29"
…
A5: "決算発表予定日\r\nScheduled Dates for Earnings Announcements"
B5: "コード\r\nCode"
C5: "会社名"
D5: "Issue Name"
E5: "決算期末\r\nFiscal Year-end"
F5: "業種名"
G5: "Industry"
H5: "種別"
I5: "Fiscal Year/Quarter"
J5: "市場区分"
K5: "Market Segment"
…
A715: "46331"
B715: "7203"
C715: "トヨタ自動車"
D715: "TOYOTA MOTOR CORPORATION"
E715: "46477"
F715: "輸送用機器"
G715: "Transportation Equipment"
H715: "第２四半期"
I715: "Second quarter"
J715: "プライム"
K715: "Prime"
…
A2946: "未定_Undecided"
B2946: "254A"
C2946: "ＡＩフュージョンキャピタルグループ"
D2946: "AI FUSION CAPITAL GROUP CORP."
E2946: "46477"
F2946: "証券、商品先物取引業"
G2946: "Securities & Commodity Futures"
H2946: "第２四半期"
I2946: "Second quarter"
J2946: "スタンダード"
K2946: "Standard"
…
```

Verified: live, 2026-10-31, `curl` capture decoded with `readWorkbookRows`. Sheet rows 1–5, 715 and 2946 of 2,974 kept; the empty styled cells `B1`–`K4` and all other rows omitted (`…`); numbers shown as their stored text.

### Error response

```http
HTTP/1.1 404 Not Found
Content-Type: text/html
Content-Length: 21245
```

```html
<!-- … -->
<title>ページが見つかりません | 日本取引所グループ</title>
<!-- … -->
```

Verified: live, 2026-10-31, `curl` of `/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_x.xlsx` (a file that does not exist). Line 29 of the 21,245-byte page kept; the code reads only the status.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `data_j.xlsx` `コード` | Trimmed, upper-cased; kept when `jp:<code>` is a valid stock id; the first row of a code wins | `StockDirectoryEntry.symbol` (`packages/contracts/src/stockDirectory.ts`) | [`stock_directory.symbol`](../../database/tables/stock_directory.md) |
| `data_j.xlsx` `市場・商品区分` | Exact text: `プライム（…）` → `tse-prime`, `スタンダード（…）` → `tse-standard`, `グロース（…）` → `tse-growth` (domestic and foreign); other sections drop the row | `StockDirectoryEntry.listing` | [`stock_directory.listing`](../../database/tables/stock_directory.md) |
| `data_e.xlsx` `Name (English)`, joined on `Local Code` | Trimmed; when missing or not 1–200 UTF-16 units, the Japanese name; when neither fits, the row is dropped and counted | `StockDirectoryEntry.name` | [`stock_directory.name`](../../database/tables/stock_directory.md) |
| `data_j.xlsx` `銘柄名` | Trimmed; when not 1–200 units, the English name | `StockDirectoryEntry.localName` | [`stock_directory.local_name`](../../database/tables/stock_directory.md) |
| `data_j.xlsx` `日付` | `YYYYMMDD` → `YYYY-MM-DD` when every kept row states the same valid date, else null | `StockDirectoryData.asOf` | [`stock_directory_meta.as_of`](../../database/tables/stock_directory_meta.md) |
| (download) | The runner's clock when the refresh started | completion `fetchedAt` | [`stock_directory_meta.retrieved_at`](../../database/tables/stock_directory_meta.md) |
| `kessanMM_MMDD.xlsx` `Code` | Trimmed, upper-cased; must match `[0-9][0-9A-Z]{3}`; matched to the watchlist stock's symbol | (the stock `jp:<code>`) | [`earnings_events.stock_id`](../../database/tables/earnings_events.md) |
| `Scheduled Dates for Earnings Announcements` | Excel serial → `YYYY-MM-DD` (`46331` → `2026-11-05`); `未定_Undecided` → null; dated rows outside `[fromDate, toDate]` (today to today + 185 days) are dropped; undecided rows are kept | `EarningsEvent.announcementDate` (`packages/contracts/src/watchlist.ts`) | [`earnings_events.announcement_date`](../../database/tables/earnings_events.md) |
| `Fiscal Year-end` | Excel serial → `YYYY-MM-DD` | `EarningsEvent.fiscalPeriodEnd` | [`earnings_events.fiscal_period_end`](../../database/tables/earnings_events.md) |
| `Fiscal Year/Quarter` | Trimmed, 1–80 characters | `EarningsEvent.fiscalPeriodLabel` | [`earnings_events.fiscal_period_label`](../../database/tables/earnings_events.md) |
| `Fiscal Year-end` + `Fiscal Year/Quarter` | `fy<end>-<slug of label>` (`fy2027-03-31-second-quarter`), must match `[a-z0-9-]{1,48}` | `EarningsEvent.periodKey` | [`earnings_events.period_key`](../../database/tables/earnings_events.md) |
| (none) | JPX states no time of day | `EarningsEvent.timing` = `unknown` | [`earnings_events.timing`](../../database/tables/earnings_events.md) |
| `Issue Name` | Trimmed; the first non-empty name of the code's rows; dropped when over 200 UTF-16 units; sent with events only when the stock needs a name, and always with `NO_SCHEDULED_DATE` | `EarningsData.name` | [`watchlist_stocks.name`](../../database/tables/watchlist_stocks.md) |
| (fixed) | `EARNINGS_SOURCE_INFO.jpx` | publisher `Japan Exchange Group (JPX)`, source URL of the schedule page | [`earnings_sources.publisher`, `earnings_sources.source_url`](../../database/tables/earnings_sources.md) |

At most 8 events per stock are kept, dated ones first in date order, undecided ones last.

## 7. Maintenance

### Known differences between the runners

- Transport: the Rust fetcher keeps a keep-alive connection pool (an address with an idle connection is tried first) and resends a GET once on a fresh connection when the pooled one was closed before answering; the TypeScript fetcher opens a fresh socket per request (`agent: false`) and never resends. Both try up to 3 validated addresses (`crates/research-net/src/pinned.rs`, `crates/research-net/src/transport.rs`, `packages/adapters/src/node/pinnedConnect.ts`, `packages/adapters/src/node/index.ts`).
- The Rust earnings source holds its cache lock across the page and workbook downloads, so two concurrent earnings refreshes queue behind each other (recorded in `crates/research-finance/src/jpx.rs`); the TypeScript source has no lock, so two concurrent calls could each download a workbook that is not cached yet. Both send their requests one after another within a call.
- Rust decodes workbook XML with `String::from_utf8_lossy` and strips a leading BOM; TypeScript's `TextDecoder("utf-8")` does the same.

### Open issues

- JPX documents neither the workbook layouts nor the link shapes; both are as observed on 2026-10-31 and fail closed when they change (`DIRECTORY_PARSE_FAILED`, `SOURCE_FAILED`).
- The decoded workbook contents are checked by rebuilding a real `.xlsx` from the documented cells (shared strings for text, numbers as numbers, like JPX's file) with `packages/adapters/test/zipTestUtils.ts` and parsing its bytes with `parseJpxListingWorkbook` and the whole earnings source (`packages/adapters/test/finance/jpxDocExamples.test.ts`). The captured workbooks themselves are not committed (JPX's terms), so the rebuilt file holds only the documented rows and not JPX's exact styles or ZIP layout.
- The next-day list `kessan.xlsx` ("scheduled to be disclosed on" the next business day) is not read; its rows also appear in the monthly `kessanMM_MMDD.xlsx` files.
- JPX's terms prohibit collecting data for commercial purposes without permission; this single-owner workspace uses the files for the owner's own research only.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-13 | live | Earnings schedule page links and workbook layout (`earningsLive.test.ts`) | Earnings implementation (ADR-0016) |
| 2026-10-24 | live | Listed-issues pages, `data_j.xlsx` / `data_e.xlsx` layout, 3,707 kept issues | Directory implementation (ADR-0034) |
| 2026-10-31 | live | All six endpoints (3 pages, 3 workbooks) and one 404; link discovery by `extractJpxListingUrl` / `extractJpxWorkbookUrls` on the captured pages; the captured workbooks through `parseJpxListingWorkbook` (4,440 issues per language, 3,700 kept, `asOf` 2026-09-30) and `parseJpxWorkbook` (2,961 rows, 21 undecided); terms of use | Claude (external API documents, ADR-0047) |
