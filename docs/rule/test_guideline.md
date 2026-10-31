Test in a real development environment network.

Perform positive-path testing in the actual development environment network.

Please test main branch.

## What this means

**"Development environment network" is literal.** The positive path is run in
`bun run dev` — the environment changes are made in — with the real outbound
network: the runner really fetches a subscribed feed and a public web page, and
the real agent backend CLI really answers. A check that passes in `bun run prod`
only, or against fixtures, a scripted backend or a prepared database, does not
satisfy this rule. Production gets the same positive-path run before a release
is used, but it does not replace the development one.

A change is not verified until its positive path has been run in the actual
environment — the real launcher (`bun run prod` / `bun run dev`), the real
runner, the real agent backend CLI — starting from the state a fresh AND an
upgraded installation really has (nothing saved in Settings; earlier runs but
no saved settings) — and the result has been looked at. The two starting
states are both required: a fresh database has no backend saved, and an
upgraded one carries the last question's backend without saved settings.

## Why: the defects that motivated this rule

- Send disabled because no backend was saved: the composer correctly disabled
  sending with no backend, but the path from a fresh install (choose a
  backend in Settings → AI agent, then send) had never been walked end to end.
  Every scripted test passed because scripted state was already in place.
- Settings could not be saved because OpenCode required a model id the owner
  could not know: the model was a free text field, and the runner-reported
  model list was never exercised against the real CLI. Every scripted test
  passed with a typed fixture id.
- Every question failed with `NO_EVIDENCE_COLLECTED` in `bun run dev`: the
  development launcher ran the runner under Bun, where the runner's pinned
  HTTPS fetcher never completes a request, so every network tool timed out.
  The development browser test checked the page, the badge and hot reload but
  never sent work through the runner, and the real-environment run that had
  been done used `bun run prod` only — which is why the owner tightened the
  rule to "development environment network".

## What the repository offers today

- Opt-in live tests (they spend plan quota and need the network, so they skip
  without their switches): `bun run test:live:opencode` (Level 2 pipeline +
  Level 3 whole-application Playwright with the real OpenCode backend;
  `packages/adapters/test/providers/live.smoke.test.ts` for the adapter).
- Real-environment positive-path checks that need the network but spend no
  model quota: `bun run test:real` (`tests/real/`, Playwright, minutes not
  seconds). It builds in a pristine copy with no `dist/`, starts the real
  `bun run prod` and `bun run dev` on test ports with throwaway directories,
  subscribes one real catalog feed (EIA Today in Energy, overridable through
  `RESEARCH_REAL_FEED_URL`), triggers "Refresh news now" and requires the
  ingest to complete with at least one article and no fetch error — once per
  environment, plus an absolute release directory (build, start, rebuild
  while running, rollback) and both environments side by side. This is the
  suite that would have caught the `bun --watch` runner and the `dist/`
  build defects.
- **`bun run test:real` alone is PARTIAL coverage of this rule (network path
  only).** It never sends a question through a real agent backend, never
  retrieves a public page through the research tool, and never starts from
  the fresh and the upgraded settings states — every research question could
  fail while it passes. The positive path is the opt-in
  `RUN_LIVE_OPENCODE=1 OPENCODE_MODEL=… bun run test:real:live`
  (`tests/real/live.spec.ts`, spends plan quota): fresh state (Chat notice →
  Settings selectors → save → real recommended source → question → completed
  run with claim + source link), a second question naming a public page
  (`RESEARCH_REAL_PAGE_URL`) completing with a heading-first Markdown file in
  the development pages directory, and an upgraded state (a run but no saved
  settings, created through the API) sending without visiting Settings. A
  model reply that fails the protocol fails the test — a finding, never
  something to assert around — and every attempt's outcome is recorded in
  `docs/REQUIREMENTS_STATUS.md`.
- Deterministic browser coverage: the fresh-state and upgrade-state E2E tests
  in `tests/e2e/research.spec.ts`, the launcher specs in
  `tests/e2e/startLocal.spec.ts` and `tests/e2e/devLocal.spec.ts`, and the
  scripted UI review (`bun run review:ui`, see
  `docs/rule/UI_review_rule.md`).
- Scripted backends, fixtures and prepared state remain useful for
  determinism, but they NEVER count as this proof: only the real launcher,
  runner and backend CLI do.

## Rules

### Database migrations and existing installations

These rules apply whenever a change introduces or changes a persisted schema,
its readers/writers, or the launcher's migration behavior.

- **Applied migrations are immutable.** Never edit a migration that has been
  applied to a development, test, staging or production database that must
  remain usable. Treat uncertain application history as already applied.
  Schema corrections require a new, sequentially numbered migration. A
  restart does not reapply an edited migration whose name is already recorded.
- **Fresh-install and upgrade coverage are separate requirements.** Test both
  an empty database receiving all migrations and a populated database receiving
  only pending migrations. Passing the first case does not establish the second.
- **Reproduce the actual previous schema.** An upgrade fixture MUST preserve
  the historical table definitions and applied-migration ledger. Building the
  fixture from today's edited migration files is insufficient. If an earlier
  development layout was applied under the same migration name, include that
  layout explicitly, as well as the current supported layout. Check the schema
  and migration ledger read-only when diagnosing an existing installation;
  never infer its schema solely from repository files.
- **Test populated upgrades and failure behavior.** Include existing records,
  owner/source identities, exact values, commit/source timestamps and child
  rows. Verify their preservation, foreign-key integrity, required indexes and
  triggers, and reads/writes through the application after upgrade. Include
  child rows that cannot be reconstructed from a parent snapshot when the
  migration promises to preserve them. Verify that a failed migration rolls
  back without data loss, partial schema changes or an incorrectly recorded
  success, and that rerunning the migration command is safe.
- **Exercise the deployment path.** Use the real launcher and migration runner
  for the target environment, including Wrangler/local D1 where applicable;
  Node SQLite tests alone do not verify that path. For changes delivered while
  development is running, test the supported migration/reload sequence. If a
  restart is required, state and test that requirement explicitly.
- **Playwright MUST cover an upgraded database.** Start from a populated
  historical database in an isolated directory, apply the pending migrations
  through the supported launcher, and exercise the affected page and API.
  Require successful API responses, expected persisted values and absence of
  the reported error. A page that loads while its data request returns 500
  is a failed test. Include reload/restart persistence when relevant.
- **Report the scope precisely.** Record the command, browser, starting schema
  and migration state, fresh/upgrade scenario, model/provider usage and result.
  Distinguish synthetic imports from live provider data and fresh-database
  Playwright runs from upgrade runs. Do not report an existing-installation
  issue as fixed based only on a pristine test database. Mark untested scenarios
  and browser-launch failures explicitly.

All automated upgrade and reproduction tests MUST obey the isolation rules
below. Never migrate, reset or seed the owner's operational database as a test.
An authorized repair of that database is a separate operation; report it
separately from isolated regression tests.

Regression motivating these rules: an early version of migration 0016 had
already been applied, but its file was later edited to add material metadata
columns. Fresh-database Playwright tests passed because they used the edited
definition. The running development database retained the earlier layout, and
the market-data API returned HTTP 500. Additive migration 0017 repaired the
schema; the missing historical-layout upgrade scenario was the testing gap.

### Real-environment isolation and reporting

- Real-environment tests MUST use throwaway data directories and test ports,
  never the owner's `data/` or port 8787. They are opt-in because they spend
  quota and need the network.
- Real-environment tests are isolated by construction, not by convention:
  every suite that starts a launcher, a runner or a build constructs its
  child environment through `scripts/testEnv.ts` — an explicit allowlist
  plus its own throwaway values for every path and port setting, never the
  caller's environment — points `RESEARCH_RUNNER_ENV_FILE` at a file it
  wrote itself (the pristine copy excludes the operational
  `apps/runner/.env`), and registers clean-up at creation. The E2E guard
  asserts the configured directories canonicalise outside the operational
  ones and that none was created by the suite.
- What is still done by hand MUST be stated honestly: research quality has no
  versioned benchmark (REQUIREMENTS_STATUS.md, "AI evaluation: not done"),
  and SEC EDGAR / OpenRouter / remote-backup paths are unverified live.
- Every user-facing change MUST name in its summary which real-environment
  run covered it (command, model, outcome), or state that none did and why.
