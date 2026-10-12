# Agent backends

Status as verified on 2026-10-12 against the locally installed tools (OpenCode v2.0.27 with the Go-plan model `opencode-go/muse-spark-1.3-contributor` and the free-tier model `opencode/muse-spark-1.3-contributor-free`, codex-cli 0.160.0, Claude Code 2.1.296; OpenRouter documentation only, no API key). Re-verify after any CLI upgrade (section 13: provider terms and flags change). Adapters live in `packages/adapters/src/providers`; each file's header records the exact version and evidence.

All adapters are **text in, text out**. The orchestrator owns tools (ADR-0003), so no adapter claims `tool-calls` or `structured-output`.

| | OpenCode | Codex | Claude Code | OpenRouter |
|---|---|---|---|---|
| Integration | `opencode run --standalone --format json` | `codex exec --json` | `claude -p --output-format stream-json` | HTTPS chat completions (SSE) |
| Capabilities claimed | none | none | `stream` | `stream`, `cancel` |
| Cost model | plan-limited (unknown) | plan-limited (unknown) | plan-limited (unknown) | metered |
| Tool isolation | enforced (version-pinned) | **unverified** | enforced (checked per run) | enforced (no tools sent) |
| Verified | live, v2.0.27, Go-plan model `opencode-go/muse-spark-1.3-contributor` and free-tier model `opencode/muse-spark-1.3-contributor-free` (2026-10-12) | live, codex-cli 0.160.0 | live, 2.1.296 | **documentation only** (no API key available) |

## What "enforced" rests on

- **Claude Code.** Launched with `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, `--no-session-persistence`, `--safe-mode`, `--permission-mode dontAsk`, `--permission-prompts none`, prompt on stdin, cwd = per-job scratch directory. The CLI's own init event listed zero tools and zero MCP servers, and the adapter re-checks that on every run: any tool, MCP server or tool-use block fails the turn closed.
- **OpenCode.** A per-run config in the scratch directory defines the `research-text` agent; the config is chosen by model. Plan models get a deny-all agent (`{action:"*", resource:"*", effect:"deny"}` last at both levels); `opencode debug agents` showed the deny rule last, and a live attempt to run a command was refused. Free-tier models (ids ending in `-free`) get a deny-first, ask-for-the-ten-gated-permissions agent (`edit`, `glob`, `grep`, `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`; `edit` covers the `write` tool too): the provider only serves free-tier models to sessions that list its tools, and a non-interactive run without `--auto` rejects every ask before the tool runs, so a forced tool call ends the turn with `PROVIDER_TOOL_CALL_REJECTED` and no side effect. `execute` is not permission-gated and stays denied by the deny-first rule. There is no per-run tool listing to re-check, so the adapter accepts only the verified version range and reports `TOOL_ISOLATION_UNVERIFIED` for newer versions until re-verified. Requires a model chosen in Settings → AI agent, with `OPENCODE_MODEL` as the runner-side fallback, so the CLI never picks a provider — possibly a metered one — on its own. Stream handling stays fail-closed: any tool event ends the turn; a rejected call (`part.state.status` `"error"`) reports `PROVIDER_TOOL_CALL_REJECTED`, any other tool event reports `PROVIDER_TOOL_ISOLATION_VIOLATED`. See ADR-0012.
- **OpenRouter.** A plain HTTPS completion with no `tools` field; there is nothing to isolate. Requires `OPENROUTER_API_KEY` and a model. Real cost from the response is reported; a response without a cost is reported as unknown, never as zero. No fallback models.

**Claude Code and metered authentication.** The adapter is plan-limited by declaration, so it refuses API-key or third-party-provider authentication, which would be metered: `probe()` reports such a login as `NOT_CONFIGURED`, and a run whose init event shows an API key source is killed with `PROVIDER_METERED_AUTH_NOT_ALLOWED` before any text is accepted. Use OpenRouter (with an explicit spend ceiling) for metered access.

## Why Codex is "unverified"

With every hardening flag applied (`--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, approvals `never`, web search and MCP disabled, 21 features disabled), a live turn still listed command-execution and sub-agent tools. In the one attempt observed the command failed closed, but that is one observation, not an enforced property, and a read-only sandbox still permits reading any file the owner can read. The adapter therefore declares `toolIsolation: "unverified"`, fails a turn that produces anything other than message/reasoning items, and the pipeline **refuses to use it** unless the owner sets `ALLOW_UNVERIFIED_TOOL_ISOLATION=1` on the runner — ideally only inside a disposable OS sandbox (section 6.2).

## Credentials and environment

- CLI authentication is whatever each CLI already holds; adapters never read credential files (AGT-003).
- Each child process gets an explicit allowlisted environment (`PATH`, `HOME`, locale, temp dir and the CLI's own config variables). The runner token, Cloudflare credentials and other providers' keys are never passed.
- `probe()` checks installation and login status without spending model quota.
- **OpenCode model list.** `probe()` also runs `opencode models`, which prints the local model catalog (one `provider/model` id per line) without sending a prompt or spending model quota; the adapter reports the ids that pass its model-id validation (de-duplicated, sorted, capped at 300) as `capabilities.models` so Settings → AI agent can suggest them. If that command fails, the backend is reported as it otherwise would be and the list is simply omitted.

## Live-test note (2026-10-12)

- The free-tier model `opencode/muse-spark-1.3-contributor-free` runs through this app with the ask-and-reject config (`opencode` v2.0.27): the provider serves it only to sessions that list its tools, so the adapter lists the ten gated permissions with every call rejected — a trivial prompt answers with text, while a turn in which the model tries a tool fails with `PROVIDER_TOOL_CALL_REJECTED` (nothing ran) and the pipeline fails closed. A deny-all config is refused before any model request (`provider.auth` / 403); the adapter keeps deny-all as the default for plan models such as `opencode-go/muse-spark-1.3-contributor`, which answered through the same CLI path. Provider message text is never logged (SEC-010). See "OpenCode happy path (2026-10-12)" in [REQUIREMENTS_STATUS.md](REQUIREMENTS_STATUS.md) and ADR-0012.
- OpenCode serves free-tier models only to sessions that list its tools, so this app runs them with every tool call rejected; an answer fails if the model tries a tool, and a plan model avoids that. Settings → AI agent shows this caution whenever an OpenCode model id ending in `-free` is selected.

## Known limitations

- Subscription automation is subject to each provider's terms; check them before unattended use. OpenAI documents API keys as the default for automation.
- Killing a CLI process is best-effort cancellation; correctness after a cancel comes from lease fencing, not from the kill.
- Windows: spawning without a shell does not find `.cmd` shims; only the direct child is killed on abort.
- Proxy/CA variables are not on the allowlist.
