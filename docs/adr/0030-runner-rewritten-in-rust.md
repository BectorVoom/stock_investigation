# ADR-0030: The local runner is rewritten in Rust (tokio + rayon)

**Status:** Accepted; **default switched to Rust on 2026-10-19** (see "Default switch") · **Date:** 2026-10-17 · **Owner decision:**
"Please optimise speed tool of web search and convert markdown by rust and
rayon", then "Please rewrite node.js code in rust" — scope chosen: **whole
runner**

## Context

The runner (`apps/runner`, bundled from TypeScript and run on Node) executes
every job: research pipeline, notebook assist, news ingest, market and
earnings refresh, Google Calendar sync. Its bundle reaches about 36,700 lines
of our TypeScript (the runner-reached halves of `packages/*` plus
`apps/runner`).

Measured on 2026-10-17 from the owner's machine:

| Step | Measured |
|---|---|
| GDELT `api.gdeltproject.org` TLS handshake | 3.4–5.0 s |
| GDELT first byte, fresh connection | 6.5–12.2 s |
| GDELT first byte, reused connection | ≈ 3.0 s |
| Wikipedia search, fresh connection | ≈ 0.9 s (TLS ≈ 0.25–0.38 s) |
| `htmlToMarkdown`, 1 MB article | 26 ms |
| `htmlToMarkdown`, 2 MB hostile nesting | 470 ms (htmlparser2's O(depth) stack) |

The Node fetcher opens a fresh socket per request (`agent: false`,
`packages/adapters/src/node/pinnedConnect.ts`), so every search, robots.txt
and page request pays a full TLS handshake — the dominant cost of
`web.search`. The conversion cost is small next to the network, but the
owner asked for it in Rust with rayon.

Porting specifications (exact behaviour, wire formats, pitfalls, tests):
`../stock_investigation.worktrees/briefs/rr-spec-{shell-wire,pipeline,providers,network-tools,finance-google}.md`
(working documents, not part of the repository).

## Decision

1. **A Cargo workspace at the repository root** (`Cargo.toml`, `crates/*`)
   builds one production binary, `research-runner`. The Worker API, the web
   app and the MCP server stay TypeScript. The TypeScript runner keeps working
   until the Rust runner passes the real-environment positive path on
   `bun run dev` (docs/rule/test_guideline.md); the launcher then switches,
   and the TypeScript that only the runner used is removed.
2. **Faithful port.** Every observable output — prompts sent to agents,
   model-facing tool text, Markdown archives, evidence, completions, events,
   `runner.log` lines, exit codes — is byte-identical to the TypeScript
   runner unless listed under "Deliberate changes" below. Parity is proved by
   **conformance vectors generated from the TypeScript implementation**
   (`vectors/**`, written by `scripts/vectors/*.ts`, replayed by `cargo
   test`), the same pattern as the Lean vectors in `formal/`. A drift check
   (`bun run vectors:check`) fails when the TypeScript output changes without
   the committed vectors.
3. **JavaScript semantics live in one crate** (`research-js`): UTF-16 lengths
   and slicing, JS whitespace and `trim`, JS number formatting and `toFixed`,
   `encodeURIComponent`, `JSON.stringify` strings, V8 `Date.parse`. No other
   crate re-implements them (DRY; they are the most likely source of silent
   differences).
4. **The wire contract** is hand-written serde types plus zod-parity
   validators (`research-contracts`), checked against vectors exported from
   the real zod schemas, including systematic mutations (unknown keys,
   length boundaries in UTF-16 units, JS whitespace, safe integers).
5. **Tokio for I/O, rayon for CPU-parallel pure work** — only where the work
   is genuinely parallel and the output is collected by index so it equals
   the sequential result:
   - claim verification across claims × evidence (normalised texts and
     number tokens precomputed in parallel);
   - feed item normalisation and fingerprinting (parallel map, sequential
     dedupe fold);
   - notebook prompt lines and content-size sums for large notebooks;
   - batch HTML → Markdown conversion (`convert_many`) and vector replay.
   A single HTML parse, tool calls within a plan (evidence ids depend on call
   order), model turns and rate-limited fetches stay sequential. CPU work
   called from async code runs on the rayon pool through a oneshot bridge,
   never on a tokio worker.
6. **HTML → Markdown** is a byte-level port of htmlparser2 12.0.0's
   tokenizer, parser and the `entities` decoder (html5ever's WHATWG tree
   builder produces different text on malformed pages), plus the converter.
   Its stack operations are O(1), removing the O(n·depth) residual.
7. **Errors and logging.** Library crates return `Result` with typed errors
   (`thiserror`); no `unwrap`/`expect`/`panic` outside tests (clippy-denied);
   `unsafe_code = "forbid"`. One logger (`research-effects`) writes the same
   JSON lines as `packages/effects/src/logging.ts`. A panic inside a job is
   caught at the job boundary and reported like a TypeScript throw
   (`job_crashed` + retryable failure), so `panic = "unwind"` is required.
8. **Test seams** live in a separate crate, `research-runner-testkit`, with
   its own binary `research-runner-e2e`. The production binary has no
   dependency on it (checked from `cargo metadata`) and contains none of its
   marker strings (checked on the release binary).
9. **Agent backend extensions (FR-013)**: Rust backends implement the
   `AgentRuntime` trait and are registered in the composition root; an
   `ExternalProcessRuntime` runs an owner-registered backend as a process
   speaking JSON Lines (`probe`; `run` with the request on stdin and agent
   events on stdout), so the scripted E2E agent plugs in through a small
   TypeScript stdio wrapper.

## Deliberate changes (each tested)

| # | Change | Why |
|---|---|---|
| C1 | Outbound HTTPS connections are reused. The pool is keyed by (validated host name, peer IP); reuse requires the fresh DNS answer to be all-public and to contain that IP; the peer is checked before TLS; a connection that ended a response abnormally (cap, abort, decode error, non-2xx) is closed, never pooled; no proxy, no HTTP/2 coalescing; idle connections close after 90 s. | Saves one handshake per robots.txt + page pair in `web.fetch_page` (and, until Wikipedia search was removed on 2026-10-19 — ADR-0025 — per Wikipedia search after the first: measured 0.74–0.49 s vs 0.82–0.94 s fresh). It does **not** help GDELT: GDELT closes an idle connection within about 1 s, so with the 5 s spacing a pooled GDELT connection is always gone (measured 2026-10-17). A pooled connection never serves another host name, and a name that now resolves to a non-public address is refused exactly as before (SEC-002). |
| C2 | GDELT spacing and per-host politeness record a request start only at the instant it is sent (`slot = max(now, last + interval)` under a lock, waiters served first come first served; a caller that never sends records nothing). | The TypeScript lets concurrent callers start together, breaking GDELT's one-request-per-5-s rule. Sequential behaviour is unchanged. Proved in Lean (`formal/ResearchFormal/Spacing.lean`: any two recorded starts are at least the interval apart, for every interleaving of claims and aborts) and replayed against the Rust ledger through conformance vectors. |
| C5 | **Withdrawn (2026-10-18).** It proposed opening the GDELT connection while a search waits for its 5 s slot. | GDELT's server takes ~9.6 s to answer the TLS ClientHello (measured with `openssl s_client -msg`), longer than the 5 s spacing. Measured with the implementation: no gain for back-to-back searches (one call already lasts 9–11 s, so the next one never waits). For overlapping searches an early connection lets the second request reach GDELT ~0.1 s after the first, breaking GDELT's one-request-per-5-s rule on the wire; counting the slot at the real send instead reproduces the TypeScript timing exactly. So C5 either breaks the fair-use rule or gains nothing, and it was removed. `web.search` latency is bounded by GDELT's server (≈ 10 s per call); a faster search needs a product decision (e.g. answer with Wikipedia when GDELT is slow). |
| C3 | A tool call that exceeds its time limit is cancelled (its future is dropped). | The TypeScript abandons the promise, so a timed-out `web.fetch_page` can still write its archive file after `TOOL_TIMEOUT` was reported. |
| C4 | Process-level differences of the Rust binary: `runner_started` logs `"runtime":"rust"` and `version` (no `release`/`node`); an extra `process_helper_missing` warning when `research-provider-spawn` (the setsid helper, needed because `unsafe` is forbidden) is absent; fault codes name Rust error classes (`RUNNER_ERROR_Panic`, `RUNNER_ERROR_IoError`, …) instead of JavaScript ones; a missing env file is skipped silently (Node prints a notice); proxy environment variables are not honoured by the Worker API client. The API client keeps one connection alive and races IPv6/IPv4 addresses (claim over TLS: 155 → 81 ms median), and shutdown cancels in-flight claim/heartbeat/event requests so the runner exits within the launcher's 8 s grace (measured ≈ 0.3 s). | The runtime guard against Bun no longer applies; the rest are inherent to a native binary or are deliberate robustness fixes. Every other exit code, log event and Node quirk (env-file precedence and parsing, signal behaviour, redirect statuses) matches the TypeScript runner, pinned by `vectors/runner`. |

Not adopted (would change semantics): a search-result cache (cached hits
would misstate `retrievedAt`, DATA-002), pre-warming GDELT/Wikipedia
connections when a run starts (reveals runs that never search).

## Known defects (found while porting; all fixed in both runners)

The first port kept these so parity could be proved; the owner then decided
to fix each in the TypeScript and the Rust runner alike, so the two stay
identical. Each fix has a vitest case, regenerated conformance vectors that
the Rust replays prove, and its own commit:

- F1 a Google grant was neither stored nor revoked when writing the token file
  failed during connect: it is now revoked before the fault propagates (`492f887`).
- F2 the SEC slot sleep ignored cancellation: it now ends on cancel (`bd70420`).
- F3 JPX shared strings kept phonetic `<rPh>` runs: they are now ignored, as
  Excel shows the cell (`52b7419`).
- F4 the Twelve Data unit was returned untrimmed: it is trimmed (`3c23410`).
- F5 a disconnect without a token file reported `planning → analyzing`: it now
  walks `collecting` too (`46da1a9`).
- F6 a dead numeric branch for JPX code cells: removed, no behaviour change
  (`05a28e3`).
- F7 sync ignored the claim's calendar id: it now uses the claim's id and falls
  back to the token file's only when the claim carries `null` (`46da1a9`).
- An empty progress note was queued and refused by the Worker forever
  (`text` is `min(1)`): it is no longer enqueued (`99eb42c`).

## Consequences

- Rust toolchain (stable, ≥ 1.85, edition 2024) becomes a prerequisite of
  `bun run dev`, `bun run prod:build` and `bun run verify`.
- Release generations contain `runner/research-runner` (mode 0555) instead of
  `runner/main.mjs`; a generation built before the switch still starts with
  Node for one transition release.
- `bun run dev` rebuilds the runner with `cargo build` on change and restarts
  it, like `node --watch` today.
- Disk: one shared Cargo target directory (`CARGO_TARGET_DIR`, default
  `<repo>/target`), dev profile without debug info; pristine-copy tests
  exclude `target/`.
- Shared rules now exist in two languages (Worker in TypeScript, runner in
  Rust). Divergence is caught by the conformance vectors and by golden runner
  outputs that a vitest parses with the zod schemas.

## Default switch (2026-10-19)

The owner chose to make Rust the default runner (`DEFAULT_RUNNER_KIND = "rust"` in
`scripts/launchPlan.ts`); `RESEARCH_RUNNER=node` keeps the TypeScript runner as the
rollback. The TypeScript runner is not deleted yet; that is a later, separate step.
Evidence, all gathered with the Rust runner:

- Chrome E2E with `RESEARCH_RUNNER=rust` matched the node results (the one known
  pre-existing failure, `chartViewer.spec.ts:517`, fails with both).
- `bun run test:real` passed with the Rust runner (9 passed, live skipped).
- Live positive path on the Rust runner with the Codex backend
  (`logs/live-codex-rust-attempt2.log`): fresh state, page archive, web search and
  chat rename/delete passed (4 of 5). The fifth, "upgraded state",
  failed with `VALIDATION_FAILED` on `model` at the API (a request rejected before it reached
  the runner); the re-run recorded in `logs/live-codex-rust-upgraded.log` passed (1 passed).

## Rollback

Until the TypeScript runner is removed, the launcher setting
`RESEARCH_RUNNER=node` starts it instead. After removal, rollback is
`bun run prod:rollback` to a generation built before the switch.
