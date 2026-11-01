# ADR-0050: The Stocks page searches for stocks and adds the shown stock to the Watchlist

**Status:** Accepted · **Date:** 2026-11-01 · **Owner request:** "Please add a
stock search area to the stock data page, and add an "Add to Watchlist"
button to the stock info area. Users will be able to select which watchlist
to add the stock to."

This changes one point of [ADR-0049](0049-stocks-page-with-per-stock-tabs.md)
(amended 2026-11-01): the Stocks page (`#/stocks`, 株式データ) was to have
**no stock picker**. It now has a search, and the shown stock can be put on
the Watchlist and its lists from the page. Everything else in ADR-0049 — the
route, the four tabs, the reads from stored data only — is unchanged.

The same request also asked to remove the add form's direct stock-code input
("Enter a symbol instead", 銘柄コードを直接入力) on Registered stocks. That
form was being changed by a separate piece of work at the same time (the
owner's "Please merge 銘柄コードを直接入力 and 銘柄を検索", ADR-0034 §7), so
§1–§3 did not touch the add form. **Amended the same day (§4):** at the
owner's "Please delete 銘柄を追加 area." the whole add form left Registered
stocks.

**Amended 2026-11-01** by [ADR-0053](0053-every-sync-is-the-servers.md): §4:
"Update stock list" and the download on a visit are removed (the server
downloads the lists); §5: the table's Next announcement and Financials
columns and its status lines are removed; the Stocks page gained Remove from
Watchlist (ADR-0053 §5).

## Context

After ADR-0049's amendment, a stock reached the Stocks page only from a row
on Registered stocks or from a widget's link. To look at a stock you do not
follow, you had to add it first or type its id into the URL. Adding a stock
to the Watchlist and its lists was only possible on Registered stocks: the
add form, a row's "Add to Watchlist", and each list's Add stock dialog.

## Decision

### 1. "Find a stock" on the Stocks page

- A section headed **Find a stock** (銘柄を探す) sits at the top of the
  page, above the shown stock. It is there with or without a stock in the
  URL.
- It is the stock-directory search box (ADR-0034), unchanged: a WAI-ARIA
  combobox that searches the owner's stored US and Japanese stock lists by
  name or symbol, with the same keys (↓/↑, Enter, Escape) and the same
  status line.
- **A pick opens the stock.** Picking a hit pushes `#/stocks/<stockId>`
  (its Chart tab, a new history entry, so Back returns to the stock shown
  before), clears the box, and focus moves to the stock's heading, as for
  any link. Nothing is added.
- **Every hit can be picked.** In the add form a hit already on the
  watchlist is marked "Added" and cannot be picked. Here, where a pick only
  opens the stock, the page clears that mark (`openableSearchState`), so a
  registered stock opens too.
- **Nothing is read before the owner types.** `#/stocks` alone still sends
  no request. The first search reads the stored lists' status once (used to
  explain an empty answer, as on Registered stocks); if that read fails, the
  explanation is left out and the search still runs. The page never queues
  a stock-list download: that stays on Registered stocks (the "Update stock
  list" button and its once-per-visit rule).
- With no stock shown, the page's sentence now reads "Search for one above,
  or choose one on the Registered stocks page".

### 2. "Add to Watchlist" beside the stock's heading

- Once the watchlist has been read, the heading row shows the stock's place
  on the Watchlist: "On the Watchlist", followed by "In lists: …" when it is
  in any list.
- **The button:**
  - **Add to Watchlist** for a stock that is not on the watchlist.
  - **Add to a list** for one that is on the watchlist, while some list can
    still take it.
  - No button when there is nothing to add (on the watchlist, and every
    list either holds it or is full, or there are no lists).
- **The dialog** is modal, headed "Add 7203 to the Watchlist" (or "Add MSFT
  to lists"), with one checkbox per list in the owner's order:
  - A list that holds the stock is ticked and disabled, marked "Already in
    this list".
  - A full list (12 stocks, `WATCHLIST_LISTS_LIMITS`) is disabled, marked
    "Full · 12 of 12 stocks".
  - Every other list shows its count.
  - With no lists, the dialog says lists are made on Registered stocks and
    links there.
- **What Add does.**
  - With no list ticked, a stock that is not on the watchlist goes there
    alone. For a stock already on it, Add waits until a list is ticked.
  - Focus starts on the first list that can be ticked, else on Add.
  - Escape and Cancel close the dialog, and focus returns to the button.
    While a write is on its way both wait, so a refusal is still shown.
- **The writes are the existing ones.** No list ticked: `POST
  /api/v1/watchlist/stocks`. Each ticked list: `POST
  /api/v1/watchlist/lists/:listId/stocks`, one after another (the API puts
  the stock on the watchlist first). No new endpoint, schema or runner work.
- **After the writes:**
  - The watchlist is read again before the dialog closes (after a refusal
    too), so the status line, the button and the dialog's lists already show
    the result. Focus then returns to the button, or moves to the heading
    when no button is left. The button is not disabled while the page queues
    the new stock's dates, which would drop that focus.
  - The page's watchlist state outlives the control: when another stock is
    opened while a write is on its way, the re-read and the new stock's
    earnings dates still follow.
  - A stock that just went on the watchlist has its earnings dates fetched,
    exactly as an add on Registered stocks does (ADR-0039 scope), and a
    notice says so.
  - Adding a watched stock to lists only re-reads the watchlist and says
    "Added MSFT to Semis and Value."
  - The watchlist's automatic Google Calendar sync after the owner's own
    change applies as on Registered stocks: the calendar shows the
    watchlist, and leaving it out of sync until the next visit to
    Registered stocks would be wrong.
  - With `automaticRuns: false` the staleness refresh (ADR-0039's "a day
    old" rule) is never queued on this page — not even when a run the page
    started watching after an add ends. Only the new stock's own dates
    (and the follow-up for a stock added mid-run) are fetched.
  - A notice about one stock's add is cleared when another stock is shown.
- **A refusal keeps the dialog open** with its reason: a full watchlist, a
  full list, a list deleted meanwhile (`listFailureReason`). The lists added
  before the refusal show as "Already in this list" after the re-read.
- ADR-0049 §3 still holds: **showing** a stock never makes the runner fetch
  anything (`automaticRuns: false`). Only the owner's own Add queues the
  earnings-date fetch, the same consequence it has on Registered stocks.

### 3. Where it lives

- `apps/web/src/stocks/StockSearchArea.tsx`: Find a stock.
- `apps/web/src/stocks/StockWatchlistControl.tsx`: the status line, the
  button and the dialog.
- `apps/web/src/stocks/stocksModel.ts`: the pure helpers
  (`openableSearchState`, `listChoicesFor`, `canAddFromDetail`).
- `StockDetail` gains an `aside` slot beside its heading, and the strings
  are in `stocks.messages.ts`, English and Japanese.
- No API, schema, migration, runner or Lean change: the helpers are web
  presentation logic, not `packages/domain` algorithms.

### 4. Registered stocks loses its add form (*amended 2026-11-01*)

Owner request: "Please delete 銘柄を追加 area." Asked where the stock lists'
state and "Update stock list" (which lived at the bottom of that section)
should go, the owner chose **keep a small section** on Registered stocks.

- The **Add a stock** section (銘柄を追加) is gone from Registered stocks:
  its search box, the typed-symbol add of ADR-0034 §7, "Selected: …", "Add
  stock" and "Also sync annual financial statements".
  (`stocks/AddStockSection.tsx` and its pure helpers `resolveAddTarget`,
  `addTargetProblem`, `addTargetText` and `symbolMarket` are deleted with
  their strings.)
- A small section **Market stock lists** (銘柄一覧, `stocks/StockListsSection.tsx`;
  not "Stock lists", which already names the list tabs)
  stays below the table: each market's stored list with its count, date and
  source, "Update stock list", and the queue and load failures. Opening
  Registered stocks still downloads a missing or old list once per visit
  (ADR-0034, unchanged).
- **Where a stock is added now:**
  - The Stocks page's Find a stock plus Add to Watchlist (§1–§2).
  - A list's **Add stock** dialog on Registered stocks (ADR-0040 §7, with
    its own search; unchanged).
  - A tracked-only row's Add to Watchlist also stays.
  Typing a code that no stored list holds no longer adds it. A stock shown
  on the Stocks page by its URL or a widget's link (`#/stocks/us:NEWCO`)
  can still be added there; the API validates the symbol. With no list
  downloaded, the search's status line points at "Update stock list"; a
  recently listed stock a stored list lacks just finds no match until the
  list is updated.
- The Stocks page deliberately queues no stock-list download (ADR-0049 §3:
  showing or searching never makes the runner fetch). Opening Registered
  stocks does, once per visit, as before.
- Syncing a stock's financial statements is no longer offered at the moment
  of adding. It stays on the Stocks page's Financial statements tab ("Sync
  financial statements") and in a Registered stocks row's menu.
- Text that sent the owner to the add form now points at the Stocks page:
  the empty table ("Find a US or Japanese stock on the Stocks page…") and
  Settings → Calendar's "Add a stock to the Watchlist from the Stocks page
  to download its dates."
- The API is unchanged: `POST /api/v1/watchlist/stocks` stays (used by the
  Stocks page and a row's Add to Watchlist).

### 5. A quieter 銘柄とリスト header (*amended 2026-11-01*)

Owner request: delete the following from the 銘柄とリスト (Stocks and lists)
section: "財務諸表の同期: 20 社中 7 社", "最後に成功した更新: …" and the hint
"「新しいリスト」で「すべての銘柄」の隣に自分のタブを追加できます。…".

- The companies count ("Statements synced for n of 20 companies") is gone.
  The tracking limit is still enforced: at the limit, a row's "Sync
  financial statements" and the Stocks page's Financial statements tab say
  why they cannot sync another company.
- The section hint about New list and Show on Home is gone. The New list
  button and each list tab's actions are unchanged.
- The earnings-date refresh line shows only what needs the owner's eye
  (`watchlistStatusText` now returns null otherwise):
  - while a refresh runs: its run id and state, and the waits-for-the-runner
    note;
  - the last failure (code and the provider's status), when no refresh
    succeeded after it.
  An idle, successful refresh says nothing, because the dates in the rows
  are the result. The routine "Last successful refresh: …" is therefore no
  longer shown, but a failure or a run in progress still is: hiding those
  would hide an error. The `<output>` stays in the page while empty, so a
  run that starts or fails is announced to screen readers.
- Then (owner: "Please delete 登録銘柄: ウォッチリスト、続いて財務諸表を同期して
  いる企業"): the stock table's caption is no longer shown, on "All stocks"
  or on a list's tab. It stays in the page as the table's accessible name
  (`sr-only`), so a screen reader still announces what the table lists; the
  section heading and the tabs already say it on screen.

## Consequences

- A stock you do not follow can be found and read without adding it, and
  added to the Watchlist and its lists from where you read it.
- The Registered stocks page keeps the list management (new, rename,
  delete, Show on Home), each list's Add stock dialog and the stock-list
  downloads; since §4 it has no add form. The Stocks page only adds to
  lists that already exist.
- The Stocks page now reads the watchlist (one conditional read) whenever a
  stock is shown, as it already did to name the stock. The search's status
  read happens only after typing.

## Verification

- Web tests (`apps/web/test/stocks.test.tsx`):
  - Find a stock reads nothing until typing, reads the status once, opens a
    pick with a pushed entry and clears the box.
  - A registered hit can be picked.
  - Add to Watchlist with no list ticked sends one watchlist add and one
    earnings refresh, then shows "On the Watchlist" and "Add to a list" with
    focus on it.
  - Ticking two lists sends two list adds and no watchlist add or refresh;
    lists that hold the stock or are full are disabled. With nothing left to
    add, focus moves to the heading.
  - A full watchlist keeps the dialog open with the reason, and Escape
    returns focus to the button.
  - A stock not on the watchlist ticked into a list goes there with one list
    add (no separate watchlist add) and has its dates fetched.
  - A partial failure (a list deleted elsewhere) re-reads and shows what
    landed, with the reason.
  - Escape is ignored while a write is on its way.
  - Opening another stock mid-write still re-reads and queues the dates.
  - A list add while an earnings run is active queues no staleness refresh
    when that run ends (fails without the `automaticRuns` gate).
  - Japanese strings.
- Pure-helper tests: `stocksModel.test.ts`.
- Browser test: `tests/e2e/stocksSearch.spec.ts`. An isolated owner whose
  fixture stock lists are downloaded by the real E2E runner searches and
  opens stocks by pointer and by keyboard, then adds 7203 to the Watchlist
  and a list, read back from the API, with the CSP clean.
