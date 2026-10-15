# ADR-0022: Calendar settings move to Settings; the Watchlist page has no calendar

**Status:** Accepted · **Date:** 2026-10-15 · Amends ADR-0016 and ADR-0018
(where the calendar is shown), FR-018 and FR-019.

## Context

The owner asked (2026-10-15): "Move the calendar settings from the Watchlist
page to the Settings page, and remove the calendar from the Watchlist page."

Until now the Watchlist page held three things after its stock table: a full
month calendar (navigation, Today, day selection with a details panel), the
Google Calendar card (connect, sign-in link, sync, disconnect) and the
calendar export (the `.ics` download and the secret-token subscription
link). The Home `earnings-calendar` widget linked each announcement day, and
its "Open calendar" action, to that month calendar
(`#/watchlist/calendar[/YYYY-MM-DD]`), and its "not connected" status linked
to the Watchlist page to connect Google.

## Decision

- **Settings → Calendar.** A "Calendar" section after "AI agent" in
  Settings (`apps/web/src/settings/CalendarSettingsSection.tsx`) holds the
  Google Calendar card (moved unchanged to `settings/GoogleCalendarCard.tsx`),
  the `.ics` download and the subscription link block, with the same
  dialogs and sentences as before. It reads `GET /api/v1/watchlist` (the
  Google and feed state live on the watchlist response) and polls only while
  a run is active. When a run ends it applies the same automatic Google sync
  rule as Home and the Watchlist page (`googleAutoSyncWanted`), so a
  connection made in Settings syncs without visiting another page.
  `#/settings/calendar` scrolls to and focuses its heading.
- **The Watchlist page has no calendar.** The month calendar, the Google
  card and the export are removed from `WatchlistView`. Kept: the stock
  table with each row's per-date "Add to Google Calendar" / "Add to Outlook"
  links (actions on a date, not settings), and the automatic Google sync
  after the page's own adds and removes.
- **The widget is the only month grid.** `EarningsMonthCalendar` loses its
  full variant (selection, details panel, Today, deep-link month) and moves
  next to the widget (`home/widgets/EarningsMonthCalendar.tsx`). Announcement
  days link to `#/watchlist`, where each stock's row carries its dates and
  calendar links (the HIG's "a tap opens the app at the right location");
  "Open calendar" becomes "Open Watchlist"; "Connect it on the Watchlist
  page" becomes "Connect it in Settings" (`#/settings/calendar`).
- **Routes.** `Route.calendarDate` and `watchlistCalendarHash` are removed.
  The legacy `#/watchlist/calendar` and `#/watchlist/calendar/YYYY-MM-DD`
  hashes (old bookmarks, old widget links) parse as `#/settings/calendar`.
- No API, contract schema, migration or runner change. The widget catalog's
  description (`HOME_WIDGET_TYPE_META`, read by the MCP agents) now says
  calendar sync and export are in Settings.

## Consequences

- A day in the widget no longer opens a view of that day; it opens the
  Watchlist table. With many stocks the owner finds the row by symbol.
- The calendar export and Google sync are found under Settings, next to the
  other once-set configuration; the Watchlist page is the stock list.
- Tests: `apps/web/test/calendarSettings.test.tsx` (new, with the shared
  fake server `apps/web/test/watchlistHarness.ts`), `watchlist.test.tsx`,
  `earningsMonthCalendar.test.tsx`, `earningsCalendarWidget.test.tsx`,
  `router.test.ts`, `settings.test.tsx`; E2E `tests/e2e/watchlist.spec.ts`
  runs the download, the feed and the scripted Google connect → automatic
  sync → disconnect from Settings; the real-environment specs
  (`tests/real/watchlistReal.spec.ts`, `watchlistUpgrade.spec.ts`) and the
  UI review (`tests/ui-review/watchlistReview.spec.ts`) follow.
