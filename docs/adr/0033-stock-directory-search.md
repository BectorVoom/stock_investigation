# ADR-0033: Search every US and Japanese listed stock from the Watchlist

Status: accepted (2026-10-24)

## Context

The Watchlist's add-a-stock form takes a market and an exact symbol. The owner
asked to search all US and Japanese listed stocks instead — type "Apple",
"トヨタ", "toyota" or "7203" and pick the stock to add. Nothing in the app
lists all stocks. The browser may only call the app's own API
(`connect-src 'self'`), and only the local runner holds provider keys and
fetches outside data (THREAT_MODEL T22, ADR-0005, ADR-0016).

Two free, official lists cover the need (measured 2026-10-24):

| Market | Source | Rows kept | Names |
| --- | --- | --- | --- |
| US | SEC `https://www.sec.gov/files/company_tickers_exchange.json` (already read by the runner's SEC tool) | 7,691 on Nasdaq, NYSE, Cboe, Texas SE; OTC (2,574) and rows without an exchange are dropped | English |
| JP | JPX "List of TSE-listed Issues", monthly: `data_j.xlsx` (Japanese) and `data_e.xlsx` (English), linked from `https://www.jpx.co.jp/markets/statistics-equities/misc/01.html` and its `/english/` twin | 3,707 Prime, Standard and Growth issues (domestic and foreign); ETFs/ETNs, REITs and funds, PRO Market and equity contribution securities are dropped | Japanese and English, joined on the local code |

## Decision

1. **A local stock directory.** The runner downloads each market's list into
   the API's database; searches run against the stored copy. No outside call
   happens per keystroke, and search works offline.
2. **One job per market.** Job kind `stock-directory-refresh` carries a
   `market`; its completion `stock-directory-refreshed` replaces that market's
   rows all or nothing. One job per market keeps each completion under the
   1,000,000-byte body cap (ADR-0010): US measured about 590 KB and JP about
   430 KB as `{symbol, name, localName?, listing}` objects. A failing market
   leaves its stored list untouched.
3. **A floor against a broken parse.** A completion with fewer than
   `STOCK_DIRECTORY_LIMITS.minEntriesPerMarket` rows is refused by contract,
   so a changed file layout can never wipe the stored list; the runner
   reports `DIRECTORY_PARSE_FAILED` instead.
4. **Refresh cadence.** The owner can queue a refresh ("Update stock list").
   Opening the Watchlist queues one when a market's list is missing or older
   than `staleAfterDays` (7), at most once per visit — low frequency, as
   ADR-0016 requires for JPX. JPX publishes monthly; SEC daily.
5. **SEC needs `SEC_USER_AGENT`.** SEC's fair-access policy requires a
   declared User-Agent with a contact. Without it the US job fails with
   `DIRECTORY_NOT_CONFIGURED` and the page names the variable to set.
6. **Search semantics** (pure, `packages/domain/src/watchlist/stockSearch.ts`,
   modelled in Lean, `formal/ResearchFormal/StockSearch.lean`):
   - Fold text: NFKC (full-width → half-width, half-width kana → full-width),
     ASCII-only lower-casing, hiragana → katakana, whitespace runs → one
     space, trimmed. NFKC is outside the Lean model; the model starts after it.
   - Terms are the folded query split on spaces (at most `maxTerms`). A row
     matches when every term is a substring of one of its folded symbol, name
     or local name.
   - Rank: tier 0 exact symbol (one term equal to the symbol), 1 symbol
     prefix, 2 name or local-name prefix (first term), 3 any other match;
     then shorter symbol, then symbol, then market. At most `maxResults`.
   - The API stores the folded keys with each row and ranks in SQL; a
     workers-runtime test runs the domain reference implementation and the
     SQL on the same rows and requires identical results.
7. **Picking a hit fills the form.** The search lists symbol, name, market
   and listing; picking one sets market and symbol and shows the company; the
   owner presses "Add stock". Typing an exact symbol still works, so the form
   works before any list is downloaded. Hits already on the watchlist say so
   and cannot be picked again.
8. **Both runners.** The job is implemented in the Rust runner (default,
   ADR-0030) and the TypeScript runner (rollback), with conformance vectors
   for the two list parsers.

## Consequences

- New table `stock_directory` and `stock_directory_meta` (migration 0010).
- New routes: `GET /api/v1/watchlist/directory` (status per market),
  `GET /api/v1/watchlist/directory/search?q=&market=&limit=`,
  `POST /api/v1/watchlist/directory/refresh` (queues one job per market).
- No new outside host: `www.sec.gov` and `www.jpx.co.jp` are already on the
  runner's allowlist.
- Company names come from the directory when a stock is added from a search
  hit; the earnings refresh still fills names for stocks added by symbol.
