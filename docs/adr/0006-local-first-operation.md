# ADR-0006: Local operation is the default; Cloudflare deployment is optional

**Status:** Accepted · **Date:** 2026-10-12 · Amends ADR-0002 (owner authentication) and ADR-0005 (SSRF per runtime) · Amended by [ADR-0011](0011-development-and-production-environments.md), which separates development and production on this PC

## Context

The specification describes a Worker on Cloudflare with D1, reached through an identity provider, plus a runner on the owner's PC. The first deployment showed what that costs a single owner before the first question can be asked: a Zero Trust organisation, two Access applications (one to let the runner through), three variables, and a credential copied by hand. The owner decided to postpone the deployment and operate the workspace locally by default.

## Decision

**One codebase, two configurations, local first.**

- The top level of `infra/wrangler.jsonc` is the local configuration (`AUTH_MODE=local-dev`). The Cloudflare settings moved to `env.production`, used only by `bun run deploy`.
- `bun run start` is the supported way to run the workspace. It runs the *same* Worker code under `wrangler dev` (workerd, offline) with a SQLite-backed D1 in `data/`, bound to `127.0.0.1`, then issues or reuses a runner credential and starts the runner. No second server implementation was written: a Bun- or Node-native API would have needed its own persistence adapter and would have left the Worker path untested by daily use.
- Nothing in the application layer changed. The runner still authenticates with a bearer credential, leases and fencing still apply, and every request still passes the same validation.

**Authentication in local mode** is the existing `local-dev` mode of ADR-0002: no sign-in, a fixed owner identity, honoured only when the request URL's hostname is `localhost`, `127.0.0.1` or `[::1]`. That check is what makes it safe as a default:

- a deployed Worker never sees a loopback hostname, so deploying the top-level configuration by mistake yields an app that refuses every request;
- a DNS-rebinding page reaches the local port under its own hostname and is refused;
- cross-site writes are refused by the unchanged `Origin` + custom-header rule.

## Consequences

- **Accepted: no protection from other accounts or programs on the same PC.** Anything that can open a loopback connection can act as the owner and mint a runner credential. This is the usual trust model of a local tool; the workspace must not be run on a shared machine. The runner token is therefore stored in `data/runner-credential.json` (mode 0600) rather than re-issued on every start: keeping it out of a file would not raise the bar.
- **ADR-0005 changes in local mode.** The API's own fetches (source preview and registration) now leave from the owner's PC, so "the Worker is not on the owner's LAN" no longer holds, and workerd still cannot pin a connection to a validated address. What remains: the URL is typed by the owner (a model cannot register a source), it must be `https` on the default port with no IP literal or internal name, and the peer must present a certificate valid for that public hostname, which a private-network service cannot do for a name it does not control. Feed ingestion and research tools are unaffected: they run in the runner with address pinning.
- **Durability is the owner's job.** There is no Time Travel locally; the backup is a copy of `data/` (drill recorded in `docs/OPERATIONS.md`).
- **Reach.** The app is usable only on the PC that runs it. Using it from another device is what the postponed deployment is for.
- **The deployment path is kept working but is not exercised by daily use.** `bun run build` still dry-runs the production bundle, and the Access JWT tests still run. Signing in through Access and running the runner against a deployed Worker remain unverified (`docs/REQUIREMENTS_STATUS.md`).

## Alternatives considered

- **A native local server (Bun + `bun:sqlite`).** Faster start and no Wrangler at runtime, but a second persistence adapter and a second composition root to keep correct, and the D1 write model (ADR-0004) would no longer be what the owner actually runs.
- **Finishing the Cloudflare setup.** Still possible later; nothing was removed.
- **Local sign-in (password or passkey).** The specification forbids hand-rolled password handling, and a login would not stop a local process that can read `data/` directly.
