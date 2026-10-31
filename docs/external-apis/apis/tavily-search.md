# External API: Tavily Search

## 1. Overview

| Property | Value |
|---|---|
| Provider | Tavily |
| Purpose | The `web.search` research tool: the agent searches the whole web for short keywords and gets result titles, URLs and snippets as evidence, then reads promising results with `web.fetch_page` ([ADR-0025](../../adr/0025-web-search-research-tool.md)). Answers are reused for 15 minutes ([ADR-0039](../../adr/0039-fewer-external-requests.md)). |
| Hosts | `api.tavily.com` |
| Endpoints | `POST /search` — ranked web results for one query |
| Authentication | Bearer token in the `Authorization` header (`Bearer <TAVILY_API_KEY>`); env variable `TAVILY_API_KEY` in `apps/runner/.env`, 8–280 printable characters without spaces (runner config check). Without it `web.search` is not registered and only `news.search` is offered. The key never appears in a URL, a log line or a failure detail. |
| Configuration | The run's request must say `webAccess: "public-web"` (Settings → AI agent); otherwise the tool is not advertised to the model. |
| Usage Limits | Tavily: 100 requests per minute for a development key, 1,000 for a production key, then HTTP 429 with `Retry-After` ([rate limits](https://docs.tavily.com/documentation/rate-limits)); a `basic` search costs 1 API credit, `advanced` 2 ([search reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)); plan and pay-as-you-go limits answer 432 / 433. Ours: one request per tool call (tool timeout 20 s), always `search_depth: "basic"` (1 credit); a successful answer is cached 15 minutes per normalised query (at most 200 answers); an outage pauses all Tavily searches for the `Retry-After` Tavily sends (at most 30 minutes), else 60 s, doubling per consecutive outage up to 30 minutes. No request-rate pacing beyond that. |
| Called By | Rust runner (default) and TypeScript runner (rollback): the `web.search` tool inside `research` jobs (and Notebook assistant turns that use research tools). |
| Code | `crates/research-tools/src/search.rs`, `crates/research-tools/src/catalogue.rs`, `crates/research-tools/src/shared.rs`, `crates/research-net/src/core.rs`, `crates/research-net/src/pinned.rs`, `crates/research-net/src/transport.rs`, `crates/research-runner/src/config.rs`, `packages/adapters/src/tools/searchTools.ts`, `packages/adapters/src/tools/index.ts`, `packages/adapters/src/tools/shared.ts`, `packages/adapters/src/runtime/retryAfter.ts`, `packages/adapters/src/worker/safeFetchCore.ts`, `packages/adapters/src/node/index.ts`, `packages/adapters/src/node/pinnedConnect.ts`, `apps/runner/src/config.ts`, `crates/research-net/src/retry_after.rs` |
| Official Documentation | [Search endpoint reference](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Rate limits](https://docs.tavily.com/documentation/rate-limits) |
| Last Verified | 2026-10-31, live (section 7) |

When the model calls `web.search` with `{ "query": "<2–200 characters>" }`, the tool first looks for a fresh cached answer for the same normalised query (trimmed, whitespace runs collapsed, lower-cased). On a miss, unless Tavily is paused after an outage, it sends one JSON `POST /search` through the runner's safe fetcher, pinned to `api.tavily.com` (no redirect is ever followed for a POST). Each result with a public `https` URL becomes one evidence item (one per distinct URL): the title, the URL's host as publisher, the published date when Tavily gives one with an explicit zone, and the snippet as retrieved text. Nothing is stored as a quote (`excerpt` null, DATA-010). The model sees one line per result plus a 300-character snippet preview, and is told to read promising results with `web.fetch_page`.

## 2. Input Parameters

### POST /search

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Accept` | header | string | No | We send `application/json` | Printable ASCII | Asks for JSON. |
| `User-Agent` | header | string | No | We send `research-workspace/1.0 (personal research tool)` | Printable ASCII, ≤ 300 characters | Names the product (`SEARCH_USER_AGENT`); the model is never told it. |
| `Authorization` | header | string | Yes | — ; we send `Bearer <TAVILY_API_KEY>` | Printable ASCII, ≤ 300 characters (else the fetch fails before sending) | The owner's API key. Sent on the first request only. |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | Encoded bytes are counted against the size cap. |
| `Content-Type` | header | string | Yes | We send `application/json` | — | JSON body. |
| `Content-Length` | header | integer | Yes | We send the body's exact UTF-8 byte count | Body ≤ 64 KiB (`MAX_JSON_BODY_BYTES`) | Exact length; the POST is sent at most once (never retried on another address after the connection was made). |
| `query` | body | string | Yes | — ; we send the model's query, trimmed | 2–200 characters (tool argument schema) | The search keywords, sent unchanged after trimming. |
| `search_depth` | body | string | No | Tavily: `basic`; we send `basic` | `advanced`, `basic`, `fast`, `ultra-fast` | `basic` costs 1 credit. |
| `max_results` | body | integer | No | Tavily: `10`; we send `10` (`TAVILY_MAX_RESULTS`) | 0–20 | Most results returned. |
| `include_published_date` | body | boolean | No | Tavily: `false`; we send `true` | — | Adds `published_date` to each result so evidence can be dated (beta in Tavily's reference). |

Tavily's other body parameters (`topic`, `time_range`, `include_answer`, `include_raw_content`, `include_images`, `include_domains`, …) are never sent.

## 3. Output Parameters

### POST /search

`application/json`, one object. Validated with `tavilyResponseSchema` (TypeScript) and `tavily_hits` (Rust): `results` must be an array; in each result `url` and `title` must be strings and `content` / `published_date` a string, `null` or absent. Any other shape fails the call with `unexpected response shape`. Fields marked "live" were observed on 2026-10-31 but are not in Tavily's reference.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.query` | string | No | No | No | The executed query. |
| `$.follow_up_questions` | null | Yes | Yes | No | Live: present as `null`; not in Tavily's reference. |
| `$.answer` | string | Yes | Yes | No | An LLM answer, only with `include_answer` (never sent). Live: present as `null`. |
| `$.images` | array of objects (`url`, `description`) | No | No | No | Query images, only filled with `include_images` (never sent). Live: `[]`. |
| `$.results` | array | No | No | Yes | Results sorted by relevance; required. An empty array gives "No results for …". |
| `$.results[].title` | string | No | No | Yes | Page title; whitespace runs collapsed. An empty title drops the result. |
| `$.results[].url` | string | No | No | Yes | Page URL; a URL that fails the fetch policy (not `https`, private host, credentials, port) drops the result; a repeated URL is kept once. |
| `$.results[].content` | string | No (our schema also accepts `null`) | No (our schema also accepts absence) | Yes | A short extract of the page relevant to the query, Markdown-ish, with `[...]` between extracts. |
| `$.results[].score` | number | No | No | No | Relevance score. |
| `$.results[].raw_content` | string | Yes | Yes | No | Full page content, only with `include_raw_content` (never sent). Live: present as `null`. |
| `$.results[].published_date` | string | Yes | Yes | Yes | Publication date, sent because we ask for it. Live format: RFC 1123 (`Wed, 14 Oct 2026 07:00:00 GMT`). Its format is not specified by Tavily. |
| `$.results[].favicon` | string | No | Yes | No | Only with `include_favicon` (never sent); absent live. |
| `$.results[].images` | array | No | Yes | No | Only with `include_images` (never sent); absent live. |
| `$.results[].id` | string | No | No | No | Result id (`12fe51-00`). |
| `$.auto_parameters` | object | No | Yes | No | Only with `auto_parameters` (never sent); absent live. |
| `$.response_time` | number | No | No | No | Seconds Tavily took. |
| `$.usage` | object | No | Yes | No | Credits used, e.g. `{ "credits": 1 }`; listed in the reference, absent live (only with `include_usage`, never sent). |
| `$.request_id` | string | No | No | No | Tavily's request id (UUID). |

## 4. Error Handling

### HTTP status codes

Every failure ends the tool call with a retryable `SEARCH_FAILED` (the model sees the cause and may try another tool; the run continues). The cause is bounded to 200 characters and never contains the key. A non-2xx status travels unchanged as `ToolFailure.upstreamStatus` ([§4a](../../rule/error_handling.md), [ADR-0037](../../adr/0037-external-service-errors-keep-their-status.md)); the error body is not read.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200 | Success | Parsed as in section 3; ends any outage pause. Not JSON → cause is the body's first line; JSON of another shape → `unexpected response shape`; neither opens or ends a pause, `upstreamStatus` null. | — / `SEARCH_FAILED` |
| 301, 302, 303, 307, 308 | Not documented | A POST is never redirected: `REDIRECT_NOT_AUTHORIZED: HTTP <status>: a POST request is never redirected`, status kept. No pause. | `SEARCH_FAILED` |
| 400 | Invalid request | The query is at fault, not the provider: no pause. Cause `HTTP_ERROR: HTTP 400`. | `SEARCH_FAILED` |
| 401 | Missing or invalid API key | Opens the outage pause (the next query would fail too). | `SEARCH_FAILED` |
| 422 | Body validation failed | No pause. | `SEARCH_FAILED` |
| 429 | Rate limit exceeded (`Retry-After` sent) | Opens the outage pause for the `Retry-After` wait (delay-seconds or an HTTP date, rounded up to whole seconds, at most 30 minutes; `0` pauses nothing); an absent or unreadable header opens the escalating pause instead. A `Retry-After` on any other outage status is honoured the same way. | `SEARCH_FAILED` |
| 432, 433, 434 | Plan / key limit, pay-as-you-go limit, flex-tier capacity | Opens the outage pause. | `SEARCH_FAILED` |
| 500 and any other status | Server error | Opens the outage pause. | `SEARCH_FAILED` |
| — | Paused after an outage | No request is sent: "The search service is rate limited or unavailable. … paused for <n> seconds." | `SEARCH_COOLDOWN` (retryable) |
| — | Run cancelled | No request, or the request is abandoned; no pause. | `TOOL_ABORTED` |

### Provider error codes and body

Tavily's error bodies are JSON `{"detail": {"error": "<message>"}}` for 400, 401, 429, 432, 433 and 500, and `{"detail": [ {"type", "loc", "msg", "input", "ctx"} ]}` for 422. Our code reads none of them: the status alone decides (section 5 shows a live 401).

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 15 s for the whole request including the body (`SEARCH_TIMEOUT_MS`); the tool's own budget is 20 s. No separate connect timeout. Body cap 1,000,000 bytes, applied to the wire bytes and to the decoded bytes (`RESPONSE_TOO_LARGE`). | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs`, `packages/adapters/src/worker/safeFetchCore.ts`, `crates/research-net/src/core.rs` |
| Retries | None for the POST, in both runners: it is never sent on a reused keep-alive connection (Rust) and never resent after a connection to an address was established (a failure then is `NETWORK_ERROR`). Only a failure to connect at all (before any byte of the request was sent) moves on to the next of at most 3 validated addresses. | `packages/adapters/src/node/index.ts`, `crates/research-net/src/transport.rs` |
| Rate limit | Outage pause per provider: timeout, network error or any HTTP status except 400 / 422 opens a 60 s window, each further consecutive outage doubles it up to 30 minutes; a well-formed answer clears it; a cancelled run never opens it. When the error answer carries a readable `Retry-After`, the window is that wait instead (whole seconds, ≤ 30 minutes) and the escalation is left where it was, so the next outage without one continues doubling. The header travels on the fetch error (`SafeFetchError.retryAfter` / `retry_after`) and is read by the one shared parser (`parseRetryAfterMs` / `parse_retry_after_ms`, also used by the model providers and Google Calendar). | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs` |
| Cache | Successful answers in memory for 15 minutes, keyed by `tavily` + normalised query, at most 200 entries (oldest evicted); a hit sends nothing, does not touch the pause, and reports the original retrieval time as `retrievedAt`. Cleared when the runner restarts. | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs` |
| Fallback | None automatic. The failure text tells the model to use another search tool (`news.search`), subscribed feeds or known page URLs. | `packages/adapters/src/tools/searchTools.ts`, `crates/research-tools/src/search.rs` |

## 5. Examples

### POST /search

Request (the TypeScript runner; the Rust runner sends the same headers in the same order without `Connection: close`):

```http
POST /search HTTP/1.1
Host: api.tavily.com
Accept: application/json
User-Agent: research-workspace/1.0 (personal research tool)
Authorization: Bearer <TAVILY_API_KEY>
Accept-Encoding: gzip
Content-Type: application/json
Content-Length: 110
Connection: close

{"query":"Apple quarterly revenue 2026","search_depth":"basic","max_results":10,"include_published_date":true}
```

Verified: spec, 2026-10-31, built from `fetchTavily` in `packages/adapters/src/tools/searchTools.ts` and `buildPinnedRequestOptions`; parameters checked against https://docs.tavily.com/documentation/api-reference/endpoint/search.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 4388
```

<!-- example: tavily-search-results -->
```json
{
  "query": "Apple quarterly revenue 2026",
  "follow_up_questions": null,
  "answer": null,
  "images": [],
  "results": [
    {
      "title": "Apple Inc. - Wikipedia",
      "url": "https://en.wikipedia.org/wiki/Apple_Inc.",
      "content": "In September 2026, Apple faced a proposed £2 billion collection action in the UK Competition Appeal Tribunal concerning its App Tracking Transparency framework, with thousands of app developers alleging that the rules disadvantaged third-party developers.\n\n### Lobbying\n\nIn 2025, Apple was one of the donors who funded the White House's East Wing demolition and planned building of a ballroom.\n\n## Finances\n\nSee also: List of mergers and acquisitions by Apple\n\nRevenue by market (2024) [...] is the largest manufacturing company by revenue, the fourth-largest PC vendor \"Market share of personal computer vendors\"), the largest vendor of tablet computers, and the largest vendor of mobile phones. Apple became the first publicly traded US company to be valued at over $1 trillion in 2018, and, as of October 2025( is valued at just over $4 trillion. [...] Pogue, David (2026). Apple: The First 50 Years (First hardcover ed.). New York: Simon & Schuster. ISBN \"ISBN (identifier)\") 978-1982134594. OCLC \"OCLC (identifier)\") 1530737212. Retrieved March 28, 2026.\n Polsson, Ken. \"Chronology of Events in the History of Microcomputers\". Archived from the original on June 2, 2008. Retrieved August 18, 2008.\n Price, Rob (1987). So Far: The First Ten Years of a Vision. Apple Computer. ISBN \"ISBN (identifier)\") 978-1-55693-974-7.",
      "score": 0.36861077,
      "raw_content": null,
      "published_date": "Wed, 14 Oct 2026 07:00:00 GMT",
      "id": "12fe51-00"
    }
  ],
  "response_time": 1.26,
  "request_id": "e7dc16ae-a044-4fb6-a599-18cee083e04a"
}
```

Verified: live, 2026-10-31, `curl --http1.1` with the request above but `"max_results":3` (brief's paid-call budget). 1 of 3 results kept; whitespace re-indented; `Content-Length` is that of the 3-result answer; other response headers (`Date`, `Connection`, `content-security-policy`) omitted.

### Error response

```http
HTTP/2 401
content-type: application/json
content-length: 64
```

```json
{"detail":{"error":"Unauthorized: missing or invalid API key."}}
```

Verified: live, 2026-10-31, `curl` of the request above with a deliberately invalid key (`Bearer tvly-invalid-…`). Status line and headers as curl received them over HTTP/2 (the runner speaks HTTP/1.1 and would see `401 Unauthorized`); `date` and `content-security-policy` omitted. Our code: `SEARCH_FAILED`, cause `HTTP_ERROR: HTTP 401`, `upstreamStatus` 401, outage pause opened.

## 6. Data Mapping

Each kept result becomes one `Evidence` (`packages/contracts/src/records.ts`, Rust `crates/research-contracts/src/records.rs`) built by `collectEvidence` / `collect_evidence`; the run's evidence is stored with its bundle in [`evidence.body_json`](../../database/tables/evidence.md).

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.results[].url` | Must pass `validateFetchUrl`; its normalised `href` | `Evidence.sourceUrl` | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.results[].url` | Host name (lower case), else `unknown publisher`; ≤ 300 characters | `Evidence.publisher` | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.results[].title` | Whitespace runs collapsed, trimmed; ≤ 300 characters | `Evidence.title` | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.results[].published_date` | `zonedDateToIso`: read only when it is a bare `YYYY-MM-DD` (UTC) or ends in `Z`, `GMT`, `UTC` or `±hh:mm` / `±hhmm`; else `null` (never guessed in the machine's zone) | `Evidence.publishedAt` (ISO 8601 UTC) | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.results[].title` + `$.results[].content` | `title`, or `title` + newline + snippet (whitespace collapsed, ≤ 1,000 characters); the whole ≤ 20,000 characters; hashed with SHA-256 | Retrieved text (in memory, for verification) and `Evidence.checksum` | Checksum in [`evidence.body_json`](../../database/tables/evidence.md); the text is not stored |
| (none) | `excerpt` always `null`, `retainQuotes` false (DATA-010) | `Evidence.excerpt` | [`evidence.body_json`](../../database/tables/evidence.md) |
| (none) | `other` | `Evidence.sourceClass` | [`evidence.body_json`](../../database/tables/evidence.md) |
| (none) | The run clock when the answer arrived; a cached reuse keeps that time | `Evidence.retrievedAt` | [`evidence.body_json`](../../database/tables/evidence.md) |
| `$.results[].content` | First 300 characters (whitespace collapsed) | Model text preview line | Not stored |
| HTTP status | Unchanged | `ToolFailure.upstreamStatus` | Not stored by this tool |

## 7. Maintenance

### Known differences between the runners

- The Rust runner reuses idle keep-alive connections for GET requests but never for this POST, and sends no `Connection: close`; the TypeScript runner opens a fresh socket per request (Node adds `Connection: close`).
- `SEARCH_COOLDOWN` seconds: TypeScript rounds (`Math.round`), Rust divides; windows are whole seconds, so the text is identical.
- Otherwise none: both runners send the same body (key order `query`, `search_depth`, `max_results`, `include_published_date`) and apply the same shape rules.

### Open issues

- `published_date` formats other than the zoned forms above (for example a local time without a zone) leave the evidence undated.
- `follow_up_questions` (live, `null`) is not in Tavily's reference; harmless, the code ignores it.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | live | `POST /search` success (3 results, 1 kept) and 401 with an invalid key; request parameters and status codes against the search reference and rate-limit page | Claude (ADR-0047 external API documents) |
| 2026-10-31 | spec | `Retry-After` on 429 now honoured: header forms against RFC 9110 §10.2.3 and Tavily's rate-limit page (no live 429 provoked; no example changed) | Claude (external-API defect fixes) |
