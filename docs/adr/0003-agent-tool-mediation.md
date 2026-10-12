# ADR-0003: The orchestrator mediates all tools; agents are text-in/text-out

**Status:** Accepted · **Date:** 2026-10-11

## Context

Four backends (OpenCode, Codex, Claude Code, OpenRouter) have different native tool mechanisms. Section 6.2 requires that research agents run with no shell, file write or unbounded network by default, that tools are authorized outside the model, and that a backend whose restrictions cannot be enforced is sandboxed or marked unsupported for untrusted-source research. News content is untrusted and may contain prompt injection.

## Decision

1. **Adapters do one thing:** send a prompt, stream text back. They are launched with their own built-in tools disabled. They do not claim the `tool-calls` or `structured-output` capabilities in V1.
2. **The pipeline owns tools.** The model is asked for a JSON plan; each proposed call goes through `authorizeToolCall` (registered? on this run's allowlist? within budget? schema-valid?) and is executed by the runner with the tool's own timeout and network allowlist. Results return to the model as fenced data in the next prompt. If an adapter ever emits native `tool.request` events they pass through the same gate.
3. **Model output is a proposal, never a fact.** Citations must reference evidence the model was actually shown and quote it verbatim; numbers in observations must occur in the cited text; growth rates and pricing-power classifications are computed by the domain; the Worker re-checks referential and derivation integrity on submission.
4. **Honest isolation flag.** Each adapter declares `toolIsolation: "enforced" | "unverified"`. The pipeline refuses an `unverified` backend unless the owner sets `ALLOW_UNVERIFIED_TOOL_ISOLATION=1` on the runner. The per-backend evidence is in `docs/AGENT_BACKENDS.md`.
5. **Verification fails closed.** Deterministic checks show that a quoted passage exists in evidence the model was shown; they cannot show that it entails the claim. A claim is therefore "supported" only if a separate verification turn also returns an explicit "supported" verdict for it. If that turn fails, is cut off by a budget, or returns anything unusable, every such claim is downgraded to "unsupported" with the issue `NOT_INDEPENDENTLY_VERIFIED`. Verification never upgrades.
6. **No model prose is published.** The model's free-text answer is not part of the protocol; the conversation message and the report are assembled from verified records. A model may add table, chart or source-list views over stored datasets and may remove or focus components of earlier runs; it may not author reports or other free-text components, rewrite any component's props, or touch what the current run's deterministic presentation creates. Report badges are bound to stored claims and re-checked by the Worker, so no path (model, owner API, import) can display a status a claim did not earn.
7. **Records need a passage, not just an id.** A supplier link requires a verbatim passage of shown evidence that names the issuer; figures in its description must occur in that evidence. A scenario baseline requires a quoted passage containing the number. Pricing-power figures not found in the cited evidence are treated as undisclosed. A listing proposed by a model is stored as `listingVerification: "unverified"` and shown as such.
8. **Parsing free text is not structured output.** A reply that fails schema validation gets one repair attempt and then a typed failure; nothing is invented to fill the gap.

## Consequences

- One orchestrator works with every backend; adding a backend is one `AgentRuntime` (see `examples/extensions/scriptedAgent.ts`).
- More model turns than native tool calling would need. Accepted for V1 in exchange for a single enforcement point.
- Prompt-level fencing is defence in depth only; the guarantees come from code paths the model cannot influence, which is what the adversarial tests assert.

## What the Worker cannot re-check

The Worker validates structure, references, derivations and badge consistency of everything a runner submits, but it does **not** re-verify quotes against source text: licensed full text is deliberately never stored (DATA-010), so only the runner, which holds the retrieved text in memory during the run, can do that. The runner is the owner's own process, authenticated by a revocable credential. A stolen runner credential could therefore submit a claim marked "supported" with a quote that does not exist. This is an accepted V1 risk, recorded in `docs/THREAT_MODEL.md`; the mitigations are short-lived credentials, revocation, and the audit trail of which credential completed which run.
