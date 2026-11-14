# ADR-0075: A Gemini API backend in Settings → AI agent

**Status:** Accepted · **Date:** 2026-11-14 · **Owner request:** "Please skip opencode. Please proceed to develop backend server on cloudflare. Please verify by gemini api key."

## Context

Google serves its Gemini models through an OpenAI-compatible chat completions
endpoint (`POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
Bearer key). Settings → AI agent offers only the backends a runner reports, so
a new backend is a runner adapter in both runners (ADR-0030).

Four facts, checked live on 2026-11-14 against the owner's `GEMINI_API_KEY`,
shape the decision:

- The owner requested the `gemini-api` backend to follow the plan-limited /
  free-tier style (like `sarashina-api`, no per-question max-spend consent
  required). Because the endpoint returns no charge or price field in the
  streamed OpenAI-compatible response, every turn reports its cost as unknown
  (`null`), never `0`.
- The SSE stream uses OpenRouter's chunk shape (`choices[0].delta.content`,
  `finish_reason`, `data: [DONE]`), with an optional
  `delta.extra_content.google.thought_signature` object ignored by the shared
  parser.
- All four offered Flash models (`gemini-3.5-flash`, `gemini-3.5-flash-lite`,
  `gemini-3.6-flash`, `gemini-3.1-flash-lite`) answered HTTP 200 SSE streams
  with `max_completion_tokens: 16000` and `reasoning_effort` (`low` / `medium`
  / `high`).
- The API rejects an invalid API key with HTTP 400 (`INVALID_ARGUMENT`), unknown
  models with HTTP 404, invalid parameters with HTTP 400, quota exhaustion with
  HTTP 429, and transient demand spikes with HTTP 503. HTTP status alone chooses
  our failure code via `failureForHttpStatus` (`error_handling.md` §4a).

## Decision

1. **A new backend, `gemini-api` ("Gemini API"),** registered after
   `sarashina-api` in `createAgentRuntimes` and `create_agent_runtimes`. Tool
   isolation is enforced by construction (one user message, no `tools`). It is
   not a baseline backend.
2. **Plan-limited.** Every turn reports its cost as unknown (`null`), and a
   question carries no maximum spend.
3. **Request shape:** `model`, `messages` (one user message), `stream: true`,
   `max_completion_tokens: 16000`, and `reasoning_effort` from the run's effort.
   Both runners build the same bytes.
4. **Models.** Settings offers `gemini-3.5-flash` (the default when Settings
   names none and `GEMINI_MODEL` is unset), `gemini-3.5-flash-lite`,
   `gemini-3.6-flash`, and `gemini-3.1-flash-lite` from a fixed list in both
   adapters; the probe stays offline. Another model id may be typed ("Other"
   with placeholder `"gemini-…"`); the API refuses an id it does not serve.
   No fallback model (AGT-012).
5. **Shared code.** Chunks are read by OpenRouter's `interpretSseLine` /
   `interpret_sse_line`; retries, the idle watch and bounded reads are
   `httpTurn.ts` / `http_turn.rs`; the Rust runner's DNS-pinned client adds
   the fixed endpoint
   `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`.
   `GEMINI_API_KEY` is sent only in `Authorization` to that origin.

Wire format, status mapping and examples:
[Gemini API](../external-apis/apis/gemini-api.md).

## Consequences

- With `GEMINI_API_KEY` in `apps/runner/.env` the backend appears in Settings → AI
  agent as available; without it, as unavailable (`NOT_CONFIGURED`).
- Because cost reporting follows the plan-limited model, paid Gemini usage on a
  billed project is not tracked in USD by this backend.
- One turn generates at most 16,000 tokens; a turn cut off there reports
  `PROVIDER_OUTPUT_TRUNCATED`.
