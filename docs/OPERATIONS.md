# Operations

The workspace runs **on your own PC by default** ([ADR-0006](adr/0006-local-first-operation.md)), in two separate environments ([ADR-0011](adr/0011-development-and-production-environments.md)): **production** (the app you use) and **development** (the working tree, live). Deploying it to Cloudflare is optional and currently postponed; that path is kept at the end of this file.

## Running it (default: production on this PC)

Requires [Bun](https://bun.sh) ≥ 1.3 and Node ≥ 23.6. No Cloudflare account, no sign-in.

```sh
bun install
bun run prod           # build the release, then serve it: http://localhost:8787 — Ctrl+C stops it
```

`bun run start` means the same as `bun run prod`. `bun run prod` is two steps:

1. `bun run prod:build` — builds a new release *generation* (safe while
   production runs — see below) into
   `release/generations/<UTC timestamp>-<random>/`: the SPA, the Worker
   bundle, the runner bundle, a copy of the migrations it was built with,
   the generation's Wrangler configuration and `manifest.json` (build time,
   source revision, versions, generation id, migration list) written last.
   The finished generation is validated, made read-only, and only then
   activated by atomically replacing the pointer (`release/current.json`).
   A failed build leaves the pointer and every generation untouched. Older
   generations are pruned automatically (newest three kept, plus the active,
   previous and live-held ones).
2. `bun run prod:start` — reads the pointer ONCE and serves ONLY that
   generation for its whole life: the prebuilt Worker bundle (bundling
   disabled), `release/generations/<id>/web`, and the runner from the same
   generation. It refuses to start when the pointer is missing or its
   generation is incomplete ("run `bun run prod:build`"), and refuses old
   code against a newer database (see "Migrations and rollback").

At start, the generation's own pending migrations are applied to the production database, the API —
the same Worker code, run offline by `wrangler dev` with a SQLite-backed D1 —
listens on **127.0.0.1 only**, a runner credential is issued the first time
(labelled "Local runner (bun run prod)" under Settings) and reused on later
starts (replaced when fewer than 30 days of its 90 remain), and the runner is
started. Production never reloads on change: a build writes a *new*
generation and only moves the pointer, so a later source edit, rebuild of
`dist/`, or even `prod:build` / `prod:rollback` while production runs cannot
change what the running instance serves — only a restart moves it to the
pointer. The served generation id and build time are reported by
`GET /api/v1/version`.

| Setting | Default | Purpose |
|---|---|---|
| `RESEARCH_PORT` | `8787` | Port of the production app. |
| `RESEARCH_DATA_DIR` | `data` | Where production data is stored. |
| `RESEARCH_RELEASE_DIR` | `release` | The release area (generations + pointer) production serves. |
| `RESEARCH_PREVIOUS_RELEASE_DIR` | `release.previous` | Legacy only: where the previous release *was* kept. Migrated once into generations, never written again; still validated with the other directories. |
| `RESEARCH_ALLOW_NEWER_DB` | unset | Override for the newer-database refusal (see "Migrations and rollback"). Set to `1` only after checking the schema difference. |
| `RESEARCH_RUNNER_ENV_FILE` | `apps/runner/.env` | Env file the runner processes load (`--env-file-if-exists`). Tests point it at a file they wrote themselves, so the operational file is never read by a test. |
| `RESEARCH_RELEASE_MARKER` | unset | Build-time marker baked into the manifest and the served page (a test hook for the immutability specs; safe `[A-Za-z0-9_-]` only). |
| `RESEARCH_BUILD_FAIL_AT` | unset | Test-only hook: fail `prod:build` at the named step (`spa`, `runner`, `worker`, `finalize`). |

Tests (including the E2E suite) never write into the repository-root
`release/`, `release.previous/`, `data/` or `data-dev/`: every spec that
starts a launcher, a runner or a build constructs its child environment
through `scripts/testEnv.ts` — an explicit allowlist plus its own throwaway
values for every path and port, never the caller's environment — points
`RESEARCH_RUNNER_ENV_FILE` at a file it wrote itself (the pristine copy
excludes the operational `apps/runner/.env`), and removes its directories
afterwards. The E2E guard (`tests/e2e/globalSetup.ts`) asserts that
directly: every configured directory must canonicalise outside the
operational directories, and none of them may have been created by the
suite. (The old modification-time snapshot is gone: it blamed the tests for
the owner's own activity while an owner instance kept writing.)

## Developing it

```sh
bun run dev            # SPA http://localhost:3000 (HMR), API http://127.0.0.1:8788 — Ctrl+C stops all three
```

`bun run dev` starts the Vite dev server with hot module replacement for the
SPA, the API from the working tree with reload on change, and the runner from
source, restarted when its sources (or the packages they import) change — all
under the same supervision as production. Development data lives in `data-dev/`
(git-ignored): its own database, runner credential and logs. Development
refuses to run against the production data directory, and production refuses
to run against the development one, so the two can run at the same time
without interfering. The header shows a "Development" badge; production shows
nothing extra.

| Setting | Default | Purpose |
|---|---|---|
| `RESEARCH_DEV_PORT` | `3000` | Port of the development SPA. |
| `RESEARCH_DEV_API_PORT` | `8788` | Port of the development API (`/api` is proxied there). |
| `RESEARCH_DEV_DATA_DIR` | `data-dev` | Where development data is stored. |

The runner is started for you (no hand-issued credential needed). The old
`dev:web` / `dev:api` scripts are gone: they shared the production data
directory, which is the hazard ADR-0011 removes.

### What is stored where

| Path | Content |
|---|---|
| `data/d1/` | The production database (SQLite): workspaces, chats, claims, evidence, runs, sources. |
| `data/runner-credential.json` | The production runner's bearer token, readable only by you (mode 0600). |
| `data/pages/` | Retrieved public web pages as Markdown (one file per page, with retrieval metadata in front matter). Nothing here is in the database. |
| `data/logs/` | `build.log`, `server.log`, `runner.log`, rewritten on every start. |
| `data-dev/` | The same layout for development (`bun run dev`). Never the production data. |
| `release/` | The release area: `generations/<timestamp>-<random>/` (one directory per build: SPA, Worker bundle, runner bundle, migration copy, Wrangler configuration, manifest — read-only once finished), `current.json` (the pointer naming the active generation plus its activation history), `build.lock` (serialises builds/rollbacks/pruning), `holders/` (one marker per live instance). |
| `release.previous/` | Legacy only: the previous release *was* kept here. The first new-style `prod:build` migrates it into a generation; nothing is ever written here again. |

`data/`, `data-dev/`, `release/` and `release.previous/` are git-ignored. Deleting `data/` resets production to empty; deleting `data-dev/` resets development.

### Who can reach it

There is no login in local mode: whoever can open `http://localhost:8787` on this PC is the owner. The server listens on the loopback address only, so other devices on the network cannot connect. The API accepts the owner only when the request is addressed to `localhost`/`127.0.0.1`, which defeats DNS-rebinding pages, and writes need a same-origin `Origin` plus a custom header, which defeats cross-site requests. Other user accounts and programs **on the same PC** are not kept out; do not run it on a shared machine. See [THREAT_MODEL.md](THREAT_MODEL.md).

### Runner settings

Optional. Put them in `apps/runner/.env` (see `apps/runner/.env.example`); the launcher passes that file to the runner and sets the API URL and credential itself.

| Variable | Purpose |
|---|---|
| `SEC_USER_AGENT` | Contact string SEC EDGAR requires (e.g. `your-name you@example.com`). Without it SEC tools are disabled. |
| `OPENCODE_MODEL` | `provider/model` for OpenCode. Required so the CLI never chooses a (possibly metered) provider itself. |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Enable the metered OpenRouter backend. A run still needs an explicit max-spend. |
| `ALLOW_UNVERIFIED_TOOL_ISOLATION=1` | Opt in to backends whose tool isolation is unverified (Codex). Default: refused. |
| `RUNNER_SCRATCH_ROOT` | Parent of per-job scratch directories. Must not sit under a directory containing `opencode.json(c)` or `.opencode/`. |
| `RUNNER_PAGES_DIR` | Where retrieved public pages are archived as Markdown (the launcher sets this to `data/pages` in production, `data-dev/pages` in development). Unset it and the web page tool is disabled (the runner logs `web_pages_disabled`). |

If the runner stops mid-job nothing is completed; the lease expires after 90 s and the job is handed out again (at most three attempts).

### Launcher supervision

Readiness means the runner has actually reported to the API after the
launch: a start-up that never sees a report FAILS within 45 s with the
runner's last error line (exit code plus the `invalid_configuration` /
`unsupported_runtime` / `runner_crashed` event) and stops everything it
started — development never prints "ready" for a dead runner. While running,
a runner exit is reported on the launcher's console at once; in development
the bundle is rebuilt and rerun on the next source change as before. Three
runner exits or crash lines in a short window without a report is a crash
loop: the launcher stops retrying and says so.

Killing the launcher with SIGKILL runs no shutdown code, so a detached
guardian (`scripts/guardian.ts`) watches the launcher pid and, when it
disappears, stops the recorded process groups (recorded in
`data/logs/guardian.json`, or `data-dev/logs/guardian.json`) and exits. On
Windows process groups are not used: the guardian kills the recorded pids
directly and descendants outside them may survive.

### Web page retrieval (`web.fetch_page`, ADR-0009)

The owner's setting decides (Settings → AI agent, "Allow the agent to open
public web pages"): `DEFAULT_AGENT_SETTINGS.webAccess` is `"public-web"`
(`packages/contracts/src/settings.ts`), and the question composer sends the
saved setting with each research request (`apps/web/src/chat/composerModel.ts`).
The agent may open a public web page only when that request says
`webAccess: "public-web"`. A stored request from before the field existed
parses as `"off"` (`webAccessSchema.default("off")` in
`packages/contracts/src/jobs.ts`, fail closed, ARCH-017), so web access is
never granted by an old record — that parse default is not the owner's
default. One page per tool call, robots.txt honoured, requests to one host spaced a second apart.

- **Where the files are:** `data/pages/` (or wherever `RUNNER_PAGES_DIR` points). File names carry the retrieval date, the host and a hash of the URL; each file's front matter records the requested and final URLs, the title, the retrieval time and a checksum of the Markdown.
- **How to turn web access off:** uncheck "Allow the agent to open public web pages" in Settings → AI agent and save — the request then says `"off"`, the tool is not even advertised to the model, and without `RUNNER_PAGES_DIR` it is not registered at all.
- **How to delete them:** delete the files (or the whole directory; it is recreated on the next save). They are outside the database, so workspace export/import and database backup copies do not include them — but a directory copy of `data/` does.

### Backup and restore

The backup is a copy of `data/` (production). Development data (`data-dev/`) and releases (`release/`) are rebuilt, not backed up. Stop the app, then copy the directory:

```sh
cp -R data backups/data-$(date +%F)      # backup
RESEARCH_DATA_DIR=backups/data-2026-10-12 bun run prod:start   # open a backup to check it
```

To restore, stop the app and put a backup back in place of `data/`. Individual workspaces can also be exported from **Settings** as versioned JSON and re-imported.

Drill executed on 2026-10-12: a workspace created in one data directory was present after starting from a copy of that directory, and the runner reused the copied credential. `wrangler d1 export` does not work on a local database stored outside Wrangler's default location, so the directory copy is the supported backup.

### Promoting a change and rolling back

Daily use is production. To promote a working-tree change to production:
`bun run verify`, then `bun run prod:build` — safe while production runs,
because the build writes a new generation and only moves the pointer; the
running instance keeps serving its generation through the build and
afterwards — then restart production (Ctrl+C, `bun run prod:start`) to move
to the pointer. To undo a release: `bun run prod:rollback` moves the
pointer to the previous activation (nothing is deleted), then restart
production for it to take effect. Pruning is automatic after each
successful build.

Refusals and what they mean:

- `… resolve to the same directory …` / `… must not sit inside …` — two of
  the data directories, the release area or the legacy previous location
  overlap (this catches symlinks, case variants and parent/child nests).
  Check `RESEARCH_DATA_DIR` / `RESEARCH_DEV_DATA_DIR` /
  `RESEARCH_RELEASE_DIR` / `RESEARCH_PREVIOUS_RELEASE_DIR`.
- `… must not be the repository root or one of its parents` / `… the
  file-system root` / `… the user's home directory` — a directory setting
  points somewhere a release command must never delete from.
- `another release operation … holds the release lock` — a build, rollback
  or prune is already running; wait for it. A lock from a dead process is
  taken over with a log line.
- `the database is newer than this release …` — the database has applied
  migrations this generation does not know (usually: rolled back to older
  code). Restore a data backup, or proceed with
  `RESEARCH_ALLOW_NEWER_DB=1` only after checking the schema difference.
- `no release found at … Run \`bun run prod:build\` first.` — the pointer
  is missing or its generation is incomplete (a failed build never
  activates, so this means no good build yet).

## Live tests

Every `bun run` script in `package.json` (the ground truth), with its meaning
today (`AGENTS.md` and `README.md` carry the same list):

```sh
bun run dev            # develop live: SPA http://localhost:3000 (HMR), API http://127.0.0.1:8788, runner from source
bun run prod           # build the release, then serve it: http://localhost:8787
bun run prod:build     # build a new release generation (safe while production runs)
bun run prod:start     # serve the pointed-to generation (production)
bun run prod:rollback  # move the pointer to the previous activation (then restart)
bun run start          # same as bun run prod
bun run build          # SPA + runner bundle + dry-run of the Cloudflare bundle
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
bun run test:e2e:chrome   # Playwright on the Chrome channel only
bun run test:e2e:firefox  # Playwright on Firefox only
bun run test:e2e:webkit   # Playwright on WebKit only
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

Live tests are opt-in: without their environment switches they skip, so `bun run test` stays deterministic and offline. Their inputs other than the model are fixed: news content comes from the E2E fixtures, never from the network. The model comes from `OPENCODE_MODEL` in the caller's environment.

```sh
RUN_LIVE_AGENT_SMOKE=1 OPENCODE_MODEL=opencode-go/muse-spark-1.3-contributor node_modules/.bin/vitest run --project node packages/adapters/test/providers/live.smoke.test.ts
bun run test:live:opencode     # Levels 2 + 3: needs OPENCODE_MODEL in the environment (a Go-plan model, e.g. opencode-go/muse-spark-1.3-contributor)
```

Level 3 (Playwright against the real UI with the real OpenCode backend, `tests/e2e/opencodeLive.spec.ts`) runs as the second half of `bun run test:live:opencode`; without `RUN_LIVE_OPENCODE=1` the spec skips and the E2E runner harness serves the scripted agent, so `bun run test:e2e` never starts OpenCode. See "OpenCode happy path (2026-10-12)" in [REQUIREMENTS_STATUS.md](REQUIREMENTS_STATUS.md) for the latest evidence.

## Real-environment checks (no model quota)

```sh
bun run test:real            # tests/real/: real prod + dev on test ports, one real feed refresh each
```

`bun run test:real` is PARTIAL coverage of the owner's rule (network path
only — see `docs/rule/test_guideline.md`): it proves the runner's network
path but never sends a question through a real agent backend, never
retrieves a public page through the research tool, and never starts from the
fresh and upgraded settings states. The positive path is the opt-in live
suite below.

`bun run test:real` is the single entry point for real-environment
positive-path checks that need the network but spend no model quota. It
copies the working tree to a pristine directory (tracked files, no `dist/`),
installs, and then, each on test ports with throwaway data and release
directories:

1. Clean-checkout `prod`: `prod:build` with no `dist/` present, `prod:start`,
   subscribe one real catalog feed (EIA Today in Energy by default;
   `RESEARCH_REAL_FEED_URL` overrides it), "Refresh news now", and the ingest
   must complete with at least one article and no fetch error.
2. Absolute release directory outside the repository: build, start, build
   again (the running instance keeps serving what it started with), rollback,
   start the restored release.
3. Clean-checkout `dev`: start (nothing pre-built), the runner online under
   Node, the same real feed refresh, a runner source edit restarts the
   runner, the SPA served by Vite.
4. Both at the same time: production and development with separate data,
   neither disturbing the other.

The feed refresh through the runner's real network path is the check that
would have caught the development runner timing every fetch out: with the
runner switched back to Bun it fails (every tool call `TIMEOUT`), with the
Node runner it passes.

## Real-environment positive path (spends plan quota)

```sh
RUN_LIVE_OPENCODE=1 OPENCODE_MODEL=opencode-go/muse-spark-1.3-contributor bun run test:real:live
```

`bun run test:real:live` (`tests/real/live.spec.ts`) is the positive path
the owner's rule demands, against `bun run dev` started for real on test
ports with throwaway directories and the real network:

1. Fresh state: Chat shows the notice, Settings → AI agent gets the backend
   and model chosen from the selectors and saved (with public web access
   allowed), a real recommended source (EIA Today in Energy) subscribed, a
   question asked; the run completes with at least one claim and one source
   link.
2. A second question naming a public page (`RESEARCH_REAL_PAGE_URL`,
   default `https://example.com/`) completes, and a Markdown file for that
   page exists in the development pages directory, beginning with the page's
   heading rather than site navigation.
3. Upgraded state: after a restart with a fresh database that has a run but
   no saved settings (created through the API), a question can be sent
   without visiting Settings.

Without `RUN_LIVE_OPENCODE=1` (and `OPENCODE_MODEL`) the spec skips, so
`bun run test:real` stays quota-free. A model reply that fails the protocol
fails the test — it is recorded as a finding in
[REQUIREMENTS_STATUS.md](REQUIREMENTS_STATUS.md), never asserted around.

## Cost profile

- **Local operation costs nothing to host.** The runner polls the local API every 15 s when idle.
- **What actually costs money:** metered model APIs (OpenRouter) and any licensed market data. Subscription CLIs are shown as "unknown / plan-limited", never as $0. No market-data vendor is wired in V1.
- **If deployed:** one Cloudflare Worker with static assets and one D1 database, both within the Free plans for single-owner use (about 5,800 runner polls a day, three D1 queries each). Workers Free allows ~50 D1 queries and 10 ms CPU per request; the largest handler is about a dozen queries, and `bun run bench` measures validation of the largest admissible bundle at ~3 ms on a laptop.

## Migrations and rollback

Schema changes are forward-only SQL files in `infra/migrations`; each
production generation carries the copy it was built with and applies exactly
those at start — never the working tree's. The initial migration has no
down-migration: rollback of data is restoring a backup of `data/`, and
rollback of a release is `bun run prod:rollback` (which moves only the
pointer). Starting a generation older than the database refuses with "the
database is newer than this release" naming the unknown applied migrations;
override with `RESEARCH_ALLOW_NEWER_DB=1` only after checking. For later
migrations, write the inverse statements in the migration's header comment
and rehearse them on a copy of `data/` first (API-009).

## Switching the database

Persistence sits behind two seams, so the database can be switched without touching the application code ([ADR-0008](adr/0008-switchable-persistence.md)): the `Persistence` ports bundle (what the app depends on) and the narrow `SqlDatabase` driver interface (what the SQL repositories run on). The same API suite passes on D1 and on `node:sqlite`; the latter is the portability proof, not a supported production store. To switch engines: implement `SqlDatabase` for another SQLite-dialect engine (or the `Persistence` ports for a non-SQLite one), add a vitest project like `api-sqlite`, and keep the suite green. Moving existing rows between engines is not covered — export each workspace as JSON and re-import it.

## Observability

- API: `data/logs/server.log` (production) or `data-dev/logs/server.log`
  (development). The development Vite server logs to `data-dev/logs/vite.log`.
  Unhandled errors are logged as `{event, name, method, route}` without messages or payloads.
- Runner: JSON lines in `data/logs/runner.log` (or `data-dev/logs/runner.log`)
  (`agent_probe`, `job_claimed`, `job_finished`, `completion_rejected`, …) carrying ids and codes only.
  `job_finished` is logged once per terminal submission and carries what the
  compact run card no longer shows: run id, state, attempt and max attempts,
  agent id and provider model, prompt version, the limits in force (research
  jobs only), usage counts, whether cost is known and its known portion
  (never $0 for unknown), failure code, verification status, and the number
  and kinds of progress entries.
- Audit: `audit_log` (owner actions) and `job_transitions` (every state change with lease generation and actor).

## Deploying to Cloudflare (optional, postponed)

Nothing above needs this. The same Worker can be deployed so the app is reachable from other devices; the deployment settings live in the `production` environment of `infra/wrangler.jsonc` (the Cloudflare deployment — not the same thing as production on this PC).

**State on 2026-10-12.** A deployment exists at `research-workspace.appservice27.workers.dev` with its D1 database and a Cloudflare Access application in front of it. It is locked: `OWNER_EMAIL` was never set, so the Worker refuses every request, and the runner path is not reachable through Access. It runs an older build (no HTTPS redirect, no HSTS). It holds no data. Either leave it locked or remove it with `bunx wrangler delete --name research-workspace` and delete the Access application in Zero Trust.

To finish it later:

```sh
bunx wrangler login          # once, in an interactive terminal (or set CLOUDFLARE_API_TOKEN)
bun run deploy
```

`bun run deploy` (`scripts/deploy.ts`) checks the login, creates the D1 database if needed and writes its id into `infra/wrangler.jsonc`, builds the SPA, applies migrations to the remote database and deploys the Cloudflare deployment. `bun run db:migrate:remote` applies migrations on their own.

Then configure access (ADR-0002):

1. In Cloudflare Zero Trust, an **Access application** for the Worker hostname with a policy allowing only your email (done).
2. In `env.production.vars`: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUDIENCE` (done), and `OWNER_EMAIL` — the address the policy allows (**outstanding**). Until all three are set, every request is denied.
3. Make the runner path reachable non-interactively (**outstanding**): a second Access application for `/api/v1/runner` with either a **Bypass** policy (the runner's bearer credential is then the only gate) or a **Service Auth** policy (give the runner the service token as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`).
4. Run the runner against it: issue a credential under **Settings**, then `RESEARCH_API_URL=https://… RUNNER_TOKEN=… bun run runner`. `node dist/runner/main.mjs renew` rotates the credential and prints the new token once.

Verified on a real account (2026-10-12): database creation, migration, deployment, and that the live Worker served the SPA and refused every unauthenticated request. Not verified: signing in through Access, the runner against the deployed Worker, and the remote backup below.

```sh
wrangler d1 export research --remote --env production --output backups/research-$(date +%F).sql --config infra/wrangler.jsonc
```

D1 Time Travel (point-in-time restore) is an additional safety net on Cloudflare's side.
