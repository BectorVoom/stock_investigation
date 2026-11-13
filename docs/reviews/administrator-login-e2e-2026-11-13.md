# Administrator login E2E — 2026-11-13

## Focused login checks

Added `tests/e2e/administratorLogin.spec.ts` covering:

1. Localhost opens the workspace using the real API's automatic session.
2. An unauthenticated response shows login, hides navigation, and sends no workspace data requests.
3. A forbidden response shows the administrator refusal and Cloudflare logout link, with no workspace data requests.
4. A signing-key failure offers Retry; retrying against the real API opens the originally requested Settings page.

Chrome: 4 passed. WebKit: 4 passed. Both used fresh browser contexts against
the already running isolated E2E Worker on localhost:8799, through temporary
Playwright configs (no second server, database reset, or global runner setup).
The new spec was added after the full suite collected tests, so it was run
separately. Future normal suite invocations include it automatically.

Logs: `/tmp/stock-admin-e2e-{chrome,webkit}.log`.
`bunx tsc --noEmit -p tests`, targeted Biome, and diff whitespace checks passed.

Firefox: browser startup failed before application code ran with
`Could not find profile folder`. Reinstalled the Playwright Firefox browser
using `bunx playwright install firefox --force` and reran all four cases;
the same startup failure remained. Firefox coverage is unverified.
Logs: `/tmp/stock-admin-e2e-firefox-retry.log`.

## Full regression run

`bun run test:e2e`: Chrome finished in 8.8 minutes with **114 passed,
9 failed, 1 skipped, 55 did not run**. Serial groups skip dependent tests
following a failure. The runner stopped after Chrome's failure, so the full
Firefox and WebKit suites were not run. The optional live OpenCode case was
skipped; this run does not establish a real-agent research positive path.

Failures recorded for follow-up (no unrelated product changes made):

| Test | Observed mismatch |
| --- | --- |
| `home.spec.ts:122` | Gold unit expects `USD per XAU`; UI renders `$ per XAU`. |
| `language.spec.ts:33` | Japanese navigation expectation omits the News link. |
| `materials.spec.ts:6` | Material unit expects `USD/kg product`; UI renders `$/kg product`. |
| `notebook.spec.ts:165` | Report lookup under region `Conversation` finds no matching component. |
| `notebookScroll.spec.ts:328` | Bottom-edge dragging leaves widget order unchanged. |
| `research.spec.ts:254` | Report lookup under region `Conversation` finds no matching component. |
| `stocks.spec.ts:268` | Company panel expects two sections; three are present. |
| `watchlist.spec.ts:123` | English navigation expectation omits the News link. |
| `watchlistLists.spec.ts:187` | Price row expects `USD`; UI renders `$`. |

Traces and detailed errors: `test-results/e2e-chrome/*/{trace.zip,error-context.md}`.
Production launcher, automatic local sign-in, runner startup, restart,
generation isolation, failed builds, and database-version refusal checks passed.

## Deployed Cloudflare check

A fresh Chrome browser context's request client requested the live homepage
and `/api/v1/session` without cookies. Both returned **302** with redirect
hostname `appservice27.cloudflareaccess.com`, asserted using Playwright.
Anonymous requests do not reach the protected application.

No Access service credential pair is present in the process environment.
Successful interactive administrator login and refusal of an actual second
identity were not exercised. Cloudflare's earlier account/API inspection
verified the single allowed administrator and matching Worker bindings; that
is configuration evidence, not a successful login session. The working-tree
login UI was not deployed during this task.
