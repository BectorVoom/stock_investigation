# External API: Claude API

## 1. Overview

| Property | Value |
|---|---|
| Provider | Anthropic |
| Purpose | The metered `claude-api` agent backend ("Claude API" in Settings → AI agent, [ADR-0031](../../adr/0031-claude-api-backend.md)): one streaming Messages request per agent turn of a research run, a notebook-assistant turn or a scheduled task. The answer text is the turn's output; the token counts price the turn from the runner's own model table. |
| Hosts | `api.anthropic.com` |
| Endpoints | `POST /v1/messages` — one model turn, streamed as server-sent events |
| Authentication | API key in the `x-api-key` header; env variable `ANTHROPIC_API_KEY` in `apps/runner/.env` (8–512 printable ASCII characters after trimming, else the backend is "not configured"). `ANTHROPIC_BASE_URL` is ignored and redirects are refused, so the key reaches only this origin. `CLAUDE_API_KEY` is not read by any code. |
| Configuration | The model comes from Settings → AI agent (`owner_settings.agent_settings_json`) and must be one of `CLAUDE_API_MODELS` (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`; `claude-opus-5-5` when empty). Effort comes from the run (`low` / `medium` / `high`). No other variable. |
| Usage Limits | Anthropic's per-organization rate limits by usage tier (requests, input and output tokens per minute) and a monthly spend cap per tier ([rate limits](https://platform.claude.com/docs/en/api/rate-limits)); the live check on 2026-10-31 reported 4,000 requests, 2,000,000 input and 400,000 output tokens per minute for `claude-haiku-5-5`. Our caps: `max_tokens` 16,000 per request (thinking and answer together), the run's authorized maximum spend, at most 3 retries of a request refused before any output. No pacing and no cache. |
| Called By | Rust runner (default) and TypeScript runner (rollback), for every agent turn of a job whose backend is `claude-api` (research, notebook assist, scheduled task). The probe never calls the API. |
| Code | `crates/research-providers/src/claude_api.rs`, `crates/research-providers/src/http_turn.rs`, `crates/research-providers/src/http.rs`, `crates/research-providers/src/turn.rs`, `crates/research-providers/src/schema.rs`, `packages/adapters/src/providers/claudeApi.ts`, `packages/adapters/src/providers/httpTurn.ts`, `packages/adapters/src/providers/turn.ts`, `packages/adapters/src/providers/lines.ts`, `packages/adapters/src/runtime/retryAfter.ts`, `crates/research-net/src/retry_after.rs` |
| Official Documentation | [Messages API reference](https://platform.claude.com/docs/en/api/messages/create), [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming), [Errors](https://platform.claude.com/docs/en/api/errors), [Rate limits](https://platform.claude.com/docs/en/api/rate-limits), [Versions](https://platform.claude.com/docs/en/api/versioning), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Last Verified | 2026-10-31, live (one streamed answer, one 401, one 404; see section 7) |

For each turn the runner checks the key and the model first — a missing key fails with `NOT_CONFIGURED` and an unpriced model with `PROVIDER_MODEL_INVALID`, both before any network activity. It then sends one `POST /v1/messages` with the prompt as a single user message, no `system`, no `tools`, no `thinking` field (the models think adaptively by default) and `stream: true`. It forwards every `text_delta` as a `text.delta` event, never forwards thinking, fails the turn closed on any tool block, and once `message_delta` has delivered the final usage it computes the turn's cost in USD from `CLAUDE_API_MODELS` and reports it as a `usage` event before `completed` or `failed`.

## 2. Input Parameters

### POST /v1/messages

The body is built by `buildClaudeRequestBody` / `build_request_body` with this exact key order (the Rust parity vectors compare the bytes).

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `x-api-key` | header | string | Yes | None; we send `ANTHROPIC_API_KEY` | 8–512 printable ASCII, no spaces (our check) | The API key. Never logged, never placed in an event. |
| `anthropic-version` | header | string | Yes (the reference marks it optional; the [versioning page](https://platform.claude.com/docs/en/api/versioning) says it must be sent) | We send `2026-10-21` | `2023-06-01` or `2026-10-21` | API version. On `2026-10-21` `temperature`, `top_p` and `top_k` are rejected with 400; we send none. |
| `content-type` | header | string | Yes | We send `application/json` | — | Body encoding. |
| `accept` | header | string | No | We send `text/event-stream` | — | The answer is read as SSE. |
| `model` | body | string | Yes | None; we send the Settings model or `claude-opus-5-5` | One of `CLAUDE_API_MODELS` (our check) | Model id. |
| `max_tokens` | body | integer | Yes | None; we send `16000` (`MAX_OUTPUT_TOKENS`) | ≥ 0; per-model maximum (128K for these models) | Cap on thinking plus visible output; bounds one turn's spend (AGT-008). |
| `messages` | body | array | Yes | — | Exactly one element | The conversation. |
| `messages[0].role` | body | string | Yes | — | `user` | Role of the only message. |
| `messages[0].content` | body | string | Yes | — | String shorthand for one text block | The turn's prompt (`AgentRequest.prompt`). |
| `stream` | body | boolean | No | Provider: `false`; we send `true` | — | Server-sent events instead of one JSON message. |
| `output_config.effort` | body | string | No | Provider: `medium` on `claude-opus-5-5` and `claude-haiku-5-5`, `high` on the others; we send the run's effort | Provider: `low`, `medium`, `high`, `xhigh`, `max`; we send `low`, `medium` or `high` | Thinking depth and overall token spend. |

## 3. Output Parameters

### POST /v1/messages

`200 OK` with `content-type: text/event-stream; charset=utf-8`. Each event is an `event: <name>` line, a `data: <json>` line and a blank line; the JSON's `type` equals the event name. Order: one `message_start`, then per content block one `content_block_start`, zero or more `content_block_delta` and one `content_block_stop`, then one or more `message_delta`, then `message_stop`; `ping` events may appear anywhere and an `error` event may end the stream. The code reads only `data:` lines (the `event:` line is ignored because every payload names its type) and skips any `type` it does not know, as the [versioning policy](https://platform.claude.com/docs/en/api/versioning) asks. Production pads some payloads with spaces before the closing brace (see the example); the JSON is still valid.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `event:` line | text | No | No | No | SSE event name, equal to the payload's `type`. |
| `$.type` | string | No | No | Yes | Event type: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`; any other value is skipped. |
| **`message_start`** | | | | | |
| `$.message` | object | No | No | Yes | The `Message` with empty `content`; must be an object. |
| `$.message.id` | string | No | No | No | Message id (`msg_…`). |
| `$.message.type` | string | No | No | No | Always `message`. |
| `$.message.role` | string | No | No | No | Always `assistant`. |
| `$.message.content` | array | No | No | No | Empty at this point. |
| `$.message.model` | string | No | No | No | Model that answers. |
| `$.message.stop_reason` | string | Yes | No | No | `null` in `message_start`. |
| `$.message.stop_sequence` | string | Yes | No | No | `null` here. |
| `$.message.stop_details` | object | Yes | No | No | `null` here. |
| `$.message.container` | object | Yes | No | No | Container of a container tool; `null` (we send no tools). |
| `$.message.diagnostics` | object | Yes | No | No | Cache diagnostics; `null` (we request none). |
| `$.message.usage` | object | No | No (code tolerates absence) | Yes | Token counts so far. |
| `$.message.usage.input_tokens` | integer | No | No | Yes | Uncached input tokens. |
| `$.message.usage.cache_creation_input_tokens` | integer | Yes | No | Yes | Tokens written to the cache (0: we request no caching). |
| `$.message.usage.cache_read_input_tokens` | integer | Yes | No | Yes | Tokens read from the cache. |
| `$.message.usage.cache_creation` | object | Yes | No | No | `ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens` (integers). |
| `$.message.usage.output_tokens` | integer | No | No | Yes | Output tokens so far. |
| `$.message.usage.output_tokens_details` | object | Yes | Yes (absent in `message_start` live) | No | `thinking_tokens` (integer). |
| `$.message.usage.server_tool_use` | object | Yes | Yes (absent live) | No | `web_search_requests`, `web_fetch_requests` (integers). |
| `$.message.usage.service_tier` | string | Yes | No | No | `standard`, `priority` or `batch`. |
| `$.message.usage.inference_geo` | string | Yes | No | No | Region of inference, e.g. `global`. |
| `$.message.usage.speed` | string | Yes | No | No | `standard` or `fast`. |
| **`content_block_start`** | | | | | |
| `$.index` | integer | No | No | No | Position of the block in the final `content`. |
| `$.content_block.type` | string | No | No | Yes | `text`, `thinking` and `redacted_thinking` are accepted; every other type (`tool_use`, `server_tool_use`, tool results, `container_upload`, …) fails the turn with `PROVIDER_TOOL_ISOLATION_VIOLATED`. |
| `$.content_block.text` | string | No | Yes (text blocks only) | Yes | Initial text of a `text` block (usually empty); forwarded when non-empty. |
| `$.content_block.citations` | array | Yes | Yes | No | Citations of a text block (none: we send no documents). |
| `$.content_block.thinking`, `$.content_block.signature` | string | No | Yes (thinking blocks only) | No | Thinking text (empty: display is omitted by default) and its signature. Never forwarded. |
| `$.content_block.data` | string | No | Yes (`redacted_thinking` only) | No | Encrypted thinking. |
| **`content_block_delta`** | | | | | |
| `$.index` | integer | No | No | No | Block index. |
| `$.delta.type` | string | No | No | Yes | `text_delta` (forwarded), `thinking_delta` and `signature_delta` (ignored), `citations_delta` (ignored), `input_json_delta` (fails the turn with `PROVIDER_TOOL_ISOLATION_VIOLATED`). |
| `$.delta.text` | string | No | Yes (`text_delta` only) | Yes | Next piece of the answer; forwarded as `text.delta` when non-empty. |
| `$.delta.thinking`, `$.delta.signature`, `$.delta.partial_json`, `$.delta.citation` | string / object | No | Yes (their delta type only) | No | Payloads of the other delta types. |
| **`content_block_stop`** | | | | | |
| `$.index` | integer | No | No | No | Block index. |
| **`message_delta`** | | | | | |
| `$.delta` | object | No | No | Yes | Top-level changes; must be an object. |
| `$.delta.stop_reason` | string | Yes | No | Yes | `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`; mapped in section 4. |
| `$.delta.stop_sequence` | string | Yes | No | No | `null` (we send no stop sequences). |
| `$.delta.stop_details` | object | Yes | No | No | Only for `refusal`: `type`, `category`, `explanation`. |
| `$.delta.container` | object | Yes | No | No | `null`. |
| `$.usage` | object | No | No (code tolerates `null` or absence) | Yes | Cumulative counts; its presence marks the final usage. |
| `$.usage.input_tokens` | integer | Yes | No | Yes | Cumulative input tokens. |
| `$.usage.cache_creation_input_tokens` | integer | Yes | No | Yes | Cumulative cache writes. |
| `$.usage.cache_read_input_tokens` | integer | Yes | No | Yes | Cumulative cache reads. |
| `$.usage.output_tokens` | integer | No | No | Yes | Cumulative output tokens, thinking included. |
| `$.usage.output_tokens_details.thinking_tokens` | integer | No | Yes (object nullable) | No | Thinking share of `output_tokens`. |
| `$.usage.server_tool_use` | object | Yes | Yes | No | Server tool counts. |
| **`message_stop`**, **`ping`** | | | | | |
| `$.type` | string | No | No | Yes | `message_stop` ends the stream; `ping` is skipped. No other fields. |
| **`error`** | | | | | |
| `$.error` | object | No | No | Yes | Must be an object. |
| `$.error.type` | string | No | No | Yes | Error type, mapped in section 4. |
| `$.error.message` | string | No | No | No | Human-readable text; never read, so it can never reach a log or the UI. |

Every token count the code reads must be a non-negative integer up to 2^53 − 1 (or `null`/absent); anything else makes the line malformed. More than 8 malformed lines fail the turn with `PROVIDER_OUTPUT_INVALID`.

## 4. Error Handling

### HTTP status codes

A non-2xx answer arrives before generation, so nothing was billed. Its body is read — at most 64 KiB (`MAX_ERROR_BODY_BYTES`; a longer, unreadable or non-JSON body counts as absent) — only to recognise a spend limit (next section); otherwise the status decides. Every failure built from an answer status carries it unchanged as `upstreamStatus` ([error handling §4a](../../rule/error_handling.md)). "Retried" means the same request is sent again inside the turn (see the next table).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | `invalid_request_error`: bad request | Fails the turn, not retried | `PROVIDER_REQUEST_REJECTED` (400) |
| 400 | `invalid_request_error` whose message starts `You have reached your specified`: an organization or workspace spend limit the owner set was reached | Fails the turn at once, not retried | `PROVIDER_PAYMENT_REQUIRED` (400) |
| 401 | `authentication_error`: missing, malformed, revoked or expired key | Fails the turn, not retried | `PROVIDER_AUTH` (401) |
| 402 | `billing_error` | Fails the turn, not retried | `PROVIDER_PAYMENT_REQUIRED` (402) |
| 403 | `permission_error` | Fails the turn, not retried | `PROVIDER_AUTH` (403) |
| 404 | `not_found_error`: the model is unknown or not available to this key | Fails the turn, not retried | `PROVIDER_MODEL_UNAVAILABLE` (404) |
| 408 | Not documented by Anthropic | Fails the turn, not retried | `PROVIDER_TIMEOUT` (408) |
| 409, 413, other 4xx | `conflict_error`, `request_too_large` | Fails the turn, not retried | `PROVIDER_REQUEST_REJECTED` (status) |
| 429 | `rate_limit_error`: a rate limit | Retried, honouring `retry-after` | `PROVIDER_RATE_LIMITED` (429) when retries are exhausted |
| 429 | `rate_limit_error` with `error.details.error_code` `enforced_spend_limit_reached`: the tier's monthly spend cap (no `retry-after`; keeps failing until the next month) | Fails the turn at once, not retried | `PROVIDER_PAYMENT_REQUIRED` (429) |
| 504 | `timeout_error` | Fails the turn, not retried in the turn (the job may retry; the code is retryable), like a `timeout_error` event | `PROVIDER_TIMEOUT` (504) |
| 500, 529, other 5xx | `api_error`, `overloaded_error` | Retried | `PROVIDER_UNAVAILABLE` (status) when retries are exhausted |
| 3xx | Not expected | The redirect is refused (TS `redirect: "error"`, Rust `REDIRECT_REFUSED`) and treated as a network error: retried | `PROVIDER_UNAVAILABLE` (no status) |

### Provider error codes and body

A rejected request answers `content-type: application/json` with `{"type":"error","error":{"type":…,"message":…},"request_id":…}` ([errors](https://platform.claude.com/docs/en/api/errors)); the spend-cap 429 adds `error.details.error_code` ([rate limits](https://platform.claude.com/docs/en/api/rate-limits#reaching-your-spend-cap)). The `request-id` header carries the same id and `x-should-retry` says whether a retry may help; the code reads neither header. From the body `failureForClaudeRejection` / `failure_for_claude_rejection` reads `error.type`, `error.details.error_code` and whether `error.message` starts with `You have reached your specified` (the documented start of an owner-set spend limit, [rate limits](https://platform.claude.com/docs/en/api/rate-limits#setting-your-own-spend-limit)); the message is never stored, logged or placed in an event. A body that does not match the shape (`error` an object, `type` and `message` strings or absent, `details` an object or `null`) is treated as absent.

| Rejected answer's body | Our error code |
|---|---|
| `error.type` `rate_limit_error` and `error.details.error_code` `enforced_spend_limit_reached` | `PROVIDER_PAYMENT_REQUIRED` (status kept), not retried |
| `error.type` `invalid_request_error` and `error.message` starting `You have reached your specified` | `PROVIDER_PAYMENT_REQUIRED` (status kept), not retried |
| anything else, or no readable body | By status (table above) |

After a `200` the stream can instead end with an `error` event of the same `error` shape (no HTTP status). Its `error.type` is mapped by `failureForClaudeErrorType` / `failure_for_claude_error_type`; the resulting failure has no `upstreamStatus`, because no status was answered.

| `error.type` (stream `error` event) | Our error code |
|---|---|
| `overloaded_error`, `api_error` | `PROVIDER_UNAVAILABLE` |
| `rate_limit_error` | `PROVIDER_RATE_LIMITED` |
| `authentication_error`, `permission_error` | `PROVIDER_AUTH` |
| `billing_error` | `PROVIDER_PAYMENT_REQUIRED` |
| `timeout_error` | `PROVIDER_TIMEOUT` |
| `not_found_error` | `PROVIDER_MODEL_UNAVAILABLE` |
| anything else or missing | `PROVIDER_REQUEST_REJECTED` |

An `error` event before `message_start` is a rejection (nothing generated; `PROVIDER_UNAVAILABLE` and `PROVIDER_RATE_LIMITED` are retried); after `message_start` it fails the turn at once. A stream that ends otherwise is classified by its stop reason or by what is missing:

| Outcome | Our result |
|---|---|
| `stop_reason` `end_turn` / `stop_sequence` with some text | `completed` |
| `end_turn` / `stop_sequence` with no text | `PROVIDER_OUTPUT_EMPTY` (retryable) |
| `max_tokens`, `model_context_window_exceeded` | `PROVIDER_OUTPUT_TRUNCATED` |
| `refusal` | `PROVIDER_REFUSED` (no fallback model) |
| `tool_use`, `pause_turn`, a tool block, an `input_json_delta` | `PROVIDER_TOOL_ISOLATION_VIOLATED` |
| any other `stop_reason` | `PROVIDER_OUTPUT_INVALID` |
| closed before `message_stop`, or no `stop_reason` | `PROVIDER_OUTPUT_INVALID` |
| more than 8 malformed lines | `PROVIDER_OUTPUT_INVALID` |
| more than 2 MiB of answer text / 32 MiB of stream | `PROVIDER_OUTPUT_TOO_LARGE` |
| body read failed mid-stream | `PROVIDER_UNAVAILABLE` (not retried: generation had started) |

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 120 s of silence before the headers or between two chunks stops the turn (`PROVIDER_TIMEOUT`); the run's `deadline` bounds the whole turn (`DEADLINE_EXCEEDED`). Stream cap 32 MiB raw, 16 MiB per line, 2 MiB of answer text. | `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs`, `crates/research-providers/src/http.rs` |
| Retries | Only a request refused before any output (network error, 3xx, a 429 that is not the spend cap, a 5xx other than 504, or an `error` event before `message_start` that maps to `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMITED`): the same request, up to 3 retries, waiting `retry-after` or 2 s, 4 s, 8 s; no retry when the wait would exceed 30 s or leave less than 30 s of the deadline. Never after `message_start`, never to another model. | `packages/adapters/src/providers/httpTurn.ts` (`REJECTION_RETRY`), `crates/research-providers/src/http_turn.rs` |
| Transport | Rust: `PinnedProviderHttpClient`, the providers' own client: every request resolves the host afresh (every answer must be public) and tries each resolved address in order until a TLS connection opens. `POST /v1/messages` never reuses an idle connection and its connection is closed after the answer, as in research-net's transport (`crates/research-net/src/pinned.rs`): a reused connection that failed after the server had read the body would make the turn's retry deliver, and bill, the prompt twice. (Only a GET — OpenRouter's catalogue — keeps an idle connection, for up to 90 s.) A failed send is a transport error (`HTTP_FAILED`), a rejection before any output, retried by the turn as above. TypeScript: Node's `fetch` (undici) may send the POST on an idle keep-alive connection (undici only avoids queuing it behind another request) and never resends it itself; a failure there is a network error the turn retries after 2 s (see Known differences). | `crates/research-providers/src/http.rs`, `apps/runner/src/main.ts` |
| Rate limit | `retry-after` (delay-seconds or HTTP date) is read; the `anthropic-ratelimit-*` headers are not. No pacing of our own. | `packages/adapters/src/runtime/retryAfter.ts` (`parseRetryAfterMs`, shared), `crates/research-net/src/retry_after.rs`, `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Cache | None. No prompt caching is requested; reported cache writes are priced at the 1-hour rate (2× input) so spend is never under-reported. | `packages/adapters/src/providers/claudeApi.ts` (`claudeCostUsd`) |
| Fallback | None (AGT-012): no `fallbacks`, no other model. The run card shows the failure code; the owner may pick another backend or model. | `packages/adapters/src/providers/claudeApi.ts` |

## 5. Examples

### POST /v1/messages

Request — the bounded diagnostic request the live check sent: the body `buildClaudeRequestBody("claude-haiku-5-5", "Reply with the single word OK.", "low")` returns, with the headers both runners set, except `max_tokens` 16 instead of the code's 16000 (`MAX_OUTPUT_TOKENS`), to bound the check's spend:

<!-- example: claude-api-messages-request -->
```http
POST /v1/messages HTTP/1.1
Host: api.anthropic.com
x-api-key: <ANTHROPIC_API_KEY>
anthropic-version: 2026-10-21
content-type: application/json
accept: text/event-stream

{"model":"claude-haiku-5-5","max_tokens":16,"messages":[{"role":"user","content":"Reply with the single word OK."}],"stream":true,"output_config":{"effort":"low"}}
```

Verified: live, 2026-10-31, `curl` with exactly these headers and body (sent over HTTP/2; the runners send it over HTTP/1.1). A production request differs only in `max_tokens` (16000); `claudeApiDocExamples.test.ts` checks that every other byte equals what the code sends.

Response (the complete stream; the `ping` payload's spaces and the padding before closing braces are as received):

```http
HTTP/2 200
content-type: text/event-stream; charset=utf-8
cache-control: no-cache
anthropic-ratelimit-input-tokens-limit: 2000000
anthropic-ratelimit-output-tokens-limit: 400000
anthropic-ratelimit-requests-limit: 4000
anthropic-ratelimit-requests-remaining: 3999
anthropic-ratelimit-requests-reset: 2026-10-31T04:50:28Z
request-id: req_011CgZiJH6bRej6qq6jdLypZ
```

<!-- example: claude-api-messages-stream -->
```text
event: message_start
data: {"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_011CgZiJHsE6pxLMujG4Y7gi","type":"message","role":"assistant","content":[],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":18,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":4,"service_tier":"standard","inference_geo":"global","speed":"standard"},"diagnostics":null}    }

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}       }

event: content_block_stop
data: {"type":"content_block_stop","index":0             }

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"container":null},"usage":{"input_tokens":18,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4,"output_tokens_details":{"thinking_tokens":0}}  }

event: message_stop
data: {"type":"message_stop"             }
```

Verified: live, 2026-10-31, `curl -N` (the request above with `max_tokens` 16). Body complete and unedited. Status line and headers as curl received them over HTTP/2 (trailing space after the status code dropped), in capture order, trimmed to the relevant ones (account and workspace ids, tracing and Cloudflare headers dropped). The runners speak HTTP/1.1; no HTTP/1.1 capture was made.

### Error responses

Invalid key (`x-api-key: sk-ant-invalid-doc-example-key`):

```http
HTTP/2 401
content-type: application/json
request-id: req_011CgZiHmim6ysfMAyVn8gEk
x-should-retry: false
```

<!-- example: claude-api-error-401 -->
```json
{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CgZiHmim6ysfMAyVn8gEk"}
```

Verified: live, 2026-10-31, `curl` over HTTP/2 with a made-up key and the request above. Body unedited; headers trimmed.

Unknown model (`"model":"claude-doc-example-0"` with a valid key; our runners refuse such an id before sending, so in production this status means a listed model the key cannot use):

```http
HTTP/2 404
content-type: application/json
x-should-retry: false
request-id: req_011CgZiK462HWei6bowAUmnm
```

<!-- example: claude-api-error-404 -->
```json
{"type":"error","error":{"type":"not_found_error","message":"model: claude-doc-example-0"},"request_id":"req_011CgZiK462HWei6bowAUmnm"}
```

Verified: live, 2026-10-31, `curl` over HTTP/2 with the real key and an unknown model id. Body unedited; headers trimmed.

The tier's monthly spend cap (HTTP 429 without `retry-after`; the turn fails at once with `PROVIDER_PAYMENT_REQUIRED` (429), not retried):

```http
HTTP/1.1 429 Too Many Requests
content-type: application/json
```

<!-- example: claude-api-error-429-spend-cap -->
```json
{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.","details":{"error_code":"enforced_spend_limit_reached"}},"request_id":"req_018EeWyXxfu5pfWkrYcMdjWG"}
```

Verified: spec, 2026-10-31, https://platform.claude.com/docs/en/api/rate-limits#reaching-your-spend-cap (body as published, compacted to one line; status line and headers from the same page's description). Not observed live (cannot be provoked without spending the cap).

Error event inside a `200` stream (here before `message_start`, so the request is retried; when every retry meets it the turn fails with `PROVIDER_UNAVAILABLE`):

<!-- example: claude-api-stream-error-overloaded -->
```text
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

Verified: spec, 2026-10-31, https://platform.claude.com/docs/en/build-with-claude/streaming#error-events. Not observed live (cannot be provoked).

**Test fixtures** (`packages/adapters/test/providers/fixtures/claude-api/`). Recorded from the live checks above: `ok.sse` (the complete stream, byte for byte), `error-401.json`, `error-404.json` (the bodies, re-indented by the formatter). Documentation-derived, because the case cannot be provoked live: `error-429-spend-cap.json` (the example above), `thinking-then-text.sse`, `max-tokens.sse`, `midstream-error.sse`, `overloaded-before-start.sse`, `refusal.sse`, `tool-use.sse`.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `content_block_delta.delta.text` (`text_delta`), non-empty `content_block_start.content_block.text` | Forwarded unchanged, in order; UTF-16 length counted against 2 MiB | `AgentEvent` `text.delta.text` (`packages/contracts/src/agent.ts`; Rust `AgentEvent::TextDelta`) | Not stored as received; the research pipeline and the notebook assistant (`packages/application/src/research/pipeline.ts`, `packages/application/src/notebook/assistTurn.ts`) parse the whole answer into what they publish ([`claims`](../../database/tables/claims.md), [`research_records`](../../database/tables/research_records.md), [`notebook_turns`](../../database/tables/notebook_turns.md)) |
| `message_start.message.usage.*`, `message_delta.usage.*` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`) | Later events replace earlier fields; once a `message_delta` usage arrived, cost USD = (input × price.input + cache writes × price.input × 2 + cache reads × price.cacheRead + output × price.output) / 10^6, with Haiku 5.5's long-prompt price when input + cache tokens > 100,000; unknown (`null`) when no final usage or a count is missing | `AgentEvent` `usage.knownCostUsd`; summed into `ResourceUsage.knownCostUsd` (`packages/contracts/src/jobs.ts`) | [`research_jobs.usage_json`](../../database/tables/research_jobs.md) |
| `message_delta.delta.stop_reason`, `error.error.type`, HTTP status, a rejected answer's `error.type` / `error.details.error_code` / `error.message` prefix | Section 4 tables (the message itself is never kept) | `AgentEvent` `failed.code`, `failed.retryable`, `failed.upstreamStatus` (status unchanged; absent for stream errors) | [`research_jobs.failure_code`](../../database/tables/research_jobs.md), [`research_jobs.failure_upstream_status`](../../database/tables/research_jobs.md); notebook turns in [`notebook_turns.body_json`](../../database/tables/notebook_turns.md) |
| `retry-after` header | Seconds × 1000, or HTTP date − now | Retry delay of the turn | Not stored |

## 7. Maintenance

### Known differences between the runners

- Transport: Rust sends through `PinnedProviderHttpClient` (`crates/research-providers/src/http.rs`), which accepts only the three fixed provider URLs, resolves `api.anthropic.com` afresh for every request, connects only to public addresses (SEC-002), speaks HTTP/1.1, sends no `user-agent` or `accept-encoding`, and opens a fresh connection for every POST. TypeScript uses the runtime's global `fetch` (`apps/runner/src/main.ts`), which adds its own `user-agent`, `accept-encoding` and `accept-language` headers, does no address check, and may send the POST on an idle keep-alive connection (undici); if that connection fails after the server read the body, the turn's retry could deliver the prompt twice. The TypeScript runner is the rollback runner, so this was left as is.
- Header names: both send the lowercase names shown in section 2.
- Otherwise none: the body bytes, the event interpretation and the cost arithmetic are held equal by `vectors/providers/claude-api.json` (`crates/research-providers/tests/vectors.rs`).

### Open issues

- The error-event and spend-cap examples are `spec` only; an `overloaded_error` mid-stream and a spent cap cannot be provoked. The owner-set spend limit is recognised by the start of its message, which Anthropic documents but does not mark with a code; if the wording changes, that 400 falls back to `PROVIDER_REQUEST_REJECTED` (still not retried).
- Prices and model ids in `CLAUDE_API_MODELS` come from Anthropic's model table cached 2026-10-06; Claude Haiku 5.5's cache-read price is assumed (0.1× input). Re-check them against the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) when a model is added.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | live | `POST /v1/messages` streamed with `claude-haiku-5-5`, `max_tokens` 16, effort `low` (complete stream above, 18 input / 4 output tokens); 401 with an invalid key; 404 with an unknown model. Rate-limit headers observed. | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | Rejected-answer bodies now read: the spend-cap 429 (`error.details.error_code`, example added) and the owner-set spend-limit 400 (message prefix) against the [rate limits](https://platform.claude.com/docs/en/api/rate-limits) and [errors](https://platform.claude.com/docs/en/api/errors) pages; 504 `timeout_error` mapped to `PROVIDER_TIMEOUT`. Recorded fixtures replace the documentation-derived `ok.sse`. | Claude (external API defect fixes) |
| 2026-10-31 | spec | Request parameters, every stream event and field, error types and statuses, rate-limit headers, `anthropic-version` 2026-10-21 against the official reference pages linked in the Overview | Claude (external API documentation, ADR-0047) |
