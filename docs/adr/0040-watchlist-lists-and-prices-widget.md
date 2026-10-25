# ADR-0040: Watchlist lists and the Watchlist prices widget

**Status:** Accepted · **Date:** 2026-10-25 · **Owner request:** "Allow
users to create titled lists in Watchlist. Users can optionally add stocks
to these lists. Also, allow users to add a widget to the home page that
displays the price changes (from previous close) for stocks in their custom
watchlists."

**Amended 2026-10-25** at the owner's request ("merge 登録済みの銘柄 and list
in watchlist"): the lists are tabs over the one stock table (§7).

## Context

The Watchlist page (FR-018) holds one flat set of up to 50 stocks whose
earnings dates the runner refreshes. There is no way to group them
("Semiconductors", "Japan banks"), and Home shows stock prices only through
widgets that name market series one by one (`stock-table`, `market-metric`).

Prices already exist: a Twelve Data series is a stock's **daily closes**
(ADR-0014, ADR-0025), so "change from the previous close" is the latest
observation against the one before it — what `summarizeSeries(...).change`
and the Stock table's change columns already compute. No new provider, no
new runner fetch.

Asked on 2026-10-25, the owner chose:

- **lists group watchlist stocks**: a list holds stocks of the watchlist;
  adding a stock to a list also adds it to the watchlist (so its earnings
  dates are tracked too); removing a stock from the watchlist takes it out
  of every list; one stock can be in several lists;
- **at most 12 stocks per list** (one Stock table's worth; Twelve Data's free
  plan allows 8 requests a minute, so a full list refreshes in about 1.5
  minutes);
- the widget on **Home and in the Notebook** (one widget specification,
  ADR-0024);
- Claude subagents implement it.

## Decision

### 1. Lists

A list is `{ listId, title, stockIds, version, createdAt, updatedAt }`
(`watchlistListSchema`, `packages/contracts/src/watchlist.ts`):

- `title`: 1–80 characters after trimming, no control characters (a
  single-line name). Titles need not be unique (a
  list is identified by its id; the pickers show the stock count beside the
  title).
- `stockIds`: watchlist stock ids, in the order they were added to the
  list, no repeats, at most `WATCHLIST_LIST_LIMITS.maxStocksPerList` (12 =
  `DASHBOARD_LIMITS.maxTableSeries`). Every member is on the watchlist
  (the response schema refuses anything else).
- At most `WATCHLIST_LIST_LIMITS.maxLists` (20) lists per owner, in creation
  order. A new list is empty ("optionally add stocks").
- `version` starts at 1 and is bumped by every change to the list: a rename,
  a stock added or removed, and a removal of one of its stocks from the
  watchlist. The `/watchlist` ETag covers each list's id and version, so the
  page's existing poll sees every change.

The bounds live once, in the domain (`WATCHLIST_LIST_LIMITS`,
`packages/domain/src/watchlist/lists.ts`); contracts re-export them.

Storage: migration `0013_watchlist_lists.sql` — `watchlist_lists` (one row
per list) and `watchlist_list_stocks` (one row per membership, WITHOUT
ROWID), no secondary index. Membership integrity is kept set-based in the
same batch as the change (no FK enforcement, like every other table):

- removing a watchlist stock deletes its memberships and bumps those lists'
  versions in the watchlist removal's batch;
- deleting a list deletes its memberships in the same batch;
- the "stock is on the watchlist" and "list has room" rules are enforced
  inside the membership INSERT itself (`INSERT … SELECT … WHERE EXISTS …
  AND (SELECT COUNT(*) …) < ?`), so interleaved requests cannot break them.

### 2. API

All owner-authenticated, all answering the full `WatchlistResponse` (which
now carries `lists`), like the existing watchlist routes — 201 for a
created list, 200 otherwise:

```text
POST   /api/v1/watchlist/lists                    { title }            create
PATCH  /api/v1/watchlist/lists/:listId            { title }            rename
DELETE /api/v1/watchlist/lists/:listId                                 delete
POST   /api/v1/watchlist/lists/:listId/stocks     { market, symbol }   add a stock
DELETE /api/v1/watchlist/lists/:listId/stocks/:stockId                 remove a stock
```

- Adding a stock that is not on the watchlist first adds it to the
  watchlist exactly as `POST /watchlist/stocks` does (directory name, the
  50-stock cap, the audit row), then to the list. A full watchlist answers
  `WATCHLIST_FULL` and adds nothing. The service checks the list exists and
  has room *before* touching the watchlist, so the common failures add
  nothing; a lost race may leave the stock on the watchlist only, which is a
  valid state. The client queues the earnings-date refresh after such an
  add as it does after a plain add.
- Adding a stock already in the list changes nothing (idempotent, 200).
- Errors use the stable envelope: an unknown list or a stock not in the
  list → 404 `NOT_FOUND`; 21st list → 400 `VALIDATION_FAILED` with reason
  `WATCHLIST_LISTS_FULL`; 13th stock → `WATCHLIST_LIST_FULL`; a bad title or
  symbol → `VALIDATION_FAILED`.
- Every change is audited (`watchlist.list.create`, `.rename`, `.delete`,
  `.stock.add`, `.stock.remove`; the title is never written to the audit
  detail — it is owner text).
- Removing a stock from a list, deleting a list and removing a watchlist
  stock delete the price series no page tracks any more (§4), like a Home
  save does (S4b).
- Owner export/import does not carry the watchlist today, so it does not
  carry lists either.

### 3. Which series is a stock's price

The ONE mapping is `stockPriceSeriesId(market, symbol)` in the domain:

- US: `twelve-data:<symbol>` (`twelve-data:AAPL`, `twelve-data:BRK.B`);
- JP: `twelve-data:<code>:JPX` (`twelve-data:7203:JPX`).

Twelve Data's free plan does not include JPX listings: such a row shows the
stored reason (`SERIES_NOT_FOUND` / `PLAN_NOT_ENTITLED`, "unavailable (…)"),
exactly as a Stock table row does. No other source is added for Japanese
prices in this decision.

### 4. Which series a page shows and the runner refreshes

A `watchlist-prices` widget names no series itself
(`dashboardWidgetSeriesIds` gives none, so the Home and notebook series cap
checks are unchanged). A page's series are computed by the domain's
`pageSeriesIds(widgets, listSeries, limit = 30)`:

1. every series the page's widgets name themselves, first appearance first
   (`distinctDashboardSeriesIds`, as today);
2. then, for each `watchlist-prices` widget in widget order, its list's
   stocks' series in list order;

each id once, stopping at `DASHBOARD_LIMITS.maxSeries` (30). Named series
come first so that adding a list widget, or a stock to a list, can never
push a series out of a widget that names it. A list row past the limit is
not served; the widget computes the same function from the `/watchlist`
lists and says so on that row ("Not shown: this page already shows 30 price
series") instead of a misleading "no data". A widget whose list was deleted
contributes nothing.

Where the rule is applied (one application helper, not copies):

- `GET /home/data` and its digest: `pageSeriesIds` over the dashboard,
  replacing `distinctDashboardSeriesIds(...).slice(0, maxSeries)`. The
  digest ETag already lists the series ids, so a list change that changes
  the page's series changes the ETag.
- The notebook's market data read: the same over the notebook's widgets.
- The market-refresh claim (`prepareMarketClaim`): Home's page series
  first, then every notebook's named series and list series
  (`NotebookRepository.listWatchlistListIds`), de-duplicated, at most
  `maxTrackedSeries` (60) — `unionSeriesIds` as today. A narrow
  ("unrefreshed", ADR-0039) claim also leaves out a series whose last
  refresh stored `SERIES_NOT_FOUND` or `PLAN_NOT_ENTITLED` and no data — a
  Japanese listing on Twelve Data's free plan — so a list of Japanese
  stocks does not spend the 8-a-minute budget on every widget or stock add;
  a full refresh still asks again.
- The completion's "still tracked" filter: the uncapped keep set below, so
  a series the claim fetched is not dropped because a page gained series
  while the run was in flight.
- The keep set of every series clean-up (`deleteSeriesNotIn` after a Home
  save or reset, and the list changes in §2): Home's and every notebook's
  named and list series, uncapped. A notebook save deletes no series, as
  before this decision.

`pageSeriesIds` is proved in Lean (`formal/ResearchFormal/PageSeries.lean`):
the result has no repeats and at most `limit` ids; it begins with the named
series (all of them when they fit); every id in it is a named or listed
series; and when the distinct total fits, nothing is left out.

### 5. The widget type `watchlist-prices`

A new type of the one widget specification (ADR-0024), on Home and in the
Notebook, in `MARKET_WIDGET_TYPES` after `earnings-calendar` (it reads the
watchlist and shows market series, like the calendar reads the watchlist).
Its only content field is `listId` (an `idSchema` id). Sizes Small, Medium,
Large; default Medium. The stored `title` is the list's title when the
widget was added: the frame hides it (ADR-0024), it stays the accessible
name; the body always shows the list's *current* title.

It has no `Edit…` item: the list is chosen when it is added. To show
another list, the owner adds another widget (as for Task result, ADR-0038).

What it shows — after the Apple widget guidelines (glanceable, one list,
no chrome), reusing the Stock table's row logic:

- the list's current title and its stock count;
- one row per stock in list order: symbol and company name, the last close
  with its unit, the change from the previous close as an amount and a
  percentage (sign and colour, never colour alone — the
  existing `ChangeCell`), and the as-of date (Medium and Large). Small shows
  as many rows as fit with symbol and percentage only; Large shows every
  column;
- each row with data is a button opening the detailed chart viewer for that
  stock (ADR-0025), like a Stock table row;
- the Twelve Data in-session note and the source line, as the Stock table.

States: loading; an empty list ("No stocks in this list yet" with a link to
the Watchlist page); the list deleted ("This list was deleted" — the owner
removes the widget from its menu); a row without data ("unavailable
(reason)", or "Not shown: …" past the page limit, §4); the watchlist load
failed (Retry). A series with no observations yet triggers the page's one
automatic refresh of unrefreshed series (ADR-0039), so prices appear without
a click after a list gains a stock.

### 6. Adding one

- **Add menu** (Home and Notebook): "Watchlist prices" opens a small dialog
  listing the owner's lists (title and stock count); choosing one places
  the widget. With no lists, the dialog says so and links to the Watchlist
  page.
- **Watchlist page**: each list offers **Show on Home**, which appends a
  Watchlist prices widget for it to Home (or says it is already there).

### 7. The Watchlist page

One **Registered stocks** section below the add-a-stock form holds the
stocks and the lists (amended 2026-10-25; the first version had a separate
Lists section of cards): tabs over one stock table.

- **Tabs** (WAI-ARIA tabs pattern: one tab stop, ← / → wrap, Home / End,
  `aria-selected`, `aria-controls` → the one table panel): "All stocks (N)"
  first, then one tab per list in creation order, "Title (n)". On a phone
  the strip scrolls sideways inside itself; the page never does.
- **All stocks** is the registered-stocks table as before: the earnings
  columns, each row naming the lists its stock is in ("In lists: …"),
  Remove with its confirmation — which says when the stock will also leave
  lists ("Also removes it from 2 lists") — and the earnings refresh button
  and status line.
- **A list's tab** shows "Title · n of 12 stocks" with **Add stock**,
  **Show on Home** and a menu (Rename…, Delete… with confirmation), then the
  same table filtered to the list's stocks in list order, with **Remove
  from list** per row (focus moves to the next row's, else to Add stock).
  Add stock opens a dialog offering the watchlist's stocks not yet in the
  list (checkboxes) and the stock search box (ADR-0034) for a stock not on
  the watchlist yet (adding it also adds it to the watchlist, which the
  dialog says). A full list (12) disables Add stock and says why; an empty
  list says so.
- **New list** sits in the section header and opens a dialog with a title
  field; the new list's tab is then selected and focused. Deleting a list
  selects and focuses "All stocks"; a rename keeps its tab selected. The
  selected tab survives re-reads, and a list deleted elsewhere falls back
  to "All stocks".

### 8. Agents

Agents (the notebook assistant, the Home MCP server) may move, resize and
remove a `watchlist-prices` widget like any other, but cannot add one or
change its `listId` (`ownerPlacedOnly`, ADR-0038 §6): they cannot look lists
up. Agents cannot create or edit lists.

### 9. What does not change

- Both runners fetch exactly the series the claim names; the Rust runner
  only learns the new widget type, because notebook bodies it validates may
  hold one.
- The earnings refresh, the calendar feed and Google sync read the watchlist
  as before; lists are not part of them.
- Existing widgets, the 30-series rule of a Home save and the stored
  dashboard format are unchanged.

## Consequences

- One more widget type and one more page section; `PAGES.md`, the
  design-conformance test and the widget specification list them.
- A Home page with many list widgets can reach the 30-series limit; the rows
  past it say so. Raising the limit is a separate decision (ADR-0010 data
  volume).
- Japanese stocks show "unavailable" prices on Twelve Data's free plan.
- Deleting a list leaves its widgets in place, showing "This list was
  deleted".
- Rollback: the migration's rollback note; stored `watchlist-prices` widgets
  must be removed from Home and notebook bodies first, since the older code
  cannot read the type.
