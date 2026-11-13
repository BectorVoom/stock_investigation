# Administrator login verification — 2026-11-13

The SPA waits for the existing authenticated session before mounting the
workspace. Local authentication and server-side Access JWT checks are unchanged.
No database or domain algorithm changes; no new Lean model is required.

Passed:

- `bun run typecheck` (all projects).
- Targeted Biome checks and `git diff --check`.
- `bunx vitest run --project web apps/web/test/login.test.tsx apps/web/test/environmentBadge.test.tsx`: 9 tests.
- `bunx vitest run --project api-sqlite apps/api/test/security.test.ts`: 38 tests,
  including Access identity, wrong administrator, invalid tokens, configuration
  failures and signing-key outages.
- `REVIEW_BROWSER=chrome bun run review:ui loginReview.spec.ts`: 2 tests.
- `REVIEW_BROWSER=webkit bun run review:ui loginReview.spec.ts`: 2 tests.
- Chrome and WebKit screenshots for login and forbidden states inspected at
  390px and 1440px: readable, no page overflow, no workspace navigation.

Limitations and outstanding configuration:

- Firefox could not start: the installed Playwright Firefox reports
  `Could not find profile folder`, including after retrying with `TMPDIR=/tmp`.
  Its UI review remains unverified. One earlier retry also failed during local
  Worker test-state startup; the subsequent sequential run started the Worker
  successfully and reproduced the Firefox launch error.
- Live anonymous HTTPS requests to the deployed root and session endpoint
  redirect to the configured Cloudflare Access team and audience. Following
  the root redirect returns the Cloudflare sign-in page (HTTP 200), offering
  Cloudflare account-member authentication. In a real Chrome session the
  identity-provider redirect reaches Cloudflare's dashboard challenge page.
- The checked-in production `OWNER_EMAIL` is empty; no administrator email was
  inferred or configured. The live Access policy and Worker bindings could not
  be inspected because Wrangler credentials expired. No successful live
  administrator login is claimed. No deployment was performed.
- A real development agent/research positive-path run was not performed; these
  tests cover login with controlled session responses and existing API security.
  The unrelated research flow is outside this change's verification.

Repeatable screenshots are under
`test-results/ui-review/{chrome,webkit}/playwright-output/loginReview-*`.
The full existing UI review suite was not run; review was scoped to the added
login spec. Existing unrelated working-tree changes were retained.

## Follow-up: authenticated Cloudflare inspection

After reconnecting with Access Read and Workers Scripts Read, the MCP connection
successfully inspected account `80138f4df6225412b8cf988712e53ae3`:

- The live `research-workspace` Worker uses `AUTH_MODE=cloudflare-access` and
  `OWNER_EMAIL=appservice27@gmail.com`.
- Its team domain is `appservice27.cloudflareaccess.com`; its audience matches
  the `research-workspace.appservice27.workers.dev` Access application.
- That application's sole policy, `email_policy`, is a reusable Allow policy
  including only `appservice27@gmail.com`, with no bypass policy returned.
- Updated the local production `OWNER_EMAIL` to match the verified live value,
  preventing a subsequent deployment from restoring the earlier empty value.

This supersedes the earlier inability to inspect live configuration. No remote
configuration was changed and no deployment or interactive administrator login
was performed during this follow-up.
