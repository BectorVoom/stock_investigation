# ADR-0070: Theme search pages and a stock panel beside the results

Status: accepted, 2026-11-04. Changes ADR-0066 §2 (the answer's 50-stock
cap and `truncated`) and §3 (the results and where a stock's name leads).

## Context

On 2026-11-04 the owner asked for pagination on the theme search results,
50 rows a page, and for a click on a stock in the results to show that
stock's information in a panel on the right of the results instead of
opening a separate page.

ADR-0066 answered at most 50 stocks and said when more matched; the rest
could not be seen. A stock's name linked to its Company tab, which replaced
the results.

## Decision

1. **The API pages.** `GET /api/v1/stocks/theme-search?q=&page=`
   (`themeSearchQuerySchema`): `page` is 1-based, default 1, at most
   10,000; anything else is 400. The answer (`themeSearchResponseSchema`)
   holds that page's stocks (at most `THEME_SEARCH_LIMITS.pageSize`, 50, in
   market and symbol order), `page`, `pageSize`, `total` (every stock that
   matched) and `pageCount` (at least 1). A page past the last answers the
   last. `truncated` is gone. The schema checks that `page`, `pageCount`
   and the number of hits agree with `total`.
   - The service still reads every matching row and filters it in
     TypeScript (`matchingThemes` can drop a row the database matched), so
     `total` is exact; it then slices the page. The rows are at most the
     owner's stocks with a summary, as in ADR-0066 §4.
2. **The URL carries the page.** `#/stocks/themes/<words>` is page 1;
   `#/stocks/themes/<words>/<page>` is page 2 and later. A page that is not
   1–10,000 written in plain digits reads as page 1. Reloading, sharing or
   Back restores the page.
3. **The page controls** (changed 2026-11-04, the owner: page numbers
   "1, 2, 3, 4, …"). Under the table, when there is more than one page, in
   a navigation landmark "Result pages" (検索結果のページ): Previous (前へ),
   the page numbers, Next (次へ). The numbers are every page up to seven;
   beyond that the first and last page, the current page and its
   neighbours, and the first or last four near either end — `1 2 3 4 … 10`,
   `1 … 5 6 7 … 12`, `1 … 7 8 9 10` (`pageNumbers`; "…" always stands for
   two or more pages). Each number and Previous / Next is a link to its
   page's URL ("Page 3", 3 ページ, as its accessible name), so it can open
   in a new tab; a plain click moves to that page as a new history entry.
   The current page is highlighted, marked `aria-current="page"` and not a
   link; on the first page Previous is shown disabled, on the last Next.
   The caption names the range ("1–50 of 120 stocks", 120 銘柄中 1–50).
   Once the new page is shown, focus moves to the caption and it is
   scrolled into view. With one page the caption says the count and no
   controls are shown. (The first version had First / Previous / "Page n
   of m" / Next / Last.)
4. **A stock opens beside the results.** A plain click on a stock's name
   shows that stock in a panel ("Chosen stock", 選んだ銘柄) to the right of
   the results; the URL does not change. On screens narrower than `lg`
   (1024 px) the panel sits under the results. The name is still a link to
   the stock's Company tab, so a modified or middle click opens the full
   page in a new tab.
   - The panel holds the same stock detail as the Stocks page: the heading
     (name · symbol), the Watchlist status and Add to Watchlist button
     (ADR-0050 §2), and the Chart, Financial statements, Company and News
     tabs (ADR-0049 §3, each lazy). It opens on the Company tab, where the
     themes are; switching tabs stays in the panel.
   - Above it, "Open on its own page" (銘柄のページで開く) links to the stock
     at the panel's tab, and a close button (Close the stock, 銘柄を閉じる)
     hides the panel.
   - The shown stock's row is highlighted and marked `aria-current`. Focus
     moves to the panel's heading.
   - On wide screens the panel stays in view while the results scroll
     (sticky, scrolling on its own when taller than the window).
   - The panel keeps its stock across result pages, so the owner can page
     on while reading one stock. A new search (other words) closes it.
   - The Watchlist is read when the panel first opens, as the Stocks page
     reads it when a stock is shown.

5. **No "Close the results".** The link under the results back to
   `#/stocks` (ADR-0066 §3) is removed (the owner, 2026-11-04). A new
   search replaces the results; Back or the Stocks tab in the navigation
   leaves them.

## Verification

- Application tests: page slicing, total, page count, a page past the
  last.
- API tests: the paged answer, a page past the last, and 400 for a bad
  `page`.
- Router tests: parsing and formatting the page, and bad pages read as 1.
- `pageNumbers` unit and property tests: 1, the last and the current page
  always shown, ascending, at most seven items, "…" only for two or more
  pages.
- Web tests: 50 rows a page, the page numbers on the first and last pages
  and with many pages, no controls for one page, no Close the results, Japanese, the panel's stock and tab, no
  navigation on a click, swapping and closing the panel, and the panel
  kept across pages but closed by a new search.

No Lean model is added: paging is a slice of a sorted list, with no
algorithm beyond the arithmetic the schema checks.

## Consequences

- Every matching stock can be reached, 50 at a time.
- Looking at a result no longer loses the results.
- The stock shown in the panel is not in the URL: a reload shows the
  results without it. "Open on its own page" gives a link to the stock.
