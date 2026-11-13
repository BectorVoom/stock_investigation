# External API: Sarashina API

## 1. Overview

| Property | Value |
|---|---|
| Provider | SB Intuitions (SoftBank group) |
| Purpose | The plan-limited `sarashina-api` agent backend ([AGENT_BACKENDS.md](../../AGENT_BACKENDS.md), [ADR-0074](../../adr/0074-sarashina-api-backend.md)): each agent turn is one streaming OpenAI-compatible chat completion from a Sarashina model, chosen in Settings → AI agent. |
| Hosts | `api.sarashina.ai` |
| Endpoints | `POST /v1/chat/completions` — one model turn, streamed as server-sent events |
| Authentication | `Authorization: Bearer <key>`, env variable `SARASHINA_API_KEY` in `apps/runner/.env` (8–512 printable ASCII after trimming; issued in the Sarashina console under API Keys). Redirects are refused, so the key reaches only this origin. |
| Configuration | `SARASHINA_MODEL` (the model when Settings names none; default `sarashina3.2-mini-thinking`). The model chosen in Settings → AI agent (`owner_settings.agent_settings_json`) wins. |
| Usage Limits | Free beta: no charge, no published price or quota; SB Intuitions may use beta inputs and outputs for training (Settings says so beside the backend). `max_completion_tokens` must be 1–8,000 (a larger value answers 400). Our caps: `max_completion_tokens` 8,000 (the API's maximum), at most 3 retries of a request refused before any output, the turn's deadline. |
| Called By | Rust runner (default) and TypeScript runner (rollback): every agent turn of a job whose backend is `sarashina-api`. The probe is offline (it never contacts the API). |
| Code | `crates/research-providers/src/sarashina_api.rs`, `crates/research-providers/src/openrouter.rs`, `crates/research-providers/src/http_turn.rs`, `crates/research-providers/src/http.rs`, `packages/adapters/src/providers/sarashinaApi.ts`, `packages/adapters/src/providers/openRouter.ts`, `packages/adapters/src/providers/httpTurn.ts` |
| Official Documentation | [Sarashina API Docs](https://docs.sarashina.ai/) (Chat Completions, Models) |
| Last Verified | 2026-11-13, live (model list, streamed answers from all three chat models through both runners' adapters, `finish_reason: "length"`, 400 and 401 answers; see section 7) |

For each turn the runner checks the key and the model id — it fails with `NOT_CONFIGURED` without a key and `PROVIDER_MODEL_INVALID` for an id that fails the model-id check — then sends one chat completion naming exactly one model, with the prompt as a single user message and no `tools`. It forwards every non-empty `choices[0].delta.content` as `text.delta` and never forwards a thinking model's `delta.reasoning` (an opaque encrypted string). The API reports token counts only, so every turn reports its cost as unknown (plan-limited).

## 2. Input Parameters

### POST /v1/chat/completions

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Authorization` | header | string | Yes | None; we send `Bearer <SARASHINA_API_KEY>` | — | API key. Never logged, never placed in an event. |
| `Content-Type` | header | string | Yes | We send `application/json` | — | Body encoding. |
| `Accept` | header | string | No | We send `text/event-stream` | — | The answer is read as SSE. |
| `model` | body | string | Yes | Settings' model, else `SARASHINA_MODEL`, else `sarashina3.2-mini-thinking` | Our check: `^[A-Za-z0-9~@][A-Za-z0-9._:/#~@+-]{0,99}$`; the API answers 400 for a model it does not serve | Settings offers `sarashina3.2-mini-thinking`, `sarashina3-mini`, `sarashina3-nano`; another id can be typed. |
| `messages` | body | array | Yes | — | Exactly one element | The conversation. |
| `messages[0].role` | body | string | Yes | — | `user` | Role. |
| `messages[0].content` | body | string | Yes | — | — | The turn's prompt (`AgentRequest.prompt`). |
| `stream` | body | boolean | No | Provider: `false`; we send `true` | — | Server-sent events. |
| `max_completion_tokens` | body | integer | No | Provider: `8000`; we send `8000` | 1–8,000; larger answers 400 | Cap on thinking plus visible output. |
| `reasoning_effort` | body | string | No | Provider: model default; we send the run's effort, only when the model id ends in `-thinking` | `low`, `medium`, `high` | Thinking depth. A non-thinking model answers 400 `reasoning_effort is not supported for model …`, so it is never sent to one. |

## 3. Output Parameters

### POST /v1/chat/completions

`200` with `Content-Type: text/event-stream; charset=utf-8`. Each event is one `data:` line followed by a blank line; the stream ends with `data: [DONE]`. No `event:` lines or comments were observed. Each `data:` payload except `[DONE]` is a JSON chunk:

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.id` | string | No | No | No | Completion id, `chatcmpl-…`, the same in every chunk. |
| `$.object` | string | No | No | No | `chat.completion.chunk`. |
| `$.created` | integer | No | No | No | Unix seconds. |
| `$.model` | string | No | No | No | The model that answered. |
| `$.choices` | array | No | No | Yes | One element per content chunk; empty (`[]`) in the final usage chunk. |
| `$.choices[0].index` | integer | No | No | No | `0`. |
| `$.choices[0].delta.role` | string | No | Yes | No | `assistant`, first chunk only. |
| `$.choices[0].delta.content` | string | No | Yes | Yes | Answer text; empty in the first, thinking and last chunks. |
| `$.choices[0].delta.reasoning` | string | No | Yes | No | Thinking models only: an opaque, encrypted (base64) string in the last content chunk. Never forwarded. |
| `$.choices[0].logprobs` | null | Yes | No | No | Always `null` here. |
| `$.choices[0].finish_reason` | string | Yes | No | Yes | `null` until the last content chunk: `stop`, or `length` at `max_completion_tokens`. `error` would fail the turn (not observed). |
| `$.usage` | object | No | Yes | Yes (presence only) | Final chunk: token counts. It has no cost field, so the cost stays unknown. |
| `$.usage.prompt_tokens` | integer | No | No | No | Prompt tokens. |
| `$.usage.completion_tokens` | integer | No | No | No | Thinking plus answer tokens. |
| `$.usage.total_tokens` | integer | No | No | No | Sum. |
| `$.usage.prompt_tokens_details` | null | Yes | No | No | Always `null` here. |
| `$.error` | object | No | Yes | Yes | Not observed; an OpenAI-style error chunk is read by the shared parser (`error.code` numeric → its status). |

## 4. Error Handling

### HTTP status codes

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | A parameter out of range (`max_completion_tokens` > 8000), `reasoning_effort` for a non-thinking model, a model it does not serve, a disallowed field | Fails the turn, not retried, status kept | `PROVIDER_REQUEST_REJECTED` |
| 401 | Missing or invalid key | Fails the turn, not retried, status kept | `PROVIDER_AUTH` |
| 402 | Not observed (the beta is free) | Fails the turn, not retried, status kept | `PROVIDER_PAYMENT_REQUIRED` |
| 403 | Not observed | As 401 | `PROVIDER_AUTH` |
| 408 | Not observed | Fails the turn, status kept | `PROVIDER_TIMEOUT` |
| 429 | Not observed (no published quota) | Retried (shared rule), then fails, status kept | `PROVIDER_RATE_LIMITED` |
| 5xx | Not observed | Retried (shared rule), then fails, status kept | `PROVIDER_UNAVAILABLE` |

### Provider error codes and body

Errors are `application/json` with one field, `{"message": "<text>"}` (for example `Unauthorized`, `max_completion_tokens must be less than or equal to 8000`). The message is never read or logged; the status alone chooses the code and travels unchanged as `upstreamStatus` ([error handling §4a](../../rule/error_handling.md)).

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | The turn's deadline; an idle stream is stopped by the shared idle watch; SSE lines and the whole body are bounded (`MAX_SSE_LINE_CHARS`, `MAX_RAW_STREAM_CHARS`) | `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Retries | A network error, 429, 5xx or an error chunk before any content: the same request again, at most 3 times, within the deadline (`REJECTION_RETRY`); never once content arrived | `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Rate limit | `Retry-After` honoured by the shared retry rule; no pacing of our own | `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Cache | None. | — |
| Fallback | None (AGT-012): one model; the owner chooses another in Settings. | `packages/adapters/src/providers/sarashinaApi.ts`, `crates/research-providers/src/sarashina_api.rs` |

A turn whose stream ends without `[DONE]` or a `finish_reason` is `PROVIDER_OUTPUT_INVALID`; `finish_reason: "length"` is `PROVIDER_OUTPUT_TRUNCATED` (not retryable); no text at all is `PROVIDER_OUTPUT_EMPTY`.

## 5. Examples

### POST /v1/chat/completions

Request (exactly what both runners send for `sarashina3-mini` at any effort):

<!-- example: sarashina-api-chat-request -->
```http
POST /v1/chat/completions HTTP/1.1
Host: api.sarashina.ai
Authorization: Bearer <SARASHINA_API_KEY>
Content-Type: application/json
Accept: text/event-stream

{"model":"sarashina3-mini","messages":[{"role":"user","content":"Reply with the single word OK."}],"stream":true,"max_completion_tokens":8000}
```

Verified: live, 2026-11-13, `curl --http1.1` with exactly these headers and body; `sarashinaApiDocExamples.test.ts` checks that it equals what the adapter sends. For a thinking model the body ends `"max_completion_tokens":8000,"reasoning_effort":"<effort>"}`.

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Transfer-Encoding: chunked
Cache-Control: no-store
```

<!-- example: sarashina-api-chat-stream -->
```text
data: {"id":"chatcmpl-bc96ddbc9b5da9d2","object":"chat.completion.chunk","created":1794576591,"model":"sarashina3-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-bc96ddbc9b5da9d2","object":"chat.completion.chunk","created":1794576591,"model":"sarashina3-mini","choices":[{"index":0,"delta":{"content":"OK"},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-bc96ddbc9b5da9d2","object":"chat.completion.chunk","created":1794576591,"model":"sarashina3-mini","choices":[{"index":0,"delta":{"content":""},"logprobs":null,"finish_reason":"stop"}]}

data: {"id":"chatcmpl-bc96ddbc9b5da9d2","object":"chat.completion.chunk","created":1794576591,"model":"sarashina3-mini","choices":[],"usage":{"prompt_tokens":9,"total_tokens":11,"completion_tokens":2,"prompt_tokens_details":null}}

data: [DONE]
```

Verified: live, 2026-11-13, `curl --http1.1` (the request above). The complete stream; 4 of 12 response headers kept (the others are security headers: CSP, HSTS, referrer policy, X-* headers). The thinking model's stream (`fixtures/sarashina-api/thinking-ok.sse`) and a capped one (`fixtures/sarashina-api/length.sse`) are recorded beside the adapter tests.

### Error response

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
Content-Length: 74
```

```json
{"message":"reasoning_effort is not supported for model sarashina3-mini"}
```

Verified: live, 2026-11-13, `curl --http1.1` with the request above plus `"reasoning_effort":"low"` (why the adapter sends it to thinking models only). A bad key answers `401` with `{"message":"Unauthorized"}` (`fixtures/sarashina-api/error-401.json`).

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.choices[0].delta.content` | Non-empty strings forwarded unchanged, in order; at most `MAX_OUTPUT_TEXT_CHARS` per turn | `AgentEvent` `text.delta` `.text` (`packages/contracts/src/agent.ts`; Rust `AgentEvent::TextDelta`) | Not stored by the adapter (the pipeline stores the parsed answer) |
| `$.choices[0].finish_reason` | Any string ends the answer; `length` → `PROVIDER_OUTPUT_TRUNCATED` | `AgentEvent` `completed` / `failed.code` | Not stored |
| `$.usage` | No cost field: the turn's cost is `null` (unknown), never 0 | `AgentEvent` `usage.knownCostUsd` = `null` | Not stored |
| HTTP status of a refused request | Unchanged | `AgentEvent` `failed.upstreamStatus` | Not stored |

## 7. Maintenance

### Known differences between the runners

None. Both build the same body bytes (checked by `sarashinaApi.test.ts` and the Rust `body_matches_the_typescript_runner_byte_for_byte` test) and parse chunks with the shared OpenRouter chunk parser. The Rust runner speaks HTTP/1.1 through its DNS-pinned client, which lists `https://api.sarashina.ai/v1/chat/completions` as a fixed endpoint; the TypeScript runner uses the runner's fetch with redirects refused.

### Open issues

- The beta is free and reports no price. If SB Intuitions starts billing the key, the backend would still report the cost as unknown; it would then need a price table (like the Claude API's) and the metered cost model. Re-check the terms when the beta ends.
- No 429 or 5xx answer has been observed; their handling follows the shared rule.
- `GET /v1/models` is not called: the offered models are a fixed list in both adapters (from that endpoint on 2026-11-13, without the embedding, rerank and guard models). A new model can be typed through "Other" until it is added to `SARASHINA_API_MODELS`.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-11-13 | live | `GET /v1/models`; streamed answers from `sarashina3-mini`, `sarashina3-nano`, `sarashina3.2-mini-thinking` (low effort) over HTTP/2 and HTTP/1.1; `finish_reason: "length"` at 5 tokens; 400 for `max_completion_tokens` 9000, an unknown model and `reasoning_effort` on a non-thinking model; 401 for a bad key; one real turn per model through the TypeScript adapter and two through the Rust adapter's pinned transport (`crates/research-providers/tests/sarashina_live.rs`) | Antigravity agent |
