# Table: google_calendar_links

## Overview

| Property | Value |
|---|---|
| Table Name | `google_calendar_links` |
| Purpose | One row holds the owner's Google Calendar sync state: connection status, the dedicated calendar's id, and the last sync and failure (FR-019, ADR-0018). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 7. Watchlist and calendar |
| Created By | `infra/migrations/0008_google_calendar.sql` |
| Primary Key | `owner_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createGoogleCalendarRepository`, `googleLinkStatements`), `packages/adapters/src/sql/unitOfWork.ts` (`commitCompletion`), `packages/application/src/googleCalendarLink.ts` (the patches) |
| Update Strategy | Read-modify-write upsert of the whole row; a guarded partial UPDATE in a completion batch |
| Data Retention | One row per owner, never deleted (disconnect resets it) |

Connect, sync and disconnect are `google-calendar` runner jobs queued by `POST /google-calendar/{connect,sync,disconnect}`. The API sets the row to `connecting` before inserting a connect job, stores the sign-in URL the runner sends, and applies a patch when the run completes, fails, is cancelled or loses its lease. `GET /watchlist` reports the state (`googleCalendar`), with `inSync` computed by comparing `synced_digest` with the current desired events' digest.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `status` | TEXT | No | - | `disconnected`, `connecting`, `connected` or `needs-reconnect` (checked on read). |
| `connect_from` | TEXT | Yes | - | Status a connect run started from (same values as `status`); a failed, cancelled or lease-expired connect restores it. NULL outside a connect. |
| `pending_auth_url` | TEXT | Yes | - | Google sign-in URL sent by the runner (client id, loopback port, state, PKCE challenge; no credential). Stored only while `connecting`. |
| `calendar_id` | TEXT | Yes | - | Id of the dedicated secondary calendar the app created in the owner's Google account; NULL when disconnected. |
| `connected_at` | TEXT | Yes | - | ISO-8601 UTC time of the last successful connect. |
| `last_synced_at` | TEXT | Yes | - | ISO-8601 UTC time of the last successful sync. |
| `synced_digest` | TEXT | Yes | - | SHA-256 hex digest of the desired event set the last sync applied. |
| `last_inserted` | INTEGER | Yes | - | Events inserted by the last sync; the four counts are NULL together until a sync completes. |
| `last_updated` | INTEGER | Yes | - | Events updated by the last sync. |
| `last_deleted` | INTEGER | Yes | - | Events deleted by the last sync. |
| `last_unchanged` | INTEGER | Yes | - | Events left unchanged by the last sync. |
| `last_failure_code` | TEXT | Yes | - | Stable `GOOGLE_*` failure code of the last failed run (never provider text); cleared by a successful connect or sync. |
| `last_failure_at` | TEXT | Yes | - | ISO-8601 UTC time of that failure. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last write to the row. |
| `last_failure_upstream_status` | INTEGER | Yes | - | HTTP status Google answered with behind `last_failure_code`, unchanged (ADR-0037); NULL when no Google answer caused the failure. Added by `0012_upstream_status.sql`. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id` | - | One link per owner; the upsert's conflict target and the key of every read. |

## Indexes

None. The primary key serves every read and write: all access is by `owner_id`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`createGoogleCalendarRepository().setConnecting` (`POST /google-calendar/connect`, before the job insert) upserts the row as `connecting`, starting from a disconnected row when none exists. `apply` also upserts and can create the row.

### Update

`setConnecting`, `setPendingAuthUrl` (a runner `google-auth-url` event, applied only while `connecting`) and `apply` read the row, change fields in memory and upsert every column. `apply` is used by queue undo, lease expiry and owner cancel through `applyGoogleTerminalOutcome`. A runner completion runs `googleLinkStatements` instead: one UPDATE of only the patched columns plus `updated_at`, guarded on the job compare-and-set in the completion batch. It never inserts. Patches come from `googleSuccessPatch` and `googleTerminalPatch`.

### Delete

Never: a successful disconnect run resets every column to NULL and `status` to `disconnected`.

### Synchronization

The row tracks a one-way push of the owner's dated earnings events (from `watchlist_stocks` and `earnings_events`) to the dedicated Google calendar. A sync run diffs the desired events against the calendar and stores the applied digest and counts. A later watchlist or earnings change flips `inSync` without any write here.

### Retention

At most one row per owner, kept for the life of the installation.

## Notes

- Security: there is deliberately no token column. The refresh token lives only in a runner-side 0600 file beside `runner-credential.json`; the OAuth client secret stays in the runner's `.env`.
- Deleting the row makes the page show "disconnected" but leaves the runner's grant file; disconnect from the page or delete the token file instead ([database operations](../operations.md#0008--google-calendar)).
- `setConnecting`, `setPendingAuthUrl` and `apply` read the row and then upsert every column without a version check, so two of them interleaving can overwrite each other's change.
