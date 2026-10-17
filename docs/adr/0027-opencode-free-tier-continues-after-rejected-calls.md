# ADR-0027: OpenCode free-tier turns continue after a rejected tool call

**Status:** Accepted · **Date:** 2026-10-17 · **Amends:** decision 3 of
[ADR-0012](0012-opencode-free-tier-ask-and-reject.md) · Extended by
[ADR-0028](0028-native-research-tool-calls-are-the-plan.md): a rejected call
naming a permitted research tool becomes a tool request

## Context

ADR-0012 runs free-tier OpenCode models (ids ending in `-free`) with OpenCode's
gated tools advertised and every call rejected by the CLI before it runs. It
also ended the turn at the first rejected call, with
`PROVIDER_TOOL_CALL_REJECTED`.

In use, that made free-tier models nearly unusable for research. On
2026-10-17 two consecutive runs with `opencode/nemotron-3.5-lightning-free`
(`run_766b667d…`, `run_1e570aa7…`) both failed with
`PROVIDER_TOOL_CALL_REJECTED`: the research prompts talk about searching and
sources, the model sees a `websearch` tool, and it tries it.

Verified by hand on 2026-10-17 with `opencode` v2.0.27, using the adapter's
own free-tier config and arguments: the CLI rejected the `websearch` call
(stderr `permission requested: websearch (...); auto-rejecting`, a
`tool_use` event with `part.state.status: "error"`), ended that step
(`step_finish`), started a new step and the model answered in text. The
answer that the adapter threw away was there.

## Decision

1. In a free-tier run, a tool event whose `part.state.status` is `"error"`
   (rejected by the CLI, nothing ran) no longer ends the turn. The adapter
   skips it and keeps reading; the model's later text is the answer.
2. At most `MAX_REJECTED_TOOL_CALLS` (4) rejected calls are tolerated in one
   turn. One more ends the turn with `PROVIDER_TOOL_CALL_REJECTED`, and so does
   a turn that ends with rejected calls but no text.
3. Unchanged: any other tool event (a tool ran, or its state is unknown), and
   every tool event in a plan-model run, ends the turn at once with
   `PROVIDER_TOOL_ISOLATION_VIOLATED`. Only the status is read; provider
   message text and tool inputs never leave the adapter (SEC-010).
4. The free-tier system prompt now says a tool call "is rejected before it
   runs and returns nothing" instead of "ends the turn with a failure", which
   is no longer true.

## Why isolation is not weakened

Every later call is checked exactly like the first: it must arrive as a
rejected (`"error"`) tool event, or the turn fails closed. The protection
was always the CLI's rejection before the tool runs (ADR-0012); ending the
turn after a rejection added no protection, because nothing had run. What the
model receives back is the CLI's own rejection notice, not retrieved content.

## Alternatives rejected

- **Retry the whole turn with a stronger prompt.** Spends a second model call
  and the model, still shown the tools, tends to try again.
- **Make `PROVIDER_TOOL_CALL_REJECTED` retryable at job level.** Re-runs the
  whole pipeline for a failure the model recovers from on its own in the same
  turn.
- **No bound.** A model that loops on tool calls would run until the deadline.

## Consequences

- Free-tier research turns succeed when the model tries a tool and then
  answers; `PROVIDER_TOOL_CALL_REJECTED` now means the model kept calling
  tools or never answered.
- Text the model wrote before a rejected call stays in the turn's output. The
  plan and answer parsers read the first balanced JSON object
  (`extractJsonObject`), so a prose preamble does not break them.
