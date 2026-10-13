# Threat model

Single owner; assets are the owner's research record, their CLI subscriptions/API keys, and their home network.

The default is local operation (ADR-0006): browser, API and runner all on the owner's PC, the API on the loopback address with no sign-in. The same controls apply to a Cloudflare deployment, where the owner is identified by Cloudflare Access instead.

## Trust boundaries

```text
[untrusted]  news feeds, article pages, SEC responses, market-data responses, model output, import files, URL input
     |
     v  (validated at every arrow)
Browser SPA --(loopback host or Access JWT, + CSRF)--> Worker --(owner-scoped SQL)--> D1
                                       ^
                                       | bearer credential, lease generation
                                Local runner --(allowlisted env, no tools)--> agent CLI / OpenRouter
                                       |
                                       +--(pinned, allowlisted HTTPS)--> subscribed sources, sec.gov
                                       +--(pinned HTTPS, one page per call)--> public web pages
                                       +--(pinned HTTPS, keyed)--> api.stlouisfed.org, api.twelvedata.com
                                       +--(pinned HTTPS, keyed)--> finnhub.io (earnings, US)
                                       +--(pinned HTTPS, keyless)--> www.jpx.co.jp (earnings schedule, JP)
```

Local operation (ADR-0006) keeps this shape twice, once per environment
(ADR-0011): production serves the built release on 127.0.0.1:8787 from `data/`,
development serves the working tree live (Vite :3000, API 127.0.0.1:8788) from
`data-dev/`. Retrieved public pages leave the diagram sideways: the runner saves
them as Markdown under `data/pages/` (or `data-dev/pages/`), outside the
database, and they are never uploaded.

## Threats and controls

| # | Threat | Control | Evidence |
|---|---|---|---|
| T1 | Anonymous or wrong-user access | Access JWT verified in the Worker (issuer, audience, RS256, owner email); fail closed on missing/unknown config; local-dev only for loopback | `apps/api/test/security.test.ts` |
| T2 | CSRF on cookie-authenticated writes | Same-origin `Origin` + custom header + JSON only; in local development the Vite dev server origin (`DEV_ALLOWED_ORIGIN`) is accepted as a second origin, and only there | same |
| T3 | Browser reaching runner endpoints / runner acting as owner | Runner routes need the bearer token and refuse `Origin`/`Cookie`; owner routes ignore bearer tokens | same |
| T4 | Runner token theft from the database | Only SHA-256 of a 256-bit token is stored; expiry, revocation, rotation | same |
| T5 | Cross-owner access by guessing ids | Every query filters on `owner_id`; unknown ids are 404 | same |
| T6 | SSRF via source URL, redirect, or DNS rebinding | String policy on every hop; runner pins the connection to a validated public address and uses per-tool host allowlists (ADR-0005) | `tests/security/ssrf.test.ts`, adapter tests |
| T7 | Prompt injection in news content | Tools authorized outside the model (registry, allowlist, budget, schema); agent CLIs run without usable tools (OpenCode plan models with no tools sent; free-tier models list the gated tools but every call is rejected before it runs and ends the turn, ADR-0012); content fenced as data | `packages/application/test/pipeline.test.ts` (adversarial suite), E2E |
| T8 | Model fabricates sources, quotes, numbers, growth rates | Citations must be shown evidence with verbatim quotes of minimum length; numbers must occur in cited text; derived figures computed by the domain; Worker re-checks integrity | pipeline tests, `apps/api/test/jobs.test.ts` |
| T9 | XSS through agent output, feed text or imported files | Text nodes only; no `innerHTML`; registry-validated props; unknown component types denied; no `<img>` is rendered from stored data (approved images removed 2026-10-13); CSP `script-src 'self'` | `packages/ui-registry/test/xss.test.tsx`, E2E |
| T10 | Stale or duplicated runner writes | Lease generation fencing; idempotent completion; guarded atomic batches | `apps/api/test/jobs.test.ts`, `formal/ResearchFormal/Lease.lean` |
| T11 | Runaway cost | Per-run ceilings checked before each step; metered backends need explicit spend consent; no fallback; unknown cost never shown as 0; rate limits on job creation and source checks | pipeline tests, `formal/ResearchFormal/Budget.lean` |
| T12 | Secrets in logs, prompts or the bundle | `sanitizeLogCall` enforces the content rule on every line (facade and direct `Effect.log*` alike): non-snake_case event names rejected, sensitive field-name segments and long/multi-line string values dropped and counted in `redacted_fields`; `UnexpectedError` carries class name only; CLI env allowlist; no secrets in SPA bundle | `packages/effects/test/logging.test.ts`, `errors.test.ts`, provider tests, runner tests |
| T13 | Malicious import file | Schema + integrity validation, ids re-minted, components re-validated against the registry | `apps/api/test/workspaces.test.ts` |
| T15 | Credentials sent over plain HTTP (the platform serves the hostname on port 80 too) | API redirects safe reads to HTTPS and rejects writes; HSTS on API and static responses; the SPA upgrades itself at startup; the runner refuses a non-HTTPS API URL | `apps/api/test/security.test.ts`, runner config tests |
| T16 | Local mode: a web page, a LAN device or a rebinding hostname using the unauthenticated local API | Both local environments (production on 127.0.0.1:8787, development Vite :3000 + API 127.0.0.1:8788) bind the API to 127.0.0.1 only with separate data directories; owner identity is granted only when the request URL's hostname is a loopback name; writes need a same-origin `Origin` and the custom header; a second launcher on a busy port refuses to start | `apps/api/test/security.test.ts`, `tests/e2e/startLocal.spec.ts` |
| T14 | XML bombs / oversized responses | Entity expansion off, input caps, byte and time limits; the page-to-Markdown converter is linear-time (nesting ceiling 32 per formatting element kind, per-tag match index, root-directed work budget) | feed parser tests, `htmlToMarkdown` hostile/nesting tests, `scripts/bench.ts` worst-case conversions |
| T17 | Model-proposed URL exfiltrates what the model knows in a query string, or reaches where it should not | Gated by the owner's setting (`DEFAULT_AGENT_SETTINGS.webAccess` is `"public-web"`; a stored request from before the field parses as `"off"`, fail closed); `authorizeToolCall` on every call; https-only string policy plus the runner's pinned fetcher with per-hop validation; one page per call; URL length cap; tool-call budget; no secrets in prompts; robots.txt honoured per RFC 9309 — percent-encoding normalised before comparison, every redirect hop checked before it is contacted (`REDIRECT_NOT_AUTHORIZED` otherwise), cross-host robots redirects followed and applied to the asked host | `tests/security/webFetch.test.ts`, `packages/adapters/test/tools/webTools.test.ts`, `robotsPolicy.test.ts`, pipeline gating tests |
| T18 | A build, rollback or stray write swaps the code under a running instance, or old code runs against a newer database | Release generations: builds write a new read-only directory and move the pointer atomically; `prod:start` serves only the generation it started with; `prod:rollback` moves only the pointer; a generation older than the database refuses unless overridden; the served generation id and build time are reported by `GET /api/v1/version` | `tests/e2e/startLocal.spec.ts`, `tests/local/releaseOps.test.ts` |
| T19 | Market-data API keys leak, or provider text poisons storage/logs/UI | Keys live only in the runner environment (`FRED_API_KEY`, `TWELVE_DATA_API_KEY`); Twelve Data travels in the `Authorization` header sent on the first request only and **never follows a redirect**; FRED's key stays in its `api_key` parameter because that API requires it. Provider message bodies are untrusted: they are never stored, shown or logged — every unavailable code carries our own fixed wording (`marketUnavailableReason`), and error bodies stay inside the adapter | `packages/adapters/test/finance/` (key-never-in-error tests, redirect tests), `packages/adapters/test/worker/workerSafeFetcher.test.ts` |
| T20 | Calendar subscription token leaks (it travels in a URL path) | 256-bit `cal_`-prefixed token returned and shown once, stored only as SHA-256 (ADR-0002 treatment); rotation revokes the old token at once; any failure answers the same `NOT_FOUND` body and any other request under `/api/v1/calendar-feed/` the same uniform 404; the token never reaches a log line (application logs the `:token` route pattern; both launch plans run `wrangler dev` with `--log-level warn` so its per-request path lines are dropped), an audit row or an error body; owner routes never accept the feed token and the feed route never serves another owner's calendar | `apps/api/test/watchlist.test.ts` (uniform 404, rotation/revocation, route isolation), `tests/local/calendarFeedServerLog.test.ts` |
| T21 | Malicious earnings workbook (ZIP / XML bomb, oversized) | Narrow Node-only binary port with host pinning, redirect validation and byte/time ceilings (`SafeFetcher` not widened); minimal stored/deflated ZIP reader with hard ceilings (archive ≤ 4 MB, inflated entries ≤ 16 MB, only the two named entries inflated, ZIP64/encrypted/multi-disk fail closed); bounded linear XML scanning with no entity expansion, bounded rows/shared strings/cells, entry names never used as paths; columns located by header text, structural failures fail the whole workbook closed | `packages/adapters/test/node/` (binary fetch, ZIP bombs/ceilings/corrupt), `packages/adapters/test/finance/jpxWorkbook.test.ts` |
| T22 | Finnhub API key leaks, or earnings provider text poisons storage/logs/UI | The key lives only in the runner environment (`FINNHUB_API_KEY`); it travels in the `X-Finnhub-Token` header (fixed allowlist, first request only, never follows a redirect) and never enters a URL. Response bodies are untrusted: they are never stored, shown or logged — every unavailable code carries our own fixed wording (`earningsUnavailableReason`), estimates are never stored or shown, and only `date`/`hour`/`quarter`/`year`/`symbol` (plus the profile `name`) are read | `packages/adapters/test/finance/finnhubEarnings.test.ts` (documentation-shaped fixtures labelled as such; key-never-in-error tests), `packages/adapters/test/worker/safeFetchExtensions.test.ts` |

## Residual risks (accepted for V1)

- **Local mode has no protection from other accounts or programs on the same PC** (ADR-0006). Anything that can open a loopback connection, or read `data/`, is the owner. Do not run it on a shared machine.
- **API-side fetches have no DNS/IP control** (ADR-0005), and in local mode they leave from the owner's PC rather than from Cloudflare. Mitigated by the string policy (https, default port, no IP literal or internal name), certificate validation for the public hostname, owner-typed URLs only, and rate limits. Feed ingestion and research tools run in the runner with address pinning and are not affected.
- **Codex tool isolation is unverified**; the backend is refused by default (docs/AGENT_BACKENDS.md).
- **OpenCode free-tier isolation is weaker than deny-all** (ADR-0012): the gated tools are advertised to the model and blocked at call time by the CLI's non-interactive ask-rejection rather than never sent. A rejected call ends the turn with `PROVIDER_TOOL_CALL_REJECTED` (nothing ran); a call that ran, or whose state is unknown, still fails with `PROVIDER_TOOL_ISOLATION_VIOLATED`. The claim rests on the v2.0.27 verification and the deny-first rule keeping `execute` and unknown tools out of the request.
- **A compromised runner credential** can read the owner's subscribed-source list and submit research for the owner's queued jobs — including claims marked "supported" whose quotes the Worker cannot re-check, because source text is not stored (ADR-0003). It cannot bypass structural integrity, derivation or badge-consistency checks, and cannot reach owner endpoints. Mitigation: short expiry, revocation, audit trail per credential.
- **Independent verification is another model call**, not a proof. It fails closed (no verdict, no "supported") and can only downgrade, but a model can still wrongly confirm a claim whose quote exists and is merely related.
- **Supplier listings proposed by a model are format-checked only** and labelled "unverified"; only SEC-directory listings are "source-verified".
- **Metered spend** is reserved before each request from the most expensive turn so far; the first metered turn of a run has no history, so one turn's cost is the worst-case overshoot.
- **Worker CPU**: validation of the largest admissible submission is benchmarked locally, not on Cloudflare. Imports and exports are capped (3,000 table cells) for the same reason.
- **Access misconfiguration** (deployment only) locks the owner out (fails closed).
- **Copyright**: excerpts are stored only for sources the owner marked as permitting them, capped at 500 characters; quotes on claims are capped at 400.
- **Market observations are personal-use vendor data** (ADR-0014): FRED series notes carrying "Copyright" (e.g. VIXCLS, © Chicago Board Options Exchange) and Twelve Data free-tier data are for the owner's internal use — they are not part of workspace export and must not be redistributed, displayed to third parties or used commercially on the free plan.
- **Earnings dates are personal-use vendor data** (ADR-0016): Finnhub data and the JPX schedule (JPX's copyright; no commercial collection, no high-load/high-frequency automatic retrieval — fetched only on an owner-queued refresh, paced, cached) are stored per owner for the owner's own calendar use — they are not part of workspace export and must not be redistributed or used commercially.
- **Model-proposed URLs** (ADR-0009): a prompt injection in retrieved text can steer the model to propose a URL carrying the question or retrieved text in its query string (the question and retrieved text — never credentials: prompts contain no secrets, SEC-005, and the URL length cap truncates exfiltration attempts). Bounded by the off-switch, one https page per call, the URL length cap, the tool-call budget, per-hop robots authorization before any redirect target is contacted, and no secrets in prompts — but a motivated injection can still encode a short secret-free fact (e.g. what the owner is researching) into a hostname or path the attacker's server logs.
