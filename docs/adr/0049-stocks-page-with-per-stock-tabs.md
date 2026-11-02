# ADR-0049: One Stocks page, with each stock's chart, statements, company and news in tabs

**Status:** Accepted · **Date:** 2026-10-31 · **Owner request:** "For each
stock, organize its price chart, financial statements, company information,
and news into a single unified tabbed interface … Use lazy loading … Cache
previously loaded tab data … Ensure that all displayed data is retrieved
through the existing backend and database architecture. Define each tab's
interaction details." Then: "Please use data in db and merge stocks data
page."

Asked on 2026-10-31, the owner chose:

- **Watchlist + Equities → one Stocks page.** The two pages become one
  (`#/stocks`, 株式データ): one stock list, and the selected stock's four
  tabs.
- **Data in the database only.** Every tab shows what is already stored;
  opening a tab never makes the runner fetch anything. (The owner also
  picked SEC profile fields for the Company tab and GDELT company news for
  the News tab; both need new runner fetches, so they are §9 follow-ups,
  not part of this decision.)

**Amended 2026-11-01** at the owner's request ("Please create 登録済みの銘柄
page and delete 登録済みの銘柄 area in 株式データ page."): the stock list
moves to a page of its own, **Registered stocks** (`#/registered`,
登録済みの銘柄), and the Stocks page keeps only one stock's detail. The owner
chose that the add-a-stock form moves with the list, and that the Stocks
page gets **no stock picker**: a stock is opened from a row's name on
Registered stocks or from a widget's link. Seven pages now. The changed
parts are marked *Amended 2026-11-01* in §1–§3; the tabs (§3 tab strip,
§4–§7), the reads and the verification are unchanged. No API, schema,
runner or Lean change.

**Changed by [ADR-0050](0050-stocks-page-search-and-add-to-watchlist.md)
(2026-11-01):** the Stocks page now has a "Find a stock" search (a pick opens
the stock) and an Add to Watchlist button beside the stock's heading. The
"no stock picker" choice above no longer holds; the rest of this decision
does.

**Amended 2026-11-01 (Company tab)** at the owner's request ("Please delete
提出者 and 主要な数値,このワークスペースでの状態 in stocks data."): the Company
tab shows the Listing group only; its Filer, Key figures and On this
workspace groups are removed (§6). The filer's identity and sync stay on the
Financial statements tab and on Registered stocks; the watchlist state stays
on the Add to Watchlist button and on Registered stocks.

**Amended 2026-11-01** by [ADR-0054](0054-every-sync-is-the-servers.md): the
Registered stocks table (§2) shows only the lists' stocks (no "All stocks"),
without the Next announcement and Financials columns or the row's financials
menu (ADR-0054 §5).

**Amended 2026-11-01** by ADR-0055, since deleted and replaced by
[ADR-0058](0058-every-stock-is-synced.md) §9: the Chart tab's empty state
has no "Open Home" link (§4); the Financial statements tab shows a stock's
stored statements when the server no longer syncs them, and no sync status
line (§5; ADR-0058 §9.3–9.4).

**Amended 2026-11-02** by [ADR-0058](0058-every-stock-is-synced.md): every
listed stock is synced, so no tab tells the owner to add a stock to the
Watchlist to get its data — a stock with nothing stored says its data is on
the way and re-reads while shown (Chart, Financial statements, Company), a
stock outside the stored stock lists says none will come; a Japanese
stock's chart notes J-Quants Free's 12-week delay; tracked companies no
longer add rows (§2) and the Financial statements tab reads the stock's
company from its profile, not from the tracked-companies list.

## Context

A stock's data already lives in four stores, and the owner reads it on two
pages:

| Data | Stored in | Read today by |
|---|---|---|
| Daily closes | `market_series` / `market_observations` (`twelve-data:AAPL`, `twelve-data:7974:JPX`, `stockPriceSeriesId`) | Home and notebook widgets only (`/home/data`, notebook market data) |
| Annual statements | `equity_company`, `equity_metric_value`, `equity_report_filing` (ADR-0048) | Equities page, Financial widgets |
| Identity | `stock_directory` (names EN/JA, listing), `watchlist_stocks`, `equity_company` (CIK / EDINET code, fiscal year end) | Watchlist search, Equities table |
| News | `articles` from the owner's Sources feeds, with no company tag | Sources page |

The Watchlist page holds the stocks the owner follows (earnings dates,
lists); the Equities page holds the companies whose statements are synced
(at most `EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies`). Both are keyed by
the same stock id (`us:AAPL`, `jp:7974`), so they merge without a schema
change.

No read returns one stored price series by stock, nor the articles that
mention a company, nor one directory entry by id.

## Decision

### 1. The page and its route

`watchlist` and `equities` leave `PAGES`; `stocks` takes the Watchlist's
place in the navigation (title "Stocks" / 「株式データ」, purpose "Follow US
and Japanese stocks and read each one's price chart, financial statements,
company information and news from the stored data."). Six pages remain.

*Amended 2026-11-01:* `registered` joins `PAGES` before `stocks` (title
"Registered stocks" / 「登録済みの銘柄」, purpose "Add US and Japanese stocks,
group them into lists, and keep their earnings dates and financial
statements synced."), and the Stocks purpose becomes "Read one stock's
price chart, financial statements, company information and news from the
stored data." (「1 銘柄の株価チャート・財務諸表・企業情報・ニュースを保存済みのデータで確認します。」).
Seven pages: Home, Registered stocks, Stocks, Tasks, Chat, Sources and
Settings (reached from the owner ID).

Routes (`router.ts`):

- `#/stocks` — the list, no stock selected;
- `#/stocks/<stockId>` — that stock selected, Chart tab;
- `#/stocks/<stockId>/<tab>` — `tab` ∈ `chart`, `financials`, `company`,
  `news` (`STOCK_TABS`).

An invalid stock id or tab parses as `#/stocks` (the tab alone falls back
to `chart`). Old links keep working: `#/watchlist` and `#/equities` open
`#/stocks`; `#/watchlist/calendar[/…]` still opens Settings → Calendar
(ADR-0022). Choosing a stock **pushes** a history entry (Back returns to
the previous stock or the bare list); switching tabs **replaces** it
(`navigate(route, { replace: true })`), so Back never walks through tabs.
`stocksHash(stockId, tab)` builds the links; the Financial widgets' "Open
Equities" link becomes "Open in Stocks" to
`#/stocks/<stockId>/financials`, and every Watchlist link opens `#/stocks`.

*Amended 2026-11-01:* `#/stocks` alone is the Stocks page with **no
stock** (it says where to choose one and reads nothing), and a bad stock id
opens it too. `#/registered` (and `#/registered/<anything>`) is the
Registered stocks page. `#/watchlist` and `#/equities` now open
`#/registered`, where their lists and actions live; `#/watchlist/calendar…`
still opens Settings → Calendar. `STOCKS_HASH` is replaced by
`REGISTERED_STOCKS_HASH`, and every "manage your stocks" link — the
Earnings calendar widget (empty state, the no-upcoming sentence, the
month grid's days, "Open Registered stocks"), the Watchlist prices widget's
empty state, the list and financial widget dialogs, Settings → Calendar and
the not-synced / at-limit API error messages — opens it. The financial
widgets' "Open in Stocks" still opens `#/stocks/<stockId>/financials`. A
row's name on Registered stocks is a link to `#/stocks/<stockId>` (a pushed
history entry); tab switches still replace it. The top bar's Stocks link
reopens the stock last shown in this browser tab (as the Chat link reopens
the open conversation), otherwise `#/stocks`.

### 2. The stock list

*Amended 2026-11-01:* this list, the add-a-stock section and everything the
last paragraph below keeps are the **Registered stocks** page
(`RegisteredStocksView`), headed "Stocks and lists" (「銘柄とリスト」; the
page header already carries the page title). The watchlist and companies
reads, the merged rows and the sync / track outcomes are shared by both
pages through `createStockRegistry` (`stocks/stockRegistry.ts`); each page
creates its own, and only one is mounted. A row's name is a link, not a
Show button: no row is selected or highlighted.

One table over the union of the watchlist's stocks (in the order they were
added) and the tracked companies that are not on the watchlist (in tracking
order after them), keyed by stock id (`mergeStockRows`, pure, web). The
Watchlist's list tabs (ADR-0040 §7) stay over it: "All stocks (N)" shows
the union; a list's tab shows its stocks in list order, as before.

Each row: symbol and name (the name is the **Show** button, `aria-pressed`
on the selected row, which is also highlighted — *amended 2026-11-01:* a
link to the stock on the Stocks page), market, next earnings
announcement (as on the Watchlist; "Not on Watchlist" for a tracked-only
stock), **Financials** (one line: the sync status as the Equities table
said it, its failure code, or "Not synced"), "In lists: …", and actions:

- on the Watchlist: Remove (confirmation, as before) / Remove from list on
  a list's tab;
- not on the Watchlist: Add to Watchlist;
- a menu: Sync financials now (tracked companies), Sync financial
  statements / Stop syncing financial statements (with confirmation: the
  data is kept, ADR-0048 §7).

Removing a stock from the Watchlist does not stop its statement sync, and
stopping the sync does not remove it from the Watchlist: a stock leaves the
list only when it is in neither (then a selected one is deselected, the URL
going back to `#/stocks`). *Amended 2026-11-01:* that deselect rule is
removed — a stock shown on the Stocks page stays shown when it stops being
registered, and its tabs say what is stored.

Adding: the Watchlist's add-a-stock section (directory search, "Enter a
symbol instead" — *amended 2026-11-01:* merged into the search box,
ADR-0034 §7) gains one checkbox, "Also sync annual financial
statements", checked by default and disabled with its reason at the
tracking limit. "Add stock" adds to the Watchlist and, when checked, tracks
the company (two existing writes; a failure of the second is reported on
its own and leaves the first). The Equities page's own track form goes.
*Changed by [ADR-0050 §4](0050-stocks-page-search-and-add-to-watchlist.md)
(2026-11-01):* the add-a-stock section, with this checkbox, is gone;
stocks are added from the Stocks page, and statements are synced from its
Financial statements tab or a row's menu.

Everything else of the Watchlist page stays as it was: directory status
lines and automatic downloads, the earnings refresh status and automatic
refresh, the list tabs and their actions (Add stock, Show on Home, Rename,
Delete), Google sync after a change.

### 3. The stock detail

*Amended 2026-11-01:* the detail is the whole Stocks page, not an area
below the list. Its stock comes from the URL only; above the heading a
"Choose another stock" link (「別の銘柄を選ぶ」) opens Registered stocks.
With no stock in the URL the page says "No stock is shown. Choose one on
the Registered stocks page to see its chart, financial statements, company
information and news." with an "Open Registered stocks" link, and reads
nothing. Once a stock is shown, the page reads the watchlist and the
companies (through `createStockRegistry`) only to name the stock and to
offer the Financial statements tab's Sync financial statements; a read failure shows its notice with Retry. Those reads only
read: the watchlist state's once-per-visit earnings refresh and automatic
Google sync run on Registered stocks alone (`automaticRuns: false` here),
so showing a stock never makes the runner fetch anything. Rule 5 below holds:
the tabs take the stock's watchlist entry and company from those reads.

Below the list, when a stock is selected: a `Section` headed with the
stock's name and symbol ("Apple Inc. · AAPL", 「任天堂 · 7974」), a tab strip,
and the selected tab's panel. With no stock selected the area says "Choose
a stock to see its chart, financial statements, company information and
news." Nothing is selected by default, so opening the page reads only the
list.

**Tab strip** — the WAI-ARIA tabs pattern with automatic activation, the
one `Tabs` component the list tabs use too (generalised from `ListTabs`):
one tab stop (the selected tab), ←/→ wrap, Home/End, each tab
`aria-controls` its own panel (`role="tabpanel"`, `aria-labelledby` its
tab, `tabindex="0"`). On a phone the strip scrolls sideways inside itself.
Labels: Chart, Financial statements, Company, News (チャート, 財務諸表, 企業情報,
ニュース). Choosing a stock from the list moves focus to the detail heading
and scrolls it into view (*amended 2026-11-01:* a stock opened by a link —
a Registered stocks row, a widget — gets focus on its heading on the Stocks
page, scrolled into view, once per stock); choosing a tab keeps focus on
the tab.

**Lazy, kept, cached** — the performance rules of this page:

1. A tab's code is its own chunk (`lazy()`), downloaded on its first
   showing; pointer-enter or focus on a tab preloads it.
2. A tab's panel mounts on its first showing for the selected stock and
   stays mounted (hidden) while that stock stays selected, so switching back
   is instant and keeps its state (chart window, statement choice, scroll,
   loaded news pages). Choosing another stock disposes the panels.
3. Reads go through shared caches keyed by (API client, stock or company,
   read): `createReadEntry` / `createReadCache` in `lib/readCache.ts`, which
   `financialStore` now uses too. One in-flight request per read, an ETag
   kept per read (an unchanged answer is a 304, answered from a digest
   before any row is loaded), the last answer kept for the visit (at most 32
   stocks' reads beyond the shown ones, least recently used dropped first),
   so returning to a stock or tab shows its data at once. A read answered
   less than a minute ago (`freshMs`, 60 s) is shown again **without a
   request**; an older one is re-checked conditionally. A failed read is
   never fresh, and a finished statement sync marks the company's hidden
   reads stale (`invalidate`), so the next showing re-reads at once. The
   News tab keeps the pages of at most 16 stocks (and 24 appended pages);
   the statement reads are bounded by the tracking limit (20 companies).
4. Only a **shown** read re-checks: on its showing (outside the minute
   above), every 5 minutes while the page is visible, and on return to the
   browser tab — never while hidden or while its panel is hidden.
5. Each panel reads only what it shows (below); the list's two reads
   (watchlist, companies) are not repeated by the tabs — the detail takes
   the stock's watchlist entry and company from the page.

### 4. Chart tab

Reads `GET /api/v1/stocks/:stockId/prices` → `{ stockId, seriesId, series }`:
the stored price series of `stockPriceSeriesId` with its newest
`MARKET_LIMITS.maxObservationsPerResponse` observations (the shape every
market widget reads), or `series: null` when none is stored.

- **Summary line** above the chart: last close with its unit, change from
  the previous close as an amount and a percentage (sign and colour, never
  colour alone), as-of date, source link — the Stock table's numbers
  (`summarizeSeries`). (*Removed 2026-11-01 at the owner's request, "Please
  add 1 day button in chart. Please delete 終値 … 前回比 … 時点 … 出典 …
  Twelve Data の日足：… and — 日次終値.": the summary line and the Twelve
  Data in-session note under it are gone, and the viewer is titled with
  the stock alone ("Apple Inc. · AAPL", no "— daily closes"). The latest
  close and its change from the previous close are the viewer's 1D preset
  (ADR-0025, added the same day); the source stayed in the data-table
  twin's provenance until that twin was removed too (below).*) (*Then also removed 2026-11-01 at the owner's
  request, "Please delete COCA COLA CO · KO in chart tab on stocks
  data.": the viewer shows no title heading of its own — the page heading
  above the tabs already names the stock — and the title ("Apple Inc. ·
  AAPL") only names the viewer's region and plot for assistive
  technology.*)
- **The chart** is the detailed chart viewer of ADR-0025 rendered **inline**
  (not a dialog): range presets (opening at 1Y), exact From/To dates,
  interval / scale / values, moving averages, crosshair with readout,
  overview navigator and visible-window statistics. (*The data-table twin
  ("historical price data", "Data table: Apple Inc. · AAPL" with the
  source under it) was removed 2026-11-01 at the owner's request, "Please
  delete データ表: COCA COLA CO · KO in stocks data.": the statistics give
  the visible window's numbers; the dialog viewer of Home and the Notebook
  keeps its twin.*) Its keyboard model is the viewer's; Escape does
  nothing here (there is no dialog to close). Nothing it does is saved.
- **No stored prices**: "No prices are stored for AAPL. Prices are
  downloaded for stocks shown on Home or in a notebook." with an "Open Home"
  link; a stored series that is unavailable says its reason with the
  existing unavailable text (Japanese stocks on Twelve Data's free plan).
  The tab never queues a refresh.

### 5. Financial statements tab

The Equities page's company detail, moved: the statement switch (income
statement / balance sheet / cash flow), 5 or 10 years, `StatementTable`
with its marks and the revision dialog, "Add statement to Home", the metric
choice and "Add chart to Home" (*removed 2026-11-01 at the owner's request,
"Please delete この財務諸表をホームに追加 and チャートをホームに追加 in stocks
data." — Home's add menu places the Financial statement and Financial
history widgets*), and the filings table (in a disclosure
"Filings (n)", closed by default — its read starts when it is opened). The
sync status line with its failure heads the tab (*removed 2026-11-01 by
ADR-0055, now ADR-0058 §9.4: the tab shows no sync status*) (*amended 2026-11-01:*
its "Sync now" button was removed at the owner's request, "Please delete
今すぐ同期 buttom in 財務諸表." — a tracked company is synced now from
Registered stocks' row menu, Sync financials now). A stock
whose company is not tracked shows "Annual financial statements are not
synced for this stock." and "Sync financial statements" (disabled with its
reason at the limit); a tracked company with no values yet says so. Reads:
the existing statement and filings reads (`financialStore`), unchanged.

### 6. Company tab

Reads `GET /api/v1/stocks/:stockId` → `{ stockId, market, symbol,
priceSeriesId, directory }`, `directory` = the stored directory entry
(`name`, `localName`, `listing`) or null, plus the watchlist entry and
company the page already holds. Shown as description lists:

- **Listing** — company name in English and Japanese (the UI language's
  first), symbol, market, listing (Nasdaq, NYSE, Prime, …), stock id;
  "not in the stored stock list" when the directory has no entry.
- *Removed 2026-11-01 (see the amendment above):* **Filer** (SEC CIK or
  EDINET code, fiscal year end, newest fiscal year, annual filings stored,
  last sync), **Key figures** (the newest fiscal year's main values, read
  from the Financial tab's statement entries) and **On this workspace** (on
  the Watchlist since, its lists, the next earnings announcement). The tab
  now makes one read, the stock's profile.

Missing values say why (never blank, never 0).

*Amended 2026-11-01 by [ADR-0053](0053-business-description-from-annual-filings.md):*
the profile read also returns `business`, and a **Business** group below
Listing shows the business description from the newest annual report (10-K
or 有価証券報告書) — summary, "Show more", the filing's link — or why there
is none.

### 7. News tab

Reads `GET /api/v1/stocks/:stockId/news?cursor=` → `{ stockId, terms,
articles, nextCursor }`: the owner's stored articles (Sources feeds) that
mention the company, newest first (`retrieved_at`, `article_id`, the
existing article index), at most `STOCK_LIMITS.newsPageSize` (20) a page.

- **Which articles** — the domain's `stockMentionTerms` builds up to four
  terms from the stored names (directory English and Japanese name, company
  name, watchlist name; corporate suffixes such as "Inc.", "Corporation",
  "Co., Ltd.", "CO.,LTD.", "& CO", SEC tags such as "/DE/" or "/MN",
  株式会社 removed) and, for a US stock, the symbol when it has at least three
  characters (a shorter one — "F", "AI", "GE" — stands alone in ordinary
  text, and its `LIKE` prefilter would pass nearly every article; such a
  stock is found by its name);
  `articleMention` finds the first term in an article's title or excerpt: an
  ASCII term matches case-insensitively at word boundaries (the symbol
  case-sensitively), a space or hyphen in a term matches either, and a term
  with Japanese text matches as a substring. Japanese stock codes are not
  terms (a four-digit number matches amounts). Proved in Lean (§8).
- **The query** — SQL selects candidates with `LIKE` patterns
  (`mentionLikePattern`, escaped, and cut to the longest prefix of whole
  characters within 50 UTF-8 bytes — D1 refuses a longer pattern; a prefix
  occurs wherever the term does) on the owner's articles below the cursor,
  in index order, `STOCK_LIMITS.newsCandidateBatch` at a time, and
  `articleMention` keeps the true mentions; the API reads at most
  `STOCK_LIMITS.newsMaxBatches` batches per request, so a page costs bounded
  work. The cursor is the last scanned candidate. ETag: the owner's newest
  article stamp and the terms.
- **Each article** — title as a link (opens the article, `SafeLink`),
  publisher, published date (else retrieved date), the excerpt when the
  source's license allows one, and "Mentions: Nintendo".
- **More** — "Show more" reads the next page and appends it; the pages stay
  while the stock stays selected.
- **None** — "No stored article mentions Nintendo. Articles come from the
  feeds chosen on Sources." with a link to `#/sources`, and the terms
  searched for.

### 8. Verification and measurement

- Lean: `formal/ResearchFormal/StockMentions.lean` models `articleMention`
  (soundness: a returned term occurs at a boundary; completeness: if a term
  occurs at a boundary, the first such term in term order is returned) and
  `mentionLikePattern` (a boundary match implies the `LIKE` prefilter
  matches, so the SQL never drops a true mention); conformance vectors tie it
  to the TypeScript.
- `bun run bench`: `mergeStockRows` over the largest list (watchlist limit +
  tracked limit) and `articleMention` over a batch of candidates have
  budgets.
- Tests: domain unit tests, API tests on real local D1 (Workers project) and
  SQLite, DOM tests per tab, E2E for the merged page and the tab
  interactions on all three engines, and the real-environment spec on the
  development server.

### 9. Follow-ups (owner's picks that need new fetches)

Not built here, because this decision reads stored data only:

- **SEC profile fields** — keep industry (SIC), state of incorporation,
  address, phone, website, former names and exchanges from the submissions
  JSON the `financial-sync` job already downloads (no extra request): a
  migration, both runners, the Company tab's "Profile" group.
- **GDELT company news** — a runner job that stores company news from GDELT
  (key-free, as `news.search`) beside the Sources articles, read by the
  same News tab.

## Consequences

- One page and one URL per stock and tab; old Watchlist and Equities links
  land on it (*amended 2026-11-01:* on Registered stocks, the list they
  managed).
- *Amended 2026-11-01:* managing stocks and reading one stock are two
  pages. Changing stocks is a round trip through Registered stocks (or a
  widget's link, or Back); the Stocks nav link brings back the last stock
  shown.
- No migration and no runner change; three read endpoints, each answered
  from existing tables and indexes, with ETags.
- A stock no page shows has no stored prices; its Chart tab says so instead
  of fetching.
- News is only as good as the owner's feeds and the name match: an article
  that names a product but not the company is missed, and a common-word name
  ("Apple") can match an unrelated article.
- The Equities page's company table columns (CIK / EDINET code, fiscal year
  end, newest fiscal year, filing count) move to the Company tab; its sync
  status stays on the row. *Amended 2026-11-01:* the Company tab no longer
  shows them (its Filer group was removed).
