# External API: Agent Web Search

## 1. Overview

| Property | Value |
|---|---|
| Provider | Independently implemented Rust Agent Web Search service |
| Purpose | `web.search` discovery leads for research and Notebook turns; read original pages with `web.fetch_page`. Replaces Tavily in normal runner composition. |
| Hosts | `127.0.0.1`, `::1` (operator-configured literal loopback only) |
| Endpoints | `POST /search` — ranked source titles, URLs and snippets |
| Authentication | `Authorization: Bearer <AGENT_WEB_SEARCH_API_KEY>`, from `apps/runner/.env`; must match the service's `SEARCH_API_KEY`. 16–256 printable nonspace ASCII characters. Never a model argument, URL parameter or log field. |
| Configuration | `AGENT_WEB_SEARCH_URL`, default `http://127.0.0.1:8090`; only HTTP origins with literal loopback addresses, no credentials/query/path/fragment. Public web access must be enabled in the research request. |
| Usage Limits | Service:16 requests and8fetches concurrently; runner:30s request,40s tool,1MiB response,64KiB request; successful query cache15minutes,200entries. Search depth basic,10results. |
| Called By | Rust runner default and TypeScript rollback runner; company-overview script's Agent Web Search mode |
| Code | `crates/research-tools/src/agent_search.rs`, `crates/research-tools/src/search.rs`, `crates/research-tools/src/catalogue.rs`, `crates/research-runner/src/config.rs`, `crates/research-runner/src/composition.rs`, `packages/adapters/src/node/agentSearch.ts`, `packages/adapters/src/tools/agentSearchEndpoint.ts`, `packages/adapters/src/tools/searchTools.ts`, `packages/adapters/src/tools/index.ts`, `apps/runner/src/config.ts`, `apps/runner/src/main.ts`, `scripts/agentWebSearch.ts`, `scripts/poc/companyDescription/webSources.ts` |
| Official Documentation | Local service specification in sibling repository `../agent-web-search/docs/SPECIFICATION.md`; [SearXNG API](https://docs.searxng.org/dev/search_api.html) |
| Last Verified |2026-11-12,live local Rust service backed by local SearXNG |

The model submits only query keywords. The configured service owns source discovery;
the runner consumes the compatible result envelope and retains its existing evidence
IDs, URL safety filtering and provenance. Local corpus mode searches imported records
only; SearXNG mode depends on enabled upstream engines. Normal runners pass no Tavily
credential and have no automatic Tavily fallback. The legacy Tavily factory branch is
retained solely for historical contract replay/explicit compatibility callers.

## 2. Input Parameters

### POST /search

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Authorization` | header | string | Yes | Bearer service key | Printable ASCII, <=300characters | Private service authentication. |
| `Content-Type` | header | string | Yes | application/json | Fixed | JSON POST. |
| `Accept` | header | string | Yes | application/json | Fixed | JSON result. |
| `Accept-Encoding` | header | string | Yes | identity | Fixed | Compressed responses refused. |
| `Host` | header | string | Yes | Configured literal host and port | Exact endpoint | No DNS lookup or redirect. |
| `query` | body | string | Yes | Model keywords,trimmed |2–200characters in tool | No endpoint/credential arguments. |
| `search_depth` | body | string | No | basic | Fixed basic | Discovery snippets. |
| `max_results` | body | integer | No |10 | Fixed10 | Result count bound. |
| `include_published_date` | body | boolean | No | true | Fixedtrue | Nullable source dates. |

No other service options are sent. Content-Length is the serialized UTF-8 body's
byte count. The service uses its own search-engine configuration.

## 3. Output Parameters

### POST /search

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.query` | string | No | No | No | Executed query. |
| `$.answer` | null | Yes | No | No | No generated answer in retrieval core. |
| `$.images` | array | No | No | No | Empty for this variant. |
| `$.results` | array | No | No | Yes | Ranked search leads. |
| `$.results[].title` | string | No | No | Yes | Source title. |
| `$.results[].url` | string | No | No | Yes | Public source URL, independently validated by runner. |
| `$.results[].content` | string | No | No | Yes | Query-ranked discovery snippet. |
| `$.results[].score` | number | No | No | No | Service lexical relevance,not a Tavily score. |
| `$.results[].raw_content` | null | Yes | No | No | Raw content not requested. |
| `$.results[].published_date` | string | Yes | No | Yes | ISO date or zoned source timestamp,not retrieval time. |
| `$.response_time` | number | No | No | No | Service duration,seconds. |
| `$.request_id` | string | No | No | No | UUID. |
| `$.provider` | string | No | No | No | local or searxng. |
| `$.corpus_scope` | string | No | No | No | imported-corpus-only or configured-searxng-engines. |
| `$.warnings` | array | No | No | No | Empty in basic discovery with no page enrichment. |

The compatibility parser accepts absent/null snippet or date and ignores extra
fields, but results/title/url remain required. Results with unsafe URLs or empty
titles are discarded. Empty arrays are an honest no-match,never invented evidence.

## 4. Error Handling

One POST per cache miss; no immediate retry. Cancellation or30sdeadline closes the
request/connection. Non-2xx status (including redirects) is returned unchanged as
`ToolFailure.upstreamStatus`; no redirect is followed and no error body is logged.
401bad key,400/422bad request,429capacity,501unsupported feature and5xxengine/service
failures retain their numeric status. Network/timeout and statuses other than400/422
open a provider pause:60s, doubling to30minutes; Retry-After is honored when present.
Codes are SEARCH_FAILED, SEARCH_COOLDOWN or TOOL_ABORTED. Successful results are
cached15minutes per normalized query (at most200),retaining original retrieval time.
Missing key means no web.search registration and one web_search_disabled warning.
There is no automatic Tavily fallback. news.search (GDELT) remains separate.

Error body: `detail:{code,error,status}` plus request_id. The runner intentionally
uses status and fixed safe wording instead of forwarding provider text. UTF-8 and
body-size failures have stable local codes without inventing an upstream status.

## 5. Examples

### POST /search

```http
POST /search HTTP/1.1
Host: 127.0.0.1:8090
Authorization: Bearer <AGENT_WEB_SEARCH_API_KEY>
Accept: application/json
Accept-Encoding: identity
Content-Type: application/json

{"query":"corporate training market demand","search_depth":"basic","max_results":10,"include_published_date":true}
```
Verified: live, 2026-11-12, authenticated POST to the local service. Credential replaced by its environment variable name.

```http
HTTP/1.1 200 OK
Content-Type: application/json
```
<!-- example: agent-web-search-search -->
```json
{
  "answer": null,
  "corpus_scope": "configured-searxng-engines",
  "images": [],
  "provider": "searxng",
  "query": "corporate training market demand",
  "request_id": "668b2666-ad14-439a-8faf-a594cc07e5c9",
  "response_time": 1.211727958,
  "results": [
    {
      "content": "This growth is primarily driven by the increasing need for employee skill enhancement, rapid technological advancements, and the rising demand for compliance and quality training across industries.",
      "published_date": "2025-07-31T08:05:00",
      "raw_content": null,
      "score": 0.925,
      "title": "Corporate Training Market Outlook Report 2025-2030: Digital Learning ...",
      "url": "https://finance.yahoo.com/news/corporate-training-market-outlook-report-080500710.html"
    }
  ],
  "warnings": []
}
```
Verified: live, 2026-11-12, local Rust service/SearXNG. One of10results kept; retained result and other fields verbatim.

### Error response

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```
<!-- example: agent-web-search-unauthorized -->
```json
{
  "detail": {
    "code": "UNAUTHORIZED",
    "error": "Valid Bearer authentication required",
    "status": 401
  },
  "request_id": "96aa6456-322d-448f-96d1-6275be45fd92"
}
```
Verified: live, 2026-11-12, deliberately invalid test credential. No edits.

## 6. Data Mapping

| External field | Transformation | Internal field | Storage |
|---|---|---|---|
| results[].url | Public HTTPS URL validation and deduplication | Evidence.sourceUrl | [evidence.source_url](../../database/tables/evidence.md) after publication |
| results[].url | Host extraction | Evidence.publisher | evidence.publisher |
| results[].title | Whitespace normalized, <=300characters | Evidence.title | evidence.title |
| results[].content | Snippet <=1000characters; title+snippet hashed; preview <=300 | CollectedEvidence.retrievedText/checksum | Text is discovery-only,in memory; checksum in evidence |
| results[].published_date | Valid ISO bare date or explicit-zone timestamp to UTC; unknown stays null | Evidence.publishedAt | evidence.published_at |
| response completion clock | Original time retained on cache reuse | Evidence.retrievedAt | evidence.retrieved_at |
| HTTP status | Unchanged | ToolFailure.upstreamStatus | Run failure_upstream_status when a run fails |

No schema change. Snippets are leads,not quotes (excerpt null); fetch the original
page before supporting a factual claim.

## 7. Maintenance

### Known differences between the runners

The Rust transport uses hyper and literal SocketAddr; TypeScript uses node:http.
Both accept one configured loopback endpoint,POST only,no redirects,identity encoding,
1MiBresponse cap,30sdeadline,cancellation and unchanged error status.

### Open issues

Search coverage/quality depends on the service's configured index and engines.
The SearXNG instance was installed separately with uv; Docker was unavailable.
The launcher does not install or start SearXNG automatically; see OPERATIONS.
The legacy Tavily adapter remains for recorded vectors and explicit old factory
callers; application composition always supplies Agent Web Search instead.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
|2026-11-12|live|Authenticated local service search with10results;401negative path; Rust/Node client and evidence tests|Codex|
