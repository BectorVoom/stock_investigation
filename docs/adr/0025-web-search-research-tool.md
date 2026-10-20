# ADR-0025: A web search research tool

**Status:** Accepted · **Date:** 2026-10-16 · **Amended:** 2026-10-19 (Wikipedia search removed)

> **Amendment (2026-10-19).** The owner asked to delete the Wikipedia search.
> `web.search` now queries GDELT only: one request, pinned to
> `api.gdeltproject.org`. A GDELT failure fails the call (`SEARCH_FAILED` with
> its cause, retryable); there is no second backend to degrade to. The text
> below describes the tool as amended; the original two-backend design is in
> git history.

## Context

The owner reported (2026-10-16): "When I ask the AI to conduct research in the
chat, I almost always encounter a 'No evidence collected' error." They asked to
keep that failure and to add web search.

What the owner's development data shows: every research run that failed with
`NO_EVIDENCE_COLLECTED` and never called a tool ended after ONE planning step
with zero tool calls ("Please investigate", "Please investigate car stocks.",
"Please create gold chart."). The model had nothing it could ask for:

- the subscribed feeds are SEC, Federal Reserve, EIA and BLS press releases, so
  the news tools only fit questions about those publishers;
- `web.fetch_page` (ADR-0009) fetches a URL it is given and "cannot search",
  and the ground rules forbid inventing URLs;
- SEC and market-data tools are unconfigured on this machine.

So the model answered `{"toolCalls":[],"done":true}` — correctly by its
instructions — and the run had no evidence.

## Decision

**Keep `NO_EVIDENCE_COLLECTED`.** A run that collects nothing still fails; an
evidence-first answer needs evidence. What changes is that the model gets a
way to find some.

**A `web.search` research tool** (`packages/adapters/src/tools/searchTools.ts`)
discovers pages; `web.fetch_page` then reads them. One call takes
`{ "query": "<2–200 characters of keywords>" }` and queries one key-free
public API through the runner's `SafeFetcher` pinned to its host:

| Backend | Endpoint | What it gives |
|---|---|---|
| GDELT DOC 2.0 | `https://api.gdeltproject.org/api/v2/doc/doc?mode=artlist&format=json&sort=hybridrel&maxrecords=10&query=<q> sourcelang:english` | recent news articles: title, real article URL, domain, seen date |

- Each result becomes one evidence item (title, publisher = domain, URL,
  `publishedAt` = GDELT's seen date or null, retrieved text = title).
  Headlines only: `retainQuotes` is false and `excerpt` null, as for web
  pages (DATA-010).
- The model text lists each result with its evidence id and URL and tells the
  model to read promising pages with `web.fetch_page`.
- A GDELT failure fails the call (`SEARCH_FAILED`, with the cause in the
  detail). Zero results is a success with no evidence and says so in the
  model text.
- GDELT asks for at most one request every 5 seconds: requests to it are spaced
  5 s apart within the runner (abort-aware wait). Its non-JSON answers (rate
  limit or query errors are plain text) are a backend failure with the first
  line of the text as detail.
- GDELT is an API with its own usage policy, not a crawled page, so robots.txt
  is not consulted (as for the SEC APIs); requests carry the descriptive
  User-Agent. No API key, no new setting.

**Gated like web access.** The query is model-chosen text sent to third
parties (the same threat as T17), so `web.search` declares
`networkAllowlist: { kind: "public-web" }` and is advertised and authorized
only when the request says `webAccess: "public-web"`. Inside the tool the
fetcher is still pinned to the GDELT host. It is registered independently of the
page archive (it writes nothing to disk).

**The planner is told it must search when nothing fits.** The planning prompt
(`PROMPT_VERSION` → `research-v5`) says: while nothing has been collected,
return at least one tool call; when no subscribed source fits, use a search
tool if one is listed, with short keyword queries; follow promising results
with the page tool. When the first plan of a run still asks for no tools and
nothing has been collected or attempted, the pipeline asks once more with a
note saying so (one extra planning step from the collection allowance, at most
once per run), before giving up.

**A failure that says why.** `NO_EVIDENCE_COLLECTED` may now carry a
`failureDetail` (as `ALL_TOOL_CALLS_FAILED` already does):
`NO_TOOL_REQUESTED` (the model asked for nothing, even after the reminder),
`TOOLS_RETURNED_NOTHING` (tools ran without error but returned no evidence),
`PLAN_NOT_JSON` (no planning reply was valid JSON). The run card shows a
one-sentence hint for these, including "turn on web access in Settings" when the
run had web access off.

## Consequences

- Questions outside the subscribed feeds can now collect evidence (news
  headlines, then fetched pages).
- Search headlines are weak evidence; analysis and verification treat them as
  any other evidence item, and a claim backed only by a headline says only what
  the headline says.
- GDELT's coverage is news only, recent months, and multilingual sources are
  filtered to English; it is a free service with no uptime promise. Market
  data (prices, charts) still needs the FRED / Twelve Data keys (ADR-0014).
- One more outbound host from the owner's machine when web access is on.
- The collection allowance is now 3 of the 6 default steps, so a run whose
  first analysis draft fails its schema still reaches independent verification
  on its repair turn.
