# ADR-0031: A metered Claude API backend beside the Claude Code CLI

**Status:** Accepted · **Date:** 2026-10-24 · **Owner request:** "Please
support claude api in settings AI Agent."

## Context

Claude is reachable today only through the `claude-code` backend, which runs
the `claude` CLI on a subscription login. That adapter is plan-limited by
declaration and deliberately refuses API-key authentication
(`PROVIDER_METERED_AUTH_NOT_ALLOWED`): an API key bills per token, and the
owner has not consented to metered spend through that backend. An owner who
has an Anthropic API key, and no subscription, therefore cannot use Claude
at all.

The Messages API reports token counts, not dollars, and the pipeline pauses
any metered run whose cost is unknown (`METERED_COST_UNKNOWN`), so a backend
that only forwarded the provider's numbers would stop after every turn.

## Decision

1. **A new backend, `claude-api` ("Claude API").** It is metered, its tool
   isolation is enforced by construction (one user message, no `tools`), and
   it is registered after `openrouter-free` in both runners
   (`createAgentRuntimes`, `create_agent_runtimes`). It is not a baseline
   backend: it is usable once a runner reports it. `claude-code` is unchanged
   and keeps refusing API keys; it still never receives `ANTHROPIC_API_KEY`.
2. **Raw HTTPS through the runner's own transport**, not the Anthropic SDK.
   Every provider here goes through a controlled transport: `environment.fetch`
   in the Node runner and the DNS-pinned, redirect-refusing client in the Rust
   runner (SEC-002), which now serves `api.anthropic.com` beside
   `openrouter.ai`. Rust has no official SDK, and the two runners must stay
   byte-identical (ADR-0030), so both speak the documented wire format:
   `POST https://api.anthropic.com/v1/messages`, `anthropic-version:
   2026-10-21`, `stream: true`, `output_config.effort` from the run's effort.
   The key is read from `ANTHROPIC_API_KEY` and sent only in `x-api-key` to
   that fixed origin; `ANTHROPIC_BASE_URL` is ignored.
3. **The adapter prices every turn.** `CLAUDE_API_MODELS`
   (`packages/adapters/src/providers/claudeApi.ts`, ported to
   `crates/research-providers/src/claude_api.rs`) lists each accepted model
   with its first-party price per million tokens. The cost of a turn is
   computed from the final `message_delta` usage. A model that is not in the
   table is refused before any network activity (`PROVIDER_MODEL_INVALID`), so
   a completed turn's cost is never unknown. Settings → AI agent offers exactly
   the listed models and refuses to save another id. Cache writes, which are
   never requested, would be priced at the higher 1-hour rate so spend is
   never under-reported.
4. **No fallback (AGT-012).** The request names one model and no `fallbacks`.
   A safety refusal (`stop_reason: "refusal"`) fails the turn with the new
   code `PROVIDER_REFUSED`; the owner chooses another model if they want one.
   Server-side fallbacks would bill another model at its own price, which the
   owner did not choose.
5. **Shared HTTP-turn code.** The idle watch, bounded body reader, request
   opening and retry of a request refused before any output moved from the
   OpenRouter adapter into `httpTurn.ts` (`http_turn.rs`); OpenRouter's
   behaviour and vectors are unchanged.

## Consequences

- A question on `claude-api` needs a maximum spend and the owner's consent,
  like OpenRouter. One turn can generate at most `MAX_OUTPUT_TOKENS` (16,000)
  thinking + answer tokens; at Claude Fable 5.1's price that is 0.80 USD.
- A new model, or a price change, is a code change: add it to
  `CLAUDE_API_MODELS` in both languages and regenerate the vectors
  (`node scripts/vectors/index.ts providers`). Until then it cannot be chosen.
- The wire format and the prices are documentation-derived (model table cached
  2026-10-06); no API key was available, so the positive path against the live
  API is unverified. See `docs/AGENT_BACKENDS.md`.
