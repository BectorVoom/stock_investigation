# Pages

The SPA is split into four pages by user action (MECE): every action lives on
exactly one page, and every primary journey step has a page. A "chat" and a
"workspace" are the same stored thing (one conversation with its research
results and notebook); the UI
says "chat" for a conversation everywhere.

Routes: `#/home` (default), `#/chat` and `#/chat/<workspaceId>`, `#/sources`,
`#/settings` and `#/watchlist`. The old `#/canvas`, `#/canvas/<workspaceId>`,
`#/workspace/<workspaceId>` and `#/workspace` hashes open the Chat page for
that conversation so old bookmarks keep working. `#/settings/agent`
scrolls the AI agent section into view and moves focus to its Default backend
select, so a notice in Chat can link straight to the control that fixes it.
`#/settings/calendar` scrolls to and focuses the Calendar section (the Home
widget's "Connect it in Settings" link); the old `#/watchlist/calendar` and
`#/watchlist/calendar/YYYY-MM-DD` links open it too (ADR-0022). An empty or
unknown hash opens Home.

Page layout (frame, panels, headings, shared parts) follows
[docs/DESIGN_GUIDELINE.md](DESIGN_GUIDELINE.md).

## Home — `#/home`

**Purpose**

Check market prices, charts and economic indicators at a glance on widgets you arrange.
The widgets are the Notebook's (ADR-0024): the same types, menu, selection,
clipboard and Undo; like every widget it shows no title (the title stays its
accessible name), and Home takes every type except a research result.

**User actions**

- Add a widget from the + menu: Text, Metric, Chart, Table (added and opened
  in their editor) or a live market type — Market metric, Line chart, Stock
  table, Indicator table, Earnings calendar (its dialog opens first).
- Edit a widget (Edit…: the content editor, or the market dialog for series,
  range, days ahead), edit a Text widget in place, or change its size from the
  menu (Size: Small / Medium / Large).
- Duplicate, Cut, Copy and Paste after (one clipboard with the Notebooks: a
  widget copied on Home pastes into a chat's notebook and back); Paste widgets
  in the toolbar; ⌘X / ⌘C / ⌘V on selected widgets.
- Select widgets (header click, Shift/Ctrl/⌘ to add) and act on the selection
  from its toolbar (Duplicate, Cut, Copy, Remove, Clear).
- Undo the last changes of this visit (up to 20; a reload clears them).
- Move a widget earlier/later.
- Drag a widget to a new position (the grip in the frame's top-right control
  cluster is the handle; Move
  earlier/later in the menu is the keyboard and assistive-technology path,
  announced with the position; the page auto-scrolls while the pointer rests
  near the top or bottom edge of the viewport; the grid, the frame, the
  pointer engine and the announcer live in `@research/widget-grid`).
- Remove a widget (at once, no dialog; Undo restores it).
- Reset to the default arrangement (after confirmation; Undo restores it).
- Queue a market-data refresh for the local runner.
- Open a price widget's detailed chart viewer (ADR-0025): the line-chart plot
  (all its series, opening at the widget's range), a metric's value block
  (its series, 1y) or a stock-table row's name (that row's series, 1y) —
  each an "Open chart" button. The viewer offers range presets plus exact
  From/To dates, interval / scale / values controls, moving averages, the
  main chart with crosshair and readout, an overview navigator,
  visible-window statistics and a data-table twin; Escape closes it with
  focus returned. Nothing it does is saved.
- (Elsewhere) Have an AI agent arrange the widgets through the MCP server
  (`docs/OPERATIONS.md`); edits made elsewhere — another tab, an agent —
  appear on this page when its tab becomes visible again.

Every action is an icon-only button (accessible name and tooltip carry the
former label); the per-widget actions open a text menu with leading icons.

**Shows**

- The arranged widgets (metric, line-chart, stock-table, indicator-table):
  latest values with unit, as-of date, change and source link, or
  "unavailable (reason)" when a series has no usable data. A tap on a price
  widget opens the detailed chart viewer at the right place (the plot, the
  value block, the row's series — see the actions above). Widgets come in
  three fixed sizes on equal grid cells with a fixed row height — Small
  1 × 1 (17rem, 272 px), Medium 2 × 2 (35rem, 560 px), Large full width × 2
  (35rem, 560 px) — as white cards with a faint
  hairline on the grey page; a body taller than its frame scrolls inside
  the frame. Every widget header is a drag handle (grip, title, actions);
  a completed move is announced with its new position.
- The earnings-calendar widget, when arranged — glanceable, after the Apple
  widget guidelines (see `DESIGN_GUIDELINE.md`): a month grid (icon buttons
  for the previous and next month, today marked) whose announcement days
  link to the Watchlist page (`#/watchlist`, where each stock's row carries
  its dates and per-date calendar links), a "Next" list of at most 3
  upcoming announcements, one status line (earnings fetch status plus the
  Google Calendar status, with "Connect it in Settings" when Google is not
  connected), a "Refresh earnings dates" icon button and an "Open Watchlist"
  link; "Earnings dates have not been fetched yet." when a stock was never
  looked up ("No announcement in the next N days." only when every stock was
  refreshed), and one sentence for the stocks with no upcoming date. The
  widget is the only month calendar; the `.ics` download, the subscription
  feed and the Google Calendar card live in Settings → Calendar.
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

Register the stocks you follow and see their earnings announcement dates.

**User actions**

- Add a stock (a US listing or a Japanese listing). The add queues an
  earnings-date refresh itself, so the dates arrive without a further click;
  when a refresh is already running, one follow-up is queued when it ends with
  a stock still never refreshed.
- Remove a stock, with confirmation.
- Queue an earnings-date refresh for the local runner (manual button; opening
  the page with dates never fetched or more than a day old queues one refresh,
  once per visit).
- Add one announcement date to Google Calendar or Outlook.

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
- No calendar: the month grid is the Home widget, and the Google Calendar
  card, the `.ics` download and the subscription link are in Settings →
  Calendar. A change made here (an add or a remove) still queues the one
  automatic Google sync when Google is connected and behind the dates.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or watching runs — see Chat (`#/chat`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).
- Google Calendar, the `.ics` download and the subscription link — see
  Settings → Calendar (`#/settings/calendar`).

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
  Notebook" action ("In notebook" once saved). Results no visible run owns
  are not shown (there is no "Other results" area).
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
  round + button at the input's leading edge opens the "Composer mode" menu
  with Research and Notebook, the current one checked (ADR-0023, as in
  ChatGPT) — Notebook shows as a removable "Notebook" chip beside the +,
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
  a series never refreshed queues one market-data refresh by itself. A tap on
  a price widget opens the same detailed chart viewer as on Home (its plot,
  value block or row name; nothing it does is saved). A
  `chart` widget carries its own series and draws through the same shared
  plot as the Chat preview it was saved from (same viewBox, ticks, axis
  titles, marks, legend and readout; `xLabel` / `yLabel` plus `xKind` keep the
  axis titles and date/number x positioning, and only a lossless conversion
  becomes a `chart` — otherwise `research`). It also carries each value's
  provenance (ADR-0026): the same basis note, cell markers, citations and
  Sources list as in Chat; a chart without provenance (owner- or
  assistant-made) is marked "basis not stated". The
  earnings calendar reads the Watchlist page's stocks with its own refresh
  button. Titles stay in the data but the frames hide them.
- The Notebook's widget list scrolls inside the panel, below its fixed header
  and toolbar; dragging near its top or bottom edge scrolls it.
- Cut, copy and paste widgets (ADR-0023): Cut / Copy / Paste after in each
  widget's menu, Cut / Copy in the selection toolbar, a Paste button in the
  Notebook header, and ⌘X / ⌘C / ⌘V (Ctrl elsewhere) on the selected widgets
  when focus is not in a text field. Cut removes at once (Undo restores);
  paste inserts fresh copies after the last selected widget (or at the end)
  and selects them. One app-wide widget clipboard (kept in this browser), so
  widgets move between chats; a research result stays in its own chat.
- Text widgets edit in place, Notion style: click the note (or Enter on it)
  and type formatted text — `# `/`## `/`### ` headings, `- `, `1. `, `[] `
  and `> ` blocks, a `/` block menu, a selection toolbar (bold, italic,
  strike, code, link) and ⌘B/⌘I/⌘K; Escape or clicking away saves and
  leaves; to-dos toggle without opening the editor. Stored as the Markdown
  subset the assistant also writes.

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

Configure how the workspace runs: the AI agent, the calendar, the runner and data export.

**User actions**

- Choose the default AI backend, its model from a list, effort, per-question limits and web access.
- Calendar (`#/settings/calendar`): connect, sync (manually, or automatically
  once after connecting and whenever the dates drift — automatic syncing
  pauses after a failed step until a manual sync succeeds) and disconnect
  Google Calendar; cancel a sign-in that is waiting or still being prepared
  (one Google step runs at a time); download the earnings calendar file
  (.ics); create, replace or revoke the calendar subscription link.
- View the session (owner id, sign-in method).
- Issue a runner credential and copy the one-time token; revoke a credential.
- Export a workspace as JSON or Markdown; import a workspace file and open it.

**Shows**

- The AI agent defaults.
- The Calendar section, over the Watchlist's earnings dates (linking to the
  Watchlist): the Google Calendar card (disconnected explanation; preparing,
  with Cancel and the note that it waits for the local runner; the sign-in
  link with its wait note and Cancel; connected with last-sync counts,
  "syncing" or "disconnecting" while a step runs, and a sentence when the
  calendar is behind the dates; needs-reconnect with the reason; the last
  failure as its fixed sentence, with the note that automatic syncing is
  paused), the `.ics` download (disabled, with the reason, while the
  watchlist is empty) and the subscription link block (created date,
  replace and revoke with confirmation; the link is shown once and is a
  secret).
- The session, runner credentials (never tokens except once at issue),
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
| 9. Track earnings announcement dates | Watchlist (register stocks — each add queues its own earnings-date refresh — and add single dates to a calendar), Home (glanceable earnings-calendar widget with the month grid, its own refresh button and an "Open Watchlist" link) and Settings → Calendar (keep Google Calendar in step, export or subscribe to the calendar) |

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
