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
3. **The page controls.** Under the table, when there is more than one
   page: First, Previous, "Page n of m" (n / m ページ), Next, Last, in a
   navigation landmark "Result pages" (検索結果のページ). Each control is a
   link to its page's URL, so it can open in a new tab; a plain click moves
   to that page as a new history entry. On the first page First and
   Previous are shown disabled, on the last Next and Last. The caption
   names the range ("1–50 of 120 stocks", 120 銘柄中 1–50). Once the new
   page is shown, focus moves to the caption and it is scrolled into view.
   With one page the caption says the count and no controls are shown.
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

## Verification

- Application tests: page slicing, total, page count, a page past the
  last.
- API tests: the paged answer, a page past the last, and 400 for a bad
  `page`.
- Router tests: parsing and formatting the page, and bad pages read as 1.
- Web tests: 50 rows a page, the controls on the first and last pages, no
  controls for one page, Japanese, the panel's stock and tab, no
  navigation on a click, swapping and closing the panel, and the panel
  kept across pages but closed by a new search.

No Lean model is added: paging is a slice of a sorted list, with no
algorithm beyond the arithmetic the schema checks.

## Consequences

- Every matching stock can be reached, 50 at a time.
- Looking at a result no longer loses the results.
- The stock shown in the panel is not in the URL: a reload shows the
  results without it. "Open on its own page" gives a link to the stock.
