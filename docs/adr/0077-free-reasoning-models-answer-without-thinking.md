# ADR-0077: Dots Note free answers without thinking

**Status:** Accepted · **Date:** 2026-11-21 · **Owner request:** "Please investigate root cause of agent research is very long." then "Yes, implement fix 2 and verify on dev"

## Context

Research runs on the `openrouter-free` backend took 2–6 minutes. Over the dev
runs since 2026-11-10 on the two profiled free models
(`dots-studio/dots-3-note-preview:free`, `nvidia/nemotron-3.5-lightning:free`),
the `analyzing` state took 71 % of all run time (150 s on average, up to
406 s), collecting 18 %, verifying 7 % (single runs up to 564 s) and planning
4 %. Analysis is one model turn (two with a repair), so the time is inside the
provider turn, not in our code, tools or retries.

Measured live on 2026-11-21 with the runners' request shape and the production
`analysisPrompt`:

1. Latency, one 35 KB turn: both models streamed within about a second and
   wrote a ~2 KB answer, after 75.7 s (Dots Note, 8,155 reasoning tokens) and
   116.4 s (Nemotron, 19,500) of thinking at `effort: medium`. `effort: low`
   thought as long (110 s / 86 s). `reasoning.max_tokens: 2000` bounded
   Nemotron (18.7 s) but not Dots Note (97.8 s). `reasoning.enabled: false`
   answered in 22.6 s / 4.7 s with 0 reasoning tokens.
2. Quality, the same question on three real pages, each answer scored by
   `verifyClaims`, two turns per setting:

   | Model | Thinking on (`medium`) | Thinking off |
   |---|---|---|
   | Dots Note | 4/5, 4/5 claims supported; 172 s, 231 s | 3/3, 5/5 supported; 6 s, 25 s |
   | Nemotron | 3/3, 4/4 supported; 114 s, 142 s | 1/1, 0/3 (cites evidence ids that do not exist); 3 s, 6 s |

3. A whole dev run of that question on Dots Note took 49 s with thinking off
   (333 s before); its collection that day found less evidence, so that run
   says nothing about quality, which item 2 measures on fixed evidence.

## Decision

1. Both runners send `"reasoning":{"enabled":false}`, in place of
   `"reasoning":{"effort":…}`, for exactly `dots-studio/dots-3-note-preview:free`
   (`answersWithoutThinking` / `answers_without_thinking`). Settings → effort
   has no effect on that model.
2. Nemotron keeps the owner's effort: without thinking it loses citation
   discipline. Every other id, paid variants and near-matches included, keeps
   the effort too.
3. Both free ids keep the 32,768-token completion allowance (for Dots Note,
   answer room should a provider think anyway; it is free).

## Consequences

- An analysis turn on Dots Note takes seconds instead of minutes, with quotes
  verified as well as before.
- Nemotron runs stay slow (85–140 s per analysis turn). Open: measure
  `reasoning.max_tokens` 2,000 / 4,000 with the production verifier (the free
  daily quota ran out during this measurement) and decide from that
  (`docs/external-apis/apis/openrouter.md` §7).
- A new free model gets thinking off only after the same latency and quality
  measurement.
- Rejected: `effort: low` (no measurable effect), `reasoning.max_tokens` for
  Dots Note (ignored), thinking off for Nemotron (wrong citations).
