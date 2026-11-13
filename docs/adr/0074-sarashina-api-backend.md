# ADR-0074: A Sarashina API backend in Settings → AI agent

**Status:** Accepted · **Date:** 2026-11-13 · **Owner request:** "Please add
Sarashina api in settings."

## Context

SB Intuitions serves its Japanese-first Sarashina models through the Sarashina
API: an OpenAI-compatible chat completions endpoint
(`POST https://api.sarashina.ai/v1/chat/completions`, Bearer key). The owner
has a key. Settings → AI agent offers only the backends a runner reports, so a
new backend is a runner adapter, in both runners (ADR-0030).

Three facts, checked live on 2026-11-13, shape the decision:

- The API is a **free beta**: no published price, and its `usage` carries
  token counts only, no cost. A metered backend whose cost is unknown pauses
  every run (`METERED_COST_UNKNOWN`), and there is no price to compute one from.
- The stream has OpenRouter's chunk shape (`choices[0].delta.content`,
  `finish_reason`, a final usage chunk with `choices: []`, `data: [DONE]`).
- The API refuses what it does not support with 400: `max_completion_tokens`
  above 8,000, and `reasoning_effort` on a model that does not think
  (`sarashina3-mini`, `sarashina3-nano`); the thinking model
  `sarashina3.2-mini-thinking` accepts `low` / `medium` / `high`.

## Decision

1. **A new backend, `sarashina-api` ("Sarashina API"),** registered after
   `claude-api` in `createAgentRuntimes` and `create_agent_runtimes`. Tool
   isolation is enforced by construction (one user message, no `tools`). It is
   not a baseline backend.
2. **Plan-limited.** Every turn reports its cost as unknown (never 0), and a
   question carries no maximum spend. Settings shows a note beside the backend:
   it is a free beta, no spend is authorized, and SB Intuitions may use what is
   sent to train its models during the beta.
3. **Only documented fields:** `model`, `messages`, `stream: true`,
   `max_completion_tokens: 8000` (the API's maximum) and, only for a model id
   ending in `-thinking`, `reasoning_effort` from the run's effort. Both
   runners build the same bytes.
4. **Models.** Settings offers `sarashina3.2-mini-thinking` (the default when
   Settings names none and `SARASHINA_MODEL` is unset), `sarashina3-mini` and
   `sarashina3-nano` from a fixed list in both adapters; the probe stays
   offline. Another id may be typed ("Other"); there is no price to protect, and
   the API refuses an id it does not serve. No fallback model (AGT-012).
5. **Shared code.** Chunks are read by OpenRouter's `interpretSseLine` /
   `interpret_sse_line`; retries, the idle watch and bounded reads are
   `httpTurn.ts` / `http_turn.rs`; the Rust runner's DNS-pinned client gains
   the fixed endpoint `https://api.sarashina.ai/v1/chat/completions`. The key
   (`SARASHINA_API_KEY`) is sent only in `Authorization` to that origin.

Wire format, status mapping and examples:
[Sarashina API](../external-apis/apis/sarashina-api.md).

## Consequences

- With `SARASHINA_API_KEY` in `apps/runner/.env` the backend appears in
  Settings → AI agent as available; without it, as unavailable
  (`NOT_CONFIGURED`).
- If SB Intuitions starts billing, the backend must become metered with a
  price table (as ADR-0031 did for the Claude API); until then a charge would
  go unreported. The external API document lists this under open issues.
- One turn generates at most 8,000 tokens, thinking included; a turn cut off
  there is `PROVIDER_OUTPUT_TRUNCATED`.
