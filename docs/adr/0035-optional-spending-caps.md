# Optional spending caps

Date: 2026-10-24

## Decision

At the owner’s request, paid backends can run without a maximum spend or a
spending-consent checkbox. This applies to Chat, retries, approvals, scheduled
occurrences and Run now. It supersedes the spending-consent portions of
ADR-0033 and earlier budget decisions; selecting a backend still determines
which provider runs, with no automatic paid fallback (AGT-012).

`maxSpendUsd: null` means no spending cap. An explicit cap remains enforced
before model requests, including the existing largest-turn reservation and
pause when metered cost is unknown. Without a cap, missing cost reporting does
not pause a run; cost summaries still report unknown cost honestly. Step,
tool-call, time and input limits remain enforced.

Legacy task `spendConsent` fields and API error codes remain readable for
stored-data and wire compatibility, but consent no longer gates execution.
Both TypeScript and Rust runners implement the same budget semantics. Lean 4
proves the optional-cap model and exports capped and uncapped conformance vectors.

## Verification

Automated verification is recorded in [requirements status](../REQUIREMENTS_STATUS.md#optional-spending-caps--2026-10-24). No live paid-provider
run has been performed for this change; deterministic tests exercise the paid
backend paths without charging a provider account.
