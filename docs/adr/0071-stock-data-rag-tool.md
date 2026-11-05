# ADR-0071: `stocks.search_data` — a retrieval tool over the stored stock data

Status: accepted, 2026-11-05.

## Context

On 2026-11-05 the owner asked: "Please add tool for stocks data RAG and
verify by openrouter."

The server already stores, per stock, everything the Stocks page shows: the
directory entry, a Japanese stock's J-Quants profile, the AI-written summary
and themes (ADR-0060), the company overview (ADR-0064), a US annual report's
business section (ADR-0053), the annual financial statements (ADR-0048,
ADR-0059), the next earnings dates (ADR-0068) and the daily closes
(ADR-0055). A research run could not read any of it: its tools fetch from the
web, SEC or GDELT, so the agent re-fetched (or guessed) what the app already
knew.

## Decision

1. **One research tool, `stocks.search_data`** (TypeScript
   `packages/adapters/src/tools/stockDataTools.ts`, Rust
   `crates/research-tools/src/stock_data.rs`; both runners, ADR-0030). Its
   arguments are `{ query, stockIds?, sections?, limit? }`
   (`stockDataSearchRequestSchema` without `leaseGeneration`): the question
   words, up to five stocks (`us:AAPL`, `jp:7974`), optionally only some
   kinds of record, and 1–12 passages (default 8). It contacts no external
   host (`networkAllowlist: none`, `sideEffect: none`, `costCategory: free`),
   so it is offered whatever the request's web access says.
2. **The API retrieves.** The tool calls
   `POST /api/v1/runner/jobs/:id/stock-data/search` with the run's lease
   generation. Only the holder of a research run's current lease may search
   (`checkLease`; a stale lease is 409 `STALE_LEASE`, another kind of job
   400), and only its owner's rows are read. `ToolContext` and the pipeline
   input carry the claim's `leaseGeneration` for this.
3. **Which stocks.** The named `stockIds`; otherwise the stocks the query
   names: a ticker written in it that the stock list holds (`AAPL`, `7974`),
   a Watchlist stock whose symbol or a distinctive name word is in it, the
   stock-list search of the whole query (3 hits) and the theme search
   (ADR-0066). At most five, in that order. None → an empty answer, and the
   tool tells the model to pass `stockIds`.
4. **Passages** (`stockDataPassages`, application). Each stock's stored
   records become short passages, each with a section, a title, its source
   page, publisher, source class and as-of time: the listing; the J-Quants
   profile; the AI summary in English and in Japanese; the company overview
   in English and in Japanese; up to 12 business-section paragraphs; one
   passage per financial statement and fiscal year (newest three), every
   value written as its exact stored decimal and currency plus a rounded
   magnitude, metrics named the way questions name them ("net income
   (profit attributable to owners of the parent)", "revenue (net sales)"); the
   upcoming earnings dates; the latest closes (latest, previous and change,
   high and low over the stored closes, latest bar). Nothing is fetched.
5. **Ranking** (`rankStockPassages`, domain). Okapi BM25 (k1 1.2, b 0.75)
   over each passage's title and text, the corpus being the searched stocks'
   passages. Text is folded like the stock search (NFKC, lower case,
   hiragana → katakana); Latin letters and digits form words (a short list of
   English question words is dropped); every kana / ideograph run is split
   into overlapping character bigrams, because Japanese has no spaces. At
   most 24 distinct query terms; ties keep input order; only passages sharing
   a term with the query are returned.
6. **Evidence.** A passage with a source page that is not AI-written becomes
   evidence the model cites by id, its text the retrieved text that quote and
   number verification checks. SEC passages may keep a quote; J-Quants,
   Finnhub and Twelve Data passages may not (`retainQuotes` false, DATA-010).
   AI-written passages (summary, overview) are labelled `AI-WRITTEN (not
   evidence)` and give no evidence; a stored record without a source page is
   context only.

## Verification with OpenRouter

`tests/live/stockDataOpenRouter.test.ts` (`bun run test:live:openrouter`,
needs `OPENROUTER_API_KEY`, optionally `OPENROUTER_MODEL`; without a model
the free-model backend picks one) runs the whole research pipeline on a real
OpenRouter model with `stocks.search_data` as its only tool, over a fixture
of Apple's stored records cut and ranked by the API's own code
(`rankStockDataPassages`). It passes when the model called the tool, the
bundle cites the stored 10-K and at least one claim is supported. Its
offline half (always run) checks that the fixture answers the question with
the FY2025 income statement first.

**Not yet run live:** the session that built this had no OpenRouter key and
its network policy refused `openrouter.ai`. Run the command above to verify.

## Consequences

- The agent answers questions about stored stocks from stored, cited data
  instead of re-fetching it; one call is a handful of indexed reads per stock
  (profile, three statements, the closes), at most five stocks.
- Retrieval is lexical: a question in words the passages do not use (a
  synonym the metric labels lack) ranks poorly. No embeddings are stored.
- The API route is covered on a real local D1 and on `node:sqlite`
  (`apps/api/test/stockData.test.ts`); the tool in both runners
  (`packages/adapters/test/tools/stockDataTools.test.ts`,
  `crates/research-tools/src/stock_data.rs`); the ranking by unit and
  property tests (`packages/domain/test/watchlist/stockDataRetrieval.test.ts`).
- **No Lean model yet.** `rankStockPassages` is a domain algorithm, so
  AGENTS.md asks for a Lean model and conformance vectors; the session could
  not install the Lean toolchain (its downloads were blocked), so soundness,
  ordering, the limit and completeness are checked by fast-check properties
  instead. Writing `formal/ResearchFormal/StockDataRetrieval.lean` and its
  vectors is follow-up work.
