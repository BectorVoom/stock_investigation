Test in a real development environment network.

Perform positive-path testing in the actual development environment network.

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
