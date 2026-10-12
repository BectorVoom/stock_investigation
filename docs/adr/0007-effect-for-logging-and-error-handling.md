# ADR-0007: Effect for logging and error handling

**Status:** Accepted · **Date:** 2026-10-12

## Context

The workspace has two failure styles: the pure core returns tagged `Result` unions (ARCH-010), while process entry points, the runner loop and the API logged with small ad-hoc facades (`createStderrLogger`, `console.error`). Each new boundary reinvented the same decisions — where the timestamp comes from, which values may enter a log line, how a thrown error becomes a typed failure — and an unexpected throw in the runner entry point escaped as an unhandled rejection with no `runner_crashed` record. The owner instructed: use Effect for logging and error handling.

## Decision

**Effect is used in the imperative shell; the pure core stays as it is.**

- **One logger.** `packages/effects` (`@research/effects`) owns the repository's only logger implementation: an Effect `Logger` that writes one JSON line per log call (`at`, `level`, `event`, then the fields). Call sites use Effect's own log functions plus log annotations, or the synchronous `createEventLogger` facade where the call site is not an Effect program.
- **Runner entry point as an Effect program.** `apps/runner/src/main.ts` models expected failures as `Data.TaggedError` classes (`ConfigurationError`, `CredentialRenewalError`) and maps them to exit codes in one place (`exitCodeForFailure`) with `Effect.catchTags`; `runRunnerLoop` itself is unchanged and only wrapped with `attempt`. Anything unexpected that escapes is logged once as `runner_crashed` with the error's class name only, and the process exits 1.
- **A small bridge converts `Result` <-> `Effect`.** `fromResult`, `attempt`, `attemptResult` lift the pure core into Effect; `toResult` runs an Effect back into a `Result` (a defect rejects the promise instead of converting). `packages/domain` gains no dependency, and use cases in `packages/application` keep returning `Result`.
- **The HTTP boundary is converted.** Every API route handler is one Effect program
  with a typed error channel (`HttpFailure` for expected failures, `UnexpectedError` for
  throws and rejections); `respond` in `apps/api/src/http.ts` is the single place that turns
  a failure into an HTTP response (`HttpFailure` → the stable API error code and status,
  `UnexpectedError` → one `unhandled_error` log plus `INTERNAL` / 500). `app.onError` only
  sees defects now, and logs as before. Observable HTTP behaviour is unchanged.
- **Logging content rule, enforced by construction.** One pure function
  (`sanitizeLogCall` in `packages/effects/src/logging.ts`) decides every line,
  so the facade and direct `Effect.log*` calls are held to the same rule: the
  message must be exactly one string matching `^[a-z][a-z0-9_]{1,63}$`,
  otherwise the event becomes `invalid_log_event` and `rejected` carries only
  the kind of the rejected value (`"string"`, `"Error"`, `"object"`, ...),
  never its content; a field whose name matches a sensitive segment
  (`token`, `secret`, `password`, `authorization`, `prompt`, `content`,
  `message`, `stack`, `quote`, `excerpt` and the rest in the code —
  `credentialId` stays allowed because it is an identifier, not the
  credential) is dropped; a string value longer than 200 characters or
  spanning more than one line is dropped; any other value type is dropped; and
  every dropped field is counted in `redacted_fields`. The keys `at`, `level`
  and `event` are reserved. `UnexpectedError` carries the operation name and
  the thrown value's class name only, never its message (SEC-010). What
  remains the caller's duty: a short code that happens to be sensitive cannot
  be detected, so call sites log codes and ids and never pass secrets,
  prompts or retrieved content to the logger.
- **Logging never throws into its caller.** The writer runs isolated inside
  the logger; failures are counted (`logFailures()` on the facade) and
  reported through one short `log_write_failed` line at most once per minute.
  The runner heartbeat chain and both HTTP boundaries (`respond`,
  `app.onError`) therefore still answer even when the log writer is down.

## Consequences

- One more dependency (`effect`) in the Worker bundle, which `bun run build` reports; the pure packages stay dependency-free by rule.
- Import boundaries gain `packages/effects` (may import `@research/domain` and `effect` only) and allow `@research/effects` in `packages/adapters`, `apps/api` and `apps/runner` — nowhere else. `apps/api` and `apps/runner` may also import `effect` itself for their shell programs; the pure core still may not.
- The runner log line format is byte-compatible with the previous one, so `scripts/start.ts` and the log readers keep working.

## Alternatives considered

- **Effect everywhere, including use cases.** Rejected: it would pull the Effect runtime into the pure core and rewrite every `Result` contract for no behavioural gain; the bridge gives the shell typed errors without touching the core.
- **A second hand-rolled logger facade.** Rejected: it is what this ADR replaces — one implementation instead of one per boundary.
- **`console`-based logging in the API.** Rejected for the same reason; the API now uses the same logger through the facade.
