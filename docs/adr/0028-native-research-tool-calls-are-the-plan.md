# ADR-0028: Native research-tool calls from an OpenCode free-tier model are the plan

**Status:** Accepted · **Date:** 2026-10-17 · **Builds on:**
[ADR-0003](0003-agent-tool-mediation.md) (the orchestrator owns tools),
[ADR-0012](0012-opencode-free-tier-ask-and-reject.md),
[ADR-0027](0027-opencode-free-tier-continues-after-rejected-calls.md)

## Context

A run on `opencode/nemotron-3.5-lightning-free` failed with
`NO_EVIDENCE_COLLECTED` / `PLAN_NOT_JSON` (`run_f5107e36…`, 2026-10-17). The
planning replies the pipeline received were:

```
{ "toolCalls": [ { "toolId": "web.search", "args": { "query"
</parameter></function></tool_call>
```

OpenCode's session records (read 2026-10-17, `opencode` v2.0.32) show why.
The free tier makes the session list OpenCode's tools (ADR-0012), and this
model then expresses its plan as NATIVE tool calls to the research tools the
planning prompt names, with valid arguments:

- `web.search` `{"query": "global services demand forecast 2026"}`
- `news.fetch_feed` `{"sourceId": "src_0565…"}`
- once `write` with the whole JSON plan as the file content

OpenCode has no tool called `web.search`, so it rejects the call
(`"No tool named \"web.search\" is currently available"`,
`metadata.providerCall.executed: false`) and what remains in the text is the
broken fragment above. The same happens in plain OpenCode with its default
config, so the prompt and the adapter config are not the cause. The plan was
correct; it arrived on the tool-call channel and was thrown away with the
text. A recorded stream also shows the cost of waiting: the model asked for
`web.search` 32 s in, then spent 12 more minutes on rejected calls before a
give-up text (`free-tier-native-tool-call.jsonl`).

The agent contract already has a `tool.request` event, and the pipeline
already merges tool requests from a turn into its plan and authorizes every
one (`authorizeToolCall`: permitted ids, budget, argument schema) — but only
after the text JSON parsed.

## Decision

1. **Adapter.** In a free-tier OpenCode run, a rejected native call
   (`state.status: "error"`, not marked `executed`) that names one of the
   request's `permittedToolIds`, with arguments that are a bounded JSON
   object, is emitted as `tool.request` (`toolId`, `args`, `callId` = the
   part id). At most `request.maxToolCalls` are emitted per turn. Any other
   rejected call is skipped as in ADR-0027. A call marked as executed, any
   other tool event, and every tool event in a plan-model run still fail
   closed with `PROVIDER_TOOL_ISOLATION_VIOLATED`.
2. **The turn ends at that model step.** When a `step_finish` arrives after
   such a request, the adapter stops the CLI and completes the turn (new
   `finished` verdict in `runCliTurn`): the requests are what the pipeline
   needs, and the CLI would only spend another slow model step on the
   rejection. The orchestrator runs the tools and asks for the next plan with
   their results — the usual planning loop.
3. **Pipeline.** A planning reply with no valid JSON plan but with tool
   requests counts as a valid plan consisting of those requests
   (`done: false`). Requests from JSON and from events share one cap,
   `MAX_TOOL_CALLS_PER_REPLY` (8), the number the prompt already states.
   `PLAN_NOT_JSON` now means a reply with neither valid JSON nor a request.
4. **Contract.** An adapter may emit `tool.request` only for a tool the
   request permits; a completed turn delivers text or tool requests.

## Why this keeps the security model

- Nothing runs inside OpenCode: the CLI rejected the call. The request goes to
  the orchestrator, which authorizes it exactly like a request written in the
  JSON plan — the model's arguments were always untrusted input validated by
  the tool's schema (ADR-0003, AGT-007).
- The adapter reads the call's name and arguments only to hand them over; the
  provider's message text is still never read, and neither is logged
  (SEC-010).
- A tool the run does not permit is never requested, whatever the model calls.

## Alternatives rejected

- **Reword the plan format** so it looks less like a function call. The model
  still sees OpenCode's tool list and the tool names in the prompt; a prompt
  change touches every backend (prompt version, golden tests) for one model's
  habit, with no guarantee.
- **Parse the leftover markup.** The arguments are not in the text at all —
  only in the tool call.
- **Read the JSON plan out of a `write` call's content.** Too specific to one
  observed reply.

## Consequences

- A free-tier model that calls the research tools natively now collects
  evidence instead of failing with `PLAN_NOT_JSON`, and its planning turns end
  as soon as it has asked for tools.
- The model's per-step speed is unchanged; this removes the wasted steps, not
  the provider's latency.
