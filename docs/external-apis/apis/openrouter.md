# External API: OpenRouter

## 1. Overview

| Property | Value |
|---|---|
| Provider | OpenRouter |
| Purpose | Two agent backends ([AGENT_BACKENDS.md](../../AGENT_BACKENDS.md)): the metered `openrouter` backend and the plan-limited `openrouter-free` backend (models served at no charge). Each agent turn is one streaming OpenAI-compatible chat completion; the free backend's model selector is filled from OpenRouter's public model catalogue. |
| Hosts | `openrouter.ai` |
| Endpoints | `POST /api/v1/chat/completions` — one model turn, streamed as server-sent events; `GET /api/v1/models` — the model catalogue (read for its free text models) |
| Authentication | Chat: `Authorization: Bearer <key>`, env variable `OPENROUTER_API_KEY` in `apps/runner/.env` (8–512 printable ASCII after trimming; a free account's key works for `openrouter-free`). Catalogue: no credential is sent. Redirects are refused, so the key reaches only this origin. |
| Configuration | `OPENROUTER_MODEL` (metered backend's model when Settings names none; required for that backend to be available), `OPENROUTER_FREE_MODEL` (free backend's fallback model, a `:free` id or `openrouter/free`). The model chosen in Settings → AI agent (`owner_settings.agent_settings_json`) wins over both. |
| Usage Limits | Free models: 20 requests a minute, and 50 a day for an account that bought fewer than 10 credits (1,000 a day otherwise); a key may carry its own credit limit ([limits](https://openrouter.ai/docs/api-reference/limits)). Paid models are billed per token at the routed provider's price. Our caps: `max_completion_tokens` 8,192 per request, the run's authorized maximum spend (metered backend only), at most 3 retries of a request refused before any output. Catalogue: cached 10 minutes, a failed refresh suppresses the next for 60 s, one request in flight, 10 s timeout, 8 MiB body, at most 300 ids kept. |
| Called By | Rust runner (default) and TypeScript runner (rollback). Chat: every agent turn of a job whose backend is `openrouter` or `openrouter-free`. Catalogue: the `openrouter-free` probe, only when `OPENROUTER_API_KEY` is set. |
| Code | `crates/research-providers/src/openrouter.rs`, `crates/research-providers/src/openrouter_models.rs`, `crates/research-providers/src/http_turn.rs`, `crates/research-providers/src/http.rs`, `crates/research-providers/src/turn.rs`, `packages/adapters/src/providers/openRouter.ts`, `packages/adapters/src/providers/openRouterModels.ts`, `packages/adapters/src/providers/httpTurn.ts`, `packages/adapters/src/providers/turn.ts` |
| Official Documentation | [Chat completion](https://openrouter.ai/docs/api-reference/chat-completion), [Streaming](https://openrouter.ai/docs/api-reference/streaming), [Parameters](https://openrouter.ai/docs/api-reference/parameters), [Usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting), [Errors](https://openrouter.ai/docs/api-reference/errors), [Limits](https://openrouter.ai/docs/api-reference/limits), [List models](https://openrouter.ai/docs/api-reference/models/get-models) |
| Last Verified | 2026-10-31, live (catalogue; a streamed free-model turn; 401, 403 and 429 answers; see section 7) |

For each turn the runner first checks the key and the model — the metered backend fails with `NOT_CONFIGURED` without a key or a valid model id; the free backend fails with `NOT_CONFIGURED`, `PROVIDER_MODEL_REQUIRED` or `PROVIDER_MODEL_INVALID` (any id that is not free) — then sends one chat completion naming exactly one model, with the prompt as a single user message and no `tools` and no `models` fallback list. It forwards every non-empty `choices[0].delta.content` as `text.delta`. The metered backend reports `usage.cost` from the final chunk as the turn's cost; the free backend always reports the cost as unknown and fails closed with `PROVIDER_FREE_MODEL_CHARGED` if any chunk reports a cost above zero. Separately, the free backend's probe reads `GET /api/v1/models` without a key and offers the free text models in Settings.

## 2. Input Parameters

### POST /api/v1/chat/completions

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Authorization` | header | string | Yes | None; we send `Bearer <OPENROUTER_API_KEY>` | — | API key. Never logged, never placed in an event. |
| `Content-Type` | header | string | Yes | We send `application/json` | — | Body encoding. |
| `Accept` | header | string | No | We send `text/event-stream` | — | The answer is read as SSE. |
| `model` | body | string | No (provider) / Yes (us) | Provider: the account's default model; we always send one | Our check: `^[A-Za-z0-9~@][A-Za-z0-9._:/#~@+-]{0,99}$`; for `openrouter-free` a `:free` id or `openrouter/free` | The only model; OpenRouter may still route it to another upstream provider of the same model. |
| `messages` | body | array | Yes | — | Exactly one element | The conversation. |
| `messages[0].role` | body | string | Yes | — | `user` | Role. |
| `messages[0].content` | body | string | Yes | — | — | The turn's prompt (`AgentRequest.prompt`). |
| `stream` | body | boolean | No | Provider: `false`; we send `true` | — | Server-sent events. |
| `max_completion_tokens` | body | integer | No | Provider: the model's maximum; we send `8192` (`MAX_COMPLETION_TOKENS`) | — | Cap on reasoning plus visible output; bounds one turn's spend (AGT-008). Preferred over the deprecated `max_tokens`. |
| `usage.include` | body | boolean | No | We send `true` | — | Deprecated no-op: usage is always included now ([usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)). Kept so older behaviour is covered. |
| `reasoning.effort` | body | string | No | Provider: model default (see the catalogue's `reasoning.default_effort`); we send the run's effort | Provider: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`; we send `low`, `medium` or `high` | Reasoning depth. Sent for every model (a model without reasoning ignores it). OpenRouter turns it into a reasoning budget of about 20 % (`low`), 50 % (`medium`) or 80 % (`high`) of `max_completion_tokens` on models that take a token budget; effort-only models decide for themselves ([reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens)). A model may still spend the whole cap on reasoning (see the example and section 7). |

### GET /api/v1/models

No query parameters (the full list is returned) and no `Authorization` header.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Accept` | header | string | No | We send `application/json` | — | JSON catalogue. |

## 3. Output Parameters

### POST /api/v1/chat/completions

`200 OK` with `content-type: text/event-stream`. Lines are `data: <json>` chunks separated by blank lines, keep-alive comments `: OPENROUTER PROCESSING`, and a final `data: [DONE]`. The code ignores every line not starting with `data:`, ends at `[DONE]`, and validates every chunk; more than 8 malformed lines fail the turn with `PROVIDER_OUTPUT_INVALID`.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `: OPENROUTER PROCESSING` | comment line | No | Yes | No | Keep-alive; ignored. |
| `data: [DONE]` | text | No | No | Yes | End of the stream. |
| `$.id` | string | No | No | No | Generation id (`gen-…`), also in the `x-generation-id` header. |
| `$.object` | string | No | No | No | `chat.completion.chunk`. |
| `$.created` | integer | No | No | No | Unix seconds. |
| `$.model` | string | No | No | No | Model that answered. |
| `$.provider` | string | No | Yes (not in the spec; present live) | No | Upstream provider, e.g. `Nvidia`. |
| `$.system_fingerprint` | string | No | Yes (absent live) | No | Provider fingerprint. |
| `$.service_tier` | string | Yes | Yes (only on the final chunk live) | No | Provider service tier. |
| `$.choices` | array | No | No (code tolerates absence) | Yes | One choice; every element must be an object. |
| `$.choices[].index` | integer | No | No | No | Choice index (0). |
| `$.choices[].delta` | object | No | No (code tolerates absence) | Yes | Incremental message. |
| `$.choices[].delta.content` | string | Yes | Yes | Yes (`choices[0]` only) | Next piece of the answer; forwarded when non-empty. Must be a string or `null` in every choice. |
| `$.choices[].delta.role` | string | No | Yes | No | `assistant`. |
| `$.choices[].delta.reasoning` | string | Yes | Yes | No | Reasoning text; never forwarded. |
| `$.choices[].delta.reasoning_details[]` | array of objects | No | Yes | No | `type` (e.g. `reasoning.text`), `text`, `format`, `index`. |
| `$.choices[].delta.refusal` | string | Yes | Yes | No | Refusal text. |
| `$.choices[].delta.tool_calls` | array | No | Yes | No | Never expected: no `tools` are sent. |
| `$.choices[].finish_reason` | string | Yes | No (code tolerates absence) | Yes (`choices[0]` only) | `null` while streaming, then `stop`, `length`, `tool_calls`, `content_filter` or `error`; must be a string or `null` in every choice. |
| `$.choices[].native_finish_reason` | string | Yes | Yes | No | The upstream provider's own reason. |
| `$.choices[].logprobs` | object | Yes | Yes | No | Not requested. |
| `$.usage` | object | Yes | Yes (final chunk only) | Yes | Usage of the whole request. |
| `$.usage.cost` | number | Yes | Yes | Yes | Charged amount in credits (USD-denominated); unknown when absent, `null`, negative or not finite. |
| `$.usage.prompt_tokens`, `$.usage.completion_tokens`, `$.usage.total_tokens` | integer | No | No | No | Token counts. |
| `$.usage.is_byok` | boolean | No | Yes | No | Bring-your-own-key request. |
| `$.usage.prompt_tokens_details` | object | No | Yes | No | `cached_tokens`, `cache_write_tokens`, `audio_tokens`, `video_tokens`. |
| `$.usage.completion_tokens_details` | object | No | Yes | No | `reasoning_tokens`, `image_tokens`, `audio_tokens`. |
| `$.usage.cost_details` | object | No | Yes | No | `upstream_inference_cost` (may be `null`), `upstream_inference_prompt_cost`, `upstream_inference_completions_cost`. |
| `$.error` | object | No | Yes | Yes | Present on a mid-stream error chunk; its presence fails or rejects the turn (section 4). |
| `$.error.code` | integer or string | No | Yes | Yes | Usually the HTTP status the error mirrors (e.g. `503`); the streaming guide also shows a string (`server_error`). Must be a string or a finite number. |
| `$.error.message` | string | No | No | No | Never read, so it cannot reach a log or the UI. |
| `$.error.metadata` | object | No | Yes | No | e.g. `error_type`, `provider_name`, `raw`. |

### GET /api/v1/models

`200 OK` with `content-type: application/json`, served with `cache-control: public, max-age=120`. The envelope must be an object with a `data` array, else the catalogue is treated as failed; each entry is validated on its own, so one odd entry does not hide the rest. A model is kept when its `id` is a free id (`openrouter/free`, or longer than 5 characters and ending in `:free`) and a valid model id, `pricing.prompt` and `pricing.completion` are both present and numerically zero, and `architecture.output_modalities` contains `text` (or is absent).

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.data` | array | No | No | Yes | Model objects. |
| `$.total_count` | integer | No | No | No | Number of models (456 live). |
| `$.links.next` | string | Yes | No | No | Next page; `null` when the list is complete. |
| `$.data[].id` | string | No | No | Yes | Model id, e.g. `google/gemma-4-31b-it:free`. |
| `$.data[].canonical_slug` | string | No | No | No | Dated slug. |
| `$.data[].hugging_face_id` | string | Yes | Yes | No | Hugging Face repository. |
| `$.data[].name` | string | No | No | No | Display name. |
| `$.data[].created` | integer | No | No | No | Unix seconds. |
| `$.data[].description` | string | No | Yes | No | Description (OpenRouter shortens it, ending with `...`). |
| `$.data[].context_length` | integer | Yes | No | No | Context window. |
| `$.data[].architecture.modality` | string | Yes | No | No | e.g. `text+image+video->text`. |
| `$.data[].architecture.input_modalities` | array of strings | No | No | No | `text`, `image`, `file`, `audio`, `video`. |
| `$.data[].architecture.output_modalities` | array of strings | No | No (code tolerates absence) | Yes | Must contain `text` for the model to be kept; every element must be a string. |
| `$.data[].architecture.tokenizer` | string | No | No | No | Tokenizer family. |
| `$.data[].architecture.instruct_type` | string | Yes | No | No | Instruct format. |
| `$.data[].pricing.prompt` | string | No | No | Yes | USD per input token as a decimal string (a number is accepted too); must parse to 0. |
| `$.data[].pricing.completion` | string | No | No | Yes | USD per output token; must parse to 0. |
| `$.data[].pricing.*` (other keys) | string / number / array | No | Yes | No | e.g. `input_cache_read`, `request`, `image`, `web_search`, `discount`, `overrides`. |
| `$.data[].top_provider` | object | No | No | No | `context_length` (nullable), `max_completion_tokens` (nullable), `is_moderated`. |
| `$.data[].per_request_limits` | object | Yes | No | No | `prompt_tokens`, `completion_tokens`. |
| `$.data[].supported_parameters` | array of strings | No | No | No | Request parameters the model accepts. |
| `$.data[].default_parameters` | object | Yes | No | No | `temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `repetition_penalty` (each nullable). |
| `$.data[].supported_voices` | array | Yes | No | No | Audio voices. |
| `$.data[].knowledge_cutoff` | string | Yes | Yes | No | `YYYY-MM-DD`. |
| `$.data[].expiration_date` | string | Yes | Yes | No | `YYYY-MM-DD`. |
| `$.data[].links.details` | string | No | No | No | Path of the endpoints listing. |
| `$.data[].endpoints` | array of strings | No | No | No | API paths serving the model. |
| `$.data[].alias_target` | object | No | Yes | No | `slug`, `name` of an alias's target. |
| `$.data[].benchmarks` | object | No | Yes | No | `design_arena`, `artificial_analysis` (`intelligence_index`, `coding_index`, `agentic_index`, each nullable). |
| `$.data[].reasoning` | object | No | Yes | No | `mandatory`, `default_enabled`, `supported_efforts` (nullable), `default_effort` (nullable), `supports_max_tokens`. |

## 4. Error Handling

### HTTP status codes

Chat: a non-2xx answer arrives before generation. Its body is read — at most 64 KiB (`MAX_ERROR_BODY_BYTES`; a longer, unreadable or non-JSON body counts as absent) — only for `error.metadata.limit_source` (next section); otherwise the status decides. The failure carries the status unchanged as `upstreamStatus` ([error handling §4a](../../rule/error_handling.md)). "Retried" means the same request inside the turn (next table). Catalogue: any non-2xx is a failed refresh (below).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 400 | Invalid or missing parameters | Fails the turn, not retried | `PROVIDER_REQUEST_REJECTED` (400) |
| 401 | Invalid, disabled or expired key (`"User not found."`) | Fails the turn, not retried | `PROVIDER_AUTH` (401) |
| 402 | Insufficient credits; key credit limit (documented); in-flight budget full (`openrouter_in_flight_budget`, with `Retry-After`) | Fails the turn, not retried | `PROVIDER_PAYMENT_REQUIRED` (402) |
| 403 | A spent budget: `limit_source` `openrouter_key_limit` (live: the key's credit limit), `openrouter_guardrail_budget` or `openrouter_workspace_budget` | Fails the turn, not retried | `PROVIDER_PAYMENT_REQUIRED` (403) |
| 403 | Missing permission, moderation block, or no spent-budget `limit_source` | Fails the turn, not retried | `PROVIDER_AUTH` (403) |
| 404, other 4xx | Not documented for this endpoint | Fails the turn, not retried | `PROVIDER_REQUEST_REJECTED` (status) |
| 408 | Request timed out | Fails the turn, not retried in the turn (the job may retry) | `PROVIDER_TIMEOUT` (408) |
| 429 | OpenRouter's free-model limit, or the upstream provider's (may carry `Retry-After`; the live upstream 429 did not) | Retried, honouring `Retry-After` | `PROVIDER_RATE_LIMITED` (429) when retries are exhausted |
| 500, 502, 503, other 5xx | Model down or invalid answer (502), no provider fits (503) | Retried | `PROVIDER_UNAVAILABLE` (status) when retries are exhausted |
| 3xx | Not expected | Redirect refused, treated as a network error: retried | `PROVIDER_UNAVAILABLE` (no status) |

### Provider error codes and body

A rejected request answers JSON `{"error":{"code":<status>,"message":…,"metadata":{…}}}`, sometimes with a top-level `user_id`; `metadata` may hold `limit_source`, `remedy_hint`, `scope`, `error_type`, `provider_name`, `raw`. `failureForOpenRouterRejection` / `failure_for_openrouter_rejection` reads only `error.metadata.limit_source` ([limits](https://openrouter.ai/docs/api-reference/limits) asks clients to branch on it, not on the hint text); the message never leaves the adapter. A body that does not match (`error` an object, `metadata` an object or `null`, `limit_source` a string or absent) is treated as absent.

| Rejected answer's `error.metadata.limit_source` | Our error code |
|---|---|
| `openrouter_credits`, `openrouter_key_limit`, `openrouter_guardrail_budget`, `openrouter_workspace_budget` (a spent budget: the owner must add credit or raise a limit) | `PROVIDER_PAYMENT_REQUIRED`, status kept, not retried — whatever the status (402 or 403) |
| any other value (e.g. `upstream_provider_shared_pool` on a 429, `openrouter_in_flight_budget`), absent, or no readable body | By status (table above) |

After a `200` the failure arrives as a chunk with a top-level `error` object (and usually `finish_reason: "error"`):

| Chunk | Our error code |
|---|---|
| `error.code` a number that is an HTTP status | Classified like that status (401/403 → `PROVIDER_AUTH`, 402 → `PROVIDER_PAYMENT_REQUIRED`, 429 → `PROVIDER_RATE_LIMITED`, other → `PROVIDER_UNAVAILABLE`), with the code kept as `upstreamStatus` |
| `error.code` a string or missing | `PROVIDER_UNAVAILABLE`, no `upstreamStatus` |
| no `error`, `choices[0].finish_reason` `error` | `PROVIDER_UNAVAILABLE` |

An error chunk before any other chunk is a rejection (nothing generated): `PROVIDER_UNAVAILABLE` and `PROVIDER_RATE_LIMITED` are retried. After any chunk — even one carrying only reasoning — it fails the turn. A stream that ends otherwise:

| Outcome | Our result |
|---|---|
| `[DONE]` or a `finish_reason`, with some text | `completed` |
| `finish_reason` `length` | `PROVIDER_OUTPUT_TRUNCATED` (also when no text arrived) |
| finished with no text | `PROVIDER_OUTPUT_EMPTY` (retryable) |
| closed with neither `[DONE]` nor a `finish_reason` | `PROVIDER_OUTPUT_INVALID` |
| `openrouter-free` and any chunk with `usage.cost` > 0 | `PROVIDER_FREE_MODEL_CHARGED`, reporting that cost |
| more than 8 malformed lines / 2 MiB of text / 32 MiB of stream | `PROVIDER_OUTPUT_INVALID` / `PROVIDER_OUTPUT_TOO_LARGE` |
| body read failed mid-stream | `PROVIDER_UNAVAILABLE` (not retried) |

Catalogue: a network error, a non-2xx status, a body over 8 MiB, invalid JSON, a wrong envelope or no free id at all is a failed refresh. `list()` never throws: it returns the last good list (stale is better than none) or nothing, and the free backend still runs with a typed model id. No status is kept, because no failure is reported.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | Chat: 120 s of silence before the headers or between chunks stops the turn (`PROVIDER_TIMEOUT`); the run's `deadline` bounds the whole turn. Caps 32 MiB stream, 16 MiB per line, 2 MiB text. Catalogue: 10 s for the request and body together, 8 MiB body. | `packages/adapters/src/providers/httpTurn.ts`, `packages/adapters/src/providers/openRouterModels.ts`, `crates/research-providers/src/http_turn.rs`, `crates/research-providers/src/openrouter_models.rs` |
| Retries | Chat: only a request refused before any output (network error, 3xx, 429, 5xx, or a `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMITED` error chunk ahead of every other chunk), up to 3 retries after `Retry-After` or 2 s, 4 s, 8 s; none when the wait would exceed 30 s or leave less than 30 s of the deadline. Never to another model. Catalogue: none; the next refresh is suppressed for 60 s. | `packages/adapters/src/providers/httpTurn.ts` (`REJECTION_RETRY`), `crates/research-providers/src/http_turn.rs` |
| Transport | Rust: `PinnedProviderHttpClient`, the providers' own client: every request resolves the host afresh (every answer must be public) and tries each resolved address in order until a TLS connection opens. `POST /api/v1/chat/completions` never reuses an idle connection and its connection is closed after the answer, as in research-net's transport (`crates/research-net/src/pinned.rs`): a reused connection that failed after the server had read the body would make the turn's retry deliver, and bill, the prompt twice. `GET /api/v1/models` keeps one idle connection per host after a complete 2xx body, reused for up to 90 s while its address is still in the answer; a send that fails on it is a transport error (`HTTP_FAILED`), a failed refresh (last good list kept, next refresh after 60 s). TypeScript: Node's `fetch` (undici) may send the POST on an idle keep-alive connection (undici only avoids queuing it behind another request) and never resends it itself; a failure there is a network error the turn retries after 2 s (see Known differences). | `crates/research-providers/src/http.rs`, `apps/runner/src/main.ts` |
| Rate limit | `Retry-After` is read; `X-RateLimit-*` headers are not. No pacing of our own: each agent step is one request. | `packages/adapters/src/runtime/retryAfter.ts` (`parseRetryAfterMs`, shared), `crates/research-net/src/retry_after.rs`, `packages/adapters/src/providers/httpTurn.ts`, `crates/research-providers/src/http_turn.rs` |
| Cache | Catalogue only: the free ids for 10 minutes per runner process; concurrent probes share one request. | `packages/adapters/src/providers/openRouterModels.ts` (`createFreeModelCatalog`), `crates/research-providers/src/openrouter_models.rs` (`FreeModelCatalog`) |
| Fallback | Chat: none — no `models` list, no other model (AGT-012). Catalogue: the last good list, or no list (Settings then accepts a typed id). | `packages/adapters/src/providers/openRouter.ts` |

## 5. Examples

### POST /api/v1/chat/completions

Request — the bounded diagnostic request the live check sent: the request both runners build (Rust writes the header names in lower case), except `max_completion_tokens` 16 instead of the code's 8192 (`MAX_COMPLETION_TOKENS`), to bound the check:

<!-- example: openrouter-chat-request -->
```http
POST /api/v1/chat/completions HTTP/1.1
Host: openrouter.ai
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
Accept: text/event-stream

{"model":"nvidia/nemotron-3.5-lightning:free","messages":[{"role":"user","content":"Reply with the single word OK."}],"stream":true,"max_completion_tokens":16,"usage":{"include":true},"reasoning":{"effort":"low"}}
```

Verified: live, 2026-10-31, `curl` with exactly these headers and body (sent over HTTP/2; the runners send it over HTTP/1.1). A production request differs only in `max_completion_tokens` (8192); `openRouterDocExamples.test.ts` checks that every other byte equals what the code sends.

Response (the model spent the 16-token cap on reasoning, so the turn ends `PROVIDER_OUTPUT_TRUNCATED`; no keep-alive comment was sent this time):

```http
HTTP/2 200
content-type: text/event-stream
cache-control: no-cache
x-generation-id: gen-1793422285-ErXzUzn3p5oWZdwrEAFK
```

<!-- example: openrouter-chat-stream-length -->
```text
data: {"id":"gen-1793422285-ErXzUzn3p5oWZdwrEAFK","object":"chat.completion.chunk","created":1793422285,"model":"nvidia/nemotron-3.5-lightning:free","provider":"Nvidia","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"Here","reasoning_details":[{"type":"reasoning.text","text":"Here","format":"unknown","index":0}]},"finish_reason":null,"native_finish_reason":null}]}

data: {"id":"gen-1793422285-ErXzUzn3p5oWZdwrEAFK","object":"chat.completion.chunk","created":1793422285,"model":"nvidia/nemotron-3.5-lightning:free","provider":"Nvidia","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"'s","reasoning_details":[{"type":"reasoning.text","text":"'s","format":"unknown","index":0}]},"finish_reason":null,"native_finish_reason":null}]}

…

data: {"id":"gen-1793422285-ErXzUzn3p5oWZdwrEAFK","object":"chat.completion.chunk","created":1793422285,"model":"nvidia/nemotron-3.5-lightning:free","provider":"Nvidia","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":null},"finish_reason":"length","native_finish_reason":"length"}]}

data: {"id":"gen-1793422285-ErXzUzn3p5oWZdwrEAFK","object":"chat.completion.chunk","created":1793422285,"model":"nvidia/nemotron-3.5-lightning:free","provider":"Nvidia","service_tier":null,"choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"length","native_finish_reason":"length"}],"usage":{"prompt_tokens":23,"completion_tokens":16,"total_tokens":39,"cost":0,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0,"upstream_inference_prompt_cost":0,"upstream_inference_completions_cost":0},"completion_tokens_details":{"reasoning_tokens":16,"image_tokens":0,"audio_tokens":0}}}

data: [DONE]
```

Verified: live, 2026-10-31, `curl -N` (the request above with `max_completion_tokens` 16). 5 of 18 events kept (the first two reasoning chunks and the last two chunks plus `[DONE]`; the 13 omitted reasoning chunks are marked `…`); every kept line is verbatim. Status line and headers as curl received them over HTTP/2 (trailing space after the status code dropped), trimmed (cookies and Cloudflare headers dropped). The runners speak HTTP/1.1; no HTTP/1.1 capture was made.

### GET /api/v1/models

Request:

```http
GET /api/v1/models HTTP/1.1
Host: openrouter.ai
Accept: application/json
```

Verified: live, 2026-10-31, `curl` with these headers (sent over HTTP/2; the runners send it over HTTP/1.1).

Response:

```http
HTTP/2 200
content-type: application/json
cache-control: public, max-age=120, stale-while-revalidate=3600, stale-if-error=3600
```

<!-- example: openrouter-models-list -->
```json
{
  "data": [
    {
      "id": "google/gemma-4-31b-it:free",
      "canonical_slug": "google/gemma-4-31b-it-20260402",
      "hugging_face_id": "google/gemma-4-31B-it",
      "name": "Google: Gemma 4 31B (free)",
      "created": 1775148486,
      "description": "Gemma 4 31B Instruct is Google DeepMind's 30.7B dense multimodal model supporting text and image input with text output. Features a 256K token context window, configurable thinking/reasoning mode, native function...",
      "context_length": 262144,
      "architecture": {
        "modality": "text+image+video->text",
        "input_modalities": [
          "image",
          "text",
          "video"
        ],
        "output_modalities": [
          "text"
        ],
        "tokenizer": "Gemma",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "0",
        "completion": "0"
      },
      "top_provider": {
        "context_length": 262144,
        "max_completion_tokens": 32768,
        "is_moderated": false
      },
      "per_request_limits": null,
      "supported_parameters": [
        "include_reasoning",
        "max_tokens",
        "reasoning",
        "response_format",
        "seed",
        "temperature",
        "tool_choice",
        "tools",
        "top_p"
      ],
      "default_parameters": {
        "temperature": 1,
        "top_p": 0.95,
        "top_k": 64,
        "frequency_penalty": null,
        "presence_penalty": null,
        "repetition_penalty": null
      },
      "supported_voices": null,
      "knowledge_cutoff": null,
      "expiration_date": null,
      "links": {
        "details": "/api/v1/models/google/gemma-4-31b-it-20260402/endpoints"
      },
      "endpoints": [
        "/api/v1/chat/completions",
        "/api/v1/completions",
        "/api/v1/messages",
        "/api/v1/responses"
      ],
      "benchmarks": {
        "design_arena": [],
        "artificial_analysis": {
          "intelligence_index": null,
          "coding_index": 43.4,
          "agentic_index": 4.2
        }
      },
      "reasoning": {
        "mandatory": false,
        "default_enabled": false
      }
    },
    {
      "id": "particle-ai/particle-1",
      "canonical_slug": "particle-ai/particle-1-20261027",
      "hugging_face_id": null,
      "name": "Particle AI: Particle-1",
      "created": 1793207893,
      "description": "Particle-1 is a token-efficient agentic coding model from Particle AI, post-trained on DeepSeek V4.1 Flash. It is suited for software engineering work such as terminal workflows, codebase changes, and data...",
      "context_length": 1048576,
      "architecture": {
        "modality": "text+image->text",
        "input_modalities": [
          "text",
          "image"
        ],
        "output_modalities": [
          "text"
        ],
        "tokenizer": "Other",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "0.00000005",
        "completion": "0.0000005",
        "input_cache_read": "0.000000003"
      },
      "top_provider": {
        "context_length": 1048576,
        "max_completion_tokens": 131072,
        "is_moderated": false
      },
      "per_request_limits": null,
      "supported_parameters": [
        "frequency_penalty",
        "include_reasoning",
        "logprobs",
        "max_tokens",
        "min_p",
        "presence_penalty",
        "reasoning",
        "reasoning_effort",
        "repetition_penalty",
        "response_format",
        "seed",
        "stop",
        "structured_outputs",
        "temperature",
        "tool_choice",
        "tools",
        "top_k",
        "top_logprobs",
        "top_p"
      ],
      "default_parameters": {},
      "supported_voices": null,
      "knowledge_cutoff": null,
      "expiration_date": null,
      "links": {
        "details": "/api/v1/models/particle-ai/particle-1-20261027/endpoints"
      },
      "endpoints": [
        "/api/v1/chat/completions",
        "/api/v1/completions",
        "/api/v1/messages",
        "/api/v1/responses"
      ],
      "reasoning": {
        "mandatory": false,
        "default_enabled": true,
        "supported_efforts": [
          "max",
          "xhigh",
          "high",
          "medium",
          "low",
          "minimal",
          "none"
        ],
        "default_effort": "high"
      }
    }
  ],
  "total_count": 456,
  "links": {
    "next": null
  }
}
```

Verified: live, 2026-10-31, `curl` (the request above). 2 of 456 models kept (one free text model, which the code keeps, and one paid model, which it drops); pretty-printed; every kept value verbatim (the descriptions end in `...` as OpenRouter sends them). Status line and headers as received over HTTP/2, trimmed.

### Error responses

Invalid key (`Authorization: Bearer sk-or-v1-invalid-doc-example-key`):

```http
HTTP/2 401
content-type: application/json
```

<!-- example: openrouter-error-401 -->
```json
{"error":{"message":"User not found.","code":401}}
```

Verified: live, 2026-10-31, `curl` over HTTP/2 with a made-up key and the chat request above. Body unedited; headers trimmed.

A key whose credit limit is spent, asking for a paid model (`meta-llama/llama-3.1-8b-instruct`):

```http
HTTP/2 403
content-type: application/json
x-generation-id: gen-1793422274-GbM2WqMyTWtk9vDYXkx5
```

<!-- example: openrouter-error-403 -->
```json
{"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/<redacted> $0.00 of $0.00 used; does not reset.","code":403,"metadata":{"limit_source":"openrouter_key_limit","remedy_hint":"Raise or remove this API key's usage limit at https://openrouter.ai/settings/keys, or use a key without a limit.","scope":"key_limit","limit_usd":0,"spend_usd":0,"resets_at":null}}}
```

Verified: live, 2026-10-31, `curl` over HTTP/2 with the runner's key. Headers trimmed. The key's hash in the URL is replaced by `<redacted>`; otherwise unedited. `metadata.limit_source` `openrouter_key_limit` makes the turn fail with `PROVIDER_PAYMENT_REQUIRED` (403), not `PROVIDER_AUTH`.

A free model rate-limited upstream (no `Retry-After` header was sent):

```http
HTTP/2 429
content-type: application/json
x-generation-id: gen-1793422261-evFn4iTf1St417rnAErt
```

<!-- example: openrouter-error-429 -->
```json
{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Google AI Studio","is_byok":false,"provider_error_code":"429","limit_source":"upstream_provider_shared_pool","remedy_hint":"Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing"}},"user_id":"<redacted>"}
```

Verified: live, 2026-10-31, `curl` over HTTP/2 with the runner's key, model `google/gemma-4-31b-it:free`. Headers trimmed. `user_id` replaced by `<redacted>`; otherwise unedited.

An error chunk inside a `200` stream, before any output (retried):

<!-- example: openrouter-chat-stream-upstream-error -->
```text
: OPENROUTER PROCESSING

data: {"id":"gen-1792201335-amI9KRCwI4HRIU6r0UOe","object":"chat.completion.chunk","created":1792201335,"model":"nvidia/nemotron-3-ultra-550b-a55b:free","provider":"Nvidia","choices":[],"error":{"code":503,"message":"Upstream error from Nvidia: Service temporarily overloaded","metadata":{"error_type":"provider_overloaded"}}}
```

Verified: fixture, 2026-10-31, `packages/adapters/test/providers/fixtures/openrouter/upstream-overloaded.sse` (captured live 2026-10-17). Unedited.

**Test fixtures** (`packages/adapters/test/providers/fixtures/openrouter/`). Recorded live: `length-reasoning.sse` (the complete 18-event stream excerpted above), `error-401.json`, `error-403-key-limit.json` and `error-429-upstream.json` (2026-10-31; the key hash and `user_id` redacted as in the examples, JSON re-indented by the formatter), `upstream-overloaded.sse` (2026-10-17), `models.json` (2026-10-12, trimmed). Documentation-derived, because no live completed answer could be captured: `ok.sse`, `ok-no-cost.sse`, `midstream-error.sse`.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `choices[0].delta.content` | Forwarded unchanged when non-empty; UTF-16 length counted against 2 MiB | `AgentEvent` `text.delta.text` (`packages/contracts/src/agent.ts`; Rust `AgentEvent::TextDelta`) | Not stored as received; the research pipeline and the notebook assistant (`packages/application/src/research/pipeline.ts`, `packages/application/src/notebook/assistTurn.ts`) parse the answer into what they publish ([`claims`](../../database/tables/claims.md), [`research_records`](../../database/tables/research_records.md), [`notebook_turns`](../../database/tables/notebook_turns.md)) |
| `usage.cost` (last chunk carrying `usage`) | Credits taken as USD; `null`/absent/negative/non-finite → unknown. Metered: reported as is. Free: always unknown, and > 0 fails the turn | `AgentEvent` `usage.knownCostUsd`; summed into `ResourceUsage.knownCostUsd` (`packages/contracts/src/jobs.ts`) | [`research_jobs.usage_json`](../../database/tables/research_jobs.md) |
| `error.code`, `finish_reason`, HTTP status, a rejected answer's `error.metadata.limit_source` | Section 4 tables | `AgentEvent` `failed.code`, `failed.retryable`, `failed.upstreamStatus` (status unchanged) | [`research_jobs.failure_code`](../../database/tables/research_jobs.md), [`research_jobs.failure_upstream_status`](../../database/tables/research_jobs.md); notebook turns in [`notebook_turns.body_json`](../../database/tables/notebook_turns.md) |
| `Retry-After` header | Seconds × 1000, or HTTP date − now | Retry delay of the turn | Not stored |
| Catalogue `data[].id` (free text models only) | Deduplicated, at most 300, sorted | `AgentCapabilities.models` of `openrouter-free` (`packages/contracts/src/agent.ts`), shown in Settings → AI agent | Not stored; the id the owner picks is saved in [`owner_settings.agent_settings_json`](../../database/tables/owner_settings.md) |

## 7. Maintenance

### Known differences between the runners

- Transport: Rust sends through `PinnedProviderHttpClient` (`crates/research-providers/src/http.rs`), which accepts only the fixed URLs, resolves `openrouter.ai` afresh per request, connects only to public addresses (SEC-002), speaks HTTP/1.1, sends lowercase header names and no `user-agent`, and opens a fresh connection for every POST. TypeScript uses the runtime's global `fetch` (`apps/runner/src/main.ts`), which adds its own `user-agent`, `accept-encoding` and `accept-language`, does no address check, and may send the POST on an idle keep-alive connection (undici); if that connection fails after the server read the body, the turn's retry could deliver the prompt twice. The TypeScript runner is the rollback runner, so this was left as is.
- Rust builds a catalogue for each OpenRouter runtime, also the metered one that never reads it; TypeScript builds one for the free runtime only. No request results from the unused one.
- Otherwise none: request bodies, chunk interpretation and the free-id filter are held equal by the conversion vectors `vectors/providers/sse.json`, `vectors/providers/http-turns.json` and `vectors/providers/pure.json` (`crates/research-providers/tests/vectors.rs`).

### Open issues

- A full in-flight budget (402, `limit_source` `openrouter_in_flight_budget`) is transient and carries `Retry-After` ([limits](https://openrouter.ai/docs/api-reference/limits)), but fails the turn as `PROVIDER_PAYMENT_REQUIRED` without an in-turn retry (the job may still be retried). Not seen live; treating it as a rate limit would be a one-line change in `failureForOpenRouterRejection` / `failure_for_openrouter_rejection`.
- The [models reference](https://openrouter.ai/docs/api-reference/models/get-models) lists a bearer-key requirement, but production serves the catalogue without one (verified 2026-10-31) and the code deliberately sends none. If OpenRouter enforces the key, the free model list disappears from Settings (typed ids still work).
- `reasoning.effort` is sent for every model; on a reasoning model the 8,192-token cap can be spent on reasoning alone (`PROVIDER_OUTPUT_TRUNCATED`), as the example shows at 16 tokens. OpenRouter ignores `reasoning` for a model without reasoning, so sending it only when the catalogue lists `reasoning` would change nothing for those; for budget models `high` reserves about 80 % of the cap (about 6,550 tokens), leaving about 1,640 for the answer, and effort-only or mandatory-reasoning models may use more. Bounding it needs an owner decision (spend per turn vs. answer room vs. what Settings → effort means): raise `MAX_COMPLETION_TOKENS` (more spend per turn), send `reasoning.max_tokens` (e.g. at most half the cap) instead of `effort`, or map `high` to `medium` on this backend.
- No live completed chat answer with text was captured: the free models tried were rate-limited or spent the cap on reasoning, and the key has no credit for paid models. `packages/adapters/test/providers/fixtures/openrouter/ok.sse` is documentation-derived, not recorded.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | live | `GET /api/v1/models` without a key (456 models, 16 free); `POST /api/v1/chat/completions` on `nvidia/nemotron-3.5-lightning:free` with `max_completion_tokens` 16 (streamed, `finish_reason` `length`, `cost` 0); 401 with an invalid key; 403 key limit on a paid model; 429 upstream rate limit on `google/gemma-4-31b-it:free` | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | Rejected-answer bodies now read for `error.metadata.limit_source` (spent budgets → `PROVIDER_PAYMENT_REQUIRED`, status kept; the live 403 key-limit example) against the [limits](https://openrouter.ai/docs/api-reference/limits) page; reasoning budgets against [reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens). Recorded fixtures added from the live captures. | Claude (external API defect fixes) |
| 2026-10-31 | spec | Request parameters, chunk and usage fields, error statuses and bodies, limits, model object against the official pages linked in the Overview | Claude (external API documentation, ADR-0047) |
| 2026-10-17 | live | Upstream-overloaded error chunk before any output (fixture `upstream-overloaded.sse`) | earlier session (recorded in the `openRouter.ts` header until 2026-10-31) |
