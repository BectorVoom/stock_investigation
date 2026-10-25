# ADR-0039: Fewer requests to external services

Status: accepted (2026-10-25)

## Context

The owner asked to cut the number of requests the workspace sends to
external services, provided the user experience does not get worse. An audit
of both runners (Rust default, TypeScript rollback), the API and the SPA
found these avoidable requests:

- **A new widget or stock refreshes everything.** Adding a Home or Notebook
  widget whose series has no data, a Notebook series never refreshed, or one
  stock on the Watchlist each queued a refresh of *every* tracked series (up
  to 60: 2 FRED requests each) or *every* watchlist stock (up to 50 Finnhub
  calls), although only the new one had no data.
- **FRED metadata on every refresh.** Each FRED series costs 2 requests per
  refresh: `/fred/series` (title, unit, frequency) and the observations. The
  metadata practically never changes.
- **13F filings downloaded again.** `filings.sec_13f_holdings` downloads the
  current and the previous 13F-HR text (up to 16 MB each) on every call,
  although a filing, addressed by its accession number, never changes.
- **No search result reuse.** `web.search` (Tavily, 1 credit) and
  `news.search` (GDELT, 5 s spacing) send a request for every call, also when
  a job's re-attempt repeats the same queries minutes later.
- **GDELT's plain-text throttle reply.** GDELT sometimes answers HTTP 200
  with a plain-text "please limit requests" message. It was reported as a
  failed search without opening the outage pause, so later calls in the same
  job kept hitting GDELT.

## Decision

1. **Refresh scope.** `POST /home/refresh` and `POST /watchlist/refresh`
   take an optional body `{ scope: "all" | "unrefreshed" }`; no body means
   `"all"` (the MCP server and older clients are unchanged). A
   `"unrefreshed"` job is stored with request `{ scope: "unrefreshed" }`
   (null stays "all"), and its claim carries only the tracked series that
   have no stored observations or were never refreshed, or only the
   watchlist stocks never refreshed. The claim shape the runner sees is
   unchanged. A request for `"all"` while a `"unrefreshed"` job is still
   pending widens that job to `"all"`; once claimed, the active job is
   returned as before (one active job per kind). The idempotency
   fingerprint includes the scope.
2. **Who asks for what.** The SPA asks for `"unrefreshed"` when a widget,
   Notebook series or stock is added without data, and in the follow-up
   after a run. The Refresh buttons and the staleness auto-refresh ask for
   `"all"`. Staleness is judged by the *oldest* refresh stamp (30 minutes
   for market data, 24 hours for earnings dates). Before this change every
   refresh stamped all items at once, so oldest and newest were the same;
   with partial refreshes only the oldest stamp says whether something is
   stale.
3. **FRED metadata cache.** Each runner keeps a series' validated FRED
   metadata in memory for 24 hours, per series, bounded. A cached series
   costs 1 request (observations) instead of 2. Only valid metadata is
   cached.
4. **13F filing cache.** Each runner keeps parsed 13F-HR filings keyed by
   CIK and accession number in memory, bounded by entry count. The
   submissions index is still fetched on every call, so a newly filed 13F
   shows up at once.
5. **Search result cache.** Each runner keeps successful `web.search` and
   `news.search` results for 15 minutes, keyed by provider and the
   normalised query (trimmed, inner whitespace collapsed, lower-cased),
   bounded by entry count. A hit sends nothing and waits for no GDELT
   slot. Failures are never cached. Each hit keeps the time it was really
   retrieved, so provenance stays truthful.
6. **GDELT throttle text opens the pause.** A 200 whose body is GDELT's
   rate-limit text is treated like a 429: it opens the outage pause.

## Consequences

- With the default dashboard (9 FRED + 4 Twelve Data series), a refresh
  costs 13 requests instead of 22 once the metadata is cached. Adding a widget
  costs the new series' requests only. Adding a stock costs 1–2 Finnhub
  calls instead of one per watchlist stock.
- Freshness on screen is unchanged: observations, earnings dates, 13F
  submission lists and searches older than 15 minutes are fetched as before.
  A changed FRED title or unit shows up to 24 hours late, and a repeated
  search within 15 minutes returns the same results.
- Caches live in the runner process and are lost on restart. That only
  costs requests; correctness doesn't depend on the caches.
- Not done, recorded for later: a feed preview followed by a subscribe
  fetches the URL twice. A longer OpenRouter model-list TTL would make
  Settings show model changes later, which counts as a UX trade-off and is
  left to the owner. A per-job probe that reuses the loop's probe was not
  done either, because its network use is unverified.
