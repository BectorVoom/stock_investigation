# External API: Google Calendar API

## 1. Overview

| Property | Value |
|---|---|
| Provider | Google LLC (Google Workspace, Calendar API v3) |
| Purpose | Keeps one dedicated secondary calendar, "Earnings calendar (Research workspace)", in step with the dated earnings announcements of the owner's watchlist (FR-019, [ADR-0018](../../adr/0018-google-calendar-sync.md)): the runner creates the calendar on connect, then each sync lists the events it manages and deletes, updates and inserts until the calendar matches the desired set. |
| Hosts | `www.googleapis.com` |
| Endpoints | `POST /calendar/v3/calendars` — creates the dedicated calendar (`calendars.insert`); `GET /calendar/v3/calendars/{calendarId}` — checks it still exists (`calendars.get`); `GET /calendar/v3/calendars/{calendarId}/events` — lists the managed events, cancelled ones included (`events.list`); `POST /calendar/v3/calendars/{calendarId}/events` — inserts one event with our id (`events.insert`); `PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}` — updates the fields we manage of one event (`events.patch`); `DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}` — deletes one event (`events.delete`) |
| Authentication | OAuth 2.0 bearer token: `Authorization: Bearer <access token>`, scope `https://www.googleapis.com/auth/calendar.app.created` only (secondary calendars this app created, and their events). The access token comes from [Google OAuth 2.0](google-oauth.md) (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` in `apps/runner/.env`, refresh token in `GOOGLE_TOKEN_FILE`) and stays in runner memory. |
| Configuration | Calendar summary `Earnings calendar (Research workspace)`, description "Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.", time zone `UTC` (constants in both runners). |
| Usage Limits | [Published quotas](https://developers.google.com/workspace/calendar/api/guides/quota): 10,000 requests per minute per project, 600 per minute per user per project, 1,000,000 per day per project; exceeding answers 403 or 429. Google also applies unpublished [Calendar usage limits](https://support.google.com/a/answer/2905486) (e.g. many writes to one calendar in quick succession). Each `events.patch` costs three quota units ([events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)). Our side: requests strictly sequential, every attempt (retries and token refreshes included) admitted by the shared pacer at 5 quota units per second (key `google`; an `events.patch` counts 3, everything else 1), so at most 300 units a minute, half the per-user quota, even when a sync patches every event; at most 10 listing requests of up to 250 events each (a continuation token after the tenth fails the sync); at most `GOOGLE_SYNC_MAX_EVENTS` desired events (watchlist stocks × events per stock); a rate-limit answer is retried with exponential backoff, at most 60 s of waiting per job (section 4). |
| Called By | Rust runner and TypeScript runner, `google-calendar` jobs: `connect` (`calendars.get` of a previous id, else `calendars.insert`) and `sync` (`calendars.get`, then `events.list` or `calendars.insert`, then deletes, updates, inserts). Never the API Worker or the browser. |
| Code | `crates/research-google/src/calendar.rs`, `crates/research-google/src/jobs.rs`, `crates/research-google/src/http.rs`, `crates/research-domain/src/calendar/google_sync.rs`, `crates/research-runner/src/google_sync.rs`, `packages/adapters/src/google/googleCalendarClient.ts`, `packages/adapters/src/google/googleHttp.ts`, `apps/runner/src/googleCalendar.ts`, `packages/domain/src/calendar/googleSync.ts`, `packages/application/src/googleCalendar.ts`, `packages/contracts/src/googleCalendar.ts`, `packages/adapters/src/http/retryAfter.ts`, `crates/research-net/src/retry_after.rs` |
| Official Documentation | [Calendar API reference](https://developers.google.com/workspace/calendar/api/v3/reference) ([Calendars](https://developers.google.com/workspace/calendar/api/v3/reference/calendars), [Events](https://developers.google.com/workspace/calendar/api/v3/reference/events)); machine-readable [Discovery document](https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest) (revision `20261028`); [Handle API errors](https://developers.google.com/workspace/calendar/api/guides/errors); [Manage quotas](https://developers.google.com/workspace/calendar/api/guides/quota); [Extended properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties); [Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth) |
| Last Verified | 2026-10-31, spec (success responses against the Discovery document) and live (401 error responses without credentials) — see section 7 |

A `sync` claim carries the desired events (assembled by the API from `watchlist_stocks`, `earnings_events` and `earnings_sources`, the same assembly as the `.ics`), their digest and the calendar id the API believes is connected. The runner refreshes an access token, checks the calendar (`GET …/calendars/{id}`; a 404 creates a new one and stores its id in the token file), lists the managed events (`privateExtendedProperty=researchWorkspace=earnings`, `showDeleted=true`), plans with `planGoogleSync` / `plan_google_sync` (an event Google holds as `opaque` is updated even when its texts and dates match, so it becomes free) and applies deletes, then updates, then inserts, in id order. Event ids are deterministic (base32hex of the first 20 bytes of SHA-256 over `stockId + "\n" + periodKey`), so a re-sync never duplicates; an insert answered 409 is retried once as an update (`PATCH`). Completion reports the counts and digest, which the API stores in [`google_calendar_links`](../../database/tables/google_calendar_links.md).

## 2. Input Parameters

Every request: HTTP/1.1 to `www.googleapis.com:443`, headers `Host`, `User-Agent: stock-investigation-runner/0.1`, `Authorization: Bearer <access token>`, and with a body `Content-Type: application/json; charset=utf-8` and `Content-Length`; one connection per request (`Connection: close`). Path segments are encoded with `encodeURIComponent` (Rust: `encode_uri_component`), so a calendar id's `@` is sent as `%40`. Bodies are compact JSON (`JSON.stringify` / `research_js::json::stringify`) with the key order shown.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `Authorization` | header | string | Yes | — ; `Bearer <access token>` | OAuth 2.0 access token with `calendar.app.created` | Sent on every call below. |
| `Content-Type` | header | string | With a body | — ; `application/json; charset=utf-8` | — | Only on POST and PATCH. |
| `User-Agent` | header | string | No | — ; `stock-investigation-runner/0.1` | — | Identifies the runner. |

### POST /calendar/v3/calendars

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `summary` | body | string | Yes | — ; `Earnings calendar (Research workspace)` | — | Calendar title. |
| `description` | body | string | No | none; the fixed description above | — | Calendar description. |
| `timeZone` | body | string | No | the account's time zone; we send `UTC` | IANA time-zone name | Events are all-day, so the zone affects only Google's display. |

### GET /calendar/v3/calendars/{calendarId}

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `calendarId` | path | string | Yes | — | Our id: printable ASCII, ≤ 256 characters (`googleCalendarIdSchema`) | The stored calendar id (claim, else token file). |

### GET /calendar/v3/calendars/{calendarId}/events

Query built with `URLSearchParams` / `form_urlencoded`, in this order.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `calendarId` | path | string | Yes | — | as above | The dedicated calendar. |
| `privateExtendedProperty` | query | string | No | no filter; we send `researchWorkspace=earnings` (encoded `researchWorkspace%3Dearnings`) | `propertyName=value`, repeatable | Only events whose private extended property `researchWorkspace` is `earnings` — the events this app wrote. |
| `showDeleted` | query | boolean | No | `false`; we send `true` | — | Includes cancelled (deleted) events, so an event the owner deleted in Google is restored by an update rather than re-inserted under a taken id. |
| `maxResults` | query | integer | No | `250`; we send `250` | 1–2500 | Page size. |
| `pageToken` | query | string | No | first page; we send the previous page's `nextPageToken` | opaque | Next page. At most 10 requests per listing: a `nextPageToken` still present after the tenth page fails the sync, whatever the number of events. |

### POST /calendar/v3/calendars/{calendarId}/events

Body: one Event resource built by `eventResource` / `event_resource` from the claimed `GoogleEventBody`.

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `calendarId` | path | string | Yes | — | as above | The dedicated calendar. |
| `id` | body | string | No | server-generated; we send ours | base32hex `0-9a-v`, 5–1024 characters, unique per calendar; ours are 32 characters | Deterministic event id. |
| `status` | body | string | No | `confirmed`; we send `confirmed` | `confirmed`, `tentative`, `cancelled` | Stated so an update of a cancelled event restores it. |
| `summary` | body | string | No | — | ≤ 300 characters (our contract) | `<symbol> <name> earnings (<fiscal period label>)`. |
| `description` | body | string | No | — | ≤ 2000 characters (our contract); Google allows HTML | Plain text lines from the shared ICS text builder, without the retrieval date. |
| `start.date` | body | string (date) | Yes | — | `yyyy-mm-dd` | Announcement date (all-day). |
| `end.date` | body | string (date) | Yes | — | `yyyy-mm-dd`, exclusive | The day after the announcement. |
| `transparency` | body | string | No | `opaque`; we send `transparent` | `opaque`, `transparent` | Shows the day as free, like the `.ics` (`TRANSP:TRANSPARENT`): an earnings date does not block the owner's time. |
| `extendedProperties.private.researchWorkspace` | body | string | No | — | `earnings` | Marks the event as ours (the listing filter). |
| `extendedProperties.private.stockId` | body | string | No | — | e.g. `us:AAPL`, `jp:7203` | Watchlist stock. |
| `extendedProperties.private.periodKey` | body | string | No | — | `[a-z0-9-]{1,48}` | Fiscal period key. |
| `source.title` | body | string | No | — | 1–200 characters | Publisher (`Finnhub`, `Japan Exchange Group (JPX)`). |
| `source.url` | body | string | No | — | HTTP or HTTPS URL; ours is HTTPS | Source link. |

### PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}

Patch semantics: the fields sent replace Google's values, fields not sent stay as they are ([events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)).

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `calendarId` | path | string | Yes | — | as above | The dedicated calendar. |
| `eventId` | path | string | Yes | — | the desired body's `id` | Event to update. |
| body | body | object | Yes | — | the `POST …/events` fields and order without `id`: `status`, `summary`, `description`, `start`, `end`, `transparency`, `extendedProperties`, `source` | Only the fields this app manages, so reminders or a colour the owner set in Google survive an update; `status: confirmed` restores a cancelled event. |

### DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `calendarId` | path | string | Yes | — | as above | The dedicated calendar. |
| `eventId` | path | string | Yes | — | an id from the listing | Confirmed managed event that is no longer desired. No body. |

## 3. Output Parameters

All success bodies are `application/json; charset=UTF-8`. The Discovery document marks no response field as always present and Google's JSON API omits unset fields rather than sending `null`, so Nullable is `No` throughout; Optional is `Yes` with the Discovery description's condition where it says the field is optional, conditional or omitted, and `Yes (no schema requirement)` where it says nothing. Nested objects are expanded recursively down to leaf fields in sub-tables (`####`) under each resource. Unknown fields are ignored by both runners.

### POST /calendar/v3/calendars

`200`, one Calendar resource. Parsed by `calendarSchema` / `calendar_id`: only `id` is read.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.kind` | string | No | Yes (no schema requirement) | No | `calendar#calendar`. |
| `$.etag` | string | No | Yes (no schema requirement) | No | ETag of the resource. |
| `$.id` | string | No | Yes (no schema requirement) | Yes | Calendar id, e.g. `c_<hex>@group.calendar.google.com`; must be a non-empty string, else `GOOGLE_REQUEST_FAILED`. |
| `$.summary` | string | No | Yes (no schema requirement) | No | Title (ours). |
| `$.description` | string | No | Yes | No | Description (ours). |
| `$.location` | string | No | Yes | No | Free-form location; we send none. |
| `$.timeZone` | string | No | Yes | No | `UTC` (ours). |
| `$.dataOwner` | string | No | Yes (secondary calendars only) | No | Owner's email address; personal data, never read. |
| `$.conferenceProperties` | object | No | Yes (no schema requirement) | No | Allowed conference solution types. |
| `$.labelProperties` | object | No | Yes | No | Event labels defined on the calendar. |
| `$.autoAcceptInvitations` | boolean | No | Yes (resource calendars only) | No | Not applicable. |

Nested objects of the Calendar resource (none is read). Generated recursively from the captured Discovery document (revision `20261028`) by a script kept with the verification captures; every nested object at any depth has its own sub-table down to leaf fields, open-ended maps (`additionalProperties`) are written `<name>`. Optional: `Yes (documented)` where the field's description calls it optional or conditional, `Yes (no schema requirement)` where the schema says nothing (Discovery marks no response field as required). 
#### Calendar `$.labelProperties`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.labelProperties.eventLabels` | array of object (`EventLabel`) | No | Yes (no schema requirement) | No | Event labels defined on this calendar. |

#### Calendar `$.labelProperties.eventLabels[]`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.labelProperties.eventLabels[].id` | string | No | Yes (documented) | No | The ID of the label. |
| `$.labelProperties.eventLabels[].backgroundColor` | string | No | Yes (no schema requirement) | No | Background color of the label in hexadecimal format, such as "#039be5". |
| `$.labelProperties.eventLabels[].name` | string | No | Yes (documented) | No | Name of the label. |

#### Calendar `$.conferenceProperties`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.conferenceProperties.allowedConferenceSolutionTypes` | array of string | No | Yes (documented) | No | The types of conference solutions that are supported for this calendar. |

### GET /calendar/v3/calendars/{calendarId}

`200`, the same Calendar resource as `POST /calendar/v3/calendars` (same fields as the table above); only `$.id` is read, and it must be a non-empty string. The answer's id is not compared with the requested one: a 200 keeps the stored id.

### GET /calendar/v3/calendars/{calendarId}/events

`200`, one Events collection. Parsed by `eventsListSchema` / the checks in `list_managed_events`; each item by `calendarEventSchema` / `valid_event` → `toManaged` / `to_managed`. One malformed item fails the whole listing.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.kind` | string | No | Yes (no schema requirement) | No | `calendar#events`. |
| `$.etag` | string | No | Yes (no schema requirement) | No | ETag of the collection. |
| `$.summary` | string | No | Yes (no schema requirement) | No | Calendar title. |
| `$.description` | string | No | Yes (no schema requirement) | No | Calendar description. |
| `$.updated` | string (RFC 3339) | No | Yes (no schema requirement) | No | Last modification of the calendar. |
| `$.timeZone` | string | No | Yes (no schema requirement) | No | Calendar time zone. |
| `$.accessRole` | string | No | Yes (no schema requirement) | No | `owner` for our calendar. |
| `$.defaultReminders` | array | No | Yes (no schema requirement) | No | Calendar default reminders. |
| `$.nextPageToken` | string | No | Yes (omitted on the last page) | Yes | Next page; must be a string when present. |
| `$.nextSyncToken` | string | No | Yes (only on the last page) | No | Incremental sync is not used. |
| `$.items` | array of Event | No | Yes (no schema requirement; the parser treats absence as empty) | Yes | The managed events. |
| `$.items[].id` | string | No | Yes (no schema requirement) | Yes | Event id; must be non-empty. |
| `$.items[].status` | string | No | Yes | Yes | `cancelled` → cancelled; anything else (including absent, `confirmed`, `tentative`) → confirmed. |
| `$.items[].summary` | string | No | Yes (no schema requirement) | Yes | Compared with the desired summary; absent → `""`. |
| `$.items[].description` | string | No | Yes | Yes | Compared with the desired description; absent → `""`. |
| `$.items[].start` | object (EventDateTime) | No | Yes (no schema requirement) | Yes | Must be an object when present. |
| `$.items[].start.date` | string (date) | No | Yes (all-day events only) | Yes | Compared with the desired start date. |
| `$.items[].start.dateTime` | string (RFC 3339) | No | Yes (timed events only) | Yes | Fallback: its first 10 characters; neither present → `""`. |
| `$.items[].start.timeZone` | string | No | Yes | No | — |
| `$.items[].end` | object (EventDateTime) | No | Yes (no schema requirement) | Yes | As `start` (`date`, then `dateTime`, then `""`). |
| `$.items[].end.date` | string (date) | No | Yes (all-day events only) | Yes | Exclusive end date of an all-day event; compared with the desired end date. |
| `$.items[].end.dateTime` | string (RFC 3339) | No | Yes (timed events only) | Yes | Fallback: its first 10 characters; neither present → `""`. |
| `$.items[].end.timeZone` | string | No | Yes | No | — |
| `$.items[].extendedProperties` | object | No | Yes (no schema requirement) | No | `private` / `shared` maps; the filter already selected ours, values not read. |
| `$.items[].source` | object | No | Yes (seen only by the creator) | No | `{url, title}`; not compared. |
| `$.items[].kind` | string | No | Yes (no schema requirement) | No | `calendar#event`. |
| `$.items[].etag` | string | No | Yes (no schema requirement) | No | ETag. |
| `$.items[].htmlLink` | string | No | Yes (no schema requirement) | No | Link to the event in Google Calendar. |
| `$.items[].created` | string (RFC 3339) | No | Yes (no schema requirement) | No | Creation time. |
| `$.items[].updated` | string (RFC 3339) | No | Yes (no schema requirement) | No | Last modification. |
| `$.items[].creator` | object | No | Yes (no schema requirement) | No | `{id, email, displayName, self}`; personal data, never read. |
| `$.items[].organizer` | object | No | Yes (no schema requirement) | No | `{id, email, displayName, self}`; the calendar itself for our events. |
| `$.items[].iCalUID` | string | No | Yes (no schema requirement) | No | RFC 5545 UID. |
| `$.items[].sequence` | integer | No | Yes (no schema requirement) | No | iCalendar sequence. |
| `$.items[].eventType` | string | No | Yes (no schema requirement) | No | `default` for ours. |
| `$.items[].reminders` | object | No | Yes (no schema requirement) | No | `{useDefault, overrides}`. |
| `$.items[].transparency` | string | No | Yes | Yes | `transparent` → `transparent`; absent or anything else → `opaque`. Must be a string when present. An otherwise unchanged `opaque` event is updated once. |
| `$.items[].visibility` | string | No | Yes | No | `default`, `public`, `private`, `confidential`. |
| `$.items[].colorId` | string | No | Yes | No | Colour id. |
| `$.items[].location` | string | No | Yes | No | Free-form location. |
| `$.items[].endTimeUnspecified` | boolean | No | Yes (no schema requirement) | No | — |
| `$.items[].recurrence` | array of string | No | Yes (no schema requirement) | No | RRULE lines; ours are single events. |
| `$.items[].recurringEventId` | string | No | Yes (recurring instances only) | No | — |
| `$.items[].originalStartTime` | object | No | Yes (recurring instances only) | No | — |
| `$.items[].attendees` | array | No | Yes (no schema requirement) | No | We add none. |
| `$.items[].attendeesOmitted` | boolean | No | Yes | No | — |
| `$.items[].guestsCanModify`, `$.items[].guestsCanInviteOthers`, `$.items[].guestsCanSeeOtherGuests`, `$.items[].anyoneCanAddSelf` | boolean | No | Yes | No | Guest permissions (`anyoneCanAddSelf` deprecated). |
| `$.items[].privateCopy`, `$.items[].locked` | boolean | No | Yes | No | — |
| `$.items[].hangoutLink` | string | No | Yes | No | — |
| `$.items[].conferenceData` | object | No | Yes (no schema requirement) | No | — |
| `$.items[].attachments` | array | No | Yes (no schema requirement) | No | — |
| `$.items[].gadget` | object | No | Yes (deprecated) | No | — |
| `$.items[].eventLabelId` | string | No | Yes | No | — |
| `$.items[].focusTimeProperties`, `$.items[].outOfOfficeProperties`, `$.items[].workingLocationProperties`, `$.items[].birthdayProperties` | object | No | Yes (only for that `eventType`) | No | — |

Nested objects of the Events collection and of each Event (none is read; `start` and `end`, the only nested objects the code reads, are expanded in the table above). Generated recursively from the captured Discovery document (revision `20261028`) by a script kept with the verification captures; every nested object at any depth has its own sub-table down to leaf fields, open-ended maps (`additionalProperties`) are written `<name>`. Optional: `Yes (documented)` where the field's description calls it optional or conditional, `Yes (no schema requirement)` where the schema says nothing (Discovery marks no response field as required). 
#### Events `$.defaultReminders[]`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.defaultReminders[].method` | string | No | Yes (no schema requirement) | No | The method used by this reminder. |
| `$.defaultReminders[].minutes` | integer (int32) | No | Yes (no schema requirement) | No | Number of minutes before the start of the event when the reminder should trigger. |
#### Event `$.items[].focusTimeProperties`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].focusTimeProperties.declineMessage` | string | No | Yes (no schema requirement) | No | Response message to set if an existing event or new invitation is automatically declined by Calendar. |
| `$.items[].focusTimeProperties.autoDeclineMode` | string | No | Yes (documented) | No | Whether to decline meeting invitations which overlap Focus Time events. |
| `$.items[].focusTimeProperties.chatStatus` | string | No | Yes (no schema requirement) | No | The status to mark the user in Chat and related products. |

#### Event `$.items[].outOfOfficeProperties`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].outOfOfficeProperties.declineMessage` | string | No | Yes (no schema requirement) | No | Response message to set if an existing event or new invitation is automatically declined by Calendar. |
| `$.items[].outOfOfficeProperties.autoDeclineMode` | string | No | Yes (documented) | No | Whether to decline meeting invitations which overlap Out of office events. |

#### Event `$.items[].gadget`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].gadget.iconLink` | string | No | Yes (no schema requirement) | No | The gadget's icon URL. |
| `$.items[].gadget.link` | string | No | Yes (no schema requirement) | No | The gadget's URL. |
| `$.items[].gadget.type` | string | No | Yes (no schema requirement) | No | The gadget's type. |
| `$.items[].gadget.display` | string | No | Yes (no schema requirement) | No | The gadget's display mode. |
| `$.items[].gadget.preferences` | object, map of string | No | Yes (no schema requirement) | No | Preferences. |
| `$.items[].gadget.preferences.<name>` | string | No | Yes (map entry) | No | The preference name and corresponding value. |
| `$.items[].gadget.width` | integer (int32) | No | Yes (documented) | No | The gadget's width in pixels. |
| `$.items[].gadget.height` | integer (int32) | No | Yes (documented) | No | The gadget's height in pixels. |
| `$.items[].gadget.title` | string | No | Yes (no schema requirement) | No | The gadget's title. |

#### Event `$.items[].source`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].source.url` | string | No | Yes (no schema requirement) | No | URL of the source pointing to a resource. |
| `$.items[].source.title` | string | No | Yes (no schema requirement) | No | Title of the source; for example a title of a web page or an email subject. |

#### Event `$.items[].organizer`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].organizer.email` | string | No | Yes (documented) | No | The organizer's email address, if available. |
| `$.items[].organizer.id` | string | No | Yes (documented) | No | The organizer's Profile ID, if available. |
| `$.items[].organizer.displayName` | string | No | Yes (documented) | No | The organizer's name, if available. |
| `$.items[].organizer.self` | boolean | No | Yes (documented) | No | Whether the organizer corresponds to the calendar on which this copy of the event appears. |

#### Event `$.items[].reminders`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].reminders.useDefault` | boolean | No | Yes (no schema requirement) | No | Whether the default reminders of the calendar apply to the event. |
| `$.items[].reminders.overrides` | array of object (`EventReminder`) | No | Yes (no schema requirement) | No | If the event doesn't use the default reminders, this lists the reminders specific to the event, or, if not set, indicates that no reminders are set for this event. |

#### Event `$.items[].reminders.overrides[]`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].reminders.overrides[].method` | string | No | Yes (no schema requirement) | No | The method used by this reminder. |
| `$.items[].reminders.overrides[].minutes` | integer (int32) | No | Yes (no schema requirement) | No | Number of minutes before the start of the event when the reminder should trigger. |

#### Event `$.items[].creator`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].creator.email` | string | No | Yes (documented) | No | The creator's email address, if available. |
| `$.items[].creator.displayName` | string | No | Yes (documented) | No | The creator's name, if available. |
| `$.items[].creator.id` | string | No | Yes (documented) | No | The creator's Profile ID, if available. |
| `$.items[].creator.self` | boolean | No | Yes (documented) | No | Whether the creator corresponds to the calendar on which this copy of the event appears. |

#### Event `$.items[].attachments[]`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].attachments[].fileId` | string | No | Yes (documented) | No | ID of the attached file. |
| `$.items[].attachments[].iconLink` | string | No | Yes (documented) | No | URL link to the attachment's icon. |
| `$.items[].attachments[].fileUrl` | string | No | Yes (no schema requirement) | No | URL link to the attachment. |
| `$.items[].attachments[].mimeType` | string | No | Yes (no schema requirement) | No | Internet media type (MIME type) of the attachment. |
| `$.items[].attachments[].title` | string | No | Yes (no schema requirement) | No | Attachment title. |

#### Event `$.items[].conferenceData`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.entryPoints` | array of object (`EntryPoint`) | No | Yes (no schema requirement) | No | Information about individual conference entry points, such as URLs or phone numbers. |
| `$.items[].conferenceData.signature` | string | No | Yes (documented) | No | The signature of the conference data. |
| `$.items[].conferenceData.notes` | string | No | Yes (documented) | No | Additional notes (such as instructions from the domain administrator, legal notices) to display to the user. |
| `$.items[].conferenceData.conferenceId` | string | No | Yes (documented) | No | The ID of the conference. |
| `$.items[].conferenceData.conferenceSolution` | object (`ConferenceSolution`) | No | Yes (no schema requirement) | No | The conference solution, such as Google Meet. |
| `$.items[].conferenceData.createRequest` | object (`CreateConferenceRequest`) | No | Yes (no schema requirement) | No | A request to generate a new conference and attach it to the event. |
| `$.items[].conferenceData.parameters` | object (`ConferenceParameters`) | No | Yes (no schema requirement) | No | Additional properties related to a conference. |

#### Event `$.items[].conferenceData.entryPoints[]`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.entryPoints[].entryPointFeatures` | array of string | No | Yes (no schema requirement) | No | Features of the entry point, such as being toll or toll-free. |
| `$.items[].conferenceData.entryPoints[].accessCode` | string | No | Yes (documented) | No | The access code to access the conference. |
| `$.items[].conferenceData.entryPoints[].password` | string | No | Yes (documented) | No | The password to access the conference. |
| `$.items[].conferenceData.entryPoints[].uri` | string | No | Yes (no schema requirement) | No | The URI of the entry point. |
| `$.items[].conferenceData.entryPoints[].passcode` | string | No | Yes (documented) | No | The passcode to access the conference. |
| `$.items[].conferenceData.entryPoints[].entryPointType` | string | No | Yes (documented) | No | The type of the conference entry point. |
| `$.items[].conferenceData.entryPoints[].meetingCode` | string | No | Yes (documented) | No | The meeting code to access the conference. |
| `$.items[].conferenceData.entryPoints[].regionCode` | string | No | Yes (documented) | No | The CLDR/ISO 3166 region code for the country associated with this phone access. |
| `$.items[].conferenceData.entryPoints[].label` | string | No | Yes (documented) | No | The label for the URI. |
| `$.items[].conferenceData.entryPoints[].pin` | string | No | Yes (documented) | No | The PIN to access the conference. |

#### Event `$.items[].conferenceData.conferenceSolution`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.conferenceSolution.name` | string | No | Yes (no schema requirement) | No | The user-visible name of this solution. |
| `$.items[].conferenceData.conferenceSolution.iconUri` | string | No | Yes (no schema requirement) | No | The user-visible icon for this solution. |
| `$.items[].conferenceData.conferenceSolution.key` | object (`ConferenceSolutionKey`) | No | Yes (no schema requirement) | No | The key which can uniquely identify the conference solution for this event. |

#### Event `$.items[].conferenceData.conferenceSolution.key`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.conferenceSolution.key.type` | string | No | Yes (no schema requirement) | No | The conference solution type. |

#### Event `$.items[].conferenceData.createRequest`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.createRequest.requestId` | string | No | Yes (no schema requirement) | No | The client-generated unique ID for this request. |
| `$.items[].conferenceData.createRequest.status` | object (`ConferenceRequestStatus`) | No | Yes (no schema requirement) | No | The status of the conference create request. |
| `$.items[].conferenceData.createRequest.conferenceSolutionKey` | object (`ConferenceSolutionKey`) | No | Yes (no schema requirement) | No | The conference solution, such as Hangouts or Google Meet. |

#### Event `$.items[].conferenceData.createRequest.status`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.createRequest.status.statusCode` | string | No | Yes (documented) | No | The current status of the conference create request. |

#### Event `$.items[].conferenceData.createRequest.conferenceSolutionKey`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.createRequest.conferenceSolutionKey.type` | string | No | Yes (no schema requirement) | No | The conference solution type. |

#### Event `$.items[].conferenceData.parameters`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.parameters.addOnParameters` | object (`ConferenceParametersAddOnParameters`) | No | Yes (no schema requirement) | No | Additional add-on specific data. |

#### Event `$.items[].conferenceData.parameters.addOnParameters`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].conferenceData.parameters.addOnParameters.parameters` | object, map of string | No | Yes (no schema requirement) | No | (No description in the schema.) |
| `$.items[].conferenceData.parameters.addOnParameters.parameters.<name>` | string | No | Yes (map entry) | No | (No description in the schema.) |

#### Event `$.items[].workingLocationProperties`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].workingLocationProperties.officeLocation` | object | No | Yes (documented) | No | If present, specifies that the user is working from an office. |
| `$.items[].workingLocationProperties.type` | string | No | Yes (no schema requirement) | No | Type of the working location. |
| `$.items[].workingLocationProperties.homeOffice` | any | No | Yes (documented) | No | If present, specifies that the user is working at home. |
| `$.items[].workingLocationProperties.customLocation` | object | No | Yes (documented) | No | If present, specifies that the user is working from a custom location. |

#### Event `$.items[].workingLocationProperties.officeLocation`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].workingLocationProperties.officeLocation.deskId` | string | No | Yes (documented) | No | An optional desk identifier. |
| `$.items[].workingLocationProperties.officeLocation.floorId` | string | No | Yes (documented) | No | An optional floor identifier. |
| `$.items[].workingLocationProperties.officeLocation.floorSectionId` | string | No | Yes (documented) | No | An optional floor section identifier. |
| `$.items[].workingLocationProperties.officeLocation.label` | string | No | Yes (no schema requirement) | No | The office name that's displayed in Calendar Web and Mobile clients. |
| `$.items[].workingLocationProperties.officeLocation.buildingId` | string | No | Yes (documented) | No | An optional building identifier. |

#### Event `$.items[].workingLocationProperties.customLocation`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].workingLocationProperties.customLocation.label` | string | No | Yes (documented) | No | An optional extra label for additional information. |

#### Event `$.items[].attendees[]`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].attendees[].displayName` | string | No | Yes (documented) | No | The attendee's name, if available. |
| `$.items[].attendees[].organizer` | boolean | No | Yes (documented) | No | Whether the attendee is the organizer of the event. |
| `$.items[].attendees[].additionalGuests` | integer (int32) | No | Yes (documented) | No | Number of additional guests. |
| `$.items[].attendees[].email` | string | No | Yes (documented) | No | The attendee's email address, if available. |
| `$.items[].attendees[].resource` | boolean | No | Yes (documented) | No | Whether the attendee is a resource. |
| `$.items[].attendees[].id` | string | No | Yes (documented) | No | The attendee's Profile ID, if available. |
| `$.items[].attendees[].responseStatus` | string | No | Yes (no schema requirement) | No | The attendee's response status. |
| `$.items[].attendees[].comment` | string | No | Yes (documented) | No | The attendee's response comment. |
| `$.items[].attendees[].optional` | boolean | No | Yes (documented) | No | Whether this is an optional attendee. |
| `$.items[].attendees[].self` | boolean | No | Yes (documented) | No | Whether this entry represents the calendar on which this copy of the event appears. |
| `$.items[].attendees[].asyncOperation` | string | No | Yes (documented) | No | If present, indicates the status of an asynchronous operation ongoing for this attendee (e.g. |

#### Event `$.items[].birthdayProperties`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].birthdayProperties.contact` | string | No | Yes (documented) | No | Resource name of the contact this birthday event is linked to. |
| `$.items[].birthdayProperties.customTypeName` | string | No | Yes (documented) | No | Custom type label specified for this event. |
| `$.items[].birthdayProperties.type` | string | No | Yes (documented) | No | Type of birthday or special event. |

#### Event `$.items[].originalStartTime`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].originalStartTime.date` | string (date) | No | Yes (no schema requirement) | No | The date, in the format "yyyy-mm-dd", if this is an all-day event. |
| `$.items[].originalStartTime.dateTime` | string (date-time) | No | Yes (no schema requirement) | No | The time, as a combined date-time value (formatted according to RFC3339). |
| `$.items[].originalStartTime.timeZone` | string | No | Yes (documented) | No | The time zone in which the time is specified. |

#### Event `$.items[].extendedProperties`

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `$.items[].extendedProperties.private` | object, map of string | No | Yes (no schema requirement) | No | Properties that are private to the copy of the event that appears on this calendar. |
| `$.items[].extendedProperties.private.<name>` | string | No | Yes (map entry) | No | The name of the private property and the corresponding value. |
| `$.items[].extendedProperties.shared` | object, map of string | No | Yes (no schema requirement) | No | Properties that are shared between copies of the event on other attendees' calendars. |
| `$.items[].extendedProperties.shared.<name>` | string | No | Yes (map entry) | No | The name of the shared property and the corresponding value. |

A cancelled item may carry fewer fields than a confirmed one (how few is not stated in the Discovery document); both runners need only `id` and treat absent text fields as `""`.

### POST /calendar/v3/calendars/{calendarId}/events

`200`, the created Event resource (the same fields as `$.items[]` above, at `$`). Only the status is read: `200` → inserted, `409` → id already taken (retried once as `PATCH`); the body is not parsed.

### PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}

`200`, the whole updated Event resource (fields as `$.items[]` above, at `$`), fields we did not send included. Only the status is read.

### DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}

`204 No Content` with an empty body (the Discovery method has no response). `200` and `204` count as deleted; `404` and `410` count as already gone. The body is not read.

## 4. Error Handling

### HTTP status codes

Each request's answer is decided in this order (both runners: `send` and `mapStatus` in `packages/adapters/src/google/googleCalendarClient.ts`, `CalendarClient::send` and `map_status` in `crates/research-google/src/calendar.rs`):

1. **Expired access token**: checked after each attempt is admitted by the pacer (the first one and every rate-limit retry), so a wait cannot hand Google a lapsed token: when the token's `expires_in` (from the last token response, minus a 60 s margin) has run out, the token is refreshed before the attempt is sent. A failed refresh ends with the refresh's own code ([Google OAuth 2.0 §4](google-oauth.md#4-error-handling)).
2. **No answer** (DNS, non-public address, TLS, network, 30 s timeout, body over 1 MB) → `GOOGLE_REQUEST_FAILED` without `upstreamStatus`; `ABORTED` when the job's stop signal fired.
3. **401** → the access token is refreshed and the same request is sent once more, admitted by the pacer again; once per call, and independent of step 1 (a token just refreshed on expiry can still be rejected, and still gets this fallback). A failed refresh ends with the refresh's own code; the retry's answer, a second 401 included, continues at step 4.
4. **Rate limit**: `429`, or `403` with a reason in {`rateLimitExceeded`, `userRateLimitExceeded`, `RESOURCE_EXHAUSTED`} → the request is sent again after a wait, each attempt admitted by the pacer: retry n (0-based) waits 2^n s plus a random 0–999 ms, or the `Retry-After` (delay-seconds or an HTTP date) when that is longer. At most 4 retries per request; no retry when `Retry-After` exceeds 30 s or the wait would exceed what is left of the job's 60 s waiting budget (one budget for all calls of a job). `403 quotaExceeded` is deliberately not retried: it is the Calendar usage limit ([Calendar usage limits](https://support.google.com/a/answer/2905486)), which Google lifts after hours, so a wait of seconds within the 60 s budget cannot succeed and would only spend more requests against the exceeded limit; it ends the sync as `GOOGLE_RATE_LIMITED` at once, retryable by the owner later. The last answer continues at step 5.
5. **Operation-specific statuses**, checked before any mapping: the success status of each method, and the statuses each method treats as an outcome rather than an error (table below). Any other status — another 2xx such as 201 included — goes to step 6.
6. **`mapStatus` / `map_status`**, status first, then body: (a) `429` → `GOOGLE_RATE_LIMITED`; (b) `3xx` → `GOOGLE_REQUEST_FAILED`, body ignored; (c) for every other status (400, 401, 403, 404, 5xx, …) a body reason in {`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, `RESOURCE_EXHAUSTED`} → `GOOGLE_RATE_LIMITED`; (d) otherwise a body reason `invalid_grant` → `GOOGLE_AUTH_EXPIRED`; (e) otherwise `GOOGLE_REQUEST_FAILED`. Reasons are collected from `error` (when a string), `error.reason`, `error.status` and every `error.errors[].reason`; a body that is not JSON or not this shape contributes no reason. Google's status is kept as `upstreamStatus` in every case of step 6.

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 200 on `calendars.insert`, `calendars.get`, `events.list`, `events.insert`, `events.patch` | Success | Parses the body (`insert`/`patch` events: status only) | — |
| 200 with an unusable body | `calendars.insert`/`get` without a string `id`; `events.list` not an object, `items` not an array, an item without `id`, a text field of the wrong type | Fails the job; no `upstreamStatus` (Google did not fail) | `GOOGLE_REQUEST_FAILED` |
| 404 on `calendars.get` | The calendar was deleted in Google (or is not one this app created) | Outcome "not found": connect creates a new calendar; sync creates one, stores its id in the token file and plans from an empty listing | — |
| 409 on `events.insert` | Our deterministic id already exists (reason `duplicate`; also when the listing missed it) | Outcome "conflict": retried once as `events.patch`, counted as updated | — |
| 200, 204, 404, 410 on `events.delete` | Deleted (204), or already gone (404 `notFound`, 410 `deleted`) | Counted as deleted | — |
| 401 (`authError`, `required`) | Access token missing, expired or revoked | Step 3: refresh once, retry once; a second 401 is mapped by step 6 (reason `authError` → (e)) | `GOOGLE_REQUEST_FAILED` (status 401 kept), or the refresh's code |
| 429, any body | Rate limit | Step 4 (backoff, at most 4 retries), then step 6 (a); job `retryable: true` | `GOOGLE_RATE_LIMITED` |
| 3xx, any body | Never expected; redirects are never followed | Step 6 (b) | `GOOGLE_REQUEST_FAILED` |
| Any other non-success status whose body carries a rate-limit reason | Typically 403 `rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded` (domain `usageLimits`; Google documents 403 or 429 for rate limits), but the reason is honoured on any status | 403 with `rateLimitExceeded`, `userRateLimitExceeded` or `RESOURCE_EXHAUSTED`: step 4 (backoff); then step 6 (c); job `retryable: true` | `GOOGLE_RATE_LIMITED` |
| Any other non-success status whose body carries `invalid_grant` and no rate-limit reason | Not sent by the Calendar API (an OAuth reason, mapped defensively) | Step 6 (d) | `GOOGLE_AUTH_EXPIRED` |
| Every other non-success status: 400, 403 (`forbiddenForNonOrganizer`, insufficient scope), 404 or 410 outside the cases above, 409 outside `events.insert`, 412, other 4xx, 5xx (`backendError`), other 2xx | Any other failure | Step 6 (e); no retry | `GOOGLE_REQUEST_FAILED` |
| `GOOGLE_CLIENT_REJECTED` from a refresh (step 1 or 3) | The OAuth client is unknown, deleted or its secret is wrong ([Google OAuth 2.0 §4](google-oauth.md#4-error-handling)) | The refresh's code ends the sync | `GOOGLE_CLIENT_REJECTED` |
| `nextPageToken` still present after the tenth page | Google pages by its own rules: a page may hold fewer than the 250 events we ask for (even none) and still carry a continuation token, so this can happen with any number of events | Failure (a partial listing would leave stale events undeleted); no `upstreamStatus` | `GOOGLE_REQUEST_FAILED` |
| no answer | Step 2 | Failure without `upstreamStatus`; a stopped job ends as aborted instead | `GOOGLE_REQUEST_FAILED` |

Google's status travels unchanged as `upstreamStatus` ([error handling §4a](../../rule/error_handling.md)): `GoogleCallFailure.upstreamStatus` / `GoogleCallError::Failed.upstream_status` → the job's `failureUpstreamStatus` → [`google_calendar_links.last_failure_upstream_status`](../../database/tables/google_calendar_links.md). The first failing request ends the sync; requests already applied stay applied, and the next sync plans from what Google then holds.

### Provider error codes and body

Errors are the Google JSON error envelope (live, section 5):

| Field | Type | Read | Description |
|---|---|---|---|
| `$.error.code` | integer | No (type-checked) | HTTP status repeated. |
| `$.error.message` | string | No | Human message; never logged, stored or shown. |
| `$.error.errors[].reason` | string | Yes | Calendar reason (`authError`, `required`, `rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, `notFound`, `duplicate`, `deleted`, `conditionNotMet`, `backendError`, …). |
| `$.error.errors[].message`, `.domain`, `.location`, `.locationType` | string | No | Detail; `domain` is e.g. `global` or `usageLimits`. |
| `$.error.status` | string | Yes | gRPC-style status (`UNAUTHENTICATED`, `RESOURCE_EXHAUSTED`, …). |
| `$.error.details[]` | array | No | e.g. `google.rpc.ErrorInfo` with reason `CREDENTIALS_MISSING`. |
| `$.error.reason` | string | Yes (defensive) | Not sent by Calendar; read if present. |

`mapStatus` / `map_status` collect `error.reason`, `error.status` and every `error.errors[].reason` (or `error` itself when it is a string); a rate-limit reason wins over `invalid_grant`. The rate-limit reasons are the three `usageLimits` reasons of Google's [Calendar errors guide](https://developers.google.com/workspace/calendar/api/guides/errors) (`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`) plus the envelope status `RESOURCE_EXHAUSTED`. Of the response headers only `Retry-After` is read (step 4); `WWW-Authenticate` is not.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | 30 s per request after the single DNS lookup; the job's stop signal (cancel, lease loss, shutdown) aborts earlier | `packages/adapters/src/google/googleHttp.ts`, `crates/research-google/src/http.rs` |
| Transport | Pinned host `www.googleapis.com` only (plus `oauth2.googleapis.com` for tokens): resolved once, public addresses only, TLS verified against the name, peer re-checked, no redirects, body ≤ 1,000,000 bytes | `packages/adapters/src/google/googleHttp.ts`, `crates/research-google/src/http.rs` |
| Connections | Transport (Rust): `research-google` does not use the shared `research-net` fetch transport (`PinnedHttpsConnect` / `PinnedHopTransport` in `crates/research-net/src/pinned.rs` and `crates/research-net/src/transport.rs`), so neither its keep-alive pool, nor its resend of a GET on a fresh connection after a pooled connection closed, nor its up-to-`MAX_CONNECT_ATTEMPTS` (3) resolved addresses apply. `PinnedGoogleHttp` opens one new TLS connection per request with `PinnedTls::connect` to the first validated address only, speaks HTTP/1.1 over hyper's `http1::handshake` (no ALPN), sends `connection: close`, and never resends any request, GET included. TypeScript does the same: `agent: false` (a fresh connection, Node adds `Connection: close`) to `addresses[0]`, no resend. | `crates/research-google/src/http.rs`, `packages/adapters/src/google/googleHttp.ts` |
| Retries | The 401 → refresh → one retry; the 409 → one `PATCH`; rate limits (429, 403 `rateLimitExceeded` / `userRateLimitExceeded` / `RESOURCE_EXHAUSTED`) → up to 4 retries after 2^n s + 0–999 ms jitter or the `Retry-After` when longer. Bound: no single wait over 30 s (a longer `Retry-After` is not waited out) and at most 60 s of waiting per job (`RATE_LIMIT_JOB_BUDGET_MS` in both runners). When the retries or the budget run out, the sync fails as `GOOGLE_RATE_LIMITED`, marked retryable for the owner's next attempt. Nothing else is retried. | `packages/adapters/src/google/googleCalendarClient.ts`, `crates/research-google/src/calendar.rs`, `apps/runner/src/googleCalendar.ts`, `crates/research-google/src/jobs.rs` |
| Rate limit | Sequential requests; every attempt — rate-limit retries, the 401 retry and token refreshes included — admitted by the process-wide pacer, 5 grants per 1,000 ms window (`GOOGLE_RATE_LIMIT`; Rust `("google", 5, 1_000)`); an `events.patch` takes 3 grants (`PATCH_QUOTA_UNITS`, its quota cost), every other request 1; `Retry-After` read on rate-limit answers | `apps/runner/src/marketPacing.ts`, `crates/research-finance/src/pacing.rs`, `apps/runner/src/googleCalendar.ts`, `crates/research-google/src/jobs.rs` |
| Cache | None; every sync lists the calendar afresh. The calendar id is kept in the token file and in `google_calendar_links.calendar_id`. | `packages/adapters/src/google/googleTokenStore.ts`, `crates/research-google/src/token_store.rs` |
| Fallback | None: the Google Calendar card shows the fixed sentence for the code and the status; automatic syncing pauses until a manual sync succeeds. The `.ics` download and subscription link keep working without Google. | `packages/contracts/src/googleCalendar.ts`, `packages/application/src/googleCalendar.ts` |

## 5. Examples

Placeholders: `Bearer <redacted>` (the in-memory access token). Calendar id `c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e@group.calendar.google.com`, etags and times are illustrative values in Google's formats; the event id, summary, description, dates and private properties are what `googleEventBody` produces for `us:AAPL`, period `2026-q4`, announced 2026-10-29 after the close, source Finnhub.

### POST /calendar/v3/calendars

Request:

```http
POST /calendar/v3/calendars HTTP/1.1
host: www.googleapis.com
user-agent: stock-investigation-runner/0.1
authorization: Bearer <redacted>
content-type: application/json; charset=utf-8
content-length: 181
Connection: close

{"summary":"Earnings calendar (Research workspace)","description":"Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.","timeZone":"UTC"}
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`calendars.insert`, request `Calendar`); body as `createCalendar` / `create_calendar` build it; a `curl` of this request with an invalid token answered 401 (Error responses). Access token redacted.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
```

<!-- example: google-calendar-calendar -->
```json
{
  "kind": "calendar#calendar",
  "etag": "\"Tz8wM1iMTg-a0Q0nW0q0Ysq9UfM\"",
  "id": "c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e@group.calendar.google.com",
  "summary": "Earnings calendar (Research workspace)",
  "description": "Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.",
  "timeZone": "UTC",
  "dataOwner": "<redacted>",
  "conferenceProperties": {
    "allowedConferenceSolutionTypes": [
      "hangoutsMeet"
    ]
  }
}
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (schema `Calendar`, field by field; values illustrative). `dataOwner` (the owner's email) redacted. Not observed live: needs the owner's grant.

### GET /calendar/v3/calendars/{calendarId}

Request:

```http
GET /calendar/v3/calendars/c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e%40group.calendar.google.com HTTP/1.1
host: www.googleapis.com
user-agent: stock-investigation-runner/0.1
authorization: Bearer <redacted>
Connection: close
```

Verified: live, 2026-10-31, `curl --http1.1` of `GET /calendar/v3/calendars/primary` without and with an invalid token (401, Error responses); path encoding as `getCalendar` builds it. Access token redacted.

Response: `200` with the same Calendar resource as the `POST /calendar/v3/calendars` response above.

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
```

<!-- example: google-calendar-calendar-get -->
```json
{
  "kind": "calendar#calendar",
  "etag": "\"Tz8wM1iMTg-a0Q0nW0q0Ysq9UfM\"",
  "id": "c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e@group.calendar.google.com",
  "summary": "Earnings calendar (Research workspace)",
  "description": "Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.",
  "timeZone": "UTC",
  "dataOwner": "<redacted>",
  "conferenceProperties": {
    "allowedConferenceSolutionTypes": [
      "hangoutsMeet"
    ]
  }
}
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`calendars.get`, response `Calendar`; values illustrative). `dataOwner` redacted. Not observed live: needs the owner's grant.

### GET /calendar/v3/calendars/{calendarId}/events

Request (first page; later pages append `&pageToken=<nextPageToken>`):

```http
GET /calendar/v3/calendars/c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e%40group.calendar.google.com/events?privateExtendedProperty=researchWorkspace%3Dearnings&showDeleted=true&maxResults=250 HTTP/1.1
host: www.googleapis.com
user-agent: stock-investigation-runner/0.1
authorization: Bearer <redacted>
Connection: close
```

Verified: live, 2026-10-31, `curl --http1.1` of this query on calendar `primary` with an invalid token (Google parsed it and answered 401, Error responses); parameters checked against https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`events.list`). Access token redacted.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
```

<!-- example: google-calendar-events-list -->
```json
{
  "kind": "calendar#events",
  "etag": "\"p32vfrdhkqmo8o0o\"",
  "summary": "Earnings calendar (Research workspace)",
  "description": "Earnings announcements of the owner's watchlist, kept in step by the research workspace runner.",
  "updated": "2026-10-31T05:00:01.000Z",
  "timeZone": "UTC",
  "accessRole": "owner",
  "defaultReminders": [],
  "nextSyncToken": "CPDAlvWDx-ICEPDAlvWDx-ICGAU=",
  "items": [
    {
      "kind": "calendar#event",
      "etag": "\"3523456789012000\"",
      "id": "8ap2ge38foujtt6v1ld5e009rtdq788g",
      "status": "confirmed",
      "htmlLink": "<redacted>",
      "created": "2026-10-31T05:00:00.000Z",
      "updated": "2026-10-31T05:00:00.506Z",
      "summary": "AAPL Apple Inc. earnings (Q4 2026)",
      "description": "Scheduled earnings announcement for AAPL (Q4 2026).\nThe date can change; check the source before acting on it.\nExpected timing: after market close.\nSource: Finnhub.",
      "creator": {
        "email": "<redacted>"
      },
      "organizer": {
        "email": "c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e@group.calendar.google.com",
        "displayName": "Earnings calendar (Research workspace)",
        "self": true
      },
      "start": {
        "date": "2026-10-29"
      },
      "end": {
        "date": "2026-10-30"
      },
      "transparency": "transparent",
      "iCalUID": "8ap2ge38foujtt6v1ld5e009rtdq788g@google.com",
      "sequence": 0,
      "extendedProperties": {
        "private": {
          "researchWorkspace": "earnings",
          "stockId": "us:AAPL",
          "periodKey": "2026-q4"
        }
      },
      "reminders": {
        "useDefault": true
      },
      "source": {
        "url": "https://finnhub.io/",
        "title": "Finnhub"
      },
      "eventType": "default"
    }
  ]
}
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (schemas `Events`, `Event`, `EventDateTime`, field by field; values illustrative except the event body fields, which `googleEventBody` produced). 1 item kept; `htmlLink` and `creator.email` (personal data) redacted. Not observed live: needs the owner's grant.

### POST /calendar/v3/calendars/{calendarId}/events

Request (`PATCH …/events/{eventId}` sends the same fields without `id`, below):

```http
POST /calendar/v3/calendars/c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e%40group.calendar.google.com/events HTTP/1.1
host: www.googleapis.com
user-agent: stock-investigation-runner/0.1
authorization: Bearer <redacted>
content-type: application/json; charset=utf-8
content-length: 545
Connection: close

{"id":"8ap2ge38foujtt6v1ld5e009rtdq788g","status":"confirmed","summary":"AAPL Apple Inc. earnings (Q4 2026)","description":"Scheduled earnings announcement for AAPL (Q4 2026).\nThe date can change; check the source before acting on it.\nExpected timing: after market close.\nSource: Finnhub.","start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},"transparency":"transparent","extendedProperties":{"private":{"researchWorkspace":"earnings","stockId":"us:AAPL","periodKey":"2026-q4"}},"source":{"title":"Finnhub","url":"https://finnhub.io/"}}
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`events.insert`, request `Event`; id rules from `Event.id`; `transparency` from `Event.transparency`); body as `eventResource` / `event_resource` serialise it. Access token redacted.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
```

<!-- example: google-calendar-event-insert -->
```json
{
  "kind": "calendar#event",
  "etag": "\"3523456789012000\"",
  "id": "8ap2ge38foujtt6v1ld5e009rtdq788g",
  "status": "confirmed",
  "htmlLink": "<redacted>",
  "created": "2026-10-31T05:00:00.000Z",
  "updated": "2026-10-31T05:00:00.506Z",
  "summary": "AAPL Apple Inc. earnings (Q4 2026)",
  "description": "Scheduled earnings announcement for AAPL (Q4 2026).\nThe date can change; check the source before acting on it.\nExpected timing: after market close.\nSource: Finnhub.",
  "creator": {
    "email": "<redacted>"
  },
  "organizer": {
    "email": "c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e@group.calendar.google.com",
    "displayName": "Earnings calendar (Research workspace)",
    "self": true
  },
  "start": {
    "date": "2026-10-29"
  },
  "end": {
    "date": "2026-10-30"
  },
  "transparency": "transparent",
  "iCalUID": "8ap2ge38foujtt6v1ld5e009rtdq788g@google.com",
  "sequence": 0,
  "extendedProperties": {
    "private": {
      "researchWorkspace": "earnings",
      "stockId": "us:AAPL",
      "periodKey": "2026-q4"
    }
  },
  "reminders": {
    "useDefault": true
  },
  "source": {
    "url": "https://finnhub.io/",
    "title": "Finnhub"
  },
  "eventType": "default"
}
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`events.insert`, response `Event`; values illustrative). `htmlLink` and `creator.email` redacted. Not observed live: needs the owner's grant.

### PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}

Request (the insert body above without `id`):

```http
PATCH /calendar/v3/calendars/c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e%40group.calendar.google.com/events/8ap2ge38foujtt6v1ld5e009rtdq788g HTTP/1.1
host: www.googleapis.com
user-agent: stock-investigation-runner/0.1
authorization: Bearer <redacted>
content-type: application/json; charset=utf-8
content-length: 505
Connection: close

{"status":"confirmed","summary":"AAPL Apple Inc. earnings (Q4 2026)","description":"Scheduled earnings announcement for AAPL (Q4 2026).\nThe date can change; check the source before acting on it.\nExpected timing: after market close.\nSource: Finnhub.","start":{"date":"2026-10-29"},"end":{"date":"2026-10-30"},"transparency":"transparent","extendedProperties":{"private":{"researchWorkspace":"earnings","stockId":"us:AAPL","periodKey":"2026-q4"}},"source":{"title":"Finnhub","url":"https://finnhub.io/"}}
```

Verified: spec, 2026-10-31, https://developers.google.com/workspace/calendar/api/v3/reference/events/patch (`PATCH https://www.googleapis.com/calendar/v3/calendars/calendarId/events/eventId`, patch semantics, request `Event`); body as `eventPatch` / `event_patch` serialise it. Access token redacted.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
```

<!-- example: google-calendar-event-update -->
```json
{
  "kind": "calendar#event",
  "etag": "\"3523457001024000\"",
  "id": "8ap2ge38foujtt6v1ld5e009rtdq788g",
  "status": "confirmed",
  "htmlLink": "<redacted>",
  "created": "2026-10-31T05:00:00.000Z",
  "updated": "2026-10-31T06:46:40.512Z",
  "summary": "AAPL Apple Inc. earnings (Q4 2026)",
  "description": "Scheduled earnings announcement for AAPL (Q4 2026).\nThe date can change; check the source before acting on it.\nExpected timing: after market close.\nSource: Finnhub.",
  "creator": {
    "email": "<redacted>"
  },
  "organizer": {
    "email": "c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e@group.calendar.google.com",
    "displayName": "Earnings calendar (Research workspace)",
    "self": true
  },
  "start": {
    "date": "2026-10-29"
  },
  "end": {
    "date": "2026-10-30"
  },
  "transparency": "transparent",
  "iCalUID": "8ap2ge38foujtt6v1ld5e009rtdq788g@google.com",
  "sequence": 1,
  "extendedProperties": {
    "private": {
      "researchWorkspace": "earnings",
      "stockId": "us:AAPL",
      "periodKey": "2026-q4"
    }
  },
  "reminders": {
    "useDefault": true
  },
  "source": {
    "url": "https://finnhub.io/",
    "title": "Finnhub"
  },
  "eventType": "default"
}
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`events.patch`, response `Event`; values illustrative). `htmlLink` and `creator.email` redacted. Not observed live: needs the owner's grant.

### DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}

Request:

```http
DELETE /calendar/v3/calendars/c_4bd5625a2d1d587fcc4749eb13d051859a47065e3e52ebb3fdd0bd417d75632e%40group.calendar.google.com/events/8ap2ge38foujtt6v1ld5e009rtdq788g HTTP/1.1
host: www.googleapis.com
user-agent: stock-investigation-runner/0.1
authorization: Bearer <redacted>
Connection: close
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`events.delete`, no request body). Access token redacted.

Response:

```http
HTTP/1.1 204 No Content
```

Verified: spec, 2026-10-31, https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest (`events.delete` declares no response body). Not observed live: needs the owner's grant.

### Error responses

No access token:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="https://accounts.google.com/"
Content-Type: application/json; charset=UTF-8
```

<!-- example: google-calendar-error-missing-credentials -->
```json
{
  "error": {
    "code": 401,
    "message": "Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
    "errors": [
      {
        "message": "Login Required.",
        "domain": "global",
        "reason": "required",
        "location": "Authorization",
        "locationType": "header"
      }
    ],
    "status": "UNAUTHENTICATED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "CREDENTIALS_MISSING",
        "domain": "googleapis.com",
        "metadata": {
          "method": "calendar.v3.Calendars.Get",
          "service": "calendar-json.googleapis.com"
        }
      }
    ]
  }
}
```

Verified: live, 2026-10-31, `curl --http1.1 https://www.googleapis.com/calendar/v3/calendars/primary` without `Authorization`. Other response headers omitted.

Invalid or expired access token (what triggers the refresh-and-retry):

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="https://accounts.google.com/", error="invalid_token"
Content-Type: application/json; charset=UTF-8
```

<!-- example: google-calendar-error-invalid-token -->
```json
{
  "error": {
    "code": 401,
    "message": "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
    "errors": [
      {
        "message": "Invalid Credentials",
        "domain": "global",
        "reason": "authError",
        "location": "Authorization",
        "locationType": "header"
      }
    ],
    "status": "UNAUTHENTICATED"
  }
}
```

Verified: live, 2026-10-31, `curl --http1.1` of the `events.list` request above on calendar `primary` with `Authorization: Bearer invalid-access-token`; `POST /calendar/v3/calendars` with the same token answered the same 401. Other response headers omitted.

## 6. Data Mapping

Outbound: the claimed `GoogleEventBody` (`googleEventBodySchema` in `packages/contracts/src/googleCalendar.ts`; Rust `GoogleEventBody` in `crates/research-domain/src/calendar/google_sync.rs`), assembled by `assembleDesiredEvents` from dated events of watchlist stocks with a retrieved stamp.

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `id` (sent) | base32hex (`0-9a-v`) of the first 20 bytes of SHA-256(`stockId + "\n" + periodKey`), 32 characters | `GoogleEventBody.id` | Not stored (recomputed) — from [`earnings_events.stock_id`, `period_key`](../../database/tables/earnings_events.md) |
| `summary` (sent) | `<symbol> <name or symbol> earnings (<fiscalPeriodLabel>)` (`earningsCalendarTexts`) | `GoogleEventBody.summary` | From [`watchlist_stocks.symbol`, `name`](../../database/tables/watchlist_stocks.md), [`earnings_events.fiscal_period_label`](../../database/tables/earnings_events.md) |
| `description` (sent) | Fixed lines; "Expected timing: …" unless `timing` is `unknown`; "Source: <publisher>." without the retrieval date | `GoogleEventBody.description` | From [`earnings_events.timing`](../../database/tables/earnings_events.md), [`earnings_sources.publisher`](../../database/tables/earnings_sources.md) |
| `start.date` (sent) | Announcement date as is | `GoogleEventBody.startDate` | [`earnings_events.announcement_date`](../../database/tables/earnings_events.md) (rows with NULL are skipped) |
| `end.date` (sent) | Announcement date + 1 civil day (exclusive end) | `GoogleEventBody.endDate` | Derived |
| `transparency` (sent) | Constant `transparent` (free, as the `.ics` `TRANSP:TRANSPARENT`) | — (constant in `managedFields` / `managed_fields`) | Not stored |
| `extendedProperties.private.*` (sent) | `researchWorkspace` = `earnings`; `stockId`, `periodKey` copied | `GoogleEventBody.privateProperties` | [`earnings_events.stock_id`, `period_key`](../../database/tables/earnings_events.md) |
| `source.title`, `source.url` (sent) | Copied | `GoogleEventBody.sourceTitle`, `sourceUrl` | [`earnings_sources.publisher`, `source_url`](../../database/tables/earnings_sources.md) |

Inbound:

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `calendars.insert` / `calendars.get` `$.id` | Non-empty string | `calendarId` of `googleCalendarConnectedSchema` / `googleCalendarSyncedSchema` (`packages/contracts/src/googleCalendar.ts`) | [`google_calendar_links.calendar_id`](../../database/tables/google_calendar_links.md); also the runner token file field `calendarId` |
| `$.items[].id` | as is | `ManagedCalendarEvent.id` / `ManagedGoogleEvent.id` | Not stored |
| `$.items[].status` | `cancelled` → `cancelled`, else `confirmed` | `ManagedCalendarEvent.status` | Not stored |
| `$.items[].start.date` / `.dateTime`, `$.items[].end.date` / `.dateTime` | `date`, else first 10 characters of `dateTime`, else `""` | `startDate`, `endDate` | Not stored |
| `$.items[].summary`, `$.items[].description` | absent → `""` | `summary`, `description` | Not stored |
| `$.items[].transparency` | `transparent` → `transparent`, else (absent included) `opaque` | `ManagedCalendarEvent.transparency` / `ManagedGoogleEvent.transparency` (`GoogleEventTransparency`, `packages/domain/src/calendar/googleSync.ts`, `crates/research-domain/src/calendar/google_sync.rs`) | Not stored |
| (plan result) | `planGoogleSync` / `plan_google_sync` (Lean model `formal/ResearchFormal/GoogleSync.lean`): unknown id → insert; known and cancelled, `opaque`, or differing in start, end, summary or description → update; confirmed and not desired → delete; else unchanged | `inserted`, `updated`, `deleted`, `unchanged` of the synced completion | [`google_calendar_links.last_inserted`, `last_updated`, `last_deleted`, `last_unchanged`, `last_synced_at`](../../database/tables/google_calendar_links.md) |
| (desired set) | SHA-256 of `canonicalGoogleSyncDigestInput` (which includes the written `transparency`, so the digest of every calendar synced before it changed once and the next automatic sync corrects busy events) | `desiredDigest` | [`google_calendar_links.synced_digest`](../../database/tables/google_calendar_links.md) (`inSync` compares it with the current digest) |
| error status / reasons | `mapStatus` / `map_status`; status unchanged | `GoogleCallFailure` → job failure | [`google_calendar_links.last_failure_code`, `last_failure_upstream_status`, `last_failure_at`](../../database/tables/google_calendar_links.md) |

## 7. Maintenance

### Known differences between the runners

Header names on the wire: the TypeScript runner sends the names in lowercase as the code gives them (`host`, `user-agent`, `authorization`, `content-type`, `content-length`), and Node appends `Connection: close`; the Rust runner (hyper) sends all names in lowercase in the order `host`, `user-agent`, the caller's headers, `connection: close`, `content-length`. The examples show the TypeScript order; header names are case-insensitive, so Google sees the same request. Both runners open one fresh connection per request to the first resolved address and never resend a request; the Rust runner does not use the shared `research-net` transport's GET resend or its three-address fallback (section 4, Connections). Otherwise no differences in requests, bodies, query order, status handling or field checks: `crates/research-google/src/calendar.rs` ports `packages/adapters/src/google/googleCalendarClient.ts` (same key order in the event body, the same `encodeURIComponent` path encoding, the same listing bound of 10 requests with `maxResults=250`, the same defensive error-reason mapping). The Rust runner sends `Connection: close` explicitly; the Node port gets the same header from `agent: false`. Backoff jitter comes from `Math.random` (TypeScript) and the OS generator (`os_jitter`, Rust); the schedule, caps and budget are the same and pinned by `vectors/google/calendar.json` with scripted jitter.

### Open issues

- Every success example is `spec` (constructed field by field from the Discovery document): observing them live needs the owner's grant, which this verification did not use. The exact field set Google returns for a created calendar, a created event and a cancelled event in a `showDeleted` listing is therefore not confirmed; both parsers read only `id` (and for list items the four compared texts and dates and `transparency`), so extra or missing unread fields do not matter.
- `events.patch` costs three quota units per call (an `events.update` costs one), and the pacer counts them, so the one-time correction of up to `GOOGLE_SYNC_MAX_EVENTS` (400) events written before `transparency` was sent takes about 400 × 3 / 5 = 240 s of pacing in that sync. It stays under the 600-per-minute per-user quota; Google's unpublished per-calendar write limits are not known and are left to the backoff.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | live | 401 bodies without a token (`calendars.get` on `primary`) and with an invalid token (`events.list` with our query, `calendars.insert` with our body); no owner token or account used | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | All six methods' parameters, request and response schemas against the Discovery document revision `20261028`; error reasons against the errors guide; quotas against the quota guide; both runners' code read | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | After review: error-mapping precedence, operation-specific statuses and connection behaviour re-read in both runners (`research-google` uses its own one-shot connection, not the `research-net` pooled transport) | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | After review: nested Calendar, Events and Event objects expanded one level from the Discovery document; listing bound described as a continuation token after ten requests | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | After review: every nested object of Calendar, Events and Event expanded recursively to leaf fields from the Discovery document revision `20261028` (generated by a script kept with the captures) | Claude (external API documentation, ADR-0047) |
| 2026-10-31 | spec | Code fixes: rate-limit backoff (Calendar errors guide: `usageLimits` reasons, 403/429, exponential backoff), `transparency: transparent` in event bodies, updates as `PATCH` of the managed fields ([events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch): patch semantics, three quota units), the 401 retry and refreshes paced, refresh on `expires_in`. Examples changed: the `events.insert` request (adds `transparency`, `Content-Length` 545), the update request is now `PATCH` without `id` (`Content-Length` 505), and the listing, insert and update responses show `transparency` (Discovery `Event.transparency`; still `spec`) | Claude (external API code fixes) |
| 2026-10-31 | spec | The transparency comparison moved into `planGoogleSync` / `plan_google_sync` (Lean model with a `busy` row flag, 1,364 conformance vectors), the digest input carries `transparency`, and the pacer counts an `events.patch` as its three quota units; no example changed | Claude (external API code fixes) |
| 2026-10-31 | spec | After review: the 401 fallback is no longer spent by an expiry refresh, and expiry is checked before every paced or backoff attempt; the reason `quotaExceeded` is not retried is stated; no example changed | Claude (external API code fixes) |
