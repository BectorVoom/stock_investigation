# Agent instructions

Database: all database documentation lives in [docs/database/](docs/database/README.md) — start at its README. The canonical schema is `db/schema.sql` (fresh databases), upgrades are `infra/migrations/`, and every schema change updates both plus the table's definition document in the same commit ([database conventions §10](docs/database/conventions.md#10-table-definition-documents), checked by `tableDocs.test.ts`). SQL aliases, index naming and formatting: [database conventions](docs/database/conventions.md), [ADR-0045](docs/adr/0045-canonical-schema-and-sql-conventions.md). Migrations and rollback: [database operations](docs/database/operations.md). Equities and materials naming: [naming conventions](docs/database/naming.md). Implemented equities library and import API: [equities library guide](docs/database/libraries/equities.md).

External APIs: every integrated external API has one reference document in [docs/external-apis/](docs/external-apis/README.md) — start at its README; the rules (mandatory sections, verified production-exact examples, data mapping, what each integration change must update) are [external API conventions](docs/external-apis/conventions.md), [ADR-0047](docs/adr/0047-external-api-documents.md), checked by `externalApiDocs.test.ts`. Canonical engineering rules: [docs/ENGINEERING_DESIGN_RULES.md](docs/ENGINEERING_DESIGN_RULES.md). Architecture and requirements: [docs/ARCHITECTURE_AND_REQUIREMENTS.md](docs/ARCHITECTURE_AND_REQUIREMENTS.md). Design guideline: [docs/DESIGN_GUIDELINE.md](docs/DESIGN_GUIDELINE.md). Pages: [docs/PAGES.md](docs/PAGES.md). Requirements status: [docs/REQUIREMENTS_STATUS.md](docs/REQUIREMENTS_STATUS.md). Operations: [docs/OPERATIONS.md](docs/OPERATIONS.md). Threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Agent backends: [docs/AGENT_BACKENDS.md](docs/AGENT_BACKENDS.md). AI agents arrange the Home widgets through an MCP server: [docs/adr/0019-reusable-widget-grid-and-agent-layer.md](docs/adr/0019-reusable-widget-grid-and-agent-layer.md). The Chat page is Chat-first or Notebook-first, and a notebook assistant edits the Notebook widgets: [docs/adr/0020-chat-first-notebook-workspace.md](docs/adr/0020-chat-first-notebook-workspace.md). The Notebook also holds Home's market widgets, hides widget titles and edits Text widgets as rich text: [docs/adr/0021-notebook-market-widgets-and-rich-text.md](docs/adr/0021-notebook-market-widgets-and-rich-text.md). The calendar settings (Google Calendar, `.ics`, subscription link) live in Settings and the Watchlist page has no calendar: [docs/adr/0022-calendar-settings-in-settings.md](docs/adr/0022-calendar-settings-in-settings.md). The composer's Research / Notebook modes live in a + menu, and Notebook widgets cut, copy and paste (also between chats): [docs/adr/0023-composer-mode-menu-and-widget-cut-paste.md](docs/adr/0023-composer-mode-menu-and-widget-cut-paste.md). Home and the Notebook share one widget specification — types, title rule, sizes, menu, clipboard, Undo and dialogs: [docs/adr/0024-one-widget-specification-for-home-and-notebook.md](docs/adr/0024-one-widget-specification-for-home-and-notebook.md). A tap on a price widget opens the detailed chart viewer: [docs/adr/0025-detailed-chart-viewer.md](docs/adr/0025-detailed-chart-viewer.md). A Notebook / Home chart widget draws like the Chat chart it came from and carries its numbers' provenance (basis, sources) checked against the owner's records: [docs/adr/0026-chart-widgets-carry-provenance.md](docs/adr/0026-chart-widgets-carry-provenance.md). The Claude API is a metered backend beside the Claude Code CLI; the runner prices each turn from its own model table: [docs/adr/0031-claude-api-backend.md](docs/adr/0031-claude-api-backend.md). The UI is in English and Japanese; every UI word lives in a `*.messages.ts` catalog and Settings → Language picks the language: [docs/adr/0032-ui-languages.md](docs/adr/0032-ui-languages.md). Scheduled tasks — research questions that run on a schedule, managed on the Tasks page and shown by a widget; they fire when a runner claims work: [docs/adr/0033-scheduled-tasks.md](docs/adr/0033-scheduled-tasks.md). An orderly runner shutdown hands its lease back: the job is pending again at once and the interrupted attempt is refunded: [docs/adr/0036-runner-releases-lease-on-shutdown.md](docs/adr/0036-runner-releases-lease-on-shutdown.md). `web.search` searches the whole web (Tavily, `TAVILY_API_KEY`) and `news.search` searches GDELT news: [docs/adr/0025-web-search-research-tool.md](docs/adr/0025-web-search-research-tool.md). A Task result widget shows one scheduled task's latest answer on Home and in the Notebook: [docs/adr/0038-task-result-widget.md](docs/adr/0038-task-result-widget.md). The Watchlist searches every exchange-listed US and Japanese stock from a local directory the runner downloads one market per job (SEC, JPX): [docs/adr/0034-stock-directory-search.md](docs/adr/0034-stock-directory-search.md). When an external service answers with an error, its status is returned unchanged — stored beside our code and used as the API's response status: [docs/adr/0037-external-service-errors-keep-their-status.md](docs/adr/0037-external-service-errors-keep-their-status.md), rule [error handling §4a](docs/rule/error_handling.md). Fewer external requests: a refresh after adding a widget or stock fetches only what has no data, and the runner caches FRED metadata (24 h), 13F filings (by accession) and search answers (15 min): [docs/adr/0039-fewer-external-requests.md](docs/adr/0039-fewer-external-requests.md). The Watchlist holds titled lists of its stocks (up to 20 lists of 12), and a Watchlist prices widget shows one list's change from the previous close on Home and in the Notebook: [docs/adr/0040-watchlist-lists-and-prices-widget.md](docs/adr/0040-watchlist-lists-and-prices-widget.md). Indicator tables chart their history (Trend column, rows open the chart viewer); market history refreshes incrementally — a window from a stored anchor observation, a full fetch when the anchor changed or every 7 days — and Home and the Notebook re-check staleness while open: [docs/adr/0044-indicator-charts-and-incremental-history.md](docs/adr/0044-indicator-charts-and-incremental-history.md). Formal verification: [docs/FORMAL_VERIFICATION.md](docs/FORMAL_VERIFICATION.md). Independent review: [docs/CODEX_REVIEW.md](docs/CODEX_REVIEW.md). UI review record: [docs/UI_review.md](docs/UI_review.md). Decisions: [docs/adr/](docs/adr/). Rules: [logging](docs/rule/logging.md), [error handling](docs/rule/error_handling.md), [UI review](docs/rule/UI_review_rule.md), [real-environment testing](docs/rule/test_guideline.md). This file only points at them and adds the owner's standing instructions below.

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
