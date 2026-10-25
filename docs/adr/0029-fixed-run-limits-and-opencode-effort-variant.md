# ADR-0029: Fixed per-question limits; OpenCode runs at the chosen effort

Spending consent and mandatory caps are superseded by [ADR-0035](0035-optional-spending-caps.md).

**Status:** Accepted · **Date:** 2026-10-17 · **Owner decision:** remove
"Limits for each question" from Settings → AI agent

## Context

Two runs on `opencode/glm-5.3-flash-free` on 2026-10-17 collected plenty of
evidence and still failed:

- The analysis turn of `run_d2b4f5fb…` reasoned for 4.7 minutes — about
  121,000 characters (~20,000 tokens) of thinking on a 38 KB prompt — and was
  cut off by the 10-minute wall clock before it answered. The OpenCode adapter
  never passed the run's effort to the CLI, so the model reasoned without
  bound. Live, `--model opencode/glm-5.3-flash-free#low` cut a planning reply
  from 1,428 to 50 output tokens; an unknown variant is refused at once with
  `provider.no-route` "Variant unavailable for <model>: <variant>".
- Both runs' second attempts started with the 20-call tool budget already
  spent (usage is cumulative across attempts, FR-016) and failed at once with
  `NO_EVIDENCE_COLLECTED` / `NO_TOOL_REQUESTED`.

The owner decided to remove the per-question limits from the settings form.

## Decision

1. **Fixed limits.** Every question runs under `RUN_LIMITS`
   (`packages/contracts/src/jobs.ts`): each ceiling at its maximum — 12 agent
   steps, 60 tool calls, 30 minutes of wall clock per attempt, 2,000,000
   input bytes. `runBudget(maxSpendUsd)` builds a question's budget. The
   composer, the approval form and `Retry run` all use it, so limits stored
   by older versions no longer apply.
2. **Spend stays the owner's.** The maximum spend is consent to metered cost
   (AGT-012), so it remains: one "Max spend (USD)" field, shown in Settings →
   AI agent and in the approval form only for a backend that can bill
   (metered or not yet reported), never for a plan-limited one. A retry onto a
   metered backend repeats the original consent only when backend, model and
   spend are unchanged (older runs' different limits do not count).
3. **The budget model is unchanged.** `researchBudgetSchema`, stored requests,
   the pipeline's enforcement and the Lean budget proofs keep all five
   ceilings; only who chooses four of them changed. Runs stay bounded
   (AGT-008).
4. **OpenCode effort.** The adapter sends `--model <provider/model>#<variant>`
   for the effort chosen in Settings → AI agent, trying the nearest variants
   in order (`EFFORT_VARIANTS`): `low` → `low`, `minimal`; `medium` →
   `medium`, `low`; `high` → `high`, `max`. Variant sets differ per model —
   verified live 2026-10-17, `opencode/glm-5.3-flash-free` and
   `opencode/deepseek-v4.1-flash-free` offer `low`, `high` and `max` but no
   `medium` — and a model's own default (no variant) reasoned without bound,
   so a missing `medium` falls back to `low`, which still bounds it. Only when
   the model offers none of the candidates does the turn run without a
   variant. Each refused variant ("Variant unavailable", about 2 s) is
   remembered per model for the life of the runner. A model id that already
   names a variant is the owner's explicit choice and is used alone.

## Alternatives rejected

- **Remove the limits from runs entirely.** A hung or looping model would run
  until stopped by hand, and spend consent would need a new home.
- **Keep the form, only raise the defaults.** The owner asked for the section
  to go.
- **Map effort to a token cap instead of a variant.** OpenCode exposes reasoning
  effort as variants; a token cap would truncate answers.

## Consequences

- Questions can use up to 60 tool calls and 30 minutes per attempt; a retry
  starts with more room, though usage still accumulates across attempts.
- OpenCode turns at `medium` effort reason far less than before; `high` is one
  setting away.
- Owners with saved settings see no change in Settings except the missing
  section; their stored limits are simply not used.
