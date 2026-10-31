# Pages

The SPA is split into seven pages by user action (MECE): every action lives on
exactly one page, and every primary journey step has a page. A "chat" and a
"workspace" are the same stored thing (one conversation with its research
results and notebook); the UI
says "chat" for a conversation everywhere.

Routes: `#/home` (default), `#/chat` and `#/chat/<workspaceId>`, `#/sources`,
`#/settings`, `#/registered`, `#/stocks` (with `#/stocks/<stockId>[/<tab>]`)
and `#/tasks`. The old `#/watchlist` and `#/equities` hashes open the
Registered stocks page, where their lists and actions live (ADR-0049,
amended 2026-11-01). The old `#/canvas`, `#/canvas/<workspaceId>`,
`#/workspace/<workspaceId>` and `#/workspace` hashes open the Chat page for
that conversation so old bookmarks keep working. `#/settings/agent`
scrolls the AI agent section into view and moves focus to its Default backend
select, so a notice in Chat can link straight to the control that fixes it.
`#/settings/calendar` scrolls to and focuses the Calendar section (the Home
widget's "Connect it in Settings" link); the old `#/watchlist/calendar` and
`#/watchlist/calendar/YYYY-MM-DD` links open it too (ADR-0022). An empty or
unknown hash opens Home. The top bar's navigation lists every page except
Settings — Home, Registered stocks, Stocks, Tasks, Chat, Sources; the owner
ID at the right of the bar is the link to Settings (`#/settings`). The Stocks
link reopens the stock last shown in this browser tab (as the Chat link
reopens the open conversation), else `#/stocks`.

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
  table, Indicator table, Earnings calendar (its dialog opens first),
  Scheduled tasks (no fields: placed at once, and its menu has no Edit…), or
  Task result (ADR-0038: a dialog lists your tasks and you pick one; its
  menu has no Edit…), or Watchlist prices (ADR-0040: a dialog lists your
  Watchlist lists with their stock counts and you pick one — with no lists
  it links to the Registered stocks page; its menu has no Edit…).
- Edit a widget (Edit…: the content editor, or the market dialog for series,
  range, days ahead), edit a Text widget in place, or change its size from the
  menu (Size: Small / Medium / Large).
- Duplicate, Cut, Copy and Paste after (one clipboard with the Notebooks: a
  widget copied on Home pastes into a chat's notebook and back); ⌘X / ⌘C / ⌘V
  on selected widgets. Home has no Paste widgets toolbar button (ADR-0024
  amendment); the Notebook keeps it.
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
  (its series, 1y), a stock-table row's name (that row's series, 1y) or an
  indicator-table row's name (that row's series, at its Trend range: 1y
  daily/weekly, 5y monthly, max coarser — ADR-0044 §1) — each an "Open
  chart" button. The viewer offers range presets plus exact
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
  value block, the row's series — see the actions above; a Watchlist prices
  row's stock too). The indicator table also draws each row's history
  (ADR-0044 §1): a Trend column with a sparkline over the row's range and
  the range named beside it (1Y for a daily or weekly series, 5Y monthly,
  Max coarser; shown in a Large frame, hidden in Small and Medium ones),
  and a tap on a row's name opens
  the viewer at that same range. While Home stays open and visible it
  re-reads its data and checks staleness again every 5 minutes and on every
  return to the tab (ADR-0044 §4): data older than 30 minutes queues one
  refresh, never while one is active, at most once per stale stamp per
  30 minutes, and at least 30 minutes after the last such refresh (a run
  that outlasts 30 minutes is not followed by another at once; a series
  never refreshed still asks at once).
  Widgets come in
  three fixed sizes on equal grid cells with a fixed row height — Small
  1 × 1 (17rem, 272 px), Medium 2 × 2 (35rem, 560 px), Large full width × 2
  (35rem, 560 px) — as white cards with a faint
  hairline on the grey page; a body taller than its frame scrolls inside
  the frame. Every widget header is a drag handle (grip, title, actions);
  a completed move is announced with its new position.
- The earnings-calendar widget, when arranged — glanceable, after the Apple
  widget guidelines (see `DESIGN_GUIDELINE.md`): a month grid (icon buttons
  for the previous and next month, today marked) whose announcement days
  link to the Registered stocks page (`#/registered`, where each stock's row
  carries its dates and per-date calendar links), a "Next" list of at most 3
  upcoming announcements, one status line (earnings fetch status plus the
  Google Calendar status, with "Connect it in Settings" when Google is not
  connected), a "Refresh earnings dates" icon button and an "Open Registered
  stocks" link; "No stocks on the watchlist yet. Add one on the Registered
  stocks page." with no stock; "Earnings dates have not been fetched yet."
  when a stock was never looked up ("No announcement in the next N days." only when every stock was
  refreshed), and one sentence for the stocks with no upcoming date ("See
  them on the Registered stocks page"). The
  widget is the only month calendar; the `.ics` download, the subscription
  feed and the Google Calendar card live in Settings → Calendar.
- The scheduled-tasks widget, when arranged (ADR-0033 §9) — glanceable,
  after the Apple widget guidelines: the tasks by next run (active, then
  paused, then completed), each with its title, schedule in words, next run
  (relative within a day), last run state with an "Open chat" link, the last
  skip with its reason, and Pause/Resume and Run now icon buttons; a header
  line with "New task" (the Tasks page's editor dialog) and "Open Tasks".
  Small shows the next task only, Medium up to four, Large up to eight and
  then "N more". It polls the list (30 s; 5 s while a run is unfinished)
  only while the tab is visible, one poll for all such widgets.
- A Task result widget, when arranged (ADR-0038) — one task's latest
  answer: the task's title; a status line with when that answer was given,
  its verification status and, when it applies, "Running now", "Last run
  failed" or the last skip; the answer as plain text (Small a few lines,
  Medium more, Large all of it); "Open chat" and Run now. A run in progress
  or a failed run never hides the previous answer. It reads the same task
  list as the scheduled-tasks widget and fetches the answer only when the
  task's last run changes. A deleted task's widget says so.
- A Watchlist prices widget, when arranged (ADR-0040) — one Watchlist
  list's stocks: the list's current title and stock count, then one row per
  stock in list order with its symbol and company name, last close with its
  unit, the change from the previous close as an amount and a percentage
  (sign and colour, never colour alone) and the as-of date; Small shows the
  symbol and percentage of the rows that fit and "N more"; Large adds the
  source column. A row opens the detailed chart viewer; a row without data
  says "unavailable (reason)" (Japanese stocks on Twelve Data's free plan),
  and a row past the page's 30 price series says "Not shown: …" (named
  series come first). The Twelve Data in-session note and the source line
  close it. A deleted list says "This list was deleted."; an empty one links
  to the Registered stocks page ("Add stocks on the Registered stocks
  page"). Home loads the watchlist when such a widget is
  arranged, and its one automatic refresh of never-refreshed series also
  covers the lists' stocks, so prices arrive without a click.
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
- Registering stocks, grouping them into lists, tracking earnings
  announcement dates or syncing financial statements — see Registered stocks
  (`#/registered`); reading one stock's chart, statements, company and
  news — see Stocks (`#/stocks`).
- Creating, editing or deleting scheduled tasks — see Tasks (`#/tasks`); the
  widget only pauses, resumes and runs them.

## Registered stocks — `#/registered`

**Purpose**

Group your stocks into lists, and keep their earnings dates and financial statements synced.

The stock list, its lists and the earnings refresh moved here from the
Stocks page (ADR-0049, amended 2026-11-01). Since ADR-0050 §4 this page has
no add form: a stock is added from the Stocks page (Find a stock, then Add
to Watchlist) or from a list's Add stock dialog here. `#/watchlist` and
`#/equities` open this page, and every "manage your stocks" link (the
Earnings calendar and Watchlist prices widgets, the list and financial
widget dialogs, Settings → Calendar, the not-synced error messages) points
here. `#/registered/<anything>` opens it too. This page reads no stock's
prices, profile or news: a row's name opens that stock on the Stocks page.

**User actions**

- Queue a download of both stock lists for the local runner ("Update stock
  list", in the Stock lists section below the table; the Stocks page's
  search reads these lists). Opening the page queues one download, at most once per visit, for
  each market whose list is missing or more than 7 days old — never after the
  US list failed for a missing `SEC_USER_AGENT`.
- Remove a stock from the Watchlist, with confirmation; Add to Watchlist a
  stock that is only tracked for its statements.
- From a row's menu: Sync financial statements for a stock (track its
  company), Stop syncing financial statements (with confirmation; the stored
  data is kept), or Sync financials now (the company becomes due at once —
  the runner fetches it, the page never does).
  Removing a stock from the Watchlist does not stop its sync, and stopping
  the sync does not remove it from the Watchlist.
- Queue an earnings-date refresh for the local runner ("Refresh earnings
  dates"; opening the page with dates never fetched or more than a day old
  queues one refresh, once per visit).
- Add one announcement date to Google Calendar or Outlook.
- Group stocks into titled lists (ADR-0040 §7), shown as tabs over the one
  stock table: "All stocks (N)" first, then one tab per list ("Title (n)").
  New list (in the section header; a title of 1–80 characters) adds a tab,
  selected and focused. A list's tab carries the list's actions — Add stock
  (a dialog with the watchlist's other stocks as checkboxes and the stock
  search for a stock not on the watchlist yet, which is then added to the
  watchlist too, its earnings dates queued as after a plain add), Show on
  Home (appends a Watchlist prices widget for the list to Home, or says it
  is already there) and a menu with Rename… and Delete… (with confirmation;
  the stocks stay on the watchlist; "All stocks" is selected after) — and
  Remove from list on each row. Tabs follow the WAI-ARIA pattern (one tab
  stop, ←/→ wrap, Home/End); on a phone the strip scrolls inside itself.
  At most 20 lists and 12 stocks a list: at a bound the button is disabled
  and says why; a refused write names its reason.
- Open a stock on the Stocks page: a row's name is a link to
  `#/stocks/<stockId>` (its Chart tab; a new history entry, so Back returns
  here), where focus lands on the stock's heading. No row is selected or
  highlighted on this page.

**Shows**

- The Stock lists section (銘柄一覧): one line per stock list with its source link: "US list: 7,691 stocks,
  retrieved …", "Japan list: 3,707 stocks, as of 2026-09-30", "not downloaded
  yet", "Updating (state)…" while a download runs, and the last failure as a
  fixed sentence per code (`DIRECTORY_NOT_CONFIGURED` names `SEC_USER_AGENT`
  in `apps/runner/.env`). A refresh request that fails is followed by one
  status reload, so a market it queued anyway is shown and polled.
- The "Stocks and lists" section (the page header already carries the page
  title) with the companies line ("Statements synced for 3 of 20
  companies") and the stocks on "All stocks" — the watchlist's stocks in the
  order they were added, then the companies tracked for their statements but not on the
  watchlist — or one list's stocks in list order on its tab (with "Title · n
  of 12 stocks" above them): symbol, company name (or "unavailable (not
  retrieved yet)"), market, the next announcement date with fiscal period
  and timing, further dates in a disclosure, "date undecided" stated as
  text, the retrieved date, the source link, a per-row "unavailable
  (reason)" when there is no date ("Not on Watchlist" for a stock only
  tracked for its statements), the Financials line (sync status as "Synced 2
  hours ago", "Queued", "Running", the failure's code and the provider's
  status with the setting to add when SEC or EDINET is not configured, or
  "Not synced"), "In lists: …", and the row's actions. An empty list's tab
  says so. The selected tab survives re-reads; a list deleted elsewhere falls
  back to "All stocks".
- The earnings-date refresh status: last successful refresh time, the active run id and
  state while refreshing, or the last failure with its stable code beside the last
  success; a note that the refresh waits for the local runner when it is queued but
  nothing executes it. A queued notice ("…are being fetched…", "…was queued") clears
  when the run ends; the status line then tells the outcome.
- The outcome of the last statements action ("Syncing the statements of
  …", the sync queued, "Stopped syncing the statements of …", or its failure
  with the stable code), and a notice with Retry when the watchlist or the
  companies could not be read.
- The list polls fast while a statement sync runs and every five minutes
  otherwise, only while the page is visible.
- No calendar: the month grid is the Home widget, and the Google Calendar
  card, the `.ics` download and the subscription link are in Settings →
  Calendar. A change made here (an add or a remove) still queues the one
  automatic Google sync when Google is connected and behind the dates.

Decision records: ADR-0049 (this page and the Stocks page), ADR-0040
(lists), ADR-0048 (financial statements), ADR-0034 (stock search).

**Not here**

- Reading one stock's chart, financial statements, company information or
  news — see Stocks (`#/stocks`), opened from a row's name.
- Arranging market widgets or queueing a market-data refresh — see Home
  (`#/home`); a list's prices are its Watchlist prices widget there.
- Asking questions or watching runs — see Chat (`#/chat`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).
- Google Calendar, the `.ics` download and the subscription link — see
  Settings → Calendar (`#/settings/calendar`).
- Scheduling research questions — see Tasks (`#/tasks`).

## Stocks — `#/stocks`

**Purpose**

Read one stock's price chart, financial statements, company information and news from the stored data.

The Watchlist and Equities pages merged into this page (ADR-0049); since
2026-11-01 its stock list lives on Registered stocks, and this page shows
one stock only. `#/stocks/<stockId>` shows a stock (Chart tab) and
`#/stocks/<stockId>/<tab>` opens one of its tabs (`chart`, `financials`,
`company`, `news`), e.g. `#/stocks/us:AAPL/news`. A stock is opened from
the page's "Find a stock" search (ADR-0050), from a row's name on
Registered stocks or from a widget's link (a financial widget's "Open in
Stocks" opens `#/stocks/<stockId>/financials`). A bad stock id opens the page with no
stock; a bad tab the stock's Chart tab. Every tab shows what is stored:
opening one never makes the runner fetch anything.

**User actions**

- Find a stock (ADR-0050): search the stored US and Japanese stock lists by
  company name or symbol in the combobox at the top (↓/↑, Enter, Escape as
  on Registered stocks). A pick opens that stock — registered or not — as
  a new history entry (Chart tab), clears the box and focuses the stock's
  heading. Nothing is added, and no stock-list download is queued.
- Add to Watchlist (ADR-0050): beside the heading, "Add to Watchlist" (a
  stock not on the Watchlist) or "Add to a list" (one on it, while a list
  can take it) opens a dialog with one checkbox per list. Lists that
  already hold the stock are ticked and disabled, full lists disabled.
  Add with no list ticked puts the stock on the Watchlist alone; ticked
  lists get it too. A stock that went on the Watchlist has its earnings
  dates fetched, as an add on Registered stocks does. A refusal (full
  watchlist, full list, list deleted meanwhile) keeps the dialog open with
  its reason; Escape or Cancel closes it.
- Choose another stock: the "Choose another stock" link above the stock
  opens Registered stocks (`#/registered`).
- Switch the shown stock's tabs — Chart, Financial statements, Company,
  News — with a click or the keyboard (one tab stop, ←/→ wrap, Home/End, the
  tab focus lands on is shown). A tab switch replaces the history entry
  (Back leaves the stock rather than walking its tabs). A tab's content is
  downloaded and read on its first showing and kept while the stock stays
  shown, so switching back is instant and keeps its state.
- Chart tab: read the stored daily closes in the detailed chart viewer shown
  inline (ADR-0025: range presets, opening at 1Y, exact From/To dates,
  interval / scale / values, moving averages, crosshair and readout,
  overview navigator, visible-window statistics and the data-table twin).
  Nothing it does is saved.
- Financial statements tab: switch the statement (income statement, balance
  sheet, cash flow) and 5 or 10 years; open a value's revision history;
  open "Filings (n)" to list the annual filings with links to SEC / EDINET;
  Add statement to Home; pick a metric and Add chart to Home. The tab also
  offers Sync now, and Sync financial statements for a stock whose
  statements are not synced — the same two writes as a row's menu on
  Registered stocks, beside the statements they fill (stopping a sync is
  only there).
- Company tab: open the filer's EDGAR page (SEC CIK; an EDINET code is shown
  as text); "Open Financial statements" switches tabs.
- News tab: open an article (its title is the link); Show more loads the
  next 20; the empty state links to Sources.

**Shows**

- "Find a stock": the search box, its hint, its status line ("Searching…",
  the result count, that no stock matches, that no list is downloaded yet —
  pointing at "Update stock list" on Registered stocks — that only one
  market was searched because the other list is missing, or that the search
  failed) and its list of matching stocks: at most 10, ranked exact symbol,
  symbol prefix, name prefix, other match; symbol, the company name in the
  UI language (the Japanese name first in Japanese, the English one first
  in English, the other beside it), market and listing. Names match from
  "Apple", "トヨタ", "とよた", "toyota" or "7203"; keys an IME is composing
  with are left to the IME. While the next search runs the previous hits
  stay listed. The stored lists' status is read once, on the first search.
- The shown stock: its name and symbol as the heading ("Apple Inc. · AAPL"),
  beside it "On the Watchlist · In lists: …" and the add button, the
  "Choose another stock" link, the tab strip and the shown tab. A stock
  opened by a search pick or a link (a Registered stocks row, a widget) gets
  focus on its heading, scrolled into view, once per stock. With no
  stock in the URL: "No stock is shown. Search for one above, or choose one
  on the Registered stocks page, to see its chart, financial statements,
  company information and news." with an "Open Registered stocks" link —
  and the page reads nothing until the owner searches.
- Once a stock is shown, the page reads the watchlist and the tracked
  companies to name the stock, to show its place on the Watchlist and to
  offer the Financial statements tab's actions; a notice with Retry says
  when either read fails. Showing a stock queues nothing: the once-per-visit
  earnings-date refresh and the automatic Google sync are the Registered
  stocks page's. Only the owner's own Add to Watchlist queues the new
  stock's earnings dates (and the Google sync that follows any watchlist
  change), as an add on Registered stocks does. A shown
  stock stays when it stops being registered (removed from the Watchlist,
  its sync stopped, here or elsewhere): its tabs say what is stored.
- Chart tab: last close with its unit, the change from the previous close as
  an amount and a percentage (sign and colour, never colour alone), the
  as-of date and the source link, then the chart. With no stored prices:
  "No prices are stored for AAPL. Prices are downloaded for stocks shown on
  Home or in a notebook." with an "Open Home" link; an unavailable series
  says its reason (Japanese stocks on Twelve Data's free plan).
- Financial statements tab: the sync status with its failure; the statement
  with fiscal years side by side, missing values saying why (never 0),
  derived and revised values marked; the filings (form, filing date, period,
  standard, amendment, what the sync read, link). A stock whose statements
  are not synced says so with "Sync financial statements".
- Company tab: Listing (names in English and Japanese, symbol, market,
  listing, stock id; "not in the stored stock list" when the directory has
  no entry), Filer (SEC CIK or EDINET code, fiscal year end, newest fiscal
  year, annual filings stored, last sync), Key figures (the newest fiscal
  year's revenue, operating income, profit attributable to owners, total
  assets, total equity, operating cash flow and free cash flow, with units
  and marks), On this workspace (on the Watchlist since, its lists, the next
  earnings announcement). A missing value says why.
- News tab: the stored articles from the Sources feeds that mention the
  company, newest first, 20 at a time — title (link), publisher, published
  date (else retrieved date), the excerpt when the source allows one, and
  "Mentions: Nintendo"; with none, "No stored article mentions Nintendo.
  Articles come from the feeds chosen on Sources." with the searched names
  and a link to Sources.
- While the page is visible a shown tab re-checks its data every 5 minutes
  and on return to the browser tab (an unchanged answer costs a 304); a
  hidden tab or page re-checks nothing.

Decision records: ADR-0049 (this page), ADR-0050 (Find a stock and Add to
Watchlist), ADR-0048 (financial statements), ADR-0025 (the chart viewer),
ADR-0034 (the stock search), ADR-0040 (lists). Data, rules and API of the statements:
[equities library guide](database/libraries/equities.md).

**Not here**

- Removing stocks, making, renaming or deleting lists, the add form (with
  "Also sync annual financial statements"), stock-list downloads, the
  earnings-date refresh, per-date calendar links and stopping a stock's
  statement sync — see Registered stocks (`#/registered`). (This page adds
  the shown stock to the Watchlist and to lists that exist.)
- Arranging market widgets or queueing a market-data refresh — see Home
  (`#/home`).
- Asking questions or watching runs — see Chat (`#/chat`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials or export — see Settings (`#/settings`).
- Google Calendar, the `.ics` download and the subscription link — see
  Settings → Calendar (`#/settings/calendar`).
- Scheduling research questions — see Tasks (`#/tasks`).

## Tasks — `#/tasks`

**Purpose**

Schedule research questions to run by themselves and see when each runs next and how it last went.

A task (ADR-0033) is a research question with a schedule — once, daily,
weekdays, weekly or monthly, at a local time in its own time zone — that
runs by itself in its own chat. It fires when the local runner next asks for
work after its time; times missed while no runner polled run once on
return. At most 10 tasks are active and 30 stored.

**User actions**

- Create a task with "New task" (the editor dialog): title, question,
  horizon, markets, Repeat (Once / Daily / Weekdays / Weekly / Monthly) with
  its date, days or day of the month, the time and the time zone (the
  browser's by default), and — only while the backend saved in Settings → AI
  agent bills per use — the spend consent ("Allow this task to spend up to
  $X per run on <backend> <model>").
- Edit a task in the same dialog.
- Pause or resume a task (a time missed while paused never runs).
- Run a task now (queues one run without moving its schedule; while its last
  run is unfinished it answers that run instead of a second one).
- Delete a task, with confirmation (its chat and answers stay).
- Open a task's chat (`#/chat/<workspaceId>`), where every run's question and
  answer land.
- Show a task's result on Home ("Show result on Home", ADR-0038): appends a
  Task result widget for the task to Home, or says it is already there.

**Shows**

- The tasks, active first by next run, then paused, then completed: title,
  status, schedule in words (naming the zone when it is not the browser's),
  the question, the next run in local time (relative within a day; "due
  now" until the runner next asks for work), the last run's state with its
  failure code and "Open chat", and the last skipped occurrence with its
  reason and fix (a link to Settings → AI agent when the fix lives there).
- The counts against the limits ("3 of 10 active · 5 of 30 tasks"), a note
  that each run uses the agent choice saved in Settings → AI agent, and an
  empty state that explains what a task is.
- The outcome of the last action, or its failure with the stable code and
  what to do (task limits reached, time in the past, changed elsewhere).

**Not here**

- Asking a question once or reading the answers — see Chat (`#/chat`).
- Choosing the AI backend, model or spend ceiling the runs use — see
  Settings → AI agent (`#/settings/agent`).
- Checking market prices or arranging widgets (the scheduled-tasks widget
  included) — see Home (`#/home`).
- Registering stocks, grouping them into lists, tracking earnings
  announcement dates or syncing financial statements — see Registered stocks
  (`#/registered`); reading one stock's chart, statements, company and
  news — see Stocks (`#/stocks`).

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
- Cancel, retry or approve a run. A retry runs on the backend and model saved
  in Settings → AI agent now, not the ones the failed run used.
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
  except completed and failed, latest progress, `Stop`, a failure reason
  with a next-step hint where one exists (no evidence collected, provider
  unavailable or rate-limited),
  `Retry`, the approval form; no "Run details" and no "Evidence" button on
  the card — the records drawer opens from the "Evidence" action under an
  answer; a completed run's card is hidden, since its answer follows, and so
  is a retried run's, since its retry follows and the old failure would only
  repeat an error the retry answers), and unmatched unfinished or failed runs
  grouped under "Earlier runs". Retrying also clears an earlier "The run could
  not be retried." notice.
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
  a series never refreshed, or one refreshed more than 30 minutes ago,
  queues one market-data refresh by itself, with Home's rule; the check runs
  again every 5 minutes while the Notebook is visible and on every return to
  the tab (a Chat-first conversation below `lg` hides the panel, and a
  hidden panel asks nothing), never while a refresh is active, at most
  once per stale stamp per 30 minutes, and staleness refreshes at least 30
  minutes apart — a series never refreshed still asks at once (ADR-0044 §4). The indicator table carries its Trend column and row
  openers as on Home. A tap on
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
  earnings calendar reads the watchlist's stocks with its own refresh
  button. The Watchlist prices widget (ADR-0040) shows one Watchlist list's
  stocks as on Home; it is added from the Add menu's list dialog, the
  notebook loads the watchlist before its market data, and the lists'
  stocks join its series and its one automatic refresh. The scheduled-tasks
  and Task result widgets are Home's too (see Home): they show the owner's
  tasks, not this chat's. Titles stay in the data but the frames hide them.
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
- Registering stocks, grouping them into lists, tracking earnings
  announcement dates or syncing financial statements — see Registered stocks
  (`#/registered`); reading one stock's chart, statements, company and
  news — see Stocks (`#/stocks`).
- Scheduling a question to run by itself — see Tasks (`#/tasks`); a task's
  answers still arrive here, in its own chat.

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
- Registering stocks, grouping them into lists, tracking earnings
  announcement dates or syncing financial statements — see Registered stocks
  (`#/registered`); reading one stock's chart, statements, company and
  news — see Stocks (`#/stocks`).
- Scheduling research questions — see Tasks (`#/tasks`).

## Settings — `#/settings`

**Purpose**

Configure how the workspace runs: the AI agent, the calendar, the runner and data export.

**User actions**

- Choose the default AI backend, its model from a list, effort and web access, and — only for a
  backend that can bill — the maximum spend. The other per-question limits are fixed (ADR-0029).
- Calendar (`#/settings/calendar`): connect, sync (manually, or automatically
  once after connecting and whenever the dates drift — automatic syncing
  pauses after a failed step until a manual sync succeeds) and disconnect
  Google Calendar; cancel a sign-in that is waiting or still being prepared
  (one Google step runs at a time); download the earnings calendar file
  (.ics); create, replace or revoke the calendar subscription link.
- Language (ADR-0032): show the UI in English or 日本語, or follow the
  browser ("Browser default"); applies at once, without a reload, and is
  remembered in this browser.
- Issue a runner credential and copy the one-time token; revoke a credential.
- Export a workspace as JSON or Markdown; import a workspace file and open it.

**Shows**

- The AI agent defaults.
- The Calendar section, over the Watchlist's earnings dates (linking to the
  Watchlist on the Registered stocks page, `#/registered`): the Google Calendar card (disconnected explanation; preparing,
  with Cancel and the note that it waits for the local runner; the sign-in
  link with its wait note and Cancel; connected with last-sync counts,
  "syncing" or "disconnecting" while a step runs, and a sentence when the
  calendar is behind the dates; needs-reconnect with the reason; the last
  failure as its fixed sentence, with the note that automatic syncing is
  paused), the `.ics` download (disabled, with the reason, while the
  watchlist is empty) and the subscription link block (created date,
  replace and revoke with confirmation; the link is shown once and is a
  secret).
- The Language section (the browser default names the language it stands
  for; each language is named in itself).
- Runner credentials (never tokens except once at issue), export/import.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or reading answers — see Chat (`#/chat`).
- Produced tables and charts — see Chat (`#/chat`).
- Subscribing to news — see Sources (`#/sources`).
- Registering stocks, grouping them into lists, tracking earnings
  announcement dates or syncing financial statements — see Registered stocks
  (`#/registered`); reading one stock's chart, statements, company and
  news — see Stocks (`#/stocks`).
- Scheduling research questions — see Tasks (`#/tasks`); their runs use the
  AI agent choice saved here.

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
| 9. Track earnings announcement dates | Registered stocks (search every US and Japanese listed stock and register it — each add queues its own earnings-date refresh — and add single dates to a calendar), Home (glanceable earnings-calendar widget with the month grid, its own refresh button and an "Open Registered stocks" link) and Settings → Calendar (keep Google Calendar in step, export or subscribe to the calendar) |
| 10. Ask a research question on a schedule (ADR-0033) | Tasks (create, edit, pause, run now, delete), Home and the Notebook (glanceable scheduled-tasks widget with Pause/Resume, Run now, New task and "Open Tasks"; a Task result widget per task with its latest answer, ADR-0038) and Chat (each task's answers in its own chat) |
| 11. Follow a group of stocks' prices (ADR-0040) | Registered stocks (make titled lists of watchlist stocks — one tab each beside "All stocks" — add and remove stocks, Show on Home) and Home and the Notebook (a Watchlist prices widget per list with each stock's change from the previous close) |
| 12. Follow companies' annual financial statements (ADR-0048) | Registered stocks (sync a stock's statements, stop the sync, each row's sync status), Stocks (the Financial statements tab with statements, revisions and filings), Home and the Notebook (a Financial statement widget and a Financial history chart widget per company) |
| 13. Read everything stored about one stock (ADR-0049) | Stocks (reached from a row's name on Registered stocks or a widget's link: Chart, Financial statements, Company and News tabs) |

## How the split was checked

Each user action above appears under exactly one page (exclusive), and every
journey step maps to a page (exhaustive). Dialogs such as the records drawer
and the delete-chat confirmation belong to the page that opens them (Chat);
the widget dialog belongs to Home. One deliberate overlap: a stock's Sync
now and Sync financial statements are offered both in its row's menu on
Registered stocks (where the companies are managed) and on its Financial
statements tab on Stocks (beside what they fill); they are the same writes.
Web tests assert the Chat page shape (two states with collapse, a collapsed
secondary panel mounting none of its content, one workspace session and one
notebook session backing the open conversation, Chat/Notebook tabs below `lg`),
that Home has no composer, message list, run status or canvas region,
the old `#/canvas/<workspaceId>`, `#/canvas`, `#/workspace/<workspaceId>`
and `#/workspace` URLs open the Chat page, that the Registered stocks page
adds a stock (by symbol and from a search hit), shows its refresh and
stock-list status and links each row's name to the Stocks page, that the
Stocks page with no stock in the URL links to Registered stocks and reads
nothing, that `#/watchlist` and `#/equities` open Registered stocks, and
`tests/architecture/pagesDoc.test.ts` fails if this document drifts from
`apps/web/src/pages.ts` (titles, routes, purpose sentences).
