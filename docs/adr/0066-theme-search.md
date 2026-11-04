# ADR-0066: Theme column and theme search

Status: accepted, 2026-11-03. **Changed 2026-11-04** by
[ADR-0070](0070-theme-search-pages-and-stock-panel.md): the results come in
pages of 50 (no `truncated`), and a stock's name shows it in a panel beside
the results instead of opening its Company tab; "Close the results" is
removed. Builds on ADR-0060 (the AI-written summary's
themes), ADR-0064 (the company overview's 【テーマ】) and ADR-0050 (the
Stocks page's Find a stock).

## Context

On 2026-11-03 the owner asked for a theme column in the company
information (企業情報) table, used by a theme search. Asked to choose, the
owner picked a searchable theme column in the database plus a theme search
on the Stocks page, with the Company tab's themes linking to it.

Each stock's themes lived only inside two JSON documents of
`stock_company_summary`: the summary's `themes_json` and the overview's
`overview_json`. In `overview_json` a search would also match each theme's
reason and quotes, and nothing said which of the two the page shows.

## Decision

1. **The column.** Migration 0030 adds `stock_company_summary.theme_names`:
   the themes the Company tab shows, as a JSON array of `[en, ja]` pairs.
   These are the overview's 【テーマ】 labels when an overview is stored,
   else the summary's themes, and NULL with neither. Two triggers derive it
   after every insert and every update of `themes_json` or `overview_json`,
   so it cannot drift whoever writes the row (the API's completion batch,
   the overview writer). The migration fills it once for the rows already
   stored, using the triggers' expression.
2. **The search.** `GET /api/v1/stocks/theme-search?q=` (`themeSearchQuerySchema`,
   `themeSearchResponseSchema`).
   - The query is NFKC-normalized, its whitespace runs become one space and
     control characters are removed (`normalizeThemeQuery`).
   - The database keeps the owner's rows where
     `instr(lower(theme_names), needle) > 0`. The needle is the query
     JSON-escaped and with ASCII letters lower-cased (`themeNeedle`), because
     SQLite's `lower` folds ASCII only. `instr` has no pattern-length limit,
     unlike D1's 50-byte `LIKE` pattern, and needs no escaping.
   - Each stock then keeps the themes whose English or Japanese name
     contains the query, ignoring ASCII case (`matchingThemes`). A stock
     whose database match spans two names or the JSON punctuation is
     dropped.
   - The answer holds at most 50 stocks, in market and symbol order, with
     their stock-list names; `truncated` says more matched.
3. **The page.**
   - "Find stocks by theme" (テーマで銘柄を探す) sits under Find a stock: a
     box and a Search button.
   - A search opens `#/stocks/themes/<words>`, a new history entry. It shows
     a table of Stock (linking to the stock's Company tab), Symbol and the
     matching themes, or says that no stock matched. "Close the results"
     returns to `#/stocks`.
   - Every theme chip on the Company tab, from the overview or the summary,
     links to the search for that theme.
4. **Scale.** The search reads the owner's whole `owner_id` range of the
   primary key, one row per stock ever queued for a summary, at most the
   Watchlist's stocks. No index is added: a full-text index (FTS5) would
   help only for far more rows, and D1 supports FTS5 if that day comes.

## Verification

- Domain unit tests cover normalization, folding, JSON escaping and
  matching.
- Real-SQLite tests run both on a migrated database and on one built from
  `db/schema.sql`. They check that the triggers follow the summary, then
  the overview, and stay NULL for a row that is only queued. They also check
  that `searchThemes` finds Japanese text, quotes and stocks outside the
  stock lists, for this owner only.
- API tests run on the local D1 and on `node:sqlite`.
- Web tests cover the box, the results, the Japanese UI, the failure state
  and the theme links.

No Lean model is added: the search is a substring test with ASCII case
folding and has no algorithm beyond it. The agreement between the SQL step
and the TypeScript step is what the real-SQLite tests check.

## Consequences

- A stock without a summary or overview has no themes and is never found.
  The search says so.
- The column always follows what the page shows. When an overview is
  stored, the summary's themes are no longer searched.
- Rollback: drop the two triggers, then the column (migration 0030's
  header).
