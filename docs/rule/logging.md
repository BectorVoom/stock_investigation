# Logging

One logger, built on Effect (`@research/effects`). See
[ADR-0007](../adr/0007-effect-for-logging-and-error-handling.md).

## What MUST be done

- Log only through `@research/effects`: `makeJsonLogger` (the one Effect
  `Logger` implementation), `logEvent` for Effect programs, or the
  synchronous `createEventLogger` facade where the call site is not an Effect
  program. No second logger, no `console.log` for operational events.
- Every log call MUST write exactly one JSON line:
  `{ at, level, event, ...fields }` (`at` is an ISO timestamp from the
  injected clock, `level` is `debug`/`info`/`warn`/`error` mapped from the
  Effect log level, `event` is a snake_case name such as `job_claimed`).
- A log line MAY contain identifiers, codes and counts only: run ids,
  attempts, operation names, error class names, safe OS error codes
  (`EACCES`, `ENOENT`), ports, signal names, reasons from a fixed set.
- A log line MUST NEVER contain tokens, prompts, retrieved text, error
  messages or stack traces (SEC-010). Error messages can carry stored content
  or identifiers; only the thrown value's class name (and a safe OS-style
  `code` token) is kept.

## How it is enforced

- One pure function, `sanitizeLogCall` (`packages/effects/src/logging.ts`),
  decides every line, so the facade and direct `Effect.log*` calls are held to
  the same rule. The message must be exactly one string matching
  `^[a-z][a-z0-9_]{1,63}$`; anything else becomes `invalid_log_event` with only
  the kind of the rejected value in `rejected`, never its content. A field
  whose name matches a sensitive segment (case-insensitive, per whole word or
  `camelCase`/`snake_case` segment: `token`, `secret`, `password`, `passwd`,
  `authorization`, `cookie`, `credential`, `apikey`/`api_key`, `prompt`,
  `content`, `text`, `body`, `message`, `stack`, `quote`, `excerpt` —
  `credentialId` is spelled out as the exception and stays allowed, as does
  `promptVersion` (the short prompt template version such as `research-v4`,
  never prompt text — the runner logs it on `job_finished`) is
  dropped; a string value longer than 200 characters or spanning lines is
  dropped; any other value type (objects, arrays, `Error`s) is dropped; every
  dropped field is counted in `redacted_fields`. The keys `at`, `level`,
  `event` are reserved and can never be overwritten by a field.
- What remains the caller's duty: a short code that happens to be sensitive
  cannot be detected. Keep secrets out of log calls by construction — log
  codes and ids instead — and never pass tokens, prompts, retrieved text,
  error messages or stack traces to the logger.
- Logging never throws into its caller: the writer runs isolated inside the
  logger, failures are counted (`logFailures()` on the facade) and reported
  through one short `log_write_failed` line on `console.error` at most once
  per minute, itself isolated.
- `UnexpectedError` carries the operation name, the thrown value's class name
  and an optional safe OS code only — never its message.
- The runner prints a renewed token once to stdout for the owner to store; it
  is never passed to the logger. The launcher never prints a credential
  (`tests/e2e/startLocal.spec.ts` asserts the ready block holds no `rk_` token
  and the credential file is mode 0600).

## Where logs go

- API (`apps/api/src/app.ts`): `createEventLogger` over `console.error`; the
  launcher redirects it into `data/logs/server.log` (production) or
  `data-dev/logs/server.log` (development).
- Runner (`apps/runner/src/main.ts`): `createEventLogger` over
  `process.stderr` into `data/logs/runner.log` (or `data-dev/`).
- E2E runner harness (`tests/e2e/runnerHarness.ts`): the same logger over
  `process.stderr` (inherited by the Playwright worker).

## How to add a log statement

- In Effect code: `Effect.annotateLogs(Effect.logInfo("job_claimed"), { runId,
  attempt })`, or `logEvent("warn", "sec_tools_disabled", { reason })`.
- In non-Effect code: build one `createEventLogger(write, now)` at the
  boundary and call `logger.info/warn/error(event, fields)`. In tests use
  `silentEventLogger` when output is not under test.

## How it is checked

- `packages/effects/test/logging.test.ts`: line format, injected clock,
  level mapping, event-name enforcement (`invalid_log_event` + `rejected`
  kind, never content), field-name and field-value enforcement with
  `redacted_fields` counts (including the `credentialId` exception), writer
  isolation with `logFailures()` and the throttled `log_write_failed`
  fallback, the facade, and a scan asserting every production event name
  matches the pattern and still logs unchanged.
  `packages/effects/test/errors.test.ts` covers the `UnexpectedError`
  class-name-only rule. The launcher specs guard the credential redaction.
- `apps/runner/test/config.test.ts` pins that every `invalid_configuration`
  problem message is a short single line that echoes no value, so the field
  survives the content rule; `apps/runner/test/jobExecution.test.ts` proves
  the heartbeat chain cannot reject unhandled when its log call throws.
- `apps/api/test/errorBoundary.test.ts` proves `respond` and the defect
  boundary still answer `INTERNAL` / 500 with the stable body when the logger
  throws (workerd AND node:sqlite projects).
