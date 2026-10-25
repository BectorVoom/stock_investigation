# Rust runner API connection reuse

The runner retains up to four idle HTTP/1.1 connections to its fixed API
origin. This lets overlapping progress-event and heartbeat requests reuse
connections across bursts instead of discarding all but one. Acquisition uses
the most recently returned socket first; release removes expired or closed
idle sockets. The existing 30-second idle expiry, per-attempt deadline,
response bounds and stale-connection retry still apply. The bound covers idle
sockets, not in-flight requests; requests do not wait for a pool permit.

## Validation (2026-10-24)

- On main, the API-client suite passed 20 tests, with the existing live-Worker
  latency test ignored. The concurrent-reuse test sends two waves of four
  requests through actual loopback TCP sockets and observes four connections
  total. A separate six-request burst verifies that only four idle sockets
  remain. This demonstrates connection reuse, not an end-to-end research
  latency improvement.
- `cargo fmt --all --check` and workspace Clippy with warnings denied passed.
- `cargo test --locked -p research-runner` passed, including process and
  conformance tests (existing opt-in tests remain ignored).
- `bun run bench`: baseline failed the daily chart-resampling budget
  (5.276 ms against 5 ms). The subsequent run passed all budgets. These
  TypeScript CPU benchmarks do not measure the Rust HTTP pool.
- Workspace Rust tests encountered a pipeline corpus-count mismatch:
  `pipeline.test.ts blocks` was 62, expected 61. The research pipeline and
  vector files already had separate in-progress edits; this pool change
  does not modify them.
- No real development launcher / agent research run was performed: no live
  backend and model were selected for this validation. The required fresh
  and upgraded installation positive paths remain unverified, as does
  end-to-end research latency. Use the isolated real-environment suite in
  `docs/rule/test_guideline.md` before treating this as release validation.

This change concerns transport resource reuse; it changes no domain algorithm
or Lean model.

## Queue pickup (2026-10-24)

The API's empty-queue claim response now asks the runner to poll again after
1,000 ms rather than 15,000 ms. A question arriving just after an empty claim
therefore waits at most one polling interval before the next request, plus
request processing time, while the runner is idle. This applies to both Rust
and Node runners. Busy runners still finish their current job first; blocked
backends retain their five-second interval and API failures retain backoff.
The tradeoff is up to one idle claim per second instead of four per minute,
including on remotely hosted APIs.

Validation on main: 104 job API tests passed across real local D1/Workers and
SQLite. The regression queues a question after an empty claim and checks
pickup at the returned interval. The Rust loop regression covers the one-,
five- and fifteen-second server hints. The real development positive path
passed: `bunx playwright test --config tests/real/playwright.config.ts
devReal.spec.ts` (Rust runner, real feed, source-edit rebuild/restart; one
test passed in 44.4 seconds). This spends no model quota and does not cover
fresh/upgraded chat research with a real agent or measure chat latency.

## Collection during a search-service outage (2026-10-24)

The development run's first attempt recorded five consecutive failed
`web.search` calls, roughly 12–15 seconds apart, before a subscribed feed
returned evidence. A direct GDELT check returned HTTP 429 after 12.947 seconds.
Repeating queries was spending the collection budget on the same unavailable
provider.

Both search adapters now pause new searches for 60 seconds after a transport
timeout, network failure, HTTP 429 or HTTP 5xx. During that period they return
`SEARCH_COOLDOWN` immediately, without a provider request or spacing sleep.
The first failure remains `SEARCH_FAILED`; query errors, empty results and
owner cancellation do not open the cooldown. Later requests retry after
expiry. The state belongs to the existing search-tool factory; unrelated
tools remain available. Requests already admitted before an outage is known
can still finish. No domain algorithm or request-spacing model changes.

Validation:

- `cargo test --locked -p research-tools`: 24 passed, one existing opt-in
  network test ignored; includes regenerated TypeScript transcript parity and
  the existing Lean request-spacing vectors. New paused-time tests verify
  immediate failure, expiry/recovery, cancellation and bad-query handling.
- Search TypeScript tests: 17 passed. Typechecking, formatting and tool-crate
  Clippy with warnings denied passed.
- Real Rust tools: `cargo test --locked -p research-tools --test behavior
  measure_real_network_tools -- --ignored --nocapture` passed. First search:
  `SEARCH_FAILED` after 15,002 ms (network timeout); subsequent three searches:
  `SEARCH_COOLDOWN`, each under 1 ms. All four direct public-page fetches
  returned one evidence item each (163–1,098 ms). This measures the tool path,
  not total model or research latency.
- Isolated real development launcher: `bunx playwright test --config
  tests/real/playwright.config.ts devReal.spec.ts` passed (Rust runner, live
  feed and source-edit restart; 46.1 seconds). No model quota was spent. The
  fresh/upgraded chat positive paths with a real agent remain unverified.

## Bounded collection and repeated retrievals (2026-10-24)

The subsequent Apple research run completed, but spent 67 seconds in
collection (11:45:54 to 11:47:01 UTC), repeatedly requesting the same feeds,
unconfigured SEC tools and a search tool in cooldown across seven planning
turns. Returning cooldown errors quickly did not stop the planner from
continuing to ask for more tools.

Both pipelines now allow at most three planning rounds per attempt (or fewer
when the remaining cumulative budget requires it). Existing analysis repair
and independent verification remain available. When this limit stops
collection, progress and the answer explain that additional sources may not
have been retrieved. Without evidence the run still fails honestly.

Within an attempt, a successful tool request is not executed again for the
same tool id and serialized schema-parsed arguments; its earlier evidence
remains available. `NOT_CONFIGURED` and `SEARCH_COOLDOWN` stop further calls
to that tool for the attempt, even with other arguments. Other transient
failures can still be retried within the three rounds. Skipped requests do
not consume tool-call allowance. State is discarded between attempts; this
does not introduce a persistent data cache.

The tradeoff is reduced research breadth in exchange for bounded collection
latency. A planning round can contain up to eight calls, whose existing
individual deadlines still apply, so this is not a seconds-level latency
guarantee. No domain algorithm or Lean budget model changes.

Validation: 299 application tests passed, including a three-round planner
that never asks to stop, reuse of earlier retrievals and suppression of
unavailable tools. The prompt-volume scenario now exercises three rounds and
retains its absolute byte ceiling; its old five-round workload is no longer
used as a like-for-like speed comparison. Pipeline vectors were regenerated
and replayed by Rust. Workspace Rust tests, typechecking, Clippy, formatting
and `bun run bench` passed. The final real development network test passed
with the Rust runner and a live feed (43.0 seconds).

Attempted real chat validation:
`RUN_LIVE_AGENT=claude-code bunx playwright test --config
tests/real/playwright.config.ts live.spec.ts -g
'fresh state: notice|upgraded state: a run'`. The fresh-state research run
failed with `PROVIDER_RATE_LIMITED` on all three attempts, before tool calls.
The test was interrupted after observing that terminal failure rather than
waiting out its completed-only assertion. The serial upgraded-state test did
not run. No model was explicitly selected (CLI default). End-to-end latency
and these two chat positive paths remain unverified; no synthetic result is
reported as a successful live chat.

## Profile of collecting and analyzing (2026-10-25)

`bun run profile:runs` (new, `scripts/profileRuns.ts`) splits each stored
research run's wall-clock time into queue, lost (earlier lease generations),
planning, tools, analyzing, verifying and publishing, from the job events the
runner already records; it reads the local D1 read-only. On the owner's 14
latest development runs (6,251 s in total):

| Where | Seconds | Share |
|---|---|---|
| Lost to runner restarts (job waits out its 90 s lease, then starts from zero) | 2,652 | 42% |
| Analysis model turn | 1,604 | 26% (one 1,261 s OpenCode outlier) |
| Tools | 810 | 13% — `web.search` (GDELT) 777 s of it |
| Planning model turns | 751 | 12% |
| Verification model turn | 131 | 2% |

A direct check showed GDELT answering this machine with HTTP 429 after a
~10 s TLS handshake, so every run spent ~15 s on a search that could not
succeed. A direct A/B of the Claude API (Opus 5.5, one sample each, the
runner's request body) measured planning 5.7 s → 3.7 s and analysis 24.1 s
→ 15.0 s from effort medium to low; the owner chose to keep the Settings
effort for every step.

## Web search over Tavily, GDELT as `news.search` (2026-10-25)

The owner chose Tavily for `web.search` (whole web) and kept GDELT as a
separate `news.search` (ADR-0025 amendment). Both pause after a provider
outage for 60 s, doubling per consecutive outage up to 30 minutes, so a
refusing provider costs one slow request per pause rather than one per run.
The fetchers gained a narrow JSON-POST option for Tavily (pinned host, ≤ 64
KiB, never redirected; a POST never reuses or returns a pooled connection and
is never retried on another address once its body was sent).

Validation:

- TypeScript search and catalogue tests (35), Rust `research-tools` (all
  suites, including the replay of 425 recorded search factories — 207 Tavily
  with 157 successful calls and 145 evidence items — from the TypeScript unit
  tests and a seeded corpus).
- Real network, both runners' own fetchers, no key: `api.tavily.com`
  answered `HTTP 401` in 0.84 s (Rust,
  `cargo test -p research-tools --test behavior real_tavily -- --ignored`) and
  1.3 s (TypeScript); the next call returned `SEARCH_COOLDOWN` without a
  request. GDELT took 13–15 s to fail the same way. A run with a real key and
  model was not performed (no `TAVILY_API_KEY` on this machine).

## Lease hand-back on shutdown (2026-10-25)

In the owner's last 14 development research runs, 42% of wall time was lost
to runner restarts. The stopped runner kept its lease until the 90-second
lease ran out, and recovering the job used up an attempt. One run failed with
`RETRY_CEILING_REACHED` from restarts alone. Under ADR-0036, a runner that is
shutting down calls `POST /runner/jobs/:id/release`. The job returns to
`pending` at once with the claim refunded, so the next runner takes it on its
first claim as the same attempt.

Validation on main:

- **Real environment, Rust runner.** This used the isolated development
  launcher: a pristine copy, throwaway data, the real local D1 API and a real
  JP stock-directory download. The runner was sent SIGTERM 67 ms after it
  claimed the job. `job_released` was logged 5 ms after `shutdown_requested`,
  and the run was `pending` with attempt 0. After a source edit rebuilt and
  restarted the runner, it claimed the job 2.4 s after start, at generation 2,
  attempt 1, and completed it.
- **Real environment, Node runner (`RESEARCH_RUNNER=node`).** The same check
  passed: the job was released 25 ms after SIGTERM, reclaimed 2.0 s after the
  restart at generation 2, attempt 1, and completed. Neither check spent
  model quota or ran a chat research turn.
- **`devReal.spec.ts`** (real feed, source-edit rebuild and restart) passed:
  one test in 48.4 s.
- **API tests.** The job API suites passed on both real local D1/Workers and
  SQLite. The new cases cover:
  - requeue with the claim refunded, usage kept and the old proof fenced;
  - refusal for another runner, after a release and for a missing run;
  - a body without usage;
  - a cancel request turning a release into a cancel;
  - five claim/release restarts in a row with no retry ceiling;
  - Google connect release, which drops the dead sign-in link, and Google
    cancel release, which restores the link;
  - cross-owner refusal.
- **Runner tests.** Both runners were tested for a shutdown that releases with
  the usage so far, a refused or failed release (logged, job still
  abandoned), and no release after a lost lease. In the Rust runner, a release
  to an unanswering Worker is cut off after 2 s.
- **Lean 4.** `bun run formal:check` passed, and 1,152 `decideRelease`
  vectors replay in TypeScript and Rust.
