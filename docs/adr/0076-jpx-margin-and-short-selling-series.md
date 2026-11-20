# ADR-0076: JPX short-selling ratio and margin-trading series on Home and in the Notebook

**Status:** Accepted · **Date:** 2026-11-19 · **Owner request:** "Please add the short-selling ratio, margin buying balance (value), margin ratio, and margin valuation gain/loss ratio to the home widget."

## Context

Japanese equity supply-and-demand indicators complement price and macro series on Home and in the Notebook:

- **空売り比率 (short-selling ratio)** — daily share of short sales (with and without the price restriction) in the TSE auction market's trading value, published daily by JPX as one-page summary PDFs (`空売り集計（日次）` on `/markets/statistics-equities/short-selling/index.html`, file suffix `-m.pdf`).
- **信用買い残（金額） (margin buying balance, value)** and **信用倍率 (margin ratio)** — weekly outstanding margin trading across Tokyo and Nagoya (`二市場`, standardized plus negotiable, customer plus proprietary), published weekly by JPX as `.xlsx` workbooks on `/markets/statistics-equities/margin/04.html` (`YYYYMMDD_mtcurrent.xlsx`) alongside a ~6-week history workbook on `/markets/statistics-equities/margin/05.html`.
- **信用評価損益率 (margin valuation gain/loss ratio)** — JPX does not publish this figure; Nikkei and QUICK compute it commercially from broker reports, and no free downloadable source exists (free websites that display it prohibit automated scraping or lack stable terms). Confirmed with the owner: leave it out rather than scrape unpermitted pages, and expose the three JPX figures through the existing Metric (`市場の数値`) and Indicator table (`指標表`) widgets covering the two-market (`二市場`) total.

Two properties of JPX's public pages shape the design:

1. JPX requires no API key, asks callers to avoid high-load or high-frequency automatic retrieval, and changes the `-att` folder in file URLs when updating pages.
2. Each page lists only recent files — about 10 trading days of short-selling PDFs, 5 weekly margin workbooks, and ~6 weeks in the margin history workbook. Unlike FRED or Twelve Data, a single fetch cannot return multi-year history; replacing stored rows on a "full" refresh (ADR-0044) would discard older weeks once they roll off JPX's page.

## Decision

### 1. Provider `jpx` and closed symbol set

Add `"jpx"` to `MarketProviderId` (`packages/domain/src/market/seriesId.ts`, `crates/research-domain/src/market/series_id.rs`). Because JPX has no general symbol namespace here, `parseMarketSeriesId` accepts `jpx:<symbol>` only for the exact allow-list `JPX_MARKET_SYMBOLS`:

| Series id | Frequency | Unit | Formula |
|---|---|---|---|
| `jpx:SHORT_SELLING_RATIO` | `daily` | `Percent` | `Math.round(((restricted + unrestricted) * 1000) / total) / 10` from `YYMMDD-m.pdf` |
| `jpx:MARGIN_BUYING_VALUE` | `weekly` | `Millions of Yen` | `信用取引残高合計` `二市場` `買残高` `金額` (contract-price basis, 百万円) |
| `jpx:MARGIN_RATIO` | `weekly` | `Times` | `Math.round((buyShares * 100) / sellShares) / 100` from `信用取引残高合計` `二市場` `株数` (week skipped when `sellShares === 0`) |

All three appear in `MARKET_CATALOG` under the new category `"margin"` ("Margin & short selling" / "信用・空売り"), so Home and Notebook Metric (`market-metric`), Indicator table (`indicator-table`) and Line chart (`line-chart`) widgets select them directly with 1-year sparklines and `前月比` / `前年比` comparisons (ADR-0065, ADR-0069). Custom series entry stays `fred` and `twelve-data` only.

### 2. Readers, caching and shared JPX pacing

Both runners (`crates/research-finance/src/jpx_stats.rs` and `packages/adapters/src/finance/jpxMarketStats.ts` + `packages/adapters/src/node/pdfText.ts`) register the `jpx` market source unconditionally (no API key):

- **Short-selling PDFs:** inflate `/FlateDecode` zlib streams up to 4 MiB total per file, keep printable-ASCII content streams (dropping binary font streams), concatenate literal strings inside each `BT … ET` text object, require exact token counts (4 comma-grouped integer amounts `a, b, c, d` with `|a + b + c - d| <= 3` and 3 one-decimal percentages each within `0.1` of `100 * x / d`), and date each observation from the `YYMMDD-m.pdf` filename (at most 10 files per page).
- **Margin workbooks:** decode `sheet1.xml` + `sharedStrings.xml` through the existing bounded ZIP and workbook readers (`readWorkbookRows` / `read_workbook_rows`), read the `[東京・名古屋` section of the first `.xlsx` on `05.html`, and overlay up to 8 dated `YYYYMMDD_mtcurrent.xlsx` workbooks from `04.html` after verifying each workbook's Excel serial date above its `二市場` header.
- **Politeness and caching:** every HTTP request actually sent takes one grant from the shared `jpx` pacer window (6 starts per 60 s, shared with directory and earnings refreshes). Each HTML page is cached in process for 3 hours (`JPX_STATS_PAGE_TTL_MS`), and each file's parsed outcome (including unparsable files, which are skipped) is cached by URL and pruned when a page drops the link. Thus `MARGIN_BUYING_VALUE` and `MARGIN_RATIO` in the same refresh share one set of downloads, and subsequent refreshes within 3 hours send zero requests.

Wire format, exact cell/token layouts, error mapping and live examples: [JPX](../external-apis/apis/jpx.md).

### 3. History accumulates instead of replacing

Because JPX lists only a rolling window of recent files, a `jpx` series never uses windowed anchor checks or history replacement (ADR-0044):

- Both runners execute a `jpx` series in `market-refresh` with a single `fetchSeries` call (`from = null`, ignoring `anchor` and `fullCheck`) and omit `history` on the completion entry.
- The API (`marketEffects` in `packages/application/src/runnerJobs.ts`) forces `history: null` for `provider === "jpx"`, so `marketStatements` always merges incoming observations into `market_observations` without deleting older dates (subject only to the standard 1,500-observation cap).

### 4. Margin valuation gain/loss ratio omitted

`信用評価損益率` is not added: no free, terms-compliant source publishes machine-readable figures. If the owner later connects a paid feed (such as a commercial QUICK data source), it can be added as a separate series under its own provider.

## Consequences

- The owner can add `Short-selling ratio (空売り比率)`, `Margin buying balance (信用買い残)` and `Margin ratio (信用倍率)` to Metric, Indicator table and Line chart widgets on Home and in the Notebook with no configuration or API key.
- Initial history covers ~10 trading days for `jpx:SHORT_SELLING_RATIO` and ~8 weeks for `jpx:MARGIN_BUYING_VALUE` and `jpx:MARGIN_RATIO` (history workbook + weekly workbooks), accumulating automatically across refreshes up to 1,500 observations; `前月比` populates once observations span a calendar month (~1 month for margin, ~1 month of trading days for short selling) and `前年比` once they span a year.
- No database schema migration is required: `market_series` and `market_observations` store `jpx` rows alongside `fred` and `twelve-data`.
