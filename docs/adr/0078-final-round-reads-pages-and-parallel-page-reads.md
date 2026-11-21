# ADR-0078: The final collection round reads pages, and a round's page reads run together

**Status:** Accepted · **Date:** 2026-11-21 · **Owner request:** "Please optimize for speed while preserving answer quality as much as possible." (choice: build on the uncommitted agent-extract work)

## Context

After ADR-0077 took the model's thinking out of the Dots Note turns, the
collection loop was the next cost on dev (whole runs on 2026-11-21):

- Collection is capped at three planning rounds. The last round's
  `web.search` / `news.search` results are only leads (an extracted page is
  the evidence), and no round follows to open them. In the four runs that
  day the last round always spent calls on searches whose leads were thrown
  away, while the analysis then had one to four pages to cite; with one page
  the first draft was rejected and a 20 s repair turn followed.
- The calls of a round ran one after another. A round's page reads took
  1–2.5 s each: five reads 8.4 s, three reads 3.9 s, five reads 6.2 s.

The planning prompt's size was measured and ruled out: a 108 KB third-round
prompt answered no slower than a 5 KB one (17.4 s vs 23.7 s on Gemini Flash,
about 410 thinking tokens each); the 50–60 s planning turns seen on Gemini
were the provider's variance and 503 retries.

## Decision

Both runners, held equal by the pipeline vectors:

1. **Final round.** The last planning round (`step + 1 >= min(collectionSteps, 3)`)
   carries `PLANNING_FINAL_ROUND_NOTE`: search results can no longer be opened,
   so request page reads or stored records. A `web.search` or `news.search`
   requested there is not run; it is reported as `denied — FINAL_ROUND_NO_SEARCH`
   with a note, and is not counted as a denied request.
2. **Concurrent page reads.** A run of consecutive `web.extract` /
   `web.fetch_page` requests in one plan starts together once the run has
   been prepared, call by call in plan order (authorization, de-duplication —
   now also within the batch —, the final-round rule, budget and wall-clock
   deadline). Results are recorded in plan order. A limit reached while
   preparing stops collection after the started reads are recorded. Every
   other tool still runs alone, because search, SEC and J-Quants calls have
   rate limits and a search cooldown must stop later searches of the round.

## Consequences

- A round's page reads take as long as the slowest one instead of their sum
  (about 3–6 s per run on the measured rounds), and the last round's calls
  go to evidence instead of discarded leads.
- Evidence ids of concurrent reads follow their completion order; they are
  labels only.
- A `news.search` request in the final round no longer adds its articles to
  Sources.
- A read repeated within one batch is not retried when its twin fails.
