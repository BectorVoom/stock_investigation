# Pages

The SPA is split into four pages by user action (MECE): every action lives on
exactly one page, and every primary journey step has a page. A "chat" and a
"workspace" are the same stored thing (one conversation with its research
results and notebook); the UI
says "chat" for a conversation everywhere.

Routes: `#/home` (default), `#/chat` and `#/chat/<workspaceId>`, `#/sources`,
`#/settings`, `#/watchlist` and `#/watchlist/calendar[/YYYY-MM-DD]`. The old `#/canvas`, `#/canvas/<workspaceId>`,
`#/workspace/<workspaceId>` and `#/workspace` hashes open the Chat page for
that conversation so old bookmarks keep working. `#/settings/agent`
scrolls the AI agent section into view and moves focus to its Default backend
select, so a notice in Chat can link straight to the control that fixes it.
`#/watchlist/calendar` (or with a `YYYY-MM-DD` day) opens the Watchlist page,
scrolls to and focuses its Calendar section, and selects that day (an invalid
or missing date is the default month). An empty or unknown hash opens Home.

Page layout (frame, panels, headings, shared parts) follows
[docs/DESIGN_GUIDELINE.md](DESIGN_GUIDELINE.md).

## Home — `#/home`

**Purpose**

Check market prices, charts and economic indicators at a glance on widgets you arrange.

**User actions**

- Add a widget.
- Edit a widget (title, series, range, size).
- Move a widget earlier/later.
- Drag a widget to a new position (the header strip is the handle; Move
  earlier/later in the menu is the keyboard and assistive-technology path,
  announced with the position; the page auto-scrolls while the pointer rests
  near the top or bottom edge of the viewport; the grid, the frame, the
  pointer engine and the announcer live in `@research/widget-grid`).
- Remove a widget.
- Reset to the default arrangement.
- Queue a market-data refresh for the local runner.
- (Elsewhere) Have an AI agent arrange the widgets through the MCP server
  (`docs/OPERATIONS.md`); edits made elsewhere — another tab, an agent —
  appear on this page when its tab becomes visible again.

Every action is an icon-only button (accessible name and tooltip carry the
former label); the per-widget actions open a text menu with leading icons.

**Shows**

- The arranged widgets (metric, line-chart, stock-table, indicator-table):
  latest values with unit, as-of date, change and source link, or
  "unavailable (reason)" when a series has no usable data. Widgets come in
  three fixed sizes on equal grid cells with a fixed row height — Small
  1 × 1 (17rem, 272 px), Medium 2 × 2 (35rem, 560 px), Large full width × 2
  (35rem, 560 px) — as white cards with a faint
  hairline on the grey page; a body taller than its frame scrolls inside
  the frame. Every widget header is a drag handle (grip, title, actions);
  a completed move is announced with its new position.
- The earnings-calendar widget, when arranged — glanceable, after the Apple
  widget guidelines (see `DESIGN_GUIDELINE.md`): a compact month grid
  (icon buttons for the previous and next month, today marked) whose
  announcement days deep-link to the Watchlist calendar
  (`#/watchlist/calendar/YYYY-MM-DD`), a "Next" list of at most 3 upcoming
  announcements, one status line (earnings fetch status plus the Google
  Calendar status), a "Refresh earnings dates" icon button and an "Open
  calendar" link; "Earnings dates have not been fetched yet." when a stock was
  never looked up ("No announcement in the next N days." only when every stock
  was refreshed), and one sentence for the stocks with no upcoming date. The
  full calendar — grid details, per-date links, the `.ics` download, the
  subscription feed and the Google Calendar card — lives on the Watchlist
  page, never in the widget.
- The market-data refresh status: last successful refresh time, the active
  run id and state while refreshing ("pending" polls slowly until the local
  runner claims it), or the last failure with its stable code beside the last
  success; a note that the refresh waits for the local runner when it is
  queued but nothing executes it.
- The FRED attribution line whenever a FRED series is shown.

**Not here**

- Asking questions, reading answers, run progress or evidence records — see Chat
  (`#/chat`). No question form, no run controls and no message list live here.
- Research tables, charts or reports — see Chat (`#/chat`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Watchlist — `#/watchlist`

**Purpose**

Register the stocks you follow and keep their earnings announcement dates in your calendar.

**User actions**

- Add a stock (a US listing or a Japanese listing). The add queues an
  earnings-date refresh itself, so the dates arrive without a further click;
  when a refresh is already running, one follow-up is queued when it ends with
  a stock still never refreshed.
- Remove a stock, with confirmation.
- Queue an earnings-date refresh for the local runner (manual button; opening
  the page with dates never fetched or more than a day old queues one refresh,
  once per visit).
- Open the month calendar on any day (`#/watchlist/calendar/YYYY-MM-DD`) and
  select a day for its announcements with their calendar links.
- Connect, sync (manually, or automatically once after connecting and whenever
  the dates drift — automatic syncing pauses after a failed step until a
  manual sync succeeds) and disconnect Google Calendar; cancel a sign-in that
  is waiting or still being prepared. One Google step runs at a time.
- Download the earnings calendar file (.ics).
- Add one announcement date to Google Calendar or Outlook.
- Create, replace or revoke the calendar subscription link.

**Shows**

- The registered stocks: symbol, company name (or "unavailable (not retrieved yet)"),
  market, the next announcement date with fiscal period and timing, further dates in a
  disclosure, "date undecided" stated as text, the retrieved date, the source link, a
  per-row "unavailable (reason)" when there is no date, and a Remove action.
- The earnings-date refresh status: last successful refresh time, the active run id and
  state while refreshing, or the last failure with its stable code beside the last
  success; a note that the refresh waits for the local runner when it is queued but
  nothing executes it. A queued notice ("…are being fetched…", "…was queued") clears
  when the run ends; the status line then tells the outcome.
- The Calendar section: the full month grid (month navigation, today marked,
  announcement days as buttons naming their count and symbols, the selected
  day's announcements with company, fiscal period, timing and calendar links —
  never a link for a past date or an unstamped event) above the Google
  Calendar card (disconnected explanation; preparing, with Cancel and the
  note that it waits for the local runner; the sign-in link with its wait
  note and Cancel; connected with last-sync counts, "syncing" or
  "disconnecting" while a step runs, and a sentence when the calendar is
  behind the dates; needs-reconnect with the reason; the last failure as its
  fixed sentence, with the note that automatic syncing is paused) above the `.ics`
  download and the subscription link block (created
  date, replace and revoke with confirmation; the link is shown once and is a secret).

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or watching runs — see Chat (`#/chat`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).

## Chat — `#/chat`

**Purpose**

Ask research questions and read the answers, with their sources and run progress.

**User actions**

- Start a new chat with the full-width "New chat" pill button (no title is asked; the server
  names it "New chat" and renames it from its first question).
- Open a past chat from the Chats list.
- Rename a chat from its list row ("More actions" menu) or delete it with
  confirmation.
- Collapse or expand the Chats panel and the secondary panel with their
  icon-only side-panel buttons; switch Chat/Notebook tabs on narrow screens.
- Switch the open conversation Chat-first ↔ Notebook-first with "Focus Chat" /
  "Focus Notebook" (remembered per conversation; the tabs below `lg` are the
  same switch).
- Load earlier messages.
- Write and submit a question (agent choices are not made here — they are chosen once in Settings → AI agent),
  or address the composer at the Notebook assistant instead (the default in
  Notebook-first and with widgets selected; the selection travels as removable
  chips, or the whole notebook when nothing is selected).
- Save an answer or a research result into the Notebook ("Add to Notebook");
  saved ones say "In notebook" and offer no second save.
- Ask the notebook assistant about selected widgets, undo its turn, and confirm
  or keep its proposed removals.
- Jump from a widget to where it came from (its chat message).
- Watch a run's progress.
- Cancel, retry or approve a run.
- Copy an answer.
- Open the evidence records of a run.
- Select an item inside a result component (e.g. a table row).

**Shows**

- Two states at `lg` and up: the Chats rail plus Chat and Notebook as plain
  white rounded blocks on the grey page background with no outlines, each
  with a small header holding the title and the focus control. Chat-first is
  Chat ≈ 75–80 % / Notebook ≈ 20–25 % of the space right of the Chats panel
  (`3fr`/`1fr`); Notebook-first is the reverse. Switching changes only the
  grid template: the workspace session, the notebook session, the thread, the
  composer draft, the selection and scroll positions survive, and both panels
  stay mounted in the same DOM order. The secondary panel collapses to a
  narrow rail in both states. Below `lg` the two states keep their meaning as
  a two-tab switcher ("Chat" / "Notebook") whose default tab follows the
  remembered state: no third state, no third layout. One workspace session and
  one notebook session back the open conversation: no duplicated polling, and
  a poll that changes nothing re-renders neither. Chat-first with three or
  more widgets shows one quiet inline suggestion to focus the Notebook
  (dismissable, never automatic).
- The Chats list (newest activity first): one title-only row per chat; the open
  chat is marked with `aria-current="page"`; every row has a "More actions"
  menu (Rename, Delete); the full-width "New chat" pill button sits at the top.
- The open chat's title (renaming lives in each Chats row's "More actions"
  menu, not in this header); a welcome with the same "New chat" action when
  there are no chats.
- The message thread with numbered citation chips and a source popover, newest
  first paging through "Load earlier messages": owner messages as
  right-aligned bubbles, assistant answers as plain text with "Copy answer",
  "Add to Notebook" and "Evidence" actions, each research run as an inline card directly after
  the owner message whose `runId` matches it (a state badge for every state
  except completed and failed, latest progress, `Stop`, a failure reason,
  `Retry`, the approval form; no "Run details" and no "Evidence" button on
  the card — the records drawer opens from the "Evidence" action under an
  answer; a completed run's card is hidden, since its answer follows), and
  unmatched unfinished or failed runs grouped under "Earlier runs".
- Each research result directly after the assistant answer of the run that
  produced it, as a widget-styled preview (the same frame as Notebook widgets,
  fixed height): the rendered component with item selection plus an "Add to
  Notebook" action ("In notebook" once saved); results no visible run owns
  listed after the thread under "Other results".
- A notebook-assistant reply labelled "Notebook assistant" (never citation
  chips, never a verification badge) with its turn card: one line per change
  (added / updated / moved / resized / duplicated with before → after, long
  text behind a disclosure), the failure sentence when nothing applied, an
  Undo while the notebook still sits at the turn's version, and a confirm row
  for every proposed removal (Remove / Keep); a queued or running assistant
  run shows its run card like a research run.
- An empty conversation greets ("What would you like to research?") with starter
  suggestions that fill the question input without sending. At `lg` and up the
  greeting, the question form and the suggestions form one vertically centred
  group; below `lg` the form stays pinned to the viewport bottom.
- The question form (question, horizon, markets and the one-time spend consent,
  with a read-only agent summary and no "Limits and cost" disclosure; a
  Research / Notebook target toggle beside the input — the Notebook target
  hides the research-only fields, shows the selection chips and sends the
  instruction to the notebook assistant) and the
  evidence records drawer for one run, session notices and load errors.
- The Notebook panel: the widgets saved from this conversation and made here,
  with the notebook assistant one instruction away; a collapsed secondary
  panel mounts none of it. The five market widget types (market metric, line
  chart, stock table, indicator table, earnings calendar) name market series
  by id and render live data through the same Home widget components (same
  numbers, units, as-of dates, sources and unavailable states); they are
  added from the Add menu through Home's form (series, range, days ahead),
  edited in the same form, and reloaded only when the named series change —
  a series never refreshed queues one market-data refresh by itself. The
  earnings calendar reads the Watchlist page's stocks with its own refresh
  button. Titles stay in the data but the frames hide them.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Sources — `#/sources`

**Purpose**

Choose which news sources research may read.

**User actions**

- Preview a feed or site URL (site and feed metadata, safety/licensing check).
- Subscribe to a previewed source with a license policy and trust classification.
- Pause, resume or remove a subscribed source.
- Browse the recommended catalog, preview an entry and subscribe to it.
- Queue a news refresh for the local runner.
- Browse recent articles.

**Shows**

- The source preview, subscribed sources, recommended sources and recent articles.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or watching runs — see Chat (`#/chat`).
- Inspecting produced tables and charts — see Chat (`#/chat`).
- Runner credentials or export — see Settings (`#/settings`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Settings — `#/settings`

**Purpose**

Configure how the workspace runs: the AI agent, the runner and data export.

**User actions**

- Choose the default AI backend, its model from a list, effort, per-question limits and web access.
- View the session (owner id, sign-in method).
- Issue a runner credential and copy the one-time token; revoke a credential.
- Export a workspace as JSON or Markdown; import a workspace file and open it.

**Shows**

- The AI agent defaults, session, runner credentials (never tokens except once at issue),
  export/import.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or reading answers — see Chat (`#/chat`).
- Produced tables and charts — see Chat (`#/chat`).
- Subscribing to news — see Sources (`#/sources`).
- Registering stocks or tracking earnings announcement dates — see Watchlist
  (`#/watchlist`).

## Journeys to pages

| Journey (ARCHITECTURE_AND_REQUIREMENTS.md section 2) | Page |
|---|---|
| 1. Configure sources | Sources |
| 2. Ask a research question | Chat |
| 3. Inspect evidence | Chat (evidence records drawer) |
| 4. Map suppliers | Chat (records and report/table components) |
| 5. Inspect positions and investors | Chat (records and financial components) |
| 6. Manipulate research UI | Chat (result previews in the thread: select items; the Notebook holds what the owner keeps) |
| 7. Continue without local compute | Chat (browse chats, queue while offline; browse findings) |
| 8. Check market prices at a glance | Home (arrange widgets, queue a market-data refresh) |
| 9. Track earnings announcement dates | Watchlist (register stocks — each add queues its own earnings-date refresh — browse the month calendar, keep Google Calendar in step, export the calendar) and Home (glanceable earnings-calendar widget with its own refresh button and an "Open calendar" deep link) |

## How the split was checked

Each user action above appears under exactly one page (exclusive), and every
journey step maps to a page (exhaustive). Dialogs such as the records drawer
and the delete-chat confirmation belong to the page that opens them (Chat);
the widget dialog belongs to Home.
Web tests assert the Chat page shape (two states with collapse, a collapsed
secondary panel mounting none of its content, one workspace session and one
notebook session backing the open conversation, Chat/Notebook tabs below `lg`),
that Home has no composer, message list, run status or canvas region,
the old `#/canvas/<workspaceId>`, `#/canvas`, `#/workspace/<workspaceId>`
and `#/workspace` URLs open the Chat page, that the Watchlist page adds a
stock and shows its refresh status, and
`tests/architecture/pagesDoc.test.ts` fails if this document drifts from
`apps/web/src/pages.ts` (titles, routes, purpose sentences).
