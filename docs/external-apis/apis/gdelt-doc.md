# External API: GDELT DOC 2.0

## 1. Overview

| Property | Value |
|---|---|
| Provider | The GDELT Project |
| Purpose | The `news.search` research tool: the agent searches recent worldwide news coverage for short keywords and gets headlines and URLs as evidence, then reads promising articles with `web.fetch_page` ([ADR-0025](../../adr/0025-web-search-research-tool.md)). Answers are reused for 15 minutes and GDELT's rate-limit notice pauses the tool ([ADR-0039](../../adr/0039-fewer-external-requests.md)). |
| Hosts | `api.gdeltproject.org` |
| Endpoints | `GET /api/v2/doc/doc` — a list of news articles matching a query (`mode=artlist`) |
| Authentication | None. |
| Configuration | The run's request must say `webAccess: "public-web"` (Settings → AI agent); otherwise the tool is not advertised to the model. |
| Usage Limits | GDELT publishes no quota on the DOC API page; its rate-limit answer asks to "limit requests to one every 5 seconds" (section 5). Ours: request starts at least 5 s apart within the runner process (`GDELT_SPACING_MS`), one request per tool call (tool timeout 40 s, covering the wait), `maxrecords=10`; a successful answer is cached 15 minutes per normalised query (at most 200 answers); an outage pauses all GDELT searches 60 s, doubling per consecutive outage up to 30 minutes. |
| Called By | Rust runner (default) and TypeScript runner (rollback): the `news.search` tool inside `research` jobs (and Notebook assistant turns that use research tools). Always registered; needs no key. |
| Code | `crates/research-tools/src/search.rs`, `crates/research-tools/src/catalogue.rs`, `crates/research-tools/src/shared.rs`, `crates/research-net/src/core.rs`, `crates/research-net/src/pinned.rs`, `packages/adapters/src/tools/searchTools.ts`, `packages/adapters/src/tools/index.ts`, `packages/adapters/src/tools/shared.ts`, `packages/adapters/src/worker/safeFetchCore.ts`, `packages/adapters/src/node/pinnedConnect.ts` |
| Official Documentation | [GDELT DOC 2.0 API debuts](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) (the API's reference) |
| Last Verified | 2026-10-31, live (section 7) |

When the model calls `news.search` with `{ "query": "<2–200 characters>" }`, the tool first refuses a query with a keyword shorter than 3 characters (GDELT would refuse it, section 2) without sending anything, then looks for a fresh cached answer for the same normalised query (trimmed, whitespace runs collapsed, lower-cased). On a miss, unless GDELT is paused after an outage, it waits for its 5-second slot and sends one `GET /api/v2/doc/doc` through the runner's safe fetcher, pinned to `api.gdeltproject.org`, restricted to English-language coverage, the 10 most relevant articles of GDELT's default window (the last 3 months). Each article with a public `https` URL becomes one evidence item (one per distinct URL): the headline is the whole retrieved text, the article's domain names the publisher, and GDELT's "seen" time dates it. Nothing is stored as a quote (`excerpt` null, DATA-010).

## 2. Input Parameters

### GET /api/v2/doc/doc

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `query` | query | string | Yes | — ; we send `<model query> sourcelang:english`, percent-encoded with `encodeURIComponent` | Model query 2–200 characters after trimming (tool argument schema), and every keyword at least 3 characters (our check, below). | Keywords plus the `sourcelang:english` operator (English-language coverage only). |
| `mode` | query | string | No | GDELT: `artlist`; we send `artlist` | `artlist`, `timelinevol`, `tonechart`, … | A plain list of matching articles. |
| `format` | query | string | No | GDELT: `html`; we send `json` | `html`, `csv`, `rss`, `json`, … | UTF-8 JSON output. |
| `maxrecords` | query | integer | No | GDELT: `75`; we send `10` | 1–250 | Most articles returned. |
| `sort` | query | string | No | GDELT: relevance (`hybridrel` for content after 2018-09-16); we send `hybridrel` | `datedesc`, `dateasc`, `tonedesc`, `toneasc`, `hybridrel` | GDELT's relevance ranking. |
| `Accept` | header | string | No | We send `application/json` | Printable ASCII | GDELT ignores it; the format comes from `format`. |
| `User-Agent` | header | string | No | We send `research-workspace/1.0 (personal research tool)` | Printable ASCII, ≤ 300 characters | Names the product (`SEARCH_USER_AGENT`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | Encoded bytes are counted against the size cap. |

No time window (`timespan`, `startdatetime`) is sent, so GDELT searches its default: the last 3 months.

Keyword length: GDELT answers a query containing a keyword it deems too short with a plain-text refusal (section 5) and documents no minimum. Live on 2026-10-31 `ai` (2 characters) was refused and `fed` (3) answered, so the minimum is 3 characters. Before any request (and before the cache and the 5 s slot) the tool refuses a query in which a keyword has fewer than 3 characters (Unicode code points) with `QUERY_KEYWORD_TOO_SHORT` (`shortGdeltKeyword` / `short_gdelt_keyword`). Keywords are the whitespace-separated words outside double-quoted phrases, without a leading `-` / `(` or a trailing `)`; a word containing `:` (an operator such as `sourcecountry:us`), the `OR` connective and a word of ASCII punctuation only (`&`) are not keywords. Short words inside quoted phrases and non-ASCII keywords were not tested live: phrases are left to GDELT, and a non-ASCII keyword is counted in code points like any other (`日銀` is refused).

## 3. Output Parameters

### GET /api/v2/doc/doc

A success is `application/json; charset=utf-8`, one object. GDELT's reference does not list the `artlist` JSON fields ("the specific fields varies by output mode"); the table lists every field observed live on 2026-10-31. A capture cannot show that a field is always present or never `null`, so those columns say "Unknown" for the article fields; other fields GDELT may add are ignored. Validated with `gdeltResponseSchema` (TypeScript) and `gdelt_hits` (Rust): `articles` may be absent; per article `url` and `title` must be strings and `seendate` / `domain` strings or absent (a `null` there fails the call with `unexpected response shape`).

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.articles` | array | No | Yes | Yes | Matching articles in `sort` order. Absent means no results (the code's reading; an empty answer was not observed live). |
| `$.articles[].url` | string | Unknown (never `null` live) | Unknown (observed present live; required by both parsers — absence fails the call) | Yes | Article URL. A URL that fails the fetch policy (not `https`, private host, …) drops the article; a repeated URL is kept once. |
| `$.articles[].url_mobile` | string | Unknown (never `null` live) | Unknown (observed present live) | No | Mobile (AMP) URL, or `""`. |
| `$.articles[].title` | string | Unknown (never `null` live) | Unknown (observed present live; required by both parsers — absence fails the call) | Yes | Headline as GDELT extracted it (punctuation often space-separated: `gold : October 16 , 2026`). Trimmed; an empty title drops the article. |
| `$.articles[].seendate` | string | Unknown (never `null` live) | Unknown (observed present live; both parsers accept absence) | Yes | When GDELT first saw the article, `YYYYMMDDTHHMMSSZ` (UTC). Absent → undated; `null` or a non-string fails the call. |
| `$.articles[].socialimage` | string | Unknown (never `null` live) | Unknown (observed present live) | No | The article's social-media image URL, or `""`. |
| `$.articles[].domain` | string | Unknown (never `null` live) | Unknown (observed present live; both parsers accept absence) | Yes | The publisher's domain (`fortune.com`). Absent → the URL's host; `null` or a non-string fails the call. |
| `$.articles[].language` | string | Unknown (never `null` live) | Unknown (observed present live) | No | Language name (`English`). |
| `$.articles[].sourcecountry` | string | Unknown (never `null` live) | Unknown (observed present live) | No | Country of the publisher (`United States`). |

Other answers are plain text, not JSON (section 4); the code reads only their first line.

## 4. Error Handling

### HTTP status codes

Every failure ends the tool call with a retryable `SEARCH_FAILED` (the model sees the cause and may try another tool; the run continues), except the two rows that send no request (`QUERY_KEYWORD_TOO_SHORT`, `SEARCH_COOLDOWN`). The cause is bounded to 200 characters. A non-2xx status travels unchanged as `ToolFailure.upstreamStatus` ([§4a](../../rule/error_handling.md), [ADR-0037](../../adr/0037-external-service-errors-keep-their-status.md)); the error body is not read.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200, JSON | Success | Parsed as in section 3; ends any outage pause. JSON of another shape → cause `unexpected response shape`, no pause change. | — / `SEARCH_FAILED` |
| — | A keyword of the query has fewer than 3 characters (section 2) | No request is sent: "news.search keywords must be at least 3 characters long (GDELT refuses shorter ones such as "<keyword>"); use longer keywords, e.g. "artificial intelligence" instead of "ai"." Not retryable (the same query always fails). The model's research loop sees the code. | `QUERY_KEYWORD_TOO_SHORT` |
| 200, plain text "Your search contained a keyword that was too short." | A keyword GDELT deems too short that our check lets through (for example inside a quoted phrase; live: `ai`, now refused before sending) | Not JSON → cause is that first line; no pause (the query is at fault); `upstreamStatus` null (no error status was sent). | `SEARCH_FAILED` |
| 200, plain text starting "Please limit requests" | GDELT's rate-limit notice sent as a 200 (ADR-0039 §6; not observed on 2026-10-31) | Opens the outage pause when the first non-empty line starts with that phrase (ASCII case-insensitive); cause is the first line; `upstreamStatus` null. | `SEARCH_FAILED` |
| 429 | Rate limit; plain-text body "Please limit requests to one every 5 seconds …" (live) | Opens the outage pause; cause `HTTP_ERROR: HTTP 429`; status 429 kept. | `SEARCH_FAILED` |
| 5xx | Server error | Opens the outage pause; status kept. | `SEARCH_FAILED` |
| Other 4xx, 3xx without a usable `Location` | Not documented | No pause; status kept. Redirects are followed only to `api.gdeltproject.org` (else `HOST_NOT_ALLOWED`), at most 5. | `SEARCH_FAILED` |
| — | Paused after an outage | No request is sent: "The search service is rate limited or unavailable. … paused for <n> seconds." | `SEARCH_COOLDOWN` (retryable) |
| — | Run cancelled (also while waiting for the 5 s slot) | No request, or the request is abandoned; no pause. | `TOOL_ABORTED` |

### Provider error codes and body

None: GDELT has no error codes or error JSON. Errors are plain-text sentences (`text/html` under 200, no `Content-Type` under 429), observed in section 5.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 15 s for the whole request including the body (`SEARCH_TIMEOUT_MS`); the tool's own budget is 40 s (5 s spacing + 15 s request + margin). Body cap 1,000,000 bytes (wire and decoded, `RESPONSE_TOO_LARGE`). | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs`, `packages/adapters/src/worker/safeFetchCore.ts`, `crates/research-net/src/core.rs` |
| Retries | No application retry. Transport level, both runners: when an attempt fails before a response arrives (connect, TLS or a dropped connection), the same GET is sent to the next of at most 3 validated addresses of the host. Rust only: when a reused idle keep-alive connection turns out to be closed before any response byte, the GET is sent once more on a fresh connection to the same address. | `packages/adapters/src/node/index.ts`, `crates/research-net/src/transport.rs`, `crates/research-net/src/pinned.rs` |
| Rate limit | Request starts ≥ 5 s apart within the process, concurrent calls served first come, first served; a cancelled wait records no start. Outage pause: timeout, network error, 429, 5xx or the plain-text rate-limit notice opens a 60 s window, each further consecutive outage doubles it up to 30 minutes; a well-formed answer clears it; a cancelled run never opens it. | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs` |
| Cache | Successful answers in memory for 15 minutes, keyed by `gdelt` + normalised query, at most 200 entries shared with `web.search` (oldest evicted); a hit sends nothing, waits for no slot, and keeps the original `retrievedAt`. Cleared when the runner restarts. GDELT's own `Cache-Control: public, max-age=900` is not used. | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs` |
| Fallback | None automatic. The failure text tells the model to use another search tool (`web.search`), subscribed feeds or known page URLs. | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs` |

## 5. Examples

### GET /api/v2/doc/doc

Request (the TypeScript runner; the Rust runner sends the same headers without `Connection: close`):

```http
GET /api/v2/doc/doc?query=gold%20price%20sourcelang%3Aenglish&mode=artlist&format=json&maxrecords=10&sort=hybridrel HTTP/1.1
Host: api.gdeltproject.org
Accept: application/json
User-Agent: research-workspace/1.0 (personal research tool)
Accept-Encoding: gzip
Connection: close
```

Verified: live, 2026-10-31, `curl` with the query, `Accept` and `User-Agent` above (the model's query `gold price`).

Response:

```http
HTTP/1.1 200 OK
Server: GDELT Server
Cache-Control: public, max-age=900
Transfer-Encoding: chunked
Content-Type: application/json; charset=utf-8
```

<!-- example: gdelt-doc-artlist -->
```json
{
  "articles": [
    {
      "url": "https://fortune.com/article/current-price-of-gold-10-16-2026/",
      "url_mobile": "",
      "title": "Current price of gold : October 16 , 2026",
      "seendate": "20261016T143000Z",
      "socialimage": "https://fortune.com/img-assets/wp-content/uploads/2026/10/Price-of-Gold-Oct-16.jpg",
      "domain": "fortune.com",
      "language": "English",
      "sourcecountry": "United States"
    },
    {
      "url": "https://economictimes.indiatimes.com/wealth/invest/gold-silver-rate-today-october-19-2026-18k-20k-24k-delhi-hyderabad-bengaluru-citywise-ibja-gold-price-malabar-gold-kalyan-jewelers-joyalukkas/articleshow/135041704.cms",
      "url_mobile": "https://m.economictimes.com/wealth/invest/gold-silver-rate-today-october-19-2026-18k-20k-24k-delhi-hyderabad-bengaluru-citywise-ibja-gold-price-malabar-gold-kalyan-jewelers-joyalukkas/amp_articleshow/135041704.cms",
      "title": "Gold rate silver rate today ( October 19 , 2026 ): Check 24k , 22k , 20k and 18k gold jewellery prices from Malabar Gold & Diamonds , Joyalukkas , Kalyan Jewellers , Tanishq & IBJA in Delhi , Mumbai , Hyderabad & more cities",
      "seendate": "20261019T070000Z",
      "socialimage": "https://img.etimg.com/thumb/width-1200,height-900,imgsize-1578622,resizemode-75,msid-135041704/wealth/invest/gold-silver-rate-today-october-19-2026-18k-20k-24k-delhi-hyderabad-bengaluru-citywise-ibja-gold-price-malabar-gold-kalyan-jewelers-joyalukkas.jpg",
      "domain": "economictimes.indiatimes.com",
      "language": "English",
      "sourcecountry": "India"
    }
  ]
}
```

Verified: live, 2026-10-31, `curl` of the request above. 2 of 10 articles kept; whitespace re-indented; headers `Date`, `Access-Control-Allow-Origin`, `Timing-Allow-Origin`, `X-XSS-Protection` omitted.

### Error responses

Rate limit (the notice the code treats as an outage):

```http
HTTP/1.1 429 Too Many Requests
Server: GDELT Server
Content-Length: 444
```

```text
Please limit requests to one every 5 seconds or contact <redacted> for larger queries. All high-traffic users should switch to our ngrams dataset: https://blog.gdeltproject.org/using-the-new-web-ngrams-dataset-to-find-relevant-coverage/. For trend analysis, please see our daily newsletter briefings: https://blog.gdeltproject.org/announcing-our-new-daily-todays-trends-on-capitol-hill-todays-media-trends-newsletter-briefings/.
```

Verified: live, 2026-10-31, `curl` of the request above (answered even 25–90 s after the previous request from this machine). The contact e-mail address is replaced by `<redacted>`; `Date` omitted. Our code: `SEARCH_FAILED`, cause `HTTP_ERROR: HTTP 429`, `upstreamStatus` 429, outage pause opened.

Keyword too short (model query `ai`, URL `…?query=ai%20sourcelang%3Aenglish&mode=artlist&format=json&maxrecords=10&sort=hybridrel`):

```http
HTTP/1.1 200 OK
Server: GDELT Server
Cache-Control: public, max-age=900
Transfer-Encoding: chunked
Content-Type: text/html; charset=utf-8
```

<!-- example: gdelt-doc-keyword-too-short -->
```text
Your search contained a keyword that was too short.
```

Verified: live, 2026-10-31, `curl` with the headers above. `Date` and the CORS / XSS headers omitted. Our code no longer sends this query: `ai` is refused first with `QUERY_KEYWORD_TOO_SHORT` (section 4). The same answer to a query that passes our check: not JSON, so `SEARCH_FAILED` with cause `Your search contained a keyword that was too short.`, `upstreamStatus` null, no pause.

## 6. Data Mapping

Each kept article becomes one `Evidence` (`packages/contracts/src/records.ts`, Rust `crates/research-contracts/src/records.rs`) built by `collectEvidence` / `collect_evidence`; the run's evidence is stored with its bundle in [`evidence.body_json`](../../database/tables/evidence.md).

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.articles[].url` | Must pass `validateFetchUrl`; its normalised `href` | `Evidence.sourceUrl` | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.articles[].domain` | As given; when absent, the URL's host, else `unknown publisher`; ≤ 300 characters | `Evidence.publisher` | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.articles[].title` | Trimmed; ≤ 300 characters | `Evidence.title` | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.articles[].title` | The headline is the whole retrieved text (≤ 20,000 characters), hashed with SHA-256 | Retrieved text (in memory) and `Evidence.checksum` | Checksum in [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.articles[].seendate` | `YYYYMMDDTHHMMSSZ` → ISO 8601 UTC (`2026-10-16T14:30:00.000Z`); an impossible date (month 13, 30 February) or another shape → `null`. This is GDELT's first-seen time, used as the publication time. | `Evidence.publishedAt` | [`evidence.body_json`](../../database/tables/evidence.md) |
| (none) | `excerpt` always `null`, `retainQuotes` false (DATA-010) | `Evidence.excerpt` | [`evidence.body_json`](../../database/tables/evidence.md) |
| (none) | `news` | `Evidence.sourceClass` | [`evidence.body_json`](../../database/tables/evidence.md) |
| (none) | The run clock when the answer arrived; a cached reuse keeps that time | `Evidence.retrievedAt` | [`evidence.body_json`](../../database/tables/evidence.md) |
| HTTP status | Unchanged | `ToolFailure.upstreamStatus` | Not stored by this tool |

## 7. Maintenance

### Known differences between the runners

- Spacing: TypeScript serialises callers (`createKeyedTurns`), keeps the last request start in the tool factory and sleeps the remainder; Rust reserves a slot in a ledger (`Ledger`, proved in `formal/ResearchFormal/Spacing.lean`) and records the start only when the request is sent. Both keep starts ≥ 5 s apart.
- The Rust runner may reuse an idle keep-alive connection and sends no `Connection: close`; when such a pooled connection was already closed by GDELT before answering, Rust resends the GET once on a fresh connection. The TypeScript runner opens a fresh socket per request (Node sends `Connection: close`), so it has no such resend.
- Otherwise none: both build the same URL and apply the same shape and throttle-notice rules.

### Open issues

- The keyword-length check (section 2) rests on two live answers (`ai` refused, `fed` answered); whether GDELT refuses short words inside quoted phrases, and how it counts non-ASCII keywords, is untested. A refusal our check misses still ends as `SEARCH_FAILED` after one request.
- On 2026-10-31 GDELT answered 429 to requests spaced 25–90 s apart from this machine (possibly a per-address limit stricter than the published "one every 5 seconds"); the 5 s spacing alone does not prevent 429s, the outage pause then limits the cost.
- The rate-limit notice now comes with HTTP 429 (live); the 200-plus-notice case the code also handles was not observed and may be historical.
- The empty-result answer (no `articles` key) was not captured live.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | live | `GET /api/v2/doc/doc` success (10 articles, 2 kept), 429 rate-limit body, 200 plain-text "keyword too short"; parameters against the DOC 2.0 reference | Claude (ADR-0047 external API documents) |
| 2026-10-31 | live | Keyword minimum: `fed sourcelang:english` (`maxrecords=1`) answered 200 JSON, after two 429s spaced 2–3 minutes apart; with `ai` refused this sets the minimum at 3 characters (no example changed) | Claude (external-API defect fixes) |
