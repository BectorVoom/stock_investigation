# Web search investigation — 2026-11-12

## Confirmed blocker

A direct POST to Tavily using the configured `apps/runner/.env` key returned
HTTP **432** in **1.29 seconds**: “This request exceeds your plan's set usage
limit.” The request used the application's basic search parameters. The key
was not printed or changed. Restoring available Tavily credits is the first
operational action; changing prompts cannot resolve this refusal.

## Evidence from actual runs

Read-only inspection of the development D1 database on `main`, latest 20
`research` jobs, found:

| Tool outcome | Count |
| --- | ---: |
| `web.search` / `SEARCH_FAILED` | 12 |
| `web.search` / `SEARCH_COOLDOWN` | 13 |
| `web.search` / successful | 0 |
| `news.search` / `SEARCH_FAILED` | 10 |
| `news.search` / `SEARCH_COOLDOWN` | 9 |
| `news.search` / `QUERY_KEYWORD_TOO_SHORT` | 8 |
| `stocks.search` / successful | 94 |
| `stocks.search` / successful but empty | 51 of 94 |
| `news.fetch_feed` / successful | 20 |
| `web.fetch_page` / attempted | 0 |

These are recorded tool events, not necessarily network requests: cooldowns
send no request. Current Rust code also omits the tool event for a Tavily
432 / plan-limit error, so the event counts can understate attempted calls.
Historical `SEARCH_FAILED` events retain no underlying status; today's 432
does not prove that every historical failure had that cause.

The latest run, `run_4808bc47f83659bf20fd1546`, asked about corporate training
demand in Japan and the US. It used `opencode/mimo-v2.6-flash-free`, public-web
access, a 12-step / 60-tool-call budget, and completed after the explicit
“Collection stopped after three planning rounds” note. It collected feeds and
stored stock/financial records but fetched no public page. Job completion
therefore does not establish successful web research or sufficient coverage.

## Contributing implementation limits

- `crates/research-tools/src/search.rs`: searches pause after a provider failure;
  the initial pause is 60 seconds and can rise to 30 minutes. A plan-limit
  refusal cannot be cured by retrying after this interval.
- `crates/research-application/src/research.rs`: the planner loses access to a
  tool after `SEARCH_COOLDOWN`; a Tavily 432 is replaced with a generic
  unavailable note. Other tool failures expose only the code, discarding the
  actionable error detail. This obscures quota failures and prevents useful
  query correction from provider feedback.
- Collection is capped at three planning rounds even when the request permits
  more steps. Search, page retrieval and recovery must share those rounds.
- GDELT appends `sourcelang:english` to every query, limiting Japanese coverage.
  Its tool description does not advertise the minimum three-character keyword
  constraint; eight observed calls failed that validation.
- Tavily exposes only a query, always uses basic depth, and offers no structured
  date/domain/topic controls. Snippet previews are 300 characters and require
  a subsequent page fetch. These constrain quality after availability is fixed;
  they do not explain the confirmed quota refusal.

## Live checks and limits

One direct GDELT request for `corporate training sourcelang:english` returned
HTTP 200 in **13.54 seconds**, near the application's **15-second** search
timeout. Thus GDELT was reachable during this check, but the timing leaves
little margin; historical failure codes alone cannot establish their cause.

Checks used Python HTTPS from the development machine, not the runner's pinned
fetcher or an end-to-end model turn. No operational database, configuration,
application code or running service was changed. No new model turn was run.
The working tree already contained extensive changes, including search and
pipeline files; findings describe current on-disk source and stored events,
not an assurance that the running binary matches that source.

## Recommended order

1. Restore the configured Tavily key's available usage, then verify one real
   development research turn retrieves and reads a relevant public page.
2. Preserve safe upstream status and actionable failure details in progress
   and planner feedback, including plan-limit events.
3. Correct GDELT language handling and advertise its query constraints.
4. Reassess the three-round cap with a focused search → read → recover test.
5. Evaluate source relevance, freshness, JP/US coverage and primary-source
   retrieval separately from whether a job reaches `completed`.
