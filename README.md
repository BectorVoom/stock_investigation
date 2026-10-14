# Personal AI Research Workspace

A single-owner research instrument: it reads the news sources you subscribe to, develops evidence-linked hypotheses about products and services likely to see demand growth over three to five years, and maps them to Japanese and US listed suppliers. An agent composes tables, charts and source lists in a persistent chat workspace.

**It is not a trading system and not investment advice.** Every claim is shown with its sources and its verification status; anything unknown is shown as unavailable with a reason, never as a plausible number.

- Specification: [docs/ARCHITECTURE_AND_REQUIREMENTS.md](docs/ARCHITECTURE_AND_REQUIREMENTS.md)
- Pages (what each page is for): [docs/PAGES.md](docs/PAGES.md)
- Engineering rules: [docs/ENGINEERING_DESIGN_RULES.md](docs/ENGINEERING_DESIGN_RULES.md)
- Design guideline: [docs/DESIGN_GUIDELINE.md](docs/DESIGN_GUIDELINE.md)
- What is and is not implemented: [docs/REQUIREMENTS_STATUS.md](docs/REQUIREMENTS_STATUS.md)
- Independent review and what was done about each finding: [docs/CODEX_REVIEW.md](docs/CODEX_REVIEW.md)
- Formal proofs: [docs/FORMAL_VERIFICATION.md](docs/FORMAL_VERIFICATION.md) · Threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) · Agent backends: [docs/AGENT_BACKENDS.md](docs/AGENT_BACKENDS.md)

## How it fits together

```text
Browser (SolidJS SPA) ──http://localhost:8787──▶ API (Hono Worker, run locally) ──▶ D1 (SQLite in data/)
                                                        ▲
                                                        │ polling: claim / heartbeat / events / complete
                                                     Runner
                                                        │
                    OpenCode · Codex · Claude Code (local CLIs, tools disabled) · OpenRouter (HTTPS)
                                                        │
                              research tools: subscribed feeds, article pages, SEC EDGAR
```

Everything runs on your own PC by default, started by one command; there is no account to create and no sign-in ([ADR-0006](docs/adr/0006-local-first-operation.md)). Production serves a built release on http://localhost:8787 with your data in `data/`; development runs the working tree live on http://localhost:3000 with its own data in `data-dev/`, so it can never disturb production ([ADR-0011](docs/adr/0011-development-and-production-environments.md)). The API is Cloudflare Worker code, so the same app can later be deployed to Cloudflare behind Cloudflare Access — that step is optional and currently postponed ([docs/OPERATIONS.md](docs/OPERATIONS.md)).

The API never runs a CLI and the runner never listens on a port. If the runner is offline you can still browse everything and queue questions; they run when it reconnects.

| Path | What it is |
|---|---|
| `packages/domain` | Pure logic with zero dependencies: finance formulas, URL/IP policy, feed normalisation, claim verification, job state machine, lease fencing, budgets, workspace reducer |
| `packages/contracts` | zod schemas shared by every runtime: records, UI command protocol, runner protocol, API DTOs |
| `packages/agent-core` | Agent port, tool definition and authorization, model-text handling |
| `packages/application` | Use cases and the research pipeline; depends only on ports |
| `packages/adapters` | D1, feed parser, SSRF-safe fetchers (Worker and Node), agent backends, SEC tools — split by runtime |
| `packages/ui-registry` | Component registry and the ten renderers |
| `apps/api` · `apps/runner` · `apps/web` | Worker, local runner, SPA |
| `formal/` | Lean 4 proofs and conformance vectors |
| `examples/` | A scripted agent backend (worked extension example) and synthetic fixtures |
| `tests/` | Import-boundary checks, SSRF suite, Lean conformance, browser E2E |

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3 and Node ≥ 23.6.

```sh
bun install
bun run prod       # build the release and serve it: http://localhost:8787
bun run dev        # develop live: SPA http://localhost:3000, API http://127.0.0.1:8788
```

Open http://localhost:8787, start a conversation on **Chat**, subscribe to a source under **Sources**, choose **Refresh news now**, ask a question on **Chat** and inspect the tables, charts and reports it produced on **Canvas**. **Home** shows market prices and indicators on widgets you arrange (needs `FRED_API_KEY` and `TWELVE_DATA_API_KEY` in `apps/runner/.env`; without them those widgets say which key to set). Ctrl+C stops it. Your data stays in `data/` on this PC; back it up by copying that directory. (`bun run start` means the same as `bun run prod`.) To promote a change: `bun run verify`, then `bun run prod:build`, then restart.

The app is reachable only from this PC and has no login, so do not run it on a shared machine. Runner settings (SEC contact string, OpenRouter key, market-data keys, …), backups, development mode and the optional Cloudflare deployment are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Supported browsers

Supported: the current and the previous major version of Chrome (and Edge), Firefox and Safari on desktop.

The technical floor is what the bundled Tailwind CSS v4 itself requires ([compatibility](https://tailwindcss.com/docs/compatibility)): Chrome 111, Firefox 128, Safari 16.4 — the app cannot support less than its CSS framework does. Vite's `build.target` is pinned to exactly that floor (`apps/web/vite.config.ts`), so the bundler downlevels or rejects syntax the floor cannot run.

Verification status: the browser suite passes on Firefox — 19 passed, 1 skipped (the live-quota spec) on 2026-10-13 — and on Playwright's bundled Chromium through a temporary, since-deleted config that only swapped the engine (19 passed, 1 skipped, including the Content-Security-Policy test on Home and the icon test). NOT run on 2026-10-13: `bun run test:e2e:chrome` (no Google Chrome installed on this machine, so the Chrome-only launcher specs were not run either) and `bun run test:e2e:webkit` (Playwright's WebKit cannot launch here: missing system libraries). Safari/WebKit behaviour of the Home page is therefore unverified (open item, see `docs/REQUIREMENTS_STATUS.md`). Earlier (2026-10-12): the suite passed in Playwright Chromium (Chrome channel: 33 tests — 15 chat/research plus the Chrome-only launcher specs 12 + 4 + 2) and Playwright WebKit (15 tests; the launcher specs run under Chrome only). Playwright's WebKit build is the engine Safari uses, but it is not Safari itself: Safari.app itself was not driven. Versions at the time of writing: Playwright 1.64.0 with Chrome 154.0.8037.98 (local install, `channel: "chrome"`), Firefox 157.0 (Playwright build firefox-1555), WebKit 27.2 (Playwright build webkit-2370).

## Checks

Every `bun run` script in `package.json` (the ground truth), with its meaning today. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the full operations guide.

```sh
bun run check          # format + lint (Biome; `any` and non-null assertions are errors)
bun run typecheck      # strict tsc; each project sees only its own runtime's globals
bun run test           # vitest: 4,735 tests passed, 14 skipped across Node, DOM and the real Workers runtime with local D1 (2026-10-14)
bun run test:e2e       # Playwright, once per engine (Chrome channel, Firefox, WebKit), each with a fresh server and database: chat → research → sourced table/chart → reload, plus `bun run prod` and `bun run dev` themselves (Chrome only)
bun run test:e2e:chrome|firefox|webkit  # one engine at a time
bun run test:real      # Playwright, needs the network, spends no model quota: pristine-copy prod + dev with one real feed refresh each (PARTIAL coverage of the owner's rule — network path only)
RUN_LIVE_OPENCODE=1 OPENCODE_MODEL=opencode-go/muse-spark-1.3-contributor bun run test:real:live   # the positive path: a real question, a real page and both settings states against `bun run dev` (spends plan quota)
bun run test:live:opencode  # pipeline + whole-app live OpenCode run (needs OPENCODE_MODEL in the environment)
bun run mcp:home       # Home-widget MCP server against production (or RESEARCH_API_URL)
bun run mcp:home:dev   # Home-widget MCP server against development
bun run review:ui      # scripted UI review (REVIEW_BROWSER=chrome|firefox|webkit)
bun run formal:check   # Lean 4 proofs build, no sorry, vectors current (needs elan)
bun run bench          # hot-path benchmarks with budgets
bun run build          # SPA + runner bundle + dry-run of the Cloudflare bundle
bun run verify         # check + typecheck + test + build
bun run dev            # develop live: SPA http://localhost:3000, API http://127.0.0.1:8788
bun run prod           # build the release and serve it: http://localhost:8787 (`prod:build` then `prod:start`; `prod:rollback` moves the pointer back; `start` means the same as `prod`)
bun run deploy         # optional, postponed: deploy env.production to Cloudflare (needs wrangler login)
```

## Extending without touching the core

- **A component type:** a schema definition (`ComponentDefinition`) plus a renderer, registered at the two composition roots (`apps/api/src/composition.ts`, the SPA's registry). `apps/api/test/workspaces.test.ts` and `packages/ui-registry/test/registry.test.tsx` add one this way.
- **An agent backend:** one object implementing `AgentRuntime`, added to the runner's registry. `examples/extensions/scriptedAgent.ts` is the worked example, and the E2E suite runs a full research job through it.
- **A research tool:** a `ToolDefinition` (id, version, argument schema, timeout, network allowlist) added to the tool registry.

## Honest limits

Market data on Home comes from FRED and Twelve Data through your own keys in `apps/runner/.env` ([ADR-0014](docs/adr/0014-market-data-sources.md)): end-of-day / periodic values for personal use only — Japanese listings are not served on the free plan and the newest daily bar can be an unfinished session. PER, US short interest and Japanese margin balances in research records are still reported as unavailable with a reason. SEC EDGAR adapters are written from documentation and have not been exercised against the live service. Codex is refused by default because its tool isolation could not be verified. The full list, with requirement IDs, is in [docs/REQUIREMENTS_STATUS.md](docs/REQUIREMENTS_STATUS.md).
