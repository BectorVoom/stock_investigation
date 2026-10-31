# ADR-0018: Google Calendar sync (runner-side loopback OAuth + dedicated calendar)

**Status:** Accepted · **Date:** 2026-10-14

## Context

FR-018 gave the watchlist its calendar export without any Google credential:
`.ics` download, per-date "Add to Google Calendar" / "Add to Outlook" links
and a secret-token subscription feed (ADR-0016). The owner then asked for "a
calendar that integrates via Google Calendar": a month-grid calendar in the
widget plus a real Google Calendar connection that keeps a dedicated calendar
in their Google account in sync. The widget itself follows the Apple Human
Interface Guidelines for widgets (glanceable, deep-linking; see
`docs/DESIGN_GUIDELINE.md`): the full month grid lives on the Watchlist page,
the Home widget stays compact.

## Decision

**Runner-side loopback OAuth with the least-privilege scope
`https://www.googleapis.com/auth/calendar.app.created`.** The local runner
holds the Desktop-app client id + secret (`GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET` in `apps/runner/.env`) and the refresh token in
a runner-side file beside `runner-credential.json` (mode 0600, atomic write);
access tokens stay in memory. The scope authorises exactly one thing: the
secondary calendars the app itself created — the app can never read or change
the owner's other calendars. Only `oauth2.googleapis.com` (token, revoke) and
`www.googleapis.com` (Calendar API) are contacted, through the pinned-connect
machinery with a narrow port each; no redirects are followed.
Requests, responses and error handling of both services: [Google OAuth](../external-apis/apis/google-oauth.md) and [Google Calendar API](../external-apis/apis/google-calendar.md) ([ADR-0047](0047-external-api-documents.md)).

**Connect is a `google-calendar` job.** The runner starts a one-shot
loopback listener on `127.0.0.1` (ephemeral port), sends one `google-auth-url`
event (client id, redirect port, `state`, PKCE challenge — none of them a
credential; the event schema accepts only the runner's own link: the Google
OAuth endpoint, `response_type=code`, the single scope, PKCE `S256`, a
redirect to `http://127.0.0.1:<port>/`, each parameter once and nothing
unlisted — so a compromised runner cannot put a consent screen for another
scope or a foreign redirect behind the app's own button), and waits up
to 5 minutes for the callback (`state` compared with `timingSafeEqual`,
`error=access_denied` → `CONSENT_DENIED`). It exchanges the code (requiring a
`refresh_token` and the granted scope), reuses the stored calendar id when
`getCalendar` still finds it, else creates `"Earnings calendar (Research
workspace)"` (UTC), writes the token file, and completes. No token, secret,
code or verifier ever reaches a job row, event, audit row, log line, error
message, the browser, or a URL the browser sees.

**Sync is deterministic and idempotent.** Event ids are the first 20 bytes of
SHA-256 over `stockId + "\n" + periodKey`, base32hex-encoded to 32 characters
(the domain stays hash-free: the digest arrives through the application's
`Hasher` port), so a re-sync never duplicates. `planGoogleSync` diffs the
desired bodies (the same assembly as the `.ics`, sharing its summary /
description text builder — ICS output is byte-identical, proved by the
existing vectors) against the managed events (`privateExtendedProperty`
filter, cancelled included): deletes, updates, then inserts (a 409 retries
once as an update; a delete answered 404/410 counts as done). One
difference from the `.ics` text is deliberate: the Google description
carries no "retrieved <date>". The plan compares the description, and a
date that moves with every refresh would turn each daily refresh into an
update of every event although no announcement moved. Completion stores the digest; `inSync` is the
stored digest equalling the CURRENT desired digest, so removing a stock or a
refresh that changes dates flips it without any extra write. Stable failure
codes (`GOOGLE_NOT_CONFIGURED`, …) each carry one fixed reason sentence;
unknown stored codes display the generic reason.

**State flows through `GET /api/v1/watchlist`.** The `googleCalendar` field
(status, auth URL while connecting, calendar id, stamps, last counts,
`inSync`, the active run, the last failure) is covered by the watchlist ETag,
so both views see every change through the poll they already run. Queueing
mirrors `queueRefresh` (one non-terminal `google-calendar` job per owner, same
rate-limiter bucket, audited); `sync`/`disconnect` require connected or
needs-reconnect. A request for a different step while one runs is refused
(`CONFLICT`) rather than answered with the other step's run.

**Automatic sync cannot loop.** The Web queues a sync by itself only when the
calendar is connected, out of sync, no run of either kind is active, **no
failure is on record**, and it has not already tried for the current
watchlist ETag in this mount. The failure is stored by the API, so the stop
holds across reloads and tabs; a successful sync (the owner's "Sync now")
clears it. An ETag-only rule was the first design and it looped: every
failed run records a new `lastFailure`, which is itself an ETag change — the
independent review reproduced 29 queued jobs for one unchanged watchlist.

**How a step ends.**

- A `google-calendar` step is never retried on its own. A retried connect
  would wait on a sign-in link the restored link row no longer shows; a
  failed sync is reported and started again from the card.
- A connect whose lease expired (the runner died mid-sign-in) is failed at
  the next claim with `GOOGLE_AUTH_TIMEOUT` instead of opening a new sign-in
  window hours later with nobody at the browser.
- An owner cancel restores the link row itself when no runner holds a live
  lease, and a `connecting` row with no run behind it is shown as the status
  it would be restored to — the card can never be stranded on a dead link.
- A sign-in that produced a grant which is then not kept (wrong scope, the
  calendar could not be created, the run ended cancelled or abandoned) gives
  the grant back: the refresh token is revoked and no token file stays.
  Otherwise the app would say "not connected" while a live grant it cannot
  disconnect sat on disk.
- A sync that goes through sets the status back to `connected`.
- The runner executes one job at a time, so an open sign-in holds every
  other runner job (news, market and earnings refreshes) for up to its five
  minutes. Cancel on the card ends the wait at once.

**What is documentation-derived and not yet observed live:** the exact Google
error bodies (401, 403 `rateLimitExceeded`, 404, 409 duplicate id, 410 gone),
whether `PUT events/{id}` on a cancelled event restores it, and
`invalid_grant` on an expired or revoked refresh token. The adapter maps these
defensively and says so in comments; event bodies state `status: "confirmed"`
so an update cannot leave a cancelled event cancelled if `PUT` alone does not
restore it.

**Update (2026-10-31).** Updates now use `PATCH` with only the fields we manage
(still with `status: "confirmed"`), so reminders or a colour the owner sets in
Google survive; events are sent `transparency: "transparent"` like the `.ics`
feed; rate-limit answers are retried with bounded backoff. Current request and
error handling: [Google Calendar API](../external-apis/apis/google-calendar.md).

**Independent review (2026-10-13).** A separate reviewer read the backend
before the Web was finished and reproduced its findings against in-memory
storage. Thirteen findings (two high): twelve are fixed with tests — among
them the automatic-sync loop, the stranded `connecting` state, the kept
token after a cancelled sign-in, the retried and the abandoned sign-in, the
daily rewrite of every event, and link validation by prefix only. One is
deliberately not done: a keep-alive connection to Google (requests are paced
at five per second, so a handshake per request costs little).

## Consequences

- The owner creates a Google Cloud project, enables the Calendar API, and
  stores a Desktop-app OAuth client in `apps/runner/.env` (see
  `docs/OPERATIONS.md`); a "Testing"-mode app's refresh token expires after 7
  days, so the project is published to "In production" for personal use.
- Disconnecting revokes the grant (best effort) and deletes the local token
  file; the calendar itself stays in Google until deleted there.
- Earnings dates remain personal-use vendor data (ADR-0016); the Google
  refresh token and client secret are new secrets in the threat model (see
  `docs/THREAT_MODEL.md`).
- The subscription feed, `.ics` and per-date links keep working with no
  Google account; the widget never shows the auth URL.

## Alternatives considered (deliberately not done)

- **Browser-side Google Identity.** Rejected: tokens would reach the browser
  and the SPA bundle, and background sync with no open tab would be
  impossible — the runner already runs the refresh loop.
- **Worker-side OAuth web client.** Rejected: the client secret would live on
  Cloudflare instead of the owner's PC, and the loopback shortcut that keeps
  the secret off the network would be lost; the deployment is postponed
  anyway.
- **Embeddable iframe.** Rejected: an iframe shows Google's UI but cannot
  keep a calendar in step; it answers none of the sync requirement.
- **A broader scope (`calendar.events`, full `calendar`).** Rejected on least
  privilege: `calendar.app.created` is the only scope the sync needs.

## Rollback

- Operational: disconnect on the Watchlist page (or delete the runner-side
  token file and restart) — the app forgets the connection at once; delete
  the calendar in Google Calendar settings to remove its events. Removing the
  two `GOOGLE_OAUTH_*` values returns every `google-calendar` job to
  `GOOGLE_NOT_CONFIGURED`; stored dates stay readable.
- Schema: migration `0008_google_calendar.sql` carries its inverse in its
  header comment (`DELETE` the owner's link row and `DROP TABLE`
  `google_calendar_links` after a `wrangler d1 export` rehearsal on a copy);
  code rollback leaves the table unused but harmless.
- Contract: the `google-calendar` job kind, the `google-auth-url` event and
  the three completion outcomes are additive to the claim/complete/event
  unions; removing them is a major contract version, not a silent change.
