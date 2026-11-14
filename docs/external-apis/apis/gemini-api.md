# External API: Gemini API

## 1. Overview

| Property | Value |
|---|---|
| Provider | Google (Gemini Developer API, OpenAI compatibility endpoint) |
| Purpose | The plan-limited `gemini-api` agent backend ([AGENT_BACKENDS.md](../../AGENT_BACKENDS.md), [ADR-0075](../../adr/0075-gemini-api-backend.md)): each agent turn is one streaming OpenAI-compatible chat completion from a Gemini model, chosen in Settings → AI agent. |
| Hosts | `generativelanguage.googleapis.com` |
| Endpoints | `POST /v1beta/openai/chat/completions` — one model turn, streamed as server-sent events |
| Authentication | `Authorization: Bearer <key>`, env variable `GEMINI_API_KEY` in `apps/runner/.env` (8–512 printable ASCII after trimming; issued in Google AI Studio). Redirects are refused, so the key reaches only this origin. |
| Configuration | `GEMINI_MODEL` (the model when Settings names none; default `gemini-3.5-flash`). The model chosen in Settings → AI agent (`owner_settings.agent_settings_json`) wins. |
| Usage Limits | Subject to the API key's Gemini Developer API free-tier or project rate limits (RPM, TPM, RPD). Our caps: `max_completion_tokens` 16,000, at most 3 retries of a request refused before any output, and the turn's deadline. |
| Called By | Rust runner (default) and TypeScript runner (rollback): every agent turn of a job whose backend is `gemini-api`. The probe is offline (it never contacts the API). |
| Code | `crates/research-providers/src/gemini_api.rs`, `crates/research-providers/src/openrouter.rs`, `crates/research-providers/src/http_turn.rs`, `crates/research-providers/src/http.rs`, `packages/adapters/src/providers/geminiApi.ts`, `packages/adapters/src/providers/openRouter.ts`, `packages/adapters/src/providers/httpTurn.ts` |
| Official Documentation | [Gemini API OpenAI Compatibility](https://ai.google.dev/gemini-api/docs/openai) |
| Last Verified | 2026-11-14, live (streamed answers from `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash` and `gemini-3.1-flash-lite`, `finish_reason: "length"`, and 400 / 404 / 429 / 503 answers; see section 7) |

For each turn the runner checks the key and the model id — it fails with `NOT_CONFIGURED` without a key and `PROVIDER_MODEL_INVALID` for an id that fails the model-id check — then sends one chat completion naming one model, with the prompt as a single user message and no `tools`. It forwards every non-empty `choices[0].delta.content` as `text.delta` and ignores Google's `extra_content.google.thought_signature` field. The response reports no cost, so every turn reports its cost as unknown (plan-limited).

## 2. Input Parameters

### POST /v1beta/openai/chat/completions

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Authorization` | header | string | Yes | None; we send `Bearer <GEMINI_API_KEY>` | — | API key. Never logged, never placed in an event. |
| `Content-Type` | header | string | Yes | We send `application/json` | — | Body encoding. |
| `Accept` | header | string | No | We send `text/event-stream` | — | The answer is read as SSE. |
| `model` | body | string | Yes | Settings' model, else `GEMINI_MODEL`, else `gemini-3.5-flash` | Our check: `^[A-Za-z0-9~@][A-Za-z0-9._:/#~@+-]{0,99}$`; the API answers 404 for an unknown model | Settings offers `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.1-flash-lite`; another id can be typed. |
| `messages` | body | array | Yes | — | Exactly one element | The conversation. |
| `messages[0].role` | body | string | Yes | — | `user` | Role. |
| `messages[0].content` | body | string | Yes | — | — | The turn's prompt (`AgentRequest.prompt`). |
| `stream` | body | boolean | No | Provider: `false`; we send `true` | — | Server-sent events. |
| `max_completion_tokens` | body | integer | No | Provider default; we send `16000` | Positive integer | Cap on completion tokens. |
| `reasoning_effort` | body | string | No | Provider: model default; we send the run's effort | `low`, `medium`, `high` | Thinking depth passed for the turn. |

## 3. Output Parameters

### POST /v1beta/openai/chat/completions

`200` with `Content-Type: text/event-stream`. Each event is one `data:` line followed by a blank line; the stream ends with `data: [DONE]`. Each `data:` payload except `[DONE]` is a JSON chunk:

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.id` | string | No | No | No | Completion id, the same in every chunk. |
| `$.object` | string | No | No | No | `chat.completion.chunk`. |
| `$.created` | integer | No | No | No | Unix seconds. |
| `$.model` | string | No | No | No | The model that answered. |
| `$.choices` | array | No | No | Yes | One element per streamed chunk. |
| `$.choices[0].index` | integer | No | No | No | `0`. |
| `$.choices[0].delta.role` | string | No | Yes | No | `assistant`. |
| `$.choices[0].delta.content` | string | No | Yes | Yes | Answer text; absent on the closing chunk carrying `finish_reason`. |
| `$.choices[0].delta.extra_content` | object | No | Yes | No | Contains `google.thought_signature` on the closing chunk; ignored by our parser and never forwarded. |
| `$.choices[0].finish_reason` | string | Yes | Yes | Yes | Absent or `null` until the closing chunk: `stop`, or `length` at `max_completion_tokens`. |
| `$.error` | object | No | Yes | Yes | Not observed mid-stream; an OpenAI-style error chunk would be read by the shared parser (`error.code` numeric → its status). |

## 4. Error Handling

### HTTP status codes

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | Invalid API key (`INVALID_ARGUMENT`), `max_completion_tokens` <= 0, malformed JSON, or invalid parameter | Fails the turn, not retried, status kept | `PROVIDER_REQUEST_REJECTED` |
| 401 | Missing authentication (observed on other Google routes; Gemini returns 400 for an invalid Bearer key) | Fails the turn, not retried, status kept | `PROVIDER_AUTH` |
| 403 | Not observed | As 401 | `PROVIDER_AUTH` |
| 404 | Unknown or retired model id | Fails the turn, not retried, status kept | `PROVIDER_REQUEST_REJECTED` |
| 408 | Not observed | Fails the turn, status kept | `PROVIDER_TIMEOUT` |
| 429 | Quota or rate limit exceeded | Retried (shared rule), then fails, status kept | `PROVIDER_RATE_LIMITED` |
| 5xx | Temporary high demand (`503 UNAVAILABLE`) or server error | Retried (shared rule), then fails, status kept | `PROVIDER_UNAVAILABLE` |

### Provider error codes and body

Errors are `application/json` formatted either as an array `[{"error":{"code":400,"message":"...","status":"INVALID_ARGUMENT"}}]` (for an invalid key) or an object `{"error":{"code":...,"message":"...","status":"..."}}`. The message is never read or logged; the HTTP status alone chooses our failure code via `failureForHttpStatus` and travels unchanged as `upstreamStatus` ([error handling §4a](../../rule/error_handling.md)).

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | The turn's deadline; an idle stream is stopped by the shared idle watch; SSE lines and the whole body are bounded (`MAX_SSE_LINE_CHARS`, `MAX_RAW_STREAM_CHARS`) | `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Retries | A network error, 429, 5xx or an error chunk before any content: the same request again, at most 3 times, within the deadline (`REJECTION_RETRY`); never once content arrived | `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Rate limit | `Retry-After` honoured by the shared retry rule; no pacing of our own | `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Cache | None. | — |
| Fallback | None (AGT-012): one model; the owner chooses another in Settings. | `packages/adapters/src/providers/geminiApi.ts`, `crates/research-providers/src/gemini_api.rs` |

A turn whose stream ends without `[DONE]` or a `finish_reason` is `PROVIDER_OUTPUT_INVALID`; `finish_reason: "length"` is `PROVIDER_OUTPUT_TRUNCATED` (not retryable); no text at all is `PROVIDER_OUTPUT_EMPTY`.

## 5. Examples

### POST /v1beta/openai/chat/completions

Request (exactly what both runners send for `gemini-3.5-flash-lite` at `low` effort):

<!-- example: gemini-api-chat-request -->
```http
POST /v1beta/openai/chat/completions HTTP/1.1
Host: generativelanguage.googleapis.com
Authorization: Bearer <GEMINI_API_KEY>
Content-Type: application/json
Accept: text/event-stream

{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"Reply with the single word OK."}],"stream":true,"max_completion_tokens":16000,"reasoning_effort":"low"}
```

Verified: live, 2026-11-14, against `generativelanguage.googleapis.com` with these headers and body; `geminiApiDocExamples.test.ts` checks that it equals what the adapter sends.

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Transfer-Encoding: chunked
Cache-Control: private
```

<!-- example: gemini-api-chat-stream -->
```text
data: {"choices":[{"delta":{"content":"OK","role":"assistant"},"index":0}],"created":1794624280,"id":"F8v3apOTJ8varfcP646V6A8","model":"gemini-3.5-flash-lite","object":"chat.completion.chunk"}

data: {"choices":[{"delta":{"extra_content":{"google":{"thought_signature":"EsoDCscDAWkUfRM3iKM8KNCHYYhv27leSV0kiGItRteAVsj7sSqFmdHfs83P03hpIitzMI74VP3Euh0WnbKMMciSwSCWKsQYouq3NxT0qyiehnOR8ggy2pXQPX5fWkvdLEeJh4CB/d6FtCIII14Gm/mIlREEvMONe+XLf64kAk1zC4LyYPJm5BRe7uO0KdFktzM8dCABH/aI2jElSsf8W8jf2b5LRDT7w3K8CkmKSnkK0NmigW5d9/FAMQGnsl/GDNJAonP6CndrTGCEx/b4dEpA/avhlUSQGqBdDgDkmh4XO5xn8cNk97etefn4Td1mxM4tPhaqqzLfhHMq9e6T1nGUjJMedkBbInVIIuKxNvlz+h2flmeniTDF0NokLvr2mgb6GIxXgknCaCguQUW1XxzGgT/5iu+PYJCjdW07A5OckiU/R8gzV5oRxzahxxd0lDUsLmvvhaRE1Rk508eGBRraw+m3tG3sxqaq9NzFYyDyg6EbvPZFVIjFgntr5ow7GGWDrtfuBuRRK5wYD0MXKku6J6go+RZuBlMUukvy8gb7V1iIk3rGzUB3CbKjYavbRfsF5KoXVeFYjqkxFGf7KjbU/4IkFN2eUYg7078="}},"role":"assistant"},"finish_reason":"stop","index":0}],"created":1794624280,"id":"F8v3apOTJ8varfcP646V6A8","model":"gemini-3.5-flash-lite","object":"chat.completion.chunk"}

data: [DONE]
```

Verified: live, 2026-11-14, against `generativelanguage.googleapis.com` (the request above). The complete stream (`fixtures/gemini-api/ok.sse`); `gemini-3.5-flash` (`fixtures/gemini-api/thinking-ok.sse`) and a capped response (`fixtures/gemini-api/length.sse`) are recorded beside the adapter tests.

### Error response

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=UTF-8
```

```json
[{
  "error": {
    "code": 400,
    "message": "Please pass a valid API key",
    "status": "INVALID_ARGUMENT"
  }
}
]
```

Verified: live, 2026-11-14, against `generativelanguage.googleapis.com` with an invalid Bearer token (`fixtures/gemini-api/error-400.json`).

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `$.choices[0].delta.content` | Non-empty strings forwarded unchanged, in order; at most `MAX_OUTPUT_TEXT_CHARS` per turn | `AgentEvent` `text.delta` `.text` (`packages/contracts/src/agent.ts`; Rust `AgentEvent::TextDelta`) | Not stored by the adapter (the pipeline stores the parsed answer) |
| `$.choices[0].finish_reason` | Any string ends the answer; `length` → `PROVIDER_OUTPUT_TRUNCATED` | `AgentEvent` `completed` / `failed.code` | Not stored |
| Cost (absent) | Never reported by this endpoint: cost is `null` (unknown), never 0 | `AgentEvent` `usage.knownCostUsd` = `null` | Not stored |
| HTTP status of a refused request | Unchanged | `AgentEvent` `failed.upstreamStatus` | Not stored |

## 7. Maintenance

### Known differences between the runners

None. Both build the same body bytes (checked by `geminiApi.test.ts` and the Rust `body_matches_the_typescript_runner_byte_for_byte` test) and parse chunks with the shared OpenRouter chunk parser. The Rust runner speaks HTTP/1.1 through its DNS-pinned client, which lists `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` as a fixed endpoint; the TypeScript runner uses the runner's fetch with redirects refused.

### Open issues

- The backend is plan-limited and emits `knownCostUsd: null`; if metered USD accounting is wanted later for a billed Gemini project, a price table (like the Claude API's) would be needed.
- `GET /v1beta/openai/models` is not called: the offered models are a fixed list in both adapters, checked live on 2026-11-14. A new model can be typed through "Other" until it is added to `GEMINI_API_MODELS`.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-11-14 | live | Streamed HTTP/1.1 completions for `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash` and `gemini-3.1-flash-lite`; `finish_reason: "length"` at 5 tokens; 400 for an invalid key and invalid `max_completion_tokens`; 404 for unknown/deprecated models; 429 (`gemini-3.1-pro-preview`) and 503 (`gemini-3.8-flash`) | Antigravity agent |
