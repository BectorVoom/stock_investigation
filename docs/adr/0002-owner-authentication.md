# ADR-0002: Owner authentication via Cloudflare Access; runner bearer credentials

**Status:** Accepted for the deployed configuration; amended by [ADR-0006](0006-local-first-operation.md), which makes the `local-dev` mode below the default · **Date:** 2026-10-11

## Context

Section 13 leaves owner identity open but requires an *established* method and forbids bespoke password cryptography. Section 9 requires HttpOnly/Secure/SameSite session cookies, CSRF protection on cookie-authenticated writes, and separately scoped, renewable, revocable runner credentials. Budget: Workers Free.

## Decision

**Owner.** Put the Worker hostname behind **Cloudflare Access** (Zero Trust; free for a single user). Access performs the login with the identity provider the owner chooses and sets its own `CF_Authorization` cookie (HttpOnly, Secure, SameSite). On every `/api/v1/*` request the Worker independently verifies the `Cf-Access-Jwt-Assertion` JWT with `jose` against the team's published keys — issuer, audience (the Access application AUD) and RS256 are pinned — and then requires the `email` claim to equal `OWNER_EMAIL`. Any other valid identity (including an Access *service token*, which has no email) receives 403. Missing or unknown configuration denies everything (fail closed).

The application therefore stores no password, issues no session of its own and contains no password hashing.

**CSRF.** Every non-GET owner request must (a) carry an `Origin` equal to the request's own origin and (b) carry the custom header `X-Research-Csrf: 1`, which a cross-site page cannot add without a CORS preflight that the API never grants. JSON bodies only.

**Local development.** `AUTH_MODE=local-dev` yields a fixed owner identity, and is honoured **only** when the request URL's hostname is a loopback name. A deployed Worker is never addressed that way, so the mode cannot open a production deployment by misconfiguration. Tested in `apps/api/test/security.test.ts`.

**Runner.** The owner issues bearer credentials in Settings. A credential is a 256-bit random token shown once; only its SHA-256 is stored (a fast hash is appropriate because the secret is high-entropy, not a password). Credentials expire (1–90 days), can be revoked by the owner, and can be rotated by the runner (`renew`). Runner endpoints accept only the bearer token and refuse any request carrying `Origin` or `Cookie`, so a browser session can never reach them; owner endpoints never accept the bearer token.

## Deployment note

Because Access sits in front of the hostname, the runner path must be reachable without an interactive login. Either add an Access application for `/api/v1/runner/*` with a *Service Auth* policy and give the runner `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (the runner sends them when set), or use a *Bypass* policy for that path and rely on the bearer credential alone. See `docs/OPERATIONS.md`.

## Alternatives considered

- **Own session cookies + a shared owner secret.** Fewer moving parts but a hand-rolled login surface; rejected under "no bespoke password cryptography".
- **OAuth (GitHub/Google) implemented in the Worker.** Established, but more code and secrets than delegating to Access, for one user.
- **Passkeys/WebAuthn.** Good fit long-term; more implementation and recovery design than V1 warrants.

## Risk

Access configuration is outside this repository; a wrong AUD or team domain locks the owner out (fails closed, not open). Not verified against a live Access tenant in this change — verification is with locally generated RS256 keys.
