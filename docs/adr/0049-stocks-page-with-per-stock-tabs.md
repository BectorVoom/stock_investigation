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

### 2. The stock list

One table over the union of the watchlist's stocks (in the order they were
added) and the tracked companies that are not on the watchlist (in tracking
order after them), keyed by stock id (`mergeStockRows`, pure, web). The
Watchlist's list tabs (ADR-0040 §7) stay over it: "All stocks (N)" shows
the union; a list's tab shows its stocks in list order, as before.

Each row: symbol and name (the name is the **Show** button, `aria-pressed`
on the selected row, which is also highlighted), market, next earnings
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
going back to `#/stocks`).

Adding: the Watchlist's add-a-stock section (directory search, "Enter a
symbol instead") gains one checkbox, "Also sync annual financial
statements", checked by default and disabled with its reason at the
tracking limit. "Add stock" adds to the Watchlist and, when checked, tracks
the company (two existing writes; a failure of the second is reported on
its own and leaves the first). The Equities page's own track form goes.

Everything else of the Watchlist page stays as it was: directory status
lines and automatic downloads, the earnings refresh status and automatic
refresh, the list tabs and their actions (Add stock, Show on Home, Rename,
Delete), Google sync after a change.

### 3. The stock detail

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
and scrolls it into view; choosing a tab keeps focus on the tab.

**Lazy, kept, cached** — the performance rules of this page:

1. A tab's code is its own chunk (`lazy()`), downloaded on its first
   showing; pointer-enter or focus on a tab preloads it.
2. A tab's panel mounts on its first showing for the selected stock and
   stays mounted (hidden) while that stock stays selected, so switching back
   is instant and keeps its state (chart window, statement choice, scroll,
   loaded news pages). Choosing another stock disposes the panels.
3. Reads go through shared caches keyed by (API client, stock or company,
   read), the `financialStore` pattern generalised (`createReadCache`): one
   in-flight request per read, an ETag kept per read (an unchanged answer is
   a 304, answered from a digest before any row is loaded), the last answer
   kept for the visit, so returning to a stock or tab shows its data at once
   and re-checks it conditionally.
4. Only a **shown** read re-checks: on its showing, every 5 minutes while
   the page is visible, and on return to the tab — never while hidden or
   while its panel is hidden.
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
  (`summarizeSeries`).
- **The chart** is the detailed chart viewer of ADR-0025 rendered **inline**
  (not a dialog): range presets (opening at 1Y), exact From/To dates,
  interval / scale / values, moving averages, crosshair with readout,
  overview navigator, visible-window statistics and the data-table twin
  ("historical price data"). Its keyboard model is the viewer's; Escape does
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
choice and "Add chart to Home", and the filings table (in a disclosure
"Filings (n)", closed by default — its read starts when it is opened). The
sync status line with its failure and "Sync now" heads the tab. A stock
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
- **Filer** (tracked companies) — SEC CIK or EDINET code with a link to the
  filer's page on SEC / EDINET, fiscal year end, newest fiscal year, annual
  filings stored, last sync.
- **Key figures** — the newest fiscal year's revenue, operating income,
  profit attributable to owners, total assets, total equity, operating cash
  flow and free cash flow, each with its unit and marks as the statement
  table shows them, read from the same statement entries the Financial tab
  uses (5 years), so a stock whose Financial tab was opened costs nothing
  more.
- **On this workspace** — on the Watchlist since, the lists it is in, the
  next earnings announcement with fiscal period and timing.

Missing values say why (never blank, never 0).

### 7. News tab

Reads `GET /api/v1/stocks/:stockId/news?cursor=` → `{ stockId, terms,
articles, nextCursor }`: the owner's stored articles (Sources feeds) that
mention the company, newest first (`retrieved_at`, `article_id`, the
existing article index), at most `STOCK_LIMITS.newsPageSize` (20) a page.

- **Which articles** — the domain's `stockMentionTerms` builds up to four
  terms from the stored names (directory English and Japanese name, company
  name, watchlist name; corporate suffixes such as "Inc.", "Corporation",
  "Co., Ltd.", 株式会社 removed) and, for a US stock, the symbol;
  `articleMention` finds the first term in an article's title or excerpt: an
  ASCII term matches case-insensitively at word boundaries (the symbol
  case-sensitively), a space or hyphen in a term matches either, and a term
  with Japanese text matches as a substring. Japanese stock codes are not
  terms (a four-digit number matches amounts). Proved in Lean (§8).
- **The query** — SQL selects candidates with `LIKE` patterns
  (`mentionLikePattern`, escaped) on the owner's articles below the cursor,
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
  land on it.
- No migration and no runner change; three read endpoints, each answered
  from existing tables and indexes, with ETags.
- A stock no page shows has no stored prices; its Chart tab says so instead
  of fetching.
- News is only as good as the owner's feeds and the name match: an article
  that names a product but not the company is missed, and a common-word name
  ("Apple") can match an unrelated article.
- The Equities page's company table columns (CIK / EDINET code, fiscal year
  end, newest fiscal year, filing count) move to the Company tab; its sync
  status stays on the row.
