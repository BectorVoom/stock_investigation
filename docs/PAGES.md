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
that conversation so old bookmarks keep working. Each Settings category
has its own address (ADR-0052): `#/settings/agent`, `#/settings/calendar`,
`#/settings/language`, `#/settings/runner` and `#/settings/data`;
`#/settings` and an unknown category show the AI agent. A link to
`#/settings/agent` also moves focus to the Default backend select, so a
notice in Chat can link straight to the control that fixes it, and one to
`#/settings/calendar` to the Calendar heading (the Home widget's "Connect
it in Settings" link); the old `#/watchlist/calendar` and
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
- Nothing to refresh: the server keeps the data synchronised (ADR-0051) and
  the page only reads it.
- Open a price widget's detailed chart viewer (ADR-0025): the line-chart plot
  (all its series, opening at the widget's range), a metric's value block
  (its series, 1y), a stock-table row's name (that row's series, 1y) or an
  indicator-table row's name (that row's series, at its Trend range: 1y
  daily/weekly, 5y monthly, max coarser — ADR-0044 §1) — each an "Open
  chart" button. The viewer offers range presets plus exact
  From/To dates, chart type (Line / Candlestick for one series with bars,
  ADR-0056; opens in Line) / interval / scale / values controls, moving
  averages, the main chart (bars evenly spaced by trading day, no weekend
  gaps — ADR-0057) with crosshair and readout, a volume panel when
  the series has volumes, an overview navigator,
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
  re-reads its data (conditionally) every minute and on every return to the
  tab, sooner (5 s, backing off to a minute) while a series shown has no
  data yet; it never asks for a refresh — the server syncs every 30 minutes
  and fetches a new series within seconds of the runner's next claim
  (ADR-0051).
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
  link to the Registered stocks page (`#/registered`), a "Next" list of at most 3
  upcoming announcements, one status line (earnings fetch status plus the
  Google Calendar status, with "Connect it in Settings" when Google is not
  connected) and an "Open Registered stocks" link (no Refresh button,
  ADR-0051); "No stocks on the watchlist yet. Find one on the Stocks page
  and add it." with no stock; "Earnings dates have not been fetched yet; they appear after the next
  automatic refresh."
  when a stock was never looked up ("No announcement in the next N days." only when every stock was
  refreshed), and one sentence for the stocks with no upcoming date ("2
  stocks have no upcoming date."). The
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
  says "unavailable (reason)" (a stock its provider does not know — every
  listed stock's daily bars come from Massive for US and J-Quants for JP,
  about 12 weeks behind on its Free plan; ADR-0058 §2), and a row past the page's 30 price series says "Not shown: …" (named
  series come first). The Twelve Data in-session note and the source line
  close it. A deleted list says "This list was deleted."; an empty one links
  to the Registered stocks page ("Add stocks on the Registered stocks
  page"). Home loads the watchlist when such a widget is
  arranged; the server's sync covers the lists' stocks, so prices arrive
  without a click.
- The market-data sync status (the server's syncs, ADR-0051): last
  successful refresh time, the active run id and state while refreshing ("pending" polls slowly until the local
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
- Grouping Watchlist stocks into lists — see Registered stocks
  (`#/registered`); adding a stock to the Watchlist or removing it, and
  reading one stock's chart, statements, company and news — see Stocks
  (`#/stocks`).
- Creating, editing or deleting scheduled tasks — see Tasks (`#/tasks`); the
  widget only pauses, resumes and runs them.

## Registered stocks — `#/registered`

**Purpose**

Group the stocks on your Watchlist into lists.

The stock list and its lists moved here from the Stocks page (ADR-0049,
amended 2026-11-01). Since ADR-0050 §4 this page has no add form, and since
ADR-0054 no "All stocks" tab and no sync action: a
stock goes on the Watchlist from the Stocks page (Find a stock, then Add to
Watchlist) or from a list's Add stock dialog here, and leaves it from the
Stocks page (Remove from Watchlist). `#/watchlist` and `#/equities` open
this page, and every "manage your stocks" link (the Earnings calendar and
Watchlist prices widgets, the list dialogs, Settings → Calendar) points
here. `#/registered/<anything>` opens it too. This page reads no stock's
prices, earnings dates, statements, profile or news: a row's name opens
that stock on the Stocks page.

**User actions**

- Group stocks into titled lists (ADR-0040 §7), shown as tabs over the
  stock table: one tab per list ("Title (n)"), the first list selected on
  arrival. New list (in the section header; a title of 1–80 characters)
  adds a tab, selected and focused. A list's tab carries the list's
  actions — Add stock (a dialog with the watchlist's other stocks as
  checkboxes and the stock search for a stock not on the watchlist yet,
  which is then added to the watchlist too), Show on Home (appends a
  Watchlist prices widget for the list to Home, or says it is already
  there) and a menu with Rename… and Delete… (with confirmation; the stocks
  stay on the watchlist; the first remaining list is selected after, or
  focus goes to New list when none is left) — and Remove from list on each
  row. Tabs follow the WAI-ARIA pattern (one tab stop, ←/→ wrap,
  Home/End); on a phone the strip scrolls inside itself. At most 20 lists
  and 12 stocks a list: at a bound the button is disabled and says why; a
  refused write names its reason.
- Open a stock on the Stocks page: a row's name is a link to
  `#/stocks/<stockId>` (its Chart tab; a new history entry, so Back returns
  here), where focus lands on the stock's heading. No row is selected or
  highlighted on this page.
- Nothing to sync or refresh (ADR-0051, ADR-0054, ADR-0058): the server
  fetches the Watchlist's earnings dates, downloads the stock lists, syncs
  every listed stock's prices, statements and description and keeps the
  Google Calendar in step on its own schedule.

**Shows**

- The "Stocks and lists" section (the page header already carries the page
  title; the section header holds only New list) with one list's stocks in
  list order on its tab, "Title · n of 12 stocks" above them: symbol, the
  company name as the link (or "Show AAPL" while no name is stored), market,
  and Remove from list — no "In lists: …" line (removed 2026-11-01: the tab
  already names the list; the Stocks page still says it beside the stock's
  heading). An empty list's tab says so.
  With no list: "No lists yet. Make one with New list. Stocks go on the
  Watchlist from the Stocks page." The selected tab survives re-reads; a
  list deleted elsewhere falls back to the first list.
- No stock-list area (the 銘柄一覧 area was removed at the owner's request
  on 2026-11-01): the server downloads the lists the search reads (ADR-0054
  §2); the page only reads their status for the list dialog's search.
- A notice with Retry when the watchlist could not be read, and the
  outcome of the last list action.
- The watchlist is re-read while the page is visible (ADR-0051
  `createIdleReread`), so a change made elsewhere shows.
- No calendar: the month grid is the Home widget, and the Google Calendar
  card, the `.ics` download and the subscription link are in Settings →
  Calendar.

Decision records: ADR-0049 (this page and the Stocks page), ADR-0040
(lists), ADR-0034 (stock lists), ADR-0054 (no syncs, no "All stocks").

**Not here**

- Adding a stock to the Watchlist or removing it — see Stocks (`#/stocks`).
- Reading one stock's chart, financial statements, company information or
  news — see Stocks (`#/stocks`), opened from a row's name.
- Arranging market widgets — see Home (`#/home`); a list's prices are its Watchlist prices widget there.
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
opening one never makes the runner fetch anything. The server syncs the
daily prices, annual financial statements and business description of
every stock in the stored US and Japanese stock lists, on the Watchlist or
not (ADR-0058): no tab asks the owner to add a stock to the Watchlist to
get its data.

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
- Remove from Watchlist (ADR-0054 §5): beside the heading of a stock on the
  Watchlist; a confirmation names the stock and how many lists it leaves
  too. Removing it stops its earnings-date sync; its prices, statements and
  description stay synced like every listed stock's (ADR-0058). This is the
  only place a stock leaves the Watchlist.
- Choose another stock: the "Choose another stock" link above the stock
  opens Registered stocks (`#/registered`).
- Switch the shown stock's tabs — Chart, Financial statements, Company,
  News — with a click or the keyboard (one tab stop, ←/→ wrap, Home/End, the
  tab focus lands on is shown). A tab switch replaces the history entry
  (Back leaves the stock rather than walking its tabs). A tab's content is
  downloaded and read on its first showing and kept while the stock stays
  shown, so switching back is instant and keeps its state.
- Chart tab: read the stored daily prices in the detailed chart viewer shown
  inline (ADR-0025: range presets 1D … Max, opening at 1Y, exact From/To
  dates, chart type, interval / scale / values, moving averages, crosshair
  and readout, overview navigator and visible-window statistics; no
  data-table twin — "Data table: …" removed 2026-11-01). It opens in
  Candlestick, with a volume panel, when the stored prices carry the day's
  bars (ADR-0056), else in Line; switch Line ↔ Candlestick with Chart type.
  Nothing it does is saved.
- Financial statements tab: switch the statement (income statement, balance
  sheet, cash flow) and 5 or 10 years; open a value's revision history;
  open "Filings (n)" to list the annual filings with links to SEC / EDINET.
  No Add to Home here: Home's add menu places the Financial statement and
  Financial history widgets. Nothing to sync: the server syncs every
  listed stock's statements (ADR-0058 §3).
- Company tab: in Business, open the filing the description was read from
  ("View filing", a new tab); Show more / Show less opens and closes the
  rest of the description (kept open while the stock stays shown). No
  control when none is stored: the server reads it by itself.
- News tab: open an article (its title is the link); Show more loads the
  next 20; the empty state links to Sources.

**Shows**

- "Find a stock": the search box, its hint, its status line ("Searching…",
  the result count, that no stock matches, that no list is downloaded yet —
  the server downloads them when the local runner next takes work — that only one
  market was searched because the other list is missing, or that the search
  failed) and its list of matching stocks: at most 10, ranked exact symbol,
  symbol prefix, name prefix, other match; symbol, the company name in the
  UI language (the Japanese name first in Japanese, the English one first
  in English, the other beside it), market and listing. Names match from
  "Apple", "トヨタ", "とよた", "toyota" or "7203"; keys an IME is composing
  with are left to the IME. While the next search runs the previous hits
  stay listed. The stored lists' status is read once, on the first search.
- The shown stock: its name and symbol as the heading ("Apple Inc. · AAPL"),
  beside it "On the Watchlist · In lists: …", the add button and Remove
  from Watchlist, the
  "Choose another stock" link, the tab strip and the shown tab. A stock
  opened by a search pick or a link (a Registered stocks row, a widget) gets
  focus on its heading, scrolled into view, once per stock. With no
  stock in the URL: "No stock is shown. Search for one above, or choose one
  on the Registered stocks page, to see its chart, financial statements,
  company information and news." with an "Open Registered stocks" link —
  and the page reads nothing until the owner searches.
- Once a stock is shown, the page reads the watchlist to name the stock
  and to show its place on the Watchlist; a notice with Retry says when the
  read fails. The tracked companies are not read (the server tracks every
  listed stock, ADR-0058 §6): the Financial and Company tabs take the
  stock's company from its profile read. No page queues anything (ADR-0051,
  ADR-0054): after the owner's own Add to Watchlist the server fetches the
  new stock's earnings dates at the runner's next claim, and the Google
  Calendar follows. A shown stock stays when it leaves the Watchlist (here
  or elsewhere): its tabs say what is stored.
- Chart tab: the chart alone, with no heading of its own — the page
  heading names the stock (no "Apple Inc. · AAPL" title, no summary line, no
  Twelve Data in-session note, no "— daily closes": removed 2026-11-01);
  the 1D preset shows the latest close against the previous one. Below it
  "Source: Massive" / "Source: J-Quants" — the stored series' publisher,
  linked to its source — and, under a Japanese stock's chart, "Japanese
  prices come from J-Quants Free and end about 12 weeks ago." (J-Quants
  Free's delay, ADR-0058 §2). The server downloads the daily prices of every
  listed stock (US from Massive, Japanese from J-Quants, ADR-0058 §2). With
  no stored prices a listed stock says they appear here once stored, and
  the tab re-reads sooner (5 s, doubling to 5 minutes) until they do; a
  stock outside the stored stock lists (its profile has no listing) says
  the server downloads only the listed stocks' prices and it is not among
  them. An unavailable series says its reason.
- Financial statements tab: the stored statements only — no sync status,
  no sync wording (ADR-0058 §9.4–9.5); the server fetches in the background and
  a failed fetch is in the runner's logs, not on the page. The statement
  with fiscal years side by side, missing values saying why (never 0),
  derived and revised values marked; the filings (form, filing date, period,
  standard, amendment, what was read, link). The stock's company comes
  from its profile read, tracked or not: an untracked company's stored
  statements stay shown, headed by a line — updated again by the server
  while the stock is listed, no longer updated once its listing left the
  stored stock lists (ADR-0058 §9.3). With nothing stored it says so:
  for a listed stock, that the server fetches the statements of every
  listed stock and they appear once stored — and the tab re-reads sooner
  (5 s, doubling to 5 minutes) until they do; for a stock outside the
  stored stock lists, that it is not among them.
- Company tab: Listing (names in English and Japanese, symbol, market,
  listing, stock id; "not in the stored stock list" when the directory has
  no entry). A missing value says why. Below it Business (事業内容,
  ADR-0053): the source line ("From the 10-K for the fiscal year ended Sep
  27, 2025, filed Oct 31, 2025." / 「2025年3月31日期の有価証券報告書（2025年6月27日提出）より。」)
  with "View filing", then the opening paragraphs of "Item 1. Business" or
  事業の内容 within about 700 characters — the filing's own words in its
  own language, never translated or rewritten — and "Show more" for the
  rest; a description cut to fit ends with "The section continues in the
  filing.". Otherwise one sentence: none is stored yet and the server reads
  it from the annual report by itself (a listed stock, on the Watchlist or
  not — the tab re-reads sooner until it arrives), none is stored and the
  server reads the descriptions of the stocks in the stored stock lists only
  (a stock outside them), or the newest annual report has no business
  section that could be read (with its source line).
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
Watchlist), ADR-0054 (Remove from Watchlist, no sync actions), ADR-0058 (every listed
stock synced; the empty states, the J-Quants delay note; stored statements
stay shown, §9), ADR-0048
(financial statements), ADR-0025 (the chart viewer),
ADR-0034 (the stock search), ADR-0040 (lists). Data, rules and API of the statements:
[equities library guide](database/libraries/equities.md).

**Not here**

- Making, renaming or deleting lists and removing a stock from one list —
  see Registered stocks (`#/registered`). (This page adds the shown stock to
  the Watchlist and to lists that exist, and removes it from the Watchlist.)
- Arranging market widgets — see Home (`#/home`).
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
- Grouping Watchlist stocks into lists — see Registered stocks
  (`#/registered`); adding a stock to the Watchlist or removing it, and
  reading one stock's chart, statements, company and news — see Stocks
  (`#/stocks`).

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
  edited in the same form, and reloaded when the named series change and
  re-read like Home's while the Notebook is visible (a Chat-first
  conversation below `lg` hides the panel, and a hidden panel reads
  nothing); a series the assistant or the owner adds is fetched by the
  server within seconds (ADR-0051), never by the page. The indicator table carries its Trend column and row
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
  earnings calendar reads the watchlist's stocks (no Refresh button). The Watchlist prices widget (ADR-0040) shows one Watchlist list's
  stocks as on Home; it is added from the Add menu's list dialog, the
  notebook loads the watchlist before its market data, and the lists'
  stocks join its series and the server's sync. The scheduled-tasks
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
- Grouping Watchlist stocks into lists — see Registered stocks
  (`#/registered`); adding a stock to the Watchlist or removing it, and
  reading one stock's chart, statements, company and news — see Stocks
  (`#/stocks`).
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
- Browse recent articles. Nothing to refresh (ADR-0054 §4): the server
  queues a news ingest at once for a new source and for every active
  source about every 30 minutes; the local runner fetches them.

**Shows**

- The source preview, subscribed sources (with the line that the server
  refreshes the feeds about every 30 minutes), recommended sources and
  recent articles.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or watching runs — see Chat (`#/chat`).
- Inspecting produced tables and charts — see Chat (`#/chat`).
- Runner credentials or export — see Settings (`#/settings`).
- Grouping Watchlist stocks into lists — see Registered stocks
  (`#/registered`); adding a stock to the Watchlist or removing it, and
  reading one stock's chart, statements, company and news — see Stocks
  (`#/stocks`).
- Scheduling research questions — see Tasks (`#/tasks`).

## Settings — `#/settings`

**Purpose**

Configure how the workspace runs: the AI agent, the calendar, the runner and data export.

Laid out like ChatGPT's settings (ADR-0052): the five categories — AI
agent, Calendar, Language, Runner credentials, Export and import — listed
with icons on the left (one row above the settings on a phone), one
category on the right, each setting a row with its name and explanation on
the left and its control on the right. A category opened once stays as it
was (an unsaved AI agent draft included) while the page is open.

**User actions**

- Choose a category (click, or ↑ / ↓ and Home / End in the list); it is
  shown at once and its address replaces the current one.
- AI agent (`#/settings/agent`): choose the default AI backend, its model from a list, effort, web access (a switch) and — only for a
  backend that can bill — the maximum spend, then Save. The other per-question limits are fixed (ADR-0029).
- Calendar (`#/settings/calendar`): connect, reconnect and disconnect
  Google Calendar (there is no Sync now: the server syncs it within seconds
  of a connect and whenever the dates change, and tries a failed sync of a
  connected calendar again after 30 minutes, ADR-0054 §3); cancel a sign-in that is waiting or still being prepared
  (one Google step runs at a time); download the earnings calendar file
  (.ics); create, replace or revoke the calendar subscription link.
- Language (`#/settings/language`, ADR-0032): show the UI in English or 日本語, or follow the
  browser ("Browser default"); applies at once, without a reload, and is
  remembered in this browser.
- Runner credentials (`#/settings/runner`): issue a runner credential and copy the one-time token; revoke a credential.
- Export and import (`#/settings/data`): export a workspace as JSON or Markdown; import a workspace file and open it.

**Shows**

- The category list, the shown category marked.
- The AI agent defaults.
- The Calendar category, over the Watchlist's earnings dates (linking to the
  Watchlist on the Registered stocks page, `#/registered`): the Google Calendar card (disconnected explanation; preparing,
  with Cancel and the note that it waits for the local runner; the sign-in
  link with its wait note and Cancel; connected with last-sync counts,
  "syncing" or "disconnecting" while a step runs, and a sentence when the
  calendar is behind the dates, saying the server updates it when the
  local runner next takes work; needs-reconnect with the reason; the last
  failure as its fixed sentence, with the note that the server tries
  again later and that disconnecting and connecting again helps when it
  keeps failing), the `.ics` download (disabled, with the reason, while the
  watchlist is empty) and the subscription link block (created date,
  replace and revoke with confirmation; the link is shown once and is a
  secret).
- The Language category (the browser default names the language it stands
  for; each language is named in itself).
- Runner credentials (never tokens except once at issue) as a list of rows
  — label, status, created, expires, last used — and export/import.

**Not here**

- Checking market prices or arranging market widgets — see Home (`#/home`).
- Asking questions or reading answers — see Chat (`#/chat`).
- Produced tables and charts — see Chat (`#/chat`).
- Subscribing to news — see Sources (`#/sources`).
- Grouping Watchlist stocks into lists — see Registered stocks
  (`#/registered`); adding a stock to the Watchlist or removing it, and
  reading one stock's chart, statements, company and news — see Stocks
  (`#/stocks`).
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
| 8. Check market prices at a glance | Home (arrange widgets; the server keeps them synchronised, ADR-0051) |
| 9. Track earnings announcement dates | Stocks (search every US and Japanese listed stock and add it to the Watchlist — the server fetches its earnings dates within seconds), Home (glanceable earnings-calendar widget with the month grid and an "Open Registered stocks" link) and Settings → Calendar (keep Google Calendar in step, export or subscribe to the calendar) |
| 10. Ask a research question on a schedule (ADR-0033) | Tasks (create, edit, pause, run now, delete), Home and the Notebook (glanceable scheduled-tasks widget with Pause/Resume, Run now, New task and "Open Tasks"; a Task result widget per task with its latest answer, ADR-0038) and Chat (each task's answers in its own chat) |
| 11. Follow a group of stocks' prices (ADR-0040) | Registered stocks (make titled lists of watchlist stocks — one tab each — add and remove stocks, Show on Home) and Home and the Notebook (a Watchlist prices widget per list with each stock's change from the previous close) |
| 12. Follow companies' annual financial statements (ADR-0048, ADR-0054) | Stocks (add the stock to the Watchlist — the server syncs every Watchlist stock's statements — and its Financial statements tab with the sync status, statements, revisions and filings), Home and the Notebook (a Financial statement widget and a Financial history chart widget per company) |
| 13. Read everything stored about one stock (ADR-0049) | Stocks (reached from a row's name on Registered stocks or a widget's link: Chart, Financial statements, Company and News tabs) |

## How the split was checked

Each user action above appears under exactly one page (exclusive), and every
journey step maps to a page (exhaustive). Dialogs such as the records drawer
and the delete-chat confirmation belong to the page that opens them (Chat);
the widget dialog belongs to Home. Since ADR-0054 no page offers a sync
action, so the earlier overlap (Sync now on Registered stocks and on the
Financial statements tab) is gone.
Web tests assert the Chat page shape (two states with collapse, a collapsed
secondary panel mounting none of its content, one workspace session and one
notebook session backing the open conversation, Chat/Notebook tabs below `lg`),
that Home has no composer, message list, run status or canvas region,
the old `#/canvas/<workspaceId>`, `#/canvas`, `#/workspace/<workspaceId>`
and `#/workspace` URLs open the Chat page, that the Registered stocks page
adds a stock (by symbol and from a search hit), shows its earnings and
stock-list status and links each row's name to the Stocks page, that the
Stocks page with no stock in the URL links to Registered stocks and reads
nothing, that `#/watchlist` and `#/equities` open Registered stocks, and
`tests/architecture/pagesDoc.test.ts` fails if this document drifts from
`apps/web/src/pages.ts` (titles, routes, purpose sentences).
