# ADR-0037: External-service errors keep their status

Status: accepted (2026-10-25)

## Context

The owner asked: "If a function or API returns an error caused by an
external service, return the original error status from the external
service without changing it. Please make this change a rule."

Before this decision the status an external service answered with was lost
or changed on the way:

- The safe fetcher (TypeScript `safeFetchCore.ts`, Rust `research-net`)
  wrote it into a text field (`detail: "HTTP 503"`), and six functions
  (`httpStatusOf` ×4, `httpStatus` in the search tools, `secClient`)
  parsed it back out with a regular expression.
- Adapters replaced it with our own codes: a model provider's 529 became
  `PROVIDER_UNAVAILABLE`, a Google 403 became `GOOGLE_REQUEST_FAILED`, a
  FRED 400 became `SERIES_NOT_FOUND`; the number itself was dropped.
- The API answered a feed that the host refused with 404 as `FETCH_FAILED`
  / **502**.
- Stored runs, sources, market series, earnings rows and calendar links kept
  only our code.

## Decision

The owner chose "end to end" over "in-process and API only".

1. **One field, set where the answer arrives.** `SafeFetchError` is a union
   whose `HTTP_ERROR` member always has `status: number`; HTTP turns, the
   Google client, Twelve Data's error `code` and Claude Code's
   `api_error_status` set the same number. Nothing parses a status out of
   text any more.
2. **Carried unchanged beside our code.** `ToolFailure.upstreamStatus`,
   `ProviderFailure.upstreamStatus`, the agent `failed` event,
   `UseCaseError.upstreamStatus`, the job completion's
   `failureUpstreamStatus`, `sourceFetchReport.upstreamStatus`, the market
   and earnings entries' `upstreamStatus`. Our codes still classify the
   failure and decide retries.
3. **Stored and shown.** Migration `0012_upstream_status.sql` adds a nullable
   `*_upstream_status` column beside each stored failure code; the API views
   return it (`failureUpstreamStatus`, `lastErrorUpstreamStatus`,
   `unavailable.upstreamStatus`, calendar `lastFailure.upstreamStatus`) and
   the web app shows it next to the code.
4. **The API answers with it.** `respond` uses the upstream status as the
   response status when the failure carries one in 4xx/5xx, and the JSON
   error body adds `upstreamStatus`. A 1xx–3xx is kept in the body but not
   used as the status line (a browser would follow or wait on it), and a
   failure with no answer (timeout, DNS, refused connection) keeps the
   code's own status.
5. **Both runners.** The Rust runner mirrors every field
   (`research-application::SafeFetchError::status`, `ToolFailure`,
   `ProviderFailure`, the completion encoders), held equal to the
   TypeScript by the conformance vectors.

The rule is `docs/rule/error_handling.md` §4a and ARCH-019.

## Consequences

- An owner (or an agent reading the API) can tell a provider's 429 from its
  503 or 529, and a feed's 404 from its 410, without our mapping in between.
- Request schemas from the runner accept the new fields as optional, so a
  runner built before this change still completes jobs (its failures store
  NULL).
- The web client already branches on the error `code`, never on the status,
  so a passed-through upstream 401 or 403 does not look like the owner's own
  sign-in failing.
- The Rust API port (branch `api/axum`) does not have the new columns or the
  response-status rule; it has to adopt them before it can replace the Hono
  API.

## What is NOT done

- Progress lines of a run (`job_events.text`) stay display text; a failed
  tool's line still reads e.g. `HTTP_ERROR: HTTP 503`, but the structured
  status is on the run, not on each line.
- Our own Worker API is not an "external service": the runner, the MCP
  server and the web app keep its code and status as before.
