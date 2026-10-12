# ADR-0012: OpenCode free-tier models via ask-and-reject

**Status:** Accepted · **Date:** 2026-10-12

## Context

Free-tier OpenCode models (ids ending in `-free`, e.g.
`opencode/muse-spark-1.3-contributor-free`) were unusable as a research
backend: with the adapter's deny-all permission config the CLI sends no tool
schemas, and the provider refuses the request with `provider.auth` / 403
("OpenCode's free tier can only be used from within OpenCode"). The owner
wants them supported. Verified on this machine with OpenCode v2.0.27 on
2026-10-12; the deny-all path was re-verified on the same version.

Evidence established by hand (not re-derived here):

- The refusal is caused by the deny-all config. A custom `system` prompt with
  default permissions is accepted, so the stripped child environment and the
  custom system prompt are not the cause.
- A rule with `"effect": "ask"` keeps a tool in the request, and a
  non-interactive `opencode run` without `--auto` rejects every ask before the
  tool runs: stderr prints `permission requested: <permission> (<resource>);
  auto-rejecting`, and the JSON stream carries a `tool_use` event whose
  `part.state.status` is `"error"`. Forced calls were tried for every tool and
  each was rejected with no side effect: `read`, `glob`, `grep`, `write` and
  `edit` (both use the `edit` permission), `shell`, `webfetch`, `websearch`,
  `subagent`, `skill`, `question`.
- `execute` ("Run JavaScript in a confined Code Mode runtime"; it has `fetch`)
  is NOT permission-gated: under an ask-everything rule it ran to completion
  without any permission request. It must stay denied; a `deny` rule removes
  it from the request.
- The accepted rule list is deny-first, then `ask` for the ten verified gated
  permissions (`edit`, `glob`, `grep`, `question`, `read`, `shell`, `skill`,
  `subagent`, `webfetch`, `websearch`; `edit` covers both `edit` and `write`,
  so ten permissions advertise eleven tools). Every smaller set tried (`read
  glob grep`; `question skill`; `read`; `shell`; `edit`; all but `edit read
  shell`) was refused with the same 403, so the full gated set is required.
- The deny-all config still works on v2.0.27 with the Go-plan model
  `opencode-go/muse-spark-1.3-contributor` (forced tool request answered
  NO_TOOLS, no tool event, no side effect).

## Decision

1. **One shared free-tier rule.** `isFreeTierModelId` (the `-free` suffix)
   moves to `@research/contracts` (`packages/contracts/src/agent.ts`) as the
   single source of truth, used by the adapter and re-exported through the web
   app's `agentSettingsModel`.
2. **Per-run config by model.** Every non-free model keeps the existing
   deny-all config unchanged (the stronger isolation, still the default). A
   free-tier model gets a second config built from the exported constant
   `OPENCODE_FREE_TIER_GATED_PERMISSIONS`: deny-first, then `ask` for each of
   the ten permissions, at both the global and the agent level (last matching
   rule wins, so `execute` and any unknown future tool match only the deny
   rule). Its system prompt tells the truth: tools are listed only because the
   provider requires it, every tool call is rejected before it runs and ends
   the turn, so the model must answer with text only in exactly the requested
   format and must not call any tool. `--auto` is never passed.
3. **Fail-closed stream handling with two cases.** Any tool event still ends
   the turn immediately. In a free-tier run, a tool event whose
   `part.state.status` is `"error"` (the call was rejected, nothing ran) fails
   with the new non-violation code
   `PROVIDER_TOOL_CALL_REJECTED` (non-retryable, like the other model-output
   failures: the same prompt would likely try a tool again and every retry
   spends quota). Any other tool event (a tool ran or its state is unknown),
   and every tool event in a plan-model run, where no tool is sent at all,
   fails with `PROVIDER_TOOL_ISOLATION_VIOLATED`. Only the status is read;
   provider message text and tool inputs never leave the adapter (SEC-010).
4. **Version pin.** Minimum version rises to 2.0.27 (both paths verified
   there); the "newer minor line is unverified" rule (`TOOL_ISOLATION_UNVERIFIED`
   from 2.1.0) is kept.
5. **Settings caution.** The old "may be refused" caution is replaced with the
   accurate statement: OpenCode serves free-tier models only to sessions that
   list its tools, so this app runs them with every tool call rejected; an
   answer fails if the model tries a tool, and a plan model avoids that.

## Alternatives rejected

- **Leaving free tier unsupported.** Keeps the stronger deny-all property for
  all models but wastes working models the owner already has access to; the
  provider accepts the ask-and-reject shape, so refusal is no longer forced.
- **Ask-everything (all permissions `ask`).** Rejected because `execute` is
  not permission-gated and ran to completion under that rule — it would hand
  the model a working JavaScript/`fetch` tool.
- **Allowing tools (granting real use).** Rejected: the orchestrator owns
  tools (ADR-0003) and research content is untrusted (T7); adapters stay
  text-in/text-out.

## Consequences

- Free-tier models answer text-only prompts through this app; a turn in which
  the model tries a tool fails closed (`PROVIDER_TOOL_CALL_REJECTED`, nothing
  ran) and the pipeline reports the failure like any other provider failure.
- This is a **weaker mechanism than deny-all**: tools are advertised and
  blocked at call time by the CLI rather than never sent (recorded in
  `docs/THREAT_MODEL.md` residual risks and `docs/AGENT_BACKENDS.md`).
- The claim rests on the CLI rejecting asks in non-interactive mode and on the
  gated-permission list verified on v2.0.27. A later 2.0.x release could add
  another ungated tool; the deny-first rule keeps unknown tools out of the
  request because unknown tools are denied. A changed ask-rejection behaviour
  surfaces as `PROVIDER_TOOL_ISOLATION_VIOLATED` (fail-closed).
- The provider's acceptance check is its own policy and may change, in which
  case the turn fails with `PROVIDER_AUTH` (fail-closed).
- Whether running free-tier models as an application backend fits the
  provider's terms is for the owner to check (`docs/AGENT_BACKENDS.md` "Known
  limitations" already says provider terms apply).
