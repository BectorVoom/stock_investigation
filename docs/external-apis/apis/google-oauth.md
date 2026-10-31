# External API: Google OAuth 2.0

## 1. Overview

| Property | Value |
|---|---|
| Provider | Google LLC (Google Identity) |
| Purpose | Connects the owner's Google account to the Google Calendar sync (FR-019, [ADR-0018](../../adr/0018-google-calendar-sync.md)): the Desktop-app authorization-code flow with PKCE and a loopback redirect yields a refresh token for the one scope `https://www.googleapis.com/auth/calendar.app.created`; the runner refreshes access tokens for [Google Calendar API](google-calendar.md) calls and revokes the grant on disconnect. |
| Hosts | `accounts.google.com`, `oauth2.googleapis.com`. The redirect goes to our own loopback listener on 127.0.0.1 (listed in the README as not an API call). www.googleapis.com appears in the OAuth code only inside the scope string; the Calendar API on that host is documented in [Google Calendar API](google-calendar.md). |
| Endpoints | `GET /o/oauth2/v2/auth` — consent page, opened by the owner's browser, which redirects to the loopback listener with `code` or `error`; `POST /token` — exchanges the code, and refreshes access tokens; `POST /revoke` — revokes the refresh token |
| Authentication | OAuth client of type "Desktop app": `client_id` and `client_secret` as form fields of `POST /token` (env `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` in `apps/runner/.env`). `POST /revoke` takes only the token. The authorization URL carries the client id, which is not a secret. |
| Configuration | `GOOGLE_TOKEN_FILE` — the refresh-token file (default `google-token.json` in the runner's data directory; JSON `{version: 1, refreshToken, calendarId, scope, savedAt}`, mode 0600, written atomically through a temp file and rename). Access tokens stay in memory only. Without both client values every `google-calendar` job fails with `GOOGLE_NOT_CONFIGURED`. |
| Usage Limits | Google publishes no request quota for these endpoints. [Refresh-token limits](https://developers.google.com/identity/protocols/oauth2#expiration): 100 refresh tokens per Google Account per client id (the oldest is invalidated silently); a token unused for 6 months stops working; an External app in publishing status "Testing" gets refresh tokens that expire after 7 days. Our side: one sign-in at a time (one non-terminal `google-calendar` job per owner), a 5-minute sign-in window, one token request per attempt and no retry. Refreshes are admitted by the same pacer as the Calendar calls they serve (key `google`, 5 per second, [Google Calendar API](google-calendar.md)); the code exchange (once per sign-in) and revocations (which run after the job's stop signal) are not paced. |
| Called By | Rust runner and TypeScript runner, `google-calendar` jobs: `connect` (authorize, `POST /token` code exchange, `POST /revoke` when a grant is not kept), `sync` (`POST /token` refresh at the start, again before a Calendar request once the access token's `expires_in` has run out, or after a Calendar 401), `disconnect` (`POST /revoke`). The owner's browser opens the authorization URL. The API Worker and the web app never call Google; they only store and show the sign-in URL. |
| Code | `crates/research-google/src/oauth.rs`, `crates/research-google/src/http.rs`, `crates/research-google/src/loopback.rs`, `crates/research-google/src/token_store.rs`, `crates/research-google/src/jobs.rs`, `crates/research-contracts/src/google_calendar.rs`, `packages/adapters/src/google/googleOAuth.ts`, `packages/adapters/src/google/googleHttp.ts`, `packages/adapters/src/google/googleLoopback.ts`, `packages/adapters/src/google/googleTokenStore.ts`, `packages/adapters/src/google/index.ts`, `packages/contracts/src/googleCalendar.ts`, `apps/runner/src/googleCalendar.ts` |
| Official Documentation | [OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app) (loopback redirect, PKCE, token exchange, refresh, revoke, errors); [OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server) (`access_type`, `prompt`, redirect examples, `invalid_grant`); [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2) (refresh-token expiration); [Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth); [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) (PKCE) |
| Last Verified | 2026-10-31, live (error responses, without credentials) and spec (success responses) — see section 7 |

On `connect` the runner starts a one-shot listener on `http://127.0.0.1:<ephemeral port>/`, builds the authorization URL, and sends it to the API as the only Google value that leaves the runner (a `google-auth-url` event, checked by `isGoogleSignInUrl` / `is_google_sign_in_url`). The owner opens it, consents, and Google redirects the browser to the listener with `code` and `state`. The runner exchanges the code once (`POST /token`), requires a refresh token and the granted scope, creates or reuses the dedicated calendar, and stores the refresh token in the token file. `sync` begins with a refresh (`POST /token`); the access token's `expires_in` decides when a Calendar attempt is preceded by another refresh (checked after each pacer or backoff wait, 60 s before it runs out), and a Calendar answer of 401 still triggers one refresh and one retry per Calendar call, also right after an expiry refresh. A refresh answer that carries a new `refresh_token` (rotation) replaces the stored one at once: during a sync the token file is rewritten before the refresh returns (a failed write ends the job as a runner fault), during a connect the new token is the one stored at the end. `disconnect` revokes the refresh token (`POST /revoke`) and deletes the file whatever the answer. A sign-in that produced a refresh token the runner does not keep (scope missing, calendar step failed, cancelled, completion refused) is revoked at once on a 10-second signal of its own.

## 2. Input Parameters

### GET /o/oauth2/v2/auth

Built by `buildAuthorizationUrl` / `build_authorization_url` as `https://accounts.google.com/o/oauth2/v2/auth?` plus these nine query parameters, in this order, `application/x-www-form-urlencoded` encoded (`URLSearchParams` / `form_urlencoded`). The runner never requests this URL itself; the owner's browser does. The API accepts the URL only in exactly this shape (each parameter once, nothing else).

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `response_type` | query | string | Yes | None; we send `code` | `code` | Authorization-code flow. |
| `client_id` | query | string | Yes | None; `GOOGLE_OAUTH_CLIENT_ID` | 1–200 characters (our check) | Desktop-app client id. |
| `redirect_uri` | query | string | Yes | None; `http://127.0.0.1:<port>/` | `http://127.0.0.1:` + port 1–99999 + `/` (our check); Google requires a loopback IP redirect for Desktop clients | The one-shot loopback listener; the port is ephemeral (bound with port 0), so no fixed port can be squatted. |
| `scope` | query | string | Yes | None; `https://www.googleapis.com/auth/calendar.app.created` | Exactly this one scope | "Make secondary Google calendars, and see, create, change, and delete events on them" (Discovery scope description). |
| `access_type` | query | string | No | `online`; we send `offline` | `online`, `offline` | `offline` makes the code exchange return a refresh token. |
| `prompt` | query | string | No | None (Google shows consent only when needed); we send `consent` | `none`, `consent`, `select_account` | Forces the consent screen, so a reconnect always yields a new refresh token. |
| `code_challenge` | query | string | Recommended | None; base64url(SHA-256(verifier)), no padding | 43 characters `[A-Za-z0-9_-]` | PKCE S256 challenge (RFC 7636). The verifier is 32 CSPRNG bytes as 43 base64url characters and never leaves the runner's memory. |
| `code_challenge_method` | query | string | Recommended | `plain` when omitted; we send `S256` | `S256`, `plain` | PKCE method. |
| `state` | query | string | Recommended | None; 32 CSPRNG bytes as 43 base64url characters | 16–128 characters `[A-Za-z0-9_-]` (our check) | Login-CSRF defence: the listener accepts the callback only when `state` matches (constant-time comparison). |

### POST /token

`Content-Type: application/x-www-form-urlencoded`; the body is the form below. Fixed headers on every Google request: `Host`, `User-Agent: stock-investigation-runner/0.1`, `Content-Length`; HTTP/1.1, one connection per request (`Connection: close`).

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Content-Type` | header | string | Yes | — ; `application/x-www-form-urlencoded` | — | Form body. |
| `User-Agent` | header | string | No | — ; `stock-investigation-runner/0.1` | — | Identifies the runner. |
| `grant_type` | form | string | Yes | — ; `authorization_code` (exchange) or `refresh_token` (refresh) | enum | Which grant. |
| `code` | form | string | Exchange only | — | ≤ 500 characters (our loopback guard) | Authorization code from the callback. |
| `code_verifier` | form | string | Exchange only | — | 43 characters | PKCE verifier matching the challenge. |
| `redirect_uri` | form | string | Exchange only | — | Must equal the authorization request's value | The same `http://127.0.0.1:<port>/`. |
| `refresh_token` | form | string | Refresh only | — | ≤ 2000 characters (token-file bound) | Stored refresh token. |
| `client_id` | form | string | Yes | — ; `GOOGLE_OAUTH_CLIENT_ID` | — | Client id. |
| `client_secret` | form | string | Yes for Desktop clients | — ; `GOOGLE_OAUTH_CLIENT_SECRET` | — | Client secret (Google lists it as optional in general; a Desktop client sends it). |

Form field order: exchange `grant_type, code, client_id, client_secret, redirect_uri, code_verifier`; refresh `grant_type, client_id, client_secret, refresh_token`.

### POST /revoke

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Content-Type` | header | string | Yes | — ; `application/x-www-form-urlencoded` | — | Form body. |
| `token` | form | string | Yes | — | Refresh token from the token file | Revoking the refresh token ends the grant (Google also accepts an access token, and its sample passes `token` in the query; we send it in the body so it never appears in a URL). |

## 3. Output Parameters

### GET /o/oauth2/v2/auth

The runner never reads Google's consent pages (HTML, shown to the owner only). What it reads is the redirect Google sends the browser to: `GET http://127.0.0.1:<port>/?<query>` on our listener. The listener accepts only `GET` with `Host: 127.0.0.1:<port>`, path `/` and a matching `state`; anything else answers 404 or 400 with a fixed page and keeps waiting.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `state` (query) | string | No | No | Yes | Echo of our `state`; mismatch or absence → 400, keep waiting. |
| `code` (query) | string | No | Yes (absent on error) | Yes | Authorization code; empty or longer than 500 characters → 400, keep waiting. Never logged. |
| `error` (query) | string | No | Yes (only on refusal) | Yes | Any value ends the sign-in as `GOOGLE_CONSENT_DENIED`; `access_denied` (the owner declined) gets the "consent was denied" page, other values the generic page. The value is never reflected or stored. |
| other query parameters (e.g. `scope`) | string | No | Yes | No | Ignored; the granted scope is read from the token response instead. |

The listener answers `200` with a static page (`Content-Security-Policy: default-src 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`) and closes after the first accepted callback, after 5 minutes (`GOOGLE_AUTH_TIMEOUT`) or on abort.

### POST /token

`200` with `application/json; charset=utf-8`, one object. Parsed by `tokenResponseSchema` (TypeScript) / `token_response` (Rust); unknown fields are ignored. Google sends no `null` values here.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.access_token` | string | No | No | Yes | Short-lived access token, must be non-empty; kept in memory only. |
| `$.expires_in` | integer | No | Yes (to the parser; Google documents it as always present) | Yes | Lifetime in seconds; non-negative integer or the response is rejected. The runner refreshes before a Calendar request once `received at + expires_in − 60 s` has passed; absent → no expiry known, the 401 path refreshes. |
| `$.refresh_token` | string | No | Yes (present on the code exchange with `access_type=offline`, usually absent on refresh) | Yes | Exchange: required — absent → `GOOGLE_SCOPE_MISSING`. Refresh: when present and different from the token sent (rotation), it replaces the stored token (logged as `google_refresh_token_rotated`, the token itself never). |
| `$.scope` | string | No | Yes (to the parser) | Yes | Space-delimited granted scopes. Exchange: must contain our scope exactly, else `GOOGLE_SCOPE_MISSING` and the grant is revoked. Refresh: not used. |
| `$.token_type` | string | No | Yes (to the parser; Google: always `Bearer`) | Yes (type only) | Must be a string when present; value not used. |
| `$.id_token` | string | No | Yes (only with identity scopes, never for ours) | No | Not requested. |
| `$.refresh_token_expires_in` | integer | No | Yes (only for time-based access) | No | Not read; an expired grant surfaces later as `invalid_grant`. |

### POST /revoke

Only the status is read: `200` means revoked (`revoked: true`); anything else, or no answer, is `revoked: false`. Google documents no success body; the body is not read.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| (status) | integer | No | No | Yes | `200` = revoked; `400` = error (body as in section 4). |
| (body) | — | — | — | No | Not documented by Google for success; not read. |

## 4. Error Handling

### HTTP status codes

A `POST /token` answer is decided in this order (`exchangeCode` / `refreshAccessToken` and `mapTokenFailure` in `packages/adapters/src/google/googleOAuth.ts`; `token_post` and `map_token_failure` in `crates/research-google/src/oauth.rs`):

1. **No answer** (DNS, non-public address, TLS, network, 30 s timeout, body over 1 MB) → `GOOGLE_REQUEST_FAILED` without `upstreamStatus`.
2. **Exactly `200`** → the body is parsed (rows below); any other status, another 2xx included, goes to step 3.
3. **`mapTokenFailure` / `map_token_failure`**, status first, then body: (a) `429` → `GOOGLE_RATE_LIMITED`; (b) `3xx` → `GOOGLE_REQUEST_FAILED`, body ignored; (c) for every other status, `error` (a string, or an object's `code`) equal to `invalid_grant` → `GOOGLE_AUTH_EXPIRED`; (d) otherwise `error` equal to `rateLimitExceeded`, or a top-level `rateLimitExceeded: true` → `GOOGLE_RATE_LIMITED`; (e) otherwise `error` equal to `invalid_client` → `GOOGLE_CLIENT_REJECTED`; (f) otherwise `GOOGLE_REQUEST_FAILED`. A body that is not JSON or has a field of the wrong type contributes nothing. Google's status is kept as `upstreamStatus` in every case of step 3.

`POST /revoke` reads only the status: `200` → revoked, anything else or no answer → not revoked.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200 | Token issued | Parses the body | — |
| 200 with an unusable body | Body not JSON, `access_token` missing or empty, a field of the wrong type | Rejects the answer; no `upstreamStatus` (Google did not fail) | `GOOGLE_REQUEST_FAILED` |
| 200 without `refresh_token` (exchange) | Code exchange without an offline grant | Fails the connect | `GOOGLE_SCOPE_MISSING` |
| 200 without our scope (exchange) | The owner unchecked the calendar permission (granular consent) | Revokes the grant, fails the connect | `GOOGLE_SCOPE_MISSING` |
| 429, any body | Rate limit | Step 3 (a); job `retryable: true` (a token request is not retried; the owner retries) | `GOOGLE_RATE_LIMITED` |
| 3xx, any body | Never expected; redirects are never followed | Step 3 (b) | `GOOGLE_REQUEST_FAILED` |
| Any other status with `error` = `invalid_grant` (Google sends 400) | Code invalid, expired or already used; refresh token expired or revoked (6 months unused, Testing-mode 7 days, revoked by the owner, 100-token limit) | Step 3 (c); the card asks to reconnect | `GOOGLE_AUTH_EXPIRED` |
| Any other status with a rate-limit marker in the body | Rate limit signalled in the body | Step 3 (d); job `retryable: true` | `GOOGLE_RATE_LIMITED` |
| Any other status with `error` = `invalid_client` (Google sends 401) | Unknown, deleted or mistyped client id, or a wrong (rotated) secret | Step 3 (e); the card asks to check `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in `apps/runner/.env`; not retryable, and reconnecting cannot help | `GOOGLE_CLIENT_REJECTED` |
| 400 `invalid_request`, other 4xx, 5xx, other 2xx | Malformed request; any other failure | Step 3 (f) | `GOOGLE_REQUEST_FAILED` |
| `POST /revoke` non-200 (e.g. 400 `invalid_token`) | Token already revoked, expired or unknown | `revoked: false`; disconnect still deletes the token file and completes | None (`revoked: false`) |
| no answer | Step 1 | Failure without `upstreamStatus` | `GOOGLE_REQUEST_FAILED` |

The provider's status travels unchanged as `upstreamStatus` beside the code ([error handling §4a](../../rule/error_handling.md)): `GoogleTokenFailure.upstreamStatus` → the job's `failureUpstreamStatus` → [`google_calendar_links.last_failure_upstream_status`](../../database/tables/google_calendar_links.md). Sign-in outcomes that are not HTTP answers: no callback within 5 minutes → `GOOGLE_AUTH_TIMEOUT`; `error=…` callback → `GOOGLE_CONSENT_DENIED`; no client configured → `GOOGLE_NOT_CONFIGURED`; sign-in URL not delivered to the API after 4 attempts 2 s apart → `GOOGLE_REQUEST_FAILED`.

### Provider error codes and body

Token and revoke errors are one JSON object `{"error": "<code>", "error_description": "<text>"}`; `error_description` may be absent (revoke sends only `error`). `mapTokenFailure` / `map_token_failure` read `error` (a string, or defensively an object with `code`) and a top-level boolean `rateLimitExceeded`; `invalid_grant` → `GOOGLE_AUTH_EXPIRED`, `rateLimitExceeded` → `GOOGLE_RATE_LIMITED`, `invalid_client` → `GOOGLE_CLIENT_REJECTED`, everything else `GOOGLE_REQUEST_FAILED`. Provider text is never logged, stored or shown — only the stable code and the status.

| `error` | Endpoint | Meaning (Google) |
|---|---|---|
| `invalid_client` | `/token` | "The OAuth client was not found." (live), or wrong secret / deleted client |
| `invalid_grant` | `/token` | "The supplied authorization code is invalid or in the wrong format", or the refresh token is expired or revoked |
| `invalid_request` | `/token` | Malformed request, e.g. "Could not determine client ID from request." (live) |
| `invalid_token` | `/revoke` | The token is not valid (live) |
| `access_denied` | redirect `error=` | The owner declined consent |
| `admin_policy_enforced`, `disallowed_useragent`, `org_internal`, `deleted_client`, `redirect_uri_mismatch` | consent page | Shown by Google to the owner in the browser; the runner sees only a missing callback (timeout) |

A bad authorization request (unknown client id) is answered on the consent host with `302` to `https://accounts.google.com/signin/oauth/error?authError=…` — an HTML page for the owner ("Error 401: invalid_client"); the runner is not involved and times out after 5 minutes unless the owner cancels.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s per request, counted after the single DNS lookup; the job's stop signal ends it earlier; clean-up revokes run on their own 10 s signal; the sign-in window is 5 minutes | `packages/adapters/src/google/googleHttp.ts`, `crates/research-google/src/http.rs`, `crates/research-google/src/jobs.rs` |
| Transport | Only `oauth2.googleapis.com` and `www.googleapis.com`; the name is resolved once, every address must be public, the socket connects to that IP with TLS verified against the host name, the peer address is re-checked; no redirects; response body capped at 1,000,000 bytes | `packages/adapters/src/google/googleHttp.ts`, `crates/research-google/src/http.rs` |
| Connections | Transport (Rust): `research-google` does not use the shared `research-net` fetch transport (`PinnedHttpsConnect` / `PinnedHopTransport` in `crates/research-net/src/pinned.rs` and `crates/research-net/src/transport.rs`), so neither its keep-alive pool, nor its resend of a GET on a fresh connection after a pooled connection closed, nor its up-to-`MAX_CONNECT_ATTEMPTS` (3) resolved addresses apply. `PinnedGoogleHttp` opens one new TLS connection per request with `PinnedTls::connect` to the first validated address only, speaks HTTP/1.1 over hyper's `http1::handshake` (no ALPN), sends `connection: close`, and never resends any request, GET included. TypeScript does the same: `agent: false` (a fresh connection, Node adds `Connection: close`) to `addresses[0]`, no resend. | `crates/research-google/src/http.rs`, `packages/adapters/src/google/googleHttp.ts` |
| Retries | None for token or revoke requests (a rate-limited refresh ends the job as `GOOGLE_RATE_LIMITED`; the Calendar backoff applies to Calendar answers only). A Calendar 401 causes one refresh and one retry of that Calendar request ([Google Calendar API §4](google-calendar.md#4-error-handling)). The sign-in URL event is re-sent up to 4 times, 2 s apart. | `packages/adapters/src/google/googleOAuth.ts`, `crates/research-google/src/oauth.rs`, `apps/runner/src/googleCalendar.ts` |
| Rate limit | No headers read; 429 or `rateLimitExceeded` → `GOOGLE_RATE_LIMITED` (retryable job). Every refresh is admitted by the shared pacer (key `google`, 5 per second); the code exchange and revocations are not. | `packages/adapters/src/google/googleOAuth.ts`, `crates/research-google/src/oauth.rs`, `apps/runner/src/googleCalendar.ts`, `crates/research-google/src/jobs.rs` |
| Cache | The access token lives for one job in memory, with its expiry (`expires_in`); the refresh token lives in the token file (rewritten when Google rotates it). | `packages/adapters/src/google/googleTokenStore.ts`, `crates/research-google/src/token_store.rs` |
| Fallback | None: the Google Calendar card shows the fixed sentence for the code (`GOOGLE_CALENDAR_FAILURE_REASONS`); automatic syncing pauses until a manual sync succeeds. A token file that does not parse means "not connected". | `packages/contracts/src/googleCalendar.ts`, `crates/research-contracts/src/google_calendar.rs` |

## 5. Examples

Placeholders: `<GOOGLE_OAUTH_CLIENT_ID>`, `<GOOGLE_OAUTH_CLIENT_SECRET>` (env values); `<redacted>` for the authorization code, the PKCE verifier and the refresh token (secrets); `<state>` and `<code_challenge>` for the per-sign-in values that are not secrets.

### GET /o/oauth2/v2/auth

Request (opened by the owner's browser; one line, wrapped here only by the viewer):

```http
GET /o/oauth2/v2/auth?response_type=code&client_id=<GOOGLE_OAUTH_CLIENT_ID>&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.app.created&access_type=offline&prompt=consent&code_challenge=<code_challenge>&code_challenge_method=S256&state=<state> HTTP/1.1
Host: accounts.google.com
```

Verified: live, 2026-10-31, `curl` of this URL with client id `fake-client-id.apps.googleusercontent.com` (Google parsed it and answered 302 to its `invalid_client` error page, see Error responses); parameters checked against https://developers.google.com/identity/protocols/oauth2/native-app. Client id, challenge and state replaced by placeholders.

Response (after consent Google redirects the browser to our loopback listener):

```http
HTTP/1.1 302 Found
Location: http://127.0.0.1:51234/?state=<state>&code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7
```

Verified: spec, 2026-10-31, https://developers.google.com/identity/protocols/oauth2/web-server (redirect example `?code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7`, Google's sample code; `state` is echoed when sent) and https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2 (`302 Found` with the code in `Location`). Not observed live: needs an interactive sign-in; Google's exact status code and any extra parameters (for example `scope`) are not confirmed.

The request the listener then receives from the browser:

```http
GET /?state=<state>&code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7 HTTP/1.1
Host: 127.0.0.1:51234
```

Verified: spec, 2026-10-31, https://developers.google.com/identity/protocols/oauth2/web-server (follows from the redirect above). The listener ignores parameters other than `state`, `code` and `error`.

### POST /token

Request (code exchange; the refresh sends `grant_type=refresh_token&client_id=…&client_secret=…&refresh_token=<redacted>` instead):

```http
POST /token HTTP/1.1
host: oauth2.googleapis.com
user-agent: stock-investigation-runner/0.1
content-type: application/x-www-form-urlencoded
content-length: <bytes>
Connection: close

grant_type=authorization_code&code=<redacted>&client_id=<GOOGLE_OAUTH_CLIENT_ID>&client_secret=<GOOGLE_OAUTH_CLIENT_SECRET>&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&code_verifier=<redacted>
```

Verified: live, 2026-10-31, `curl --http1.1` with this field order and fake client values (answered 401 `invalid_client`, see Error responses); fields checked against https://developers.google.com/identity/protocols/oauth2/native-app. Secrets replaced by placeholders, so `Content-Length` is a placeholder too.

Response (code exchange, this app's grant):

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

<!-- example: google-oauth-token-exchange-app -->
```json
{
  "access_token": "<redacted>",
  "expires_in": 3599,
  "token_type": "Bearer",
  "scope": "https://www.googleapis.com/auth/calendar.app.created",
  "refresh_token": "<redacted>"
}
```

Verified: spec, 2026-10-31, https://developers.google.com/identity/protocols/oauth2/native-app (Google's documented response shape and field order, with the scope this app requests; `expires_in` illustrative). Tokens redacted. The runner accepts it: refresh token present, `scope` contains `calendar.app.created`. Not observed live: needs the owner's grant.

Response (refresh, this app's grant):

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

<!-- example: google-oauth-token-refresh-app -->
```json
{
  "access_token": "<redacted>",
  "expires_in": 3599,
  "scope": "https://www.googleapis.com/auth/calendar.app.created",
  "token_type": "Bearer"
}
```

Verified: spec, 2026-10-31, https://developers.google.com/identity/protocols/oauth2/native-app (Google's documented refresh response shape, no `refresh_token`, with the scope this app requests; `expires_in` illustrative). Access token redacted. Not observed live: needs the owner's grant.

Provider sample (code exchange), Google's own example for other scopes — the runner parses it but refuses the grant:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

<!-- example: google-oauth-token-exchange -->
```json
{
  "access_token": "1/fFAGRNJru1FTz70BzhT3Zg",
  "expires_in": 3920,
  "token_type": "Bearer",
  "scope": "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/calendar.readonly",
  "refresh_token": "1//xEoDL4iW3cxlI7yDbSRFYNG01kVKM2C-259HOF2aQbI"
}
```

Verified: spec, 2026-10-31, https://developers.google.com/identity/protocols/oauth2/native-app (Step 5 sample, verbatim; its token values are Google's sample values, its `scope` is the sample's — our grant answers `https://www.googleapis.com/auth/calendar.app.created`, and this sample would end as `GOOGLE_SCOPE_MISSING`). Google's `DPoP-Nonce` header is omitted: it is sent only to DPoP clients, and we send no `DPoP` header.

Provider sample (refresh), Google's own example for other scopes:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
```

<!-- example: google-oauth-token-refresh -->
```json
{
  "access_token": "1/fFAGRNJru1FTz70BzhT3Zg",
  "expires_in": 3920,
  "scope": "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/calendar.readonly",
  "token_type": "Bearer"
}
```

Verified: spec, 2026-10-31, https://developers.google.com/identity/protocols/oauth2/native-app ("Refreshing an access token" sample, verbatim; no `refresh_token`, as documented). `DPoP-Nonce` header omitted as above.

### POST /revoke

Request:

```http
POST /revoke HTTP/1.1
host: oauth2.googleapis.com
user-agent: stock-investigation-runner/0.1
content-type: application/x-www-form-urlencoded
content-length: <bytes>
Connection: close

token=<redacted>
```

Verified: live, 2026-10-31, `curl --http1.1` with token `1//invalid-refresh-token` (answered 400 `invalid_token`, see Error responses). Token replaced by a placeholder, so `Content-Length` is a placeholder too.

Response:

```http
HTTP/1.1 200 OK
```

Verified: spec, 2026-10-31, https://developers.google.com/identity/protocols/oauth2/native-app ("If the revocation is successfully processed, then the HTTP status code of the response is 200"). No success body is documented, and none is read. Not observed live: needs a real grant.

### Error responses

Token endpoint, unknown client (code exchange and refresh answer the same):

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Cache-Control: no-cache, no-store, max-age=0, must-revalidate
```

<!-- example: google-oauth-error-invalid-client -->
```json
{
  "error": "invalid_client",
  "error_description": "The OAuth client was not found."
}
```

Verified: live, 2026-10-31, `curl --http1.1 -X POST https://oauth2.googleapis.com/token` with client id `fake-client-id.apps.googleusercontent.com`, both `grant_type=authorization_code` and `grant_type=refresh_token` (same status line, `Cache-Control`, `Content-Type` and body; `Date` and header order differ). Other response headers omitted.

Token endpoint, no client id:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
```

<!-- example: google-oauth-error-invalid-request -->
```json
{
  "error": "invalid_request",
  "error_description": "Could not determine client ID from request."
}
```

Verified: live, 2026-10-31, `curl --http1.1 -X POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token&refresh_token=x` only. Other response headers omitted.

Revocation of an unknown token:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
```

<!-- example: google-oauth-error-revoke-invalid-token -->
```json
{
  "error": "invalid_token"
}
```

Verified: live, 2026-10-31, `curl --http1.1 -X POST https://oauth2.googleapis.com/revoke` with `token=1//invalid-refresh-token`. Other response headers omitted.

Authorization URL with an unknown client id (seen by the browser, never by the runner):

```http
HTTP/1.1 302 Moved Temporarily
Content-Type: text/html; charset=UTF-8
Location: https://accounts.google.com/signin/oauth/error?authError=Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw&flowName=GeneralOAuthFlow&client_id=fake-client-id.apps.googleusercontent.com&as=S-114631465%3A1793422235586680&aes=AVQXgOCDqAOK-lIMa6kIQ4er-a3E
```

Verified: live, 2026-10-31, `curl --http1.1` of the authorization URL above with client id `fake-client-id.apps.googleusercontent.com`. `authError` decodes to `invalid_client` / "The OAuth client was not found." / 401. `Set-Cookie`, the HTML body and other headers omitted; the `Location` value is complete.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| callback `code` | ≤ 500 characters, non-empty | `LoopbackResult.code` (`packages/adapters/src/google/googleLoopback.ts`), `LoopbackResult::Code` (`crates/research-google/src/loopback.rs`) | Not stored (memory only) |
| callback `error` | Any value → denied | `LoopbackResult` `denied` → `GOOGLE_CONSENT_DENIED` | [`google_calendar_links.last_failure_code`](../../database/tables/google_calendar_links.md) (the code, never the value) |
| `$.access_token` | none | `TokenSuccess.accessToken` / `TokenSuccess::access_token` (`Secret`) | Not stored (memory only, one job) |
| `$.refresh_token` | none (exchange; on refresh only when it differs from the token sent) | `TokenSuccess.refreshToken` / `TokenRefreshSuccess.refreshToken` / `RefreshedToken::refresh_token` → `GoogleTokenRecord.refreshToken` (`packages/adapters/src/google/googleTokenStore.ts`, `crates/research-google/src/token_store.rs`) | Runner token file `GOOGLE_TOKEN_FILE`, field `refreshToken` (never in the database) |
| `$.scope` | Split on spaces; must contain our scope | `scopeGranted` / `scope_granted`; the token file stores the constant scope, not Google's string | Token file field `scope` |
| `$.expires_in` | Integer seconds; `null` when absent; expiry = receipt time + seconds × 1000 | `TokenSuccess.expiresIn` / `expires_in` → the job's access-token expiry (`calendarSession` / `Session`) | Not stored (memory only, one job) |
| `/revoke` status | `200` → `true`, else `false` | `revoked` in `googleCalendarDisconnectedSchema` (`packages/contracts/src/googleCalendar.ts`) | Not stored (logged as `google_disconnected` / `google_grant_discarded` with `revoked`) |
| `error` / status of a failed token request | `mapTokenFailure` / `map_token_failure`; status unchanged | `GoogleTokenFailure {code, upstreamStatus}` → job failure | [`google_calendar_links.last_failure_code`, `last_failure_upstream_status`, `last_failure_at`](../../database/tables/google_calendar_links.md) |
| (authorization URL we build) | Validated by `isGoogleSignInUrl` | `google-auth-url` event `url` | [`google_calendar_links.pending_auth_url`](../../database/tables/google_calendar_links.md), only while `connecting` |

## 7. Maintenance

### Known differences between the runners

Header names on the wire: the TypeScript runner sends the names in lowercase as the code gives them (`host`, `user-agent`, `authorization`, `content-type`, `content-length`), and Node appends `Connection: close`; the Rust runner (hyper) sends all names in lowercase in the order `host`, `user-agent`, the caller's headers, `connection: close`, `content-length`. The examples show the TypeScript order; header names are case-insensitive, so Google sees the same request. Both runners open one fresh connection per request to the first resolved address and never resend a request; the Rust runner does not use the shared `research-net` transport's GET resend or its three-address fallback (section 4, Connections). Otherwise no differences in the requests, parameters, field checks or error mapping: the Rust module ports the TypeScript one (the authorization URL's parameter order is the same; `token_response` applies the same field-type checks as `tokenResponseSchema`; the Rust HTTP port sends `Connection: close` explicitly, the Node port gets it from `agent: false`). Rust decodes response bodies with UTF-8 replacement and strips one BOM; Node's `TextDecoder` does the same.

### Open issues

- The success responses (code exchange, refresh, revoke `200`) and the loopback callback are `spec` only: verifying them live needs the owner's OAuth client and an interactive sign-in, which this verification did not use. `invalid_grant` is handled from the documentation; its exact body was not captured.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | live | `POST /token` exchange and refresh with a fake client (401 `invalid_client`), `POST /token` without client (400 `invalid_request`), `POST /revoke` with an unknown token (400 `invalid_token`), authorization URL with a fake client (302 to the `invalid_client` page); no owner credentials or account used | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | Authorization parameters, loopback redirect, token exchange and refresh responses, revoke status, refresh-token expiry and limits against Google's OAuth documentation; both runners' code read | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | live | Re-captured the refresh `invalid_client` answer over HTTP/1.1 (the transport both runners use); error-mapping precedence and connection behaviour re-read in both runners after review | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | After review: added success examples of this app's own grant (scope `calendar.app.created`), kept Google's samples as provider samples | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | Code fixes: `invalid_client` → `GOOGLE_CLIENT_REJECTED` (the live 401 example now maps to it), a rotated refresh token is stored, `expires_in` drives a refresh before a Calendar request, refreshes are paced; no example changed, both runners pinned by `vectors/google/` | Claude (external API code fixes) |
