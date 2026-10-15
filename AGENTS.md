# Agent instructions

Canonical engineering rules: [docs/ENGINEERING_DESIGN_RULES.md](docs/ENGINEERING_DESIGN_RULES.md). Architecture and requirements: [docs/ARCHITECTURE_AND_REQUIREMENTS.md](docs/ARCHITECTURE_AND_REQUIREMENTS.md). Design guideline: [docs/DESIGN_GUIDELINE.md](docs/DESIGN_GUIDELINE.md). Pages: [docs/PAGES.md](docs/PAGES.md). Requirements status: [docs/REQUIREMENTS_STATUS.md](docs/REQUIREMENTS_STATUS.md). Operations: [docs/OPERATIONS.md](docs/OPERATIONS.md). Threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Agent backends: [docs/AGENT_BACKENDS.md](docs/AGENT_BACKENDS.md). AI agents arrange the Home widgets through an MCP server: [docs/adr/0019-reusable-widget-grid-and-agent-layer.md](docs/adr/0019-reusable-widget-grid-and-agent-layer.md). The Chat page is Chat-first or Notebook-first, and a notebook assistant edits the Notebook widgets: [docs/adr/0020-chat-first-notebook-workspace.md](docs/adr/0020-chat-first-notebook-workspace.md). The Notebook also holds Home's market widgets, hides widget titles and edits Text widgets as rich text: [docs/adr/0021-notebook-market-widgets-and-rich-text.md](docs/adr/0021-notebook-market-widgets-and-rich-text.md). The calendar settings (Google Calendar, `.ics`, subscription link) live in Settings and the Watchlist page has no calendar: [docs/adr/0022-calendar-settings-in-settings.md](docs/adr/0022-calendar-settings-in-settings.md). Formal verification: [docs/FORMAL_VERIFICATION.md](docs/FORMAL_VERIFICATION.md). Independent review: [docs/CODEX_REVIEW.md](docs/CODEX_REVIEW.md). UI review record: [docs/UI_review.md](docs/UI_review.md). Decisions: [docs/adr/](docs/adr/). Rules: [logging](docs/rule/logging.md), [error handling](docs/rule/error_handling.md), [UI review](docs/rule/UI_review_rule.md), [real-environment testing](docs/rule/test_guideline.md). This file only points at them and adds the owner's standing instructions below.

Please do not use any type.

use Lean 4 for formal verification of algorithmic correctness.

Please make sure the code is optimized for high performance.

## How those instructions are met here

- **No `any`:** Biome's `noExplicitAny` and `noNonNullAssertion` are errors; unknown data is parsed with zod at every boundary instead of cast.
- **Lean 4:** proofs in `formal/`, tied to the TypeScript by generated conformance vectors. See [docs/FORMAL_VERIFICATION.md](docs/FORMAL_VERIFICATION.md). Add or change an algorithm in `packages/domain` → update its Lean model and re-export the vectors.
- **Performance:** measure with `bun run bench` before and after touching a hot path; the script fails when a case exceeds its budget.
- **Logging and errors:** one Effect logger (`@research/effects`); shell code handles failures with Effect, the pure core returns `Result` (ADR-0007).

## Commands

Every `bun run` script in `package.json` (the ground truth), with its meaning today:

```sh
bun install
bun run dev            # develop live (HMR + reload): SPA http://localhost:3000, API http://127.0.0.1:8788, data in data-dev/
bun run prod           # build the release and serve production: http://localhost:8787, data in data/
bun run prod:build     # build a new release generation (safe while production runs)
bun run prod:start     # serve the pointed-to generation (production)
bun run prod:rollback  # move the pointer to the previous activation (then restart)
bun run start          # same as bun run prod
bun run mcp:home       # Home-widget MCP server against production (or RESEARCH_API_URL)
bun run mcp:home:dev   # Home-widget MCP server against development
bun run build          # SPA, runner bundle, dry-run of the Cloudflare bundle
bun run build:web      # build the SPA only (vite build)
bun run build:runner   # bundle the runner only (to dist/runner/main.mjs)
bun run runner         # bundle the runner and run it with node
bun run verify         # check + typecheck + test + build
bun run check          # Biome: format + lint
bun run format         # Biome: write formatting
bun run lint           # Biome: lint only
bun run typecheck      # strict tsc, each project against its own runtime's globals
bun run test           # vitest: node, browser-DOM and Workers-runtime (real local D1) projects
bun run test:e2e       # Playwright, once per engine in turn (chrome, firefox, webkit)
bun run test:e2e:chrome  # Playwright on the Chrome channel only
bun run test:e2e:firefox # Playwright on Firefox only
bun run test:e2e:webkit  # Playwright on WebKit only
bun run test:real      # real network, no model quota: pristine-copy prod + dev feed refreshes
bun run test:real:live # real-network positive path on dev (spends plan quota; needs RUN_LIVE_OPENCODE=1 + OPENCODE_MODEL)
bun run test:live:opencode # pipeline + whole-app live OpenCode run (needs OPENCODE_MODEL)
bun run review:ui      # scripted UI review (REVIEW_BROWSER=chrome|firefox|webkit)
bun run formal:check   # Lean proofs + conformance vectors (needs elan)
bun run bench          # hot-path benchmarks with budgets
bun run db:migrate:local  # apply migrations to the local D1
bun run db:migrate:remote # apply migrations to the remote D1
bun run deploy         # optional, postponed: deploy env.production to Cloudflare (needs wrangler login)
```

## TEST_GUDILINE
/Users/ods/Documents/stock_investigation/docs/rule/test_guideline.md

## Widget design guidline
Apple Human Interface Guidelines(ios,macos)
