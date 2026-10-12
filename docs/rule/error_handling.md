# Error handling

Expected failures are typed: `Result` in the pure core, tagged errors in
Effect at the shell. See [ADR-0007](../adr/0007-effect-for-logging-and-error-handling.md),
rules ARCH-010 and API-008.

## What MUST be done

- The pure core (`packages/domain`, use cases in `packages/application`)
  MUST return `Result<T, E>` (`ok`/`err` in `packages/domain/src/result.ts`);
  it MUST NOT throw for an expected failure and MUST NOT import Effect.
- Shell code (`apps/api`, `apps/runner`, `packages/adapters`) MUST model
  expected failures as `Data.TaggedError` classes in Effect: `HttpFailure`
  (wraps a `UseCaseError`) in the API, `ConfigurationError` and
  `CredentialRenewalError` in the runner, plus `UnexpectedError` for a throw
  or rejection (operation name, class name and safe OS code only — never the
  message, SEC-010).
- Use the bridge in `packages/effects/src/errors.ts` and nothing else:
  `fromResult` (a `Result` into Effect), `attempt` (a throwing promise into
  `UnexpectedError`), `attemptResult` (`attempt` then `fromResult`, for
  promises of a `Result`), `toResult` (an Effect back into a `Result` at the
  next boundary; a defect rejects instead of converting).
- There are exactly two error boundaries. Every API route handler is one
  Effect program answered by `respond` (`apps/api/src/http.ts`): an
  `HttpFailure` becomes the JSON error body with its stable status from
  `STATUS`, an `UnexpectedError` is logged once as `unhandled_error` (fields
  `operation`, `name`, `method`, `route` only) and answered as `INTERNAL` /
  500. A defect is not caught there; it reaches `app.onError`, which logs the
  class and route only and answers `INTERNAL`. The runner entry point
  (`apps/runner/src/main.ts`) maps every tagged failure to a log plus an exit
  code in `exitCodeForFailure` (`ConfigurationError` → 2, anything else → 1)
  with `Effect.catchTags`, and logs an escaped defect once as
  `runner_crashed` with its class name only.
- Error codes MUST be stable and machine-readable (`ApiErrorCode`, mapped in
  `STATUS`; API-008). Validation details name fields only and never echo
  values (`readJson`). No raw internal trace ever reaches an HTTP response.
- Failures MUST NEVER be swallowed (`catch {}` is prohibited) and MUST NEVER
  leak a message, prompt, token or stored content into a log or a response.

## What a new use case / route / adapter MUST do

- New use case: return `Result` with a documented error union; no Effect.
- New route: `readJson`/`pathId`/`idempotencyKey` for input, `useCase` (or
  `attempt` for a direct call) for the call, `respond` for the answer.
- New adapter: throw only for the unexpected; the caller wraps with
  `attempt(operation, …)` naming the operation in progress.

## How it is checked

- `packages/effects/test/errors.test.ts` (bridge, class-name-only rule),
  `apps/runner/test/` (exit-code mapping), API contract tests (stable codes,
  CSRF/validation rejections carry codes), and the E2E invalid-command test
  (unknown component type → 422 `UNKNOWN_COMPONENT_TYPE`, nothing applied).
