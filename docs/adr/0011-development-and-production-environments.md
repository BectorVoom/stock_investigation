# ADR-0011: Separate development and production environments on this PC

**Status:** Accepted · **Date:** 2026-10-12 · Amends ADR-0006 (local-first operation)

## Context

There was one way to run the app on the owner's PC: `bun run start`
(`scripts/start.ts`). It served the owner's real data (`data/`) and, because
it ran `wrangler dev` on the source tree and served `dist/web`, it picked up
every source change and every rebuild made in the working tree. While features
were being developed, the owner's live app changed underneath them several
times, including into states that could not send a message. Development had to
become unable to change what production serves, and unable to touch production
data.

"Production" in this ADR means **production on this PC** (the owner's daily
app). The Cloudflare deployment (`bun run deploy`, `env.production` in
`infra/wrangler.jsonc`) is a third, separate thing and is called "the
Cloudflare deployment" everywhere below. Nothing about it changes.

## Decision

| | development | production (this PC) |
|---|---|---|
| Command | `bun run dev` | `bun run prod` (= `bun run prod:build` then `bun run prod:start`) |
| Code it runs | the working tree, live | one release generation under `release/generations/`, named by `release/current.json` |
| Reload on change | yes: SPA hot module replacement, API reload, runner restart | none: the instance serves its start-up generation for its whole life |
| Data directory | `data-dev/` | `data/` (the owner's existing data — never moved, never reset) |
| Address | SPA `http://localhost:3000` (Vite), API `http://127.0.0.1:8788` | `http://localhost:8787` |
| Shown in the UI | a "Development" badge in the header | nothing extra |

Both can run at the same time without interfering (different ports, data,
credentials, logs). `bun run start` stays and means `bun run prod`, so existing
documentation and habits keep working.

**Production is immutable by construction — release generations.**
`prod:build` never touches an existing release. It builds into a new,
uniquely named generation directory under the release area
(`release/generations/<UTC timestamp>-<short random>/`): the SPA, the runner
bundle, the Worker bundle (via `wrangler deploy --dry-run` against a
generated configuration that refers only to this generation, never `dist/`),
a copy of the migrations it was built with, the generation's Wrangler
configuration (prebuilt bundle with `no_bundle: true`, the released assets,
the generation's migration copy, and `RELEASE_GENERATION` /
`RELEASE_BUILT_AT` vars reported by `GET /api/v1/version`), and
`manifest.json` (build time, source revision, versions, generation id, the
migration list, an optional build-time marker) written last. The finished
generation is validated (manifest, Worker bundle, assets, runner bundle,
migrations — all present and non-empty), made read-only (best effort: stops
accidental overwrites, not deletion, the superuser, or chmodding back), and
only then activated by atomically replacing the pointer
(`release/current.json`, temp file + rename) that names the active
generation and records the history of activations.
`prod:start` reads the pointer ONCE at start and serves that generation for
its whole life; it records its use in a holder marker
(`release/holders/<generation>/<pid>.json`, removed on stop) that pruning
respects. `prod:rollback` only moves the pointer to the previous activation
that still exists; it deletes nothing. A failed build leaves the pointer and
every generation untouched and removes only its own unfinished directory.
`prod:build`, `prod:rollback` and pruning are serialised by a lock file in
the release area (`build.lock`); a lock from a dead process — recognised by
pid and start time, so a reused pid is not mistaken for the holder — is
taken over with a log line. Pruning runs after each successful activation
and keeps the newest three generations (`KEEP_GENERATIONS`), plus the
active, previous and live-held ones. Building while production runs is safe:
the running instance keeps serving its generation through the build, the
rollback, and afterwards — only a restart moves it to the pointer.

There is deliberately no Wrangler watching flag in the release
configuration: the installed Wrangler (4.149.0) offers no supported way to
turn watching off for `wrangler dev` (no CLI flag; its `dev.watch`
configuration key is rejected with "Unexpected fields found in dev field"
and, verified by experiment, does not stop the `--no-bundle` file watcher
anyway). Watching therefore stays on, and the guarantee rests on
generations never being modified after completion — which the launcher
specs prove by building an observably different generation mid-run
(`tests/e2e/startLocal.spec.ts`: the API id, the served page, the
read-only refusal, restart-only movement, failed-build survival,
live-holder pruning).

An existing `release/` laid out the old way (a single release directly in
`release/`) is not destroyed: the first `prod:build` migrates it — and a
legacy `release.previous/` — into generations (history preserved) and only
then builds. Anything ambiguous refuses with instructions.

**Releases carry their migrations.** Each generation applies exactly the
migration copy it was built with — never the working tree's
`infra/migrations` — so rebuilding the working tree cannot change what a
release migrates, and rolling back the code is not confused with rolling
back the schema. `prod:start` reads the applied migrations from the local
D1 journal (`SELECT name FROM d1_migrations` through `wrangler d1 execute
--local`) and refuses to start a generation that does not know every
applied migration ("the database is newer than this release", naming them),
because old code against a newer schema is exactly the rollback case. The
owner who has checked the difference sets `RESEARCH_ALLOW_NEWER_DB=1`.
Everything `start.ts` guaranteed (loopback only, process-group shutdown,
readiness, credential reuse and re-issue, port-busy refusal) still holds —
the supervision code is shared, not forked.

**Development is live.** `bun run dev` starts the Vite dev server (HMR) for
the SPA, the API from the working tree (`wrangler dev`, which reloads on
change), and the runner as a watching `bun build` of its bundle into
`data-dev/runner/` run under `node --watch` (restarts when its sources or the
packages they import change; Node, never Bun — see Consequences), all under
the same supervision code as production. The SPA dev server proxies `/api` to
the development API port (`vite.config.ts` follows the launcher's
`RESEARCH_DEV_API_PORT`; default 8788). Cookie/CSRF rules keep working
through the existing `DEV_ALLOWED_ORIGIN` mechanism, which is set only in
development and never reachable in production. Verified on 2026-10-12 in a
pristine copy: the served document references `/@vite/client`; a throwaway
file under `apps/web/public/` showed rewrites immediately without a restart;
touching `apps/runner/src/main.ts` rebuilt the runner bundle and restarted
the runner (agent probes re-ran); editing `apps/api/src/app.ts` made workerd
print "Reloading local server...".

**The two data directories refuse each other — twice.** The pure plan
(`planLaunch`) refuses identical or overlapping (parent/child, either
direction) data directories by resolved path, and before ANY write the
launcher canonicalises every directory it will use: symlinks on the longest
existing ancestor are followed (`realpath`), the not-yet-existing rest
appended, and existing directories compared by file-system identity (device
+ inode) — so a symlinked `data-dev`, a case variant on a case-insensitive
file system, and a `data`/`data/dev` overlap are all caught, each refusal
naming both paths. The same ONE validation (`validateDirectorySet`) guards
every destructive operation in `prod:build`, `prod:rollback` and both
launchers: production data, development data, the release area and the
legacy previous location must be pairwise disjoint (no equality, no
containment), none the repository root or one of its parents, none the
file-system root, none the home directory. Every `rm`/`rename` in these
scripts goes through a helper that re-checks its target is inside the
validated release area. Logs, the runner
credential and the database each live under their own directory, so the backup
story is unchanged: the backup is a copy of `data/`.

**Telling them apart and telling generations apart.** The Worker gets an `APP_ENV` variable
(`"development"` | `"production"`); `GET /api/v1/session` gains
`environment` with those two values; the SPA header shows an amber
"Development" badge (text, never colour alone) when it is `development`. An
unknown or missing value is treated as `production` (no badge) — fail towards
the quiet, safe presentation. `GET /api/v1/version` additionally reports the
release generation id and build time baked in at build time (nulls outside a
release) — the read-only observable the immutability specs assert on.

**Structure.** One launcher module with the mode as input (`scripts/launch.ts`
+ pure `scripts/launchPlan.ts`, unit-tested in `tests/local/`), not two copied
scripts. `scripts/start.ts` is a three-line shim for `bun run prod`. The old
`dev:web` / `dev:api` scripts are removed: they shared the production data
directory and hardcoded ports, which is the hazard this ADR removes.

**Supervision: readiness, crash reporting, and the parent-liveness guard
(task 23b).** Readiness means the runner has actually reported to the API
after this launch (`waitForRunner` accepts only a report newer than the
runner's start): `node --watch` stays alive when the program it runs exits,
so the surviving watch process is not health. When no report arrives within
the timeout the start-up FAILS with the runner's last error line — its exit
code or signal plus the `invalid_configuration` / `unsupported_runtime` /
`runner_crashed` event from the runner log (`scripts/supervision.ts`) — and
everything started so far is stopped; development never prints "ready" for a
dead runner again. While running, a runner exit is reported on the
launcher's console at once with its exit code and log hint; in development a
watcher reports runner-log crash lines at once too (the bundle is rebuilt
and rerun on the next source change as now). Three exits or crash lines in a
short window without a successful report is a crash loop: the launcher stops
being retried and says so. Killing the launcher with SIGKILL runs no
shutdown code, so a detached parent-liveness guard (`scripts/guardian.ts`,
no new dependency) watches the launcher pid from its own process group and,
when that pid disappears, SIGTERMs (then SIGKILLs) only the process groups
recorded in `logs/guardian.json` — verified as positive integers, never
0/1, never its own group — and exits; a clean shutdown stops it first, so it
is never orphaned. Limitation: on Windows process groups are not used, so
the guard kills recorded pids directly and descendants outside them may
survive; the pid-reuse race is bounded by the 250 ms poll, not eliminated.

## Promoting a change and rolling back

Daily use is production. To promote a change: `bun run verify`, then
`bun run prod:build` (safe while production runs — see above), then restart
production (Ctrl+C, `bun run prod:start`). Each build keeps the newest three
generations plus the active, previous and live-held ones; older ones are
pruned automatically. To undo a release: `bun run prod:rollback` moves the
pointer to the previous activation, then restart production for it to take
effect. Rollback refuses when there is no previous generation with a valid
manifest, and never leaves the pointer naming something that does not exist.

## Consequences

- Developing features no longer disturbs the owner's app or data. The price is
  one more build step before a change is visible in production.
- `release/` (generations, pointer, lock, holder markers), `release.previous/`
  (legacy only: migrated once, never written again) and `data-dev/` are
  git-ignored. `data/` stays exactly where it was.
  `RESEARCH_PREVIOUS_RELEASE_DIR` is kept as a setting for the legacy
  migration path and validated with the other directories, but nothing is
  ever written to it anymore.
- Tests never write into the repository-root release or data directories:
  every spec that builds or starts a release, or starts either launcher mode,
  builds its child environment through `scripts/testEnv.ts` (explicit
  allowlist plus throwaway OS-temp values for every path and port — never the
  caller's environment), points `RESEARCH_RUNNER_ENV_FILE` at a file it wrote
  itself, and excludes the operational `apps/runner/.env` from pristine
  copies. The E2E guard (`tests/e2e/globalSetup.ts`) asserts that directly:
  every configured directory must canonicalise outside the operational
  directories, and none of them may have been created by the suite.
- The E2E suite covers both modes: `startLocal.spec.ts` exercises prod
  semantics (build generations, serve the pinned one with its id on
  `/api/v1/version` and its marker in the page, missing-release refusal,
  build-while-running and rollback-while-running immutability, read-only
  refusal, restart-only movement, failed-build survival, live-holder
  pruning, newer-database refusal with the documented override), and
  `devLocal.spec.ts` exercises dev (Vite serving,
  `environment: "development"`, badge, live file serving without navigation).
- **Correction: the first version's immutability guarantee was not true.**
  An independent review (OpenAI Codex CLI, read-only sandbox, high reasoning
  effort — see `docs/CODEX_REVIEW.md`, "Development/production split") found
  that `--no-bundle` disables bundling, not watching: Wrangler still watches
  the Worker file, the asset directory and the configuration. The
  orchestrator confirmed it by running it: with production serving a release,
  appending to `release/web/index.html` changed the served page at once, and
  editing `release/worker/worker.js` made the running API reload and answer
  with the edited code — while the already-running runner kept the old code
  (a mixed version). The same review found the data-directory comparison
  could be bypassed with a symlink, and that release-directory settings
  could delete production data. All three are fixed above (generations that
  are never modified + read-only files; canonical path validation; one
  directory-set validation before any destructive operation), each with
  regression tests that fail without the fix. Do not overstate the
  read-only part: it stops accidental overwrites, not deletion (pruning
  still deletes), not the superuser, not the owner chmodding a tree back.
- The first real-environment runs found two defects this ADR's tests had
  missed, both fixed with regression coverage in `bun run test:real`
  (`tests/real/`, documented in `docs/rule/test_guideline.md`):
  - `prod:build` bundled the Worker through `infra/wrangler.jsonc`, whose
    `assets.directory` is `../dist/web`, so a checkout that had never run
    `bun run build` failed. The build now goes through a generated
    configuration that refers only to the release being built (unit-tested in
    `tests/local/releaseOps.test.ts`); the real suite builds in a pristine
    copy with no `dist/`.
  - The development plan started the runner with `bun --watch`, under which
    the runner's pinned HTTPS fetcher never completes, so every network tool
    timed out and every run failed. Development now rebuilds the runner
    bundle on change and runs it under `node --watch` (asserted in
    `devLocal.spec.ts` and the real dev check); the runner refuses to start
    under Bun with `unsupported_runtime` and a distinct exit code.

## Alternatives considered (deliberately not done)

- **Containers or a second machine.** Heavier than the hazard warrants for one
  owner on one PC; ports + data directories + a prebuilt release give the same
  separation.
- **A native local server instead of `wrangler dev`.** Rejected already in
  ADR-0006 (a second persistence adapter and an untested Worker path); this
  ADR keeps that decision for both modes.
- **Automatic releases on a schedule or on every commit.** Rejected: promotion
  stays an explicit owner action (`prod:build` + restart) so the owner always
  knows what production runs.
- **Re-issuing the runner credential per environment label.** Not needed: each
  environment has its own database and credential file, so credentials already
  differ; only the human-readable label differs ("Local runner (bun run
  prod/dev)").
