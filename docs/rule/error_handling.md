# Error handling

How every part of the system — the TypeScript pure core, the TypeScript
shell, the web app and the Rust runner — handles a failure, and the one
helper to use for each recurring job. Background:
[ADR-0007](../adr/0007-effect-for-logging-and-error-handling.md) (Effect in
the TypeScript shell), [ADR-0030](../adr/0030-runner-rewritten-in-rust.md)
(Rust runner). Requirements: ARCH-010 (explicit error handling), ARCH-017
(fail closed), API-008 (stable error codes), SEC-010 (no secrets or content in
traces).

**Keeping this document true.** It names files and helpers instead of copying
their code, so the code stays the single source of truth. A rule that can be
checked mechanically is checked by `tests/architecture/errorHandling.test.ts`.
When you change a rule, change this file, the helper and that test in the
same commit.

## 1. Three kinds of failure

Decide which kind a failure is before writing any handling code.

| Kind | What it is | Examples | How it travels |
|---|---|---|---|
| **Expected failure** | A normal outcome the caller must handle | not found, validation failed, rate limited, not JSON, malformed URL, unreadable stored row | A typed value: `Result<T, E>` with a documented error union |
| **Unexpected failure** | Something outside the program failed in a way it did not plan for | a socket reset mid-body, a rejected promise from an adapter, `EACCES` on a file | Caught once, turned into a typed failure that carries **labels only** (§4), then handled at a boundary (§3) |
| **Defect** | A bug: an invariant the code itself guarantees did not hold | a pipeline stage the state machine cannot produce | Not converted. It escapes to the outermost boundary, which logs its name and answers or exits |

Rules that follow from the table:

- An expected failure MUST NOT be thrown, and MUST NOT be caught as an
  exception further up. If a library throws for an expected outcome (for
  example `JSON.parse`, `new URL`), wrap it once in a total function (§2).
- Unknown data MUST be validated at the boundary where it enters (zod in
  TypeScript, `research-contracts` decoders in Rust) and a mismatch is an
  expected failure.
- Fail closed (ARCH-017): when a check itself cannot be completed (robots.txt
  unreadable, URL not parseable, permission unknown), the answer is "no".

## 2. One helper per job

Use these instead of writing a new `try`/`catch`. Each has exactly one
definition.

| Job | Use | Defined in |
|---|---|---|
| Label a thrown value for a log, a failure detail or a code | `thrownName` (its `name`), `thrownCode` (a safe OS/library code), `describeThrown` (code, else name, else `"unknown error"`) | `packages/domain/src/thrown.ts` |
| Parse JSON text | `parseJson` → `Result<unknown, "INVALID_JSON">`; `parseJsonOrNull` when the value goes straight into a schema check | `packages/domain/src/json.ts` |
| Parse a URL that may be malformed | `parseUrl(raw, base?)` → `URL \| null` | `packages/domain/src/url.ts` |
| Build a typed result | `ok` / `err` (pure core), `fail(code, message)` (use cases) | `packages/domain/src/result.ts`, `packages/application/src/errors.ts` |
| Code for an agent turn that threw | `agentThrewCode` → `AGENT_THREW_<name>` | `packages/application/src/errors.ts` |
| Lift between `Result` and Effect | `fromResult`, `attempt(operation, run)`, `attemptResult`, `toResult` | `packages/effects/src/errors.ts` |
| Log at a boundary that must answer even if the logger throws | `logIsolated(() => logger.error(...))` | `packages/effects/src/logging.ts` |
| Read or write browser storage | `browserLocalStorage`, `readStoredText`, `writeStoredText` | `apps/web/src/lib/browserStorage.ts` |
| Rust: send a turn's closing event | `TurnSender::send_closing` | `crates/research-agent-core/src/runtime.rs` |
| Rust: label an I/O or TLS error like Node does | `research_net::errors::io_error_code` (+ `UNKNOWN_ERROR`) | `crates/research-net/src/errors.rs` |

`apps/mcp` and `packages/widget-grid` may not import `@research/domain`
(`tests/architecture/boundaryRules.ts`: the MCP server and the reusable grid
stand alone), so they keep small local equivalents. Everything else uses the
helpers above.

`describeThrown`'s output is mirrored byte for byte by the Rust runner
(`crates/research-net/src/errors.rs`) so failure details read the same from
both runners. Change one, change both.

## 3. Where failures end: the boundaries

A failure is handled once, at the nearest of these boundaries. Code between
the source and the boundary passes the typed failure along and does not log
it a second time.

| Boundary | File | What it does |
|---|---|---|
| API route | `apps/api/src/http.ts` → `respond` | Each route handler is one Effect program. `HttpFailure` (wraps a `UseCaseError`) → the JSON error body with its stable status from `STATUS`. `UnexpectedError` → one `unhandled_error` log (`operation`, `name`, `method`, `route`) and `INTERNAL` / 500 |
| API defect | `apps/api/src/app.ts` → `defectResponse` (`app.onError`) | Logs `unhandled_error` with the error name and route only; answers `INTERNAL` |
| TypeScript runner process (rollback runner) | `apps/runner/src/main.ts` | `Effect.catchTags` maps each tagged failure to a log and an exit code (`exitCodeForFailure`: `ConfigurationError` → 2, otherwise 1); a defect is logged once as `runner_crashed` |
| TypeScript runner job | `apps/runner/src/jobExecution.ts` | An unexpected throw becomes `job_crashed` plus a retryable `RUNNER_ERROR_<name>` completion |
| Rust runner process | `crates/research-runner/src/main.rs`, `exit_codes.rs` | `exit_code_for` maps each `RunnerFailure` to an exit code; the panic hook never prints the payload (SEC-010) |
| Rust runner job / CPU work | `crates/research-runner/src/job_execution.rs`, `research_effects::cpu::run_cpu` | A panic is caught (`panic = "unwind"`) and reported as `job_crashed` with a retryable failure, like a TypeScript throw |
| Agent tool call | `packages/agent-core/src/tools.ts`, `crates/research-agent-core/src/authorize.rs` | A throwing/panicking tool becomes `TOOL_THREW` (or `TOOL_TIMEOUT`) |
| Agent turn | `packages/application/src/research/pipeline.ts`, `notebook/assistTurn.ts` | A throwing adapter becomes a retryable `agentThrewCode(...)` provider failure |
| Widget agent host | `packages/widget-grid/src/agent/host.ts` → `guarded` | Any throw from host-supplied code or the store becomes a typed `WidgetAgentFailure`; the host never throws |
| Web request | `apps/web/src/api/http.ts` → `request` | Never rejects: every failure becomes a typed `ApiFailure` (`network`, `invalid-response`, `api`) |
| Web page | `ErrorBoundary` in `apps/web/src/App.tsx` | A failed lazy chunk shows an error state with "Try again", never a blank page |

## 4. What a failure may carry (SEC-010)

- **May carry:** stable codes (`NOT_FOUND`, `RATE_LIMITED`), ids, counts,
  operation names, the thrown value's name and safe code
  (`thrownName` / `thrownCode` / `describeThrown`), field paths of a failed
  validation.
- **Never carries:** a thrown value's `message` or `stack`, tokens, prompts,
  retrieved page or feed text, stored content, request bodies, URLs with
  query strings. Node puts paths, IP addresses and ports into messages, and
  agent or page text can contain anything.
- **API errors** use the stable machine-readable codes of `ApiErrorCode`
  (mapped to a status in `STATUS`, API-008). `message` is a fixed,
  human-readable sentence. Validation details name fields only and never echo
  values (`readJson`). No raw internal trace reaches an HTTP response.
- **Stored failure codes** (`failureCode`, `failureDetail` on jobs) follow
  `STABLE_FAILURE_CODE_PATTERN` in `packages/contracts/src/jobs.ts`; a tool
  code that does not match is replaced by `TOOL_ERROR`.
- **Web exception:** a message the owner's own browser produced (for example
  `Failed to fetch`) may be shown on screen, because it never leaves that
  browser. It is never sent to the server, logged or stored.

Logging rules (event names, field sanitising) are in [logging](logging.md).

## 5. The four allowed shapes of `catch`

Every `catch` (TypeScript), `.catch(...)` on a promise, and `let _ =` (Rust)
MUST have one of these shapes. An empty `catch {}` is not allowed.

1. **Convert.** Turn the throw into an expected failure right where the
   throwing call is: `return err(...)`, a typed failure object, or a fallback
   value whose meaning the function documents ("`null` means not
   connected"). Prefer the §2 helpers over a hand-written `try`.
2. **Clean up and rethrow.** Release what the failed step held, then rethrow
   unchanged: `ROLLBACK` then `throw error` (`packages/adapters/src/sqlite`),
   delete a half-written temp file then `throw error` (`googleTokenStore.ts`).
3. **Boundary.** One of the §3 boundaries: log once with labels only, then
   answer or exit.
4. **Best-effort discard.** The failure truly changes nothing: a cancel of a
   body that is already being dropped, a cleanup after the real error was
   reported, a convenience that cannot be remembered. The block or the line
   above it MUST have a comment saying **why** dropping it is safe.

Things that are not allowed:

- `catch {}` with nothing in it, or `.catch(() => undefined)` with no comment.
- Catching a defect to hide it (a broad `catch` around code that cannot throw
  for an expected reason). The exception is the last line of a documented
  "never throws" contract (`host.ts`, `htmlToMarkdown`, `robotsPolicy`), which
  states its fallback in a comment.
- Logging a failure and also returning it, so the boundary logs it again.
- Re-labelling a thrown value by hand (`error instanceof Error ? error.name :
  ...`). Use `thrownName`.

## 6. Per layer

### Pure core: `packages/domain`, use cases in `packages/application`

- Returns `Result<T, E>`. Use cases return `UseCaseResult<T>` built with
  `fail(code, message)`.
- Does not import Effect. May not throw for an expected failure.

### TypeScript shell: `apps/api`, `apps/runner`, `packages/adapters`, `packages/agent-core`

- Expected failures in Effect programs are `Data.TaggedError` classes:
  `HttpFailure` (API); `ConfigurationError`, `CredentialRenewalError`,
  `UnsupportedRuntimeError` (runner, `apps/runner/src/exitCodes.ts`);
  `UnexpectedError` (any throw or rejection, from `attempt`).
- An adapter returns typed failures for everything it expects (HTTP status,
  timeouts, bad bodies) and throws only for the unexpected. The caller wraps
  it with `attempt("operation_name", ...)` naming the operation in progress.
- A custom `Error` subclass sets `this.name` (for example `StoredDataError`),
  so `thrownName` can name it.

### Web app: `apps/web`

- API calls go through `request` in `apps/web/src/api/http.ts`, which never
  rejects. Views show a failure from its `ApiFailure` (code and safe
  message), with a retry where one makes sense.
- Browser storage is a convenience: every access goes through
  `browserStorage.ts`, and a refusal means "not remembered", never an error
  shown to the owner.
- Browser APIs that may be refused (clipboard, pointer capture) are a
  best-effort discard (§5.4) or set a visible "failed" state.

### Rust runner: `crates/*`

- Library crates return `Result` with `thiserror` error enums. Production
  code cannot `unwrap`, `expect`, `panic` or index (`[workspace.lints]` in
  `Cargo.toml`; tests may, `clippy.toml`).
- `let _ = …` is the only way left to drop an error silently, so each one has
  a comment on its line or the three lines above saying why (§5.4). A turn's
  closing events use `TurnSender::send_closing` instead.
- Panics are caught only at the job and CPU-bridge boundaries (§3) and are
  reported by name, never by payload.
- A failure that crosses to the Worker or the logs uses the same codes and
  labels as the TypeScript runner (`RUNNER_ERROR_<name>`, `AGENT_THREW_Panic`,
  `TOOL_THREW`, `describeThrown` labels via `io_error_code`).

## 7. Checklists

**New use case:** return `UseCaseResult<T>`; list its error codes in the doc
comment; no Effect, no throw.

**New API route:** read input with `readJson` / `pathId` / `idempotencyKey`;
call through `useCase` (or `attempt` for a direct call); answer with
`respond`. Add each new `ApiErrorCode` to `STATUS`.

**New adapter:** return typed failures for every expected outcome, including
"not JSON" (`parseJson`) and "bad URL" (`parseUrl`); bound every network call
with a timeout; throw only for the unexpected.

**New `catch`:** pick one of the four shapes in §5; for shape 4, write the
reason in a comment.

**New Rust code:** a `thiserror` enum for the crate's failures; `?` to pass
them on; a comment on every `let _ =`.

## 8. How it is checked

| Check | Where |
|---|---|
| No empty `catch`; no uncommented `.catch(() => undefined)`; thrown values labelled only by the §2 helpers; `JSON.parse` and `try { new URL }` only inside the helpers; one copy of the labels; every Rust `let _ =` explained | `tests/architecture/errorHandling.test.ts` |
| The labels: names, codes, fallbacks, nothing of the message | `packages/domain/test/failureHelpers.test.ts` |
| The Effect bridge keeps labels only | `packages/effects/test/errors.test.ts` |
| Boundaries answer even when the logger throws | `apps/api/test/errorBoundary.test.ts` |
| Runner exit-code mapping | `apps/runner/test/exitCodes.test.ts`, `crates/research-runner` tests |
| Browser storage never throws | `apps/web/test/browserStorage.test.ts` |
| Stable API codes; CSRF and validation rejections carry codes | API contract tests; E2E invalid-command test (unknown component type → 422 `UNKNOWN_COMPONENT_TYPE`, nothing applied) |
| No `unwrap` / `expect` / `panic` / indexing in production Rust | `cargo clippy` with the `[workspace.lints]` in `Cargo.toml` |
