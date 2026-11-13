# Demand investigation on News

**Acceptance correction (2026-11-07): comprehensive demand information across
major themes has NOT been demonstrated. Previous test totals established UI
and rule behavior, not useful information retrieval. Treat that acceptance
criterion as unmet.**

A [read-only audit of the actual development archive](reviews/demand-coverage-2026-11-07.json) found 1,132 articles.
Only 59 articles had a retained excerpt; 1,073 were headline-only (about 95%).
The scanner therefore could not assess the underlying reporting for most rows.
Every theme had topical articles (15–88), but only energy and mobility had
phrase-matched candidates (one each). Eleven of thirteen themes had none.
The synthetic all-theme test was constructed with matching headlines and
could not reveal this failure. The previous live test used one energy feed.

The corrected saved-news default is now **Theme news**, which includes
unassessed topical reports. Exact demand-wording views remain optional; their
absence must not hide all topic coverage or imply no demand exists.

The new current-news form opens a normal Google News search in a separate tab;
it does not import, summarize or assess results. This is an external research
path, not a replacement for verified in-app cross-theme coverage. Query
vocabulary covers both English and Japanese and optional literal product text.

Provider investigation did not produce an acceptable integrated solution:
Google's RSS response explicitly limits use to personal, non-commercial feed
readers, so the attempted RSS relay was removed. GDELT probes timed out or
returned HTTP 429. Automated browser probes of Google News encountered a human
verification challenge. None of those probes counts as a passed information
retrieval test. No provider fallback or CAPTCHA bypass is implemented.

Reproduce the stored-data audit without writing data or contacting providers:
run node scripts/poc/demandCoverageAudit.ts with the local API origin. The output
separates topical counts from phrase-match counts and states whether every
stored page was read. The output is descriptive, not evidence of economic
significance or of the absence of demand.


The News demand section provides browsing and research prompts for investors and sales teams; its source coverage remains insufficient for a comprehensive demand investigation product.
It identifies reading candidates from stored subscribed-feed headlines and
permitted excerpts. It does not establish demand, economic significance,
market size, suppliers, customers, budgets or investment suitability.

## Assessment and improvements

Historical implementation notes (the unmet source-coverage criterion above takes precedence):

The original two-regex filter was insufficient for theme-led investigation:
it lacked theme navigation, excluded ordinary orders/adoption wording, mixed
forecasts with actual growth, accepted generic "new market" stories as demand,
and searched only the pages the owner manually loaded.

The revised functional core is packages/domain/src/news/demandSignals.ts.
The UI lives in apps/web/src/news/. There are no database, ingestion, external
API, credential, provider or synchronization changes.

| Need | Implemented behavior | Regression evidence |
| --- | --- | --- |
| Major investment/commercial themes | 13 themes plus All themes; English and Japanese vocabulary, multiple topical matches permitted | Every theme tested in both languages; browser traverses all themes |
| Growing demand | Demand, orders, sales, adoption, spending/backlog growth wording, including past tense and Japanese percentages | Synthetic positive and natural-language regression cases |
| New demand | New demand, first orders/customers/contracts and applications/use cases | English/Japanese examples |
| Avoid misleading positive classifications | Forecast/negation takes precedence; weakening and uncertain views; generic new-market and strong-demand context alone do not imply growth | Negative, forecast, mixed-passage and unrelated-news cases |
| See why an item matched | Matched passages alongside the original source link, publisher, published/retrieved dates | Component and populated-browser tests |
| Investment investigation | Buyer/product, scale/period, recurring versus one-off, capacity, backlog conversion, margin/valuation and contrary-evidence checklist | Audience-switch and brief tests |
| Sales investigation | Buyer/location/use case, funded budget, procurement deadline, decision maker and incumbent/channel checklist | Audience-switch and brief tests |
| Investigate beyond the first page | Explicit batches of up to 10 stored pages (500 articles), stop/resume and coverage count | Batching, stop/resume and browser older-evidence tests |
| Failures do not erase evidence | Keep results, retry failed cursor, detect repeated cursors, deduplicate canonical URLs | Failure/retry, duplicate and cursor-loop tests |
| Missing evidence is actionable | Empty-state source/filter guidance; brief available even without matches | Empty-brief and empty-state tests |
| Bounded presentation | Initially 50 matches, Show more; brief includes at most 20 source records | Rendering/brief limit tests |
| Filtering is local | Cached analysis, conjunctive theme/type/text filters, no requests from filtering | Integration request counts, conformance vectors and benchmarks |

## Formal and performance scope

Lean 4 proves classification precedence and conjunctive filtering invariants.
Generated vectors exhaust all Boolean inputs and replay against TypeScript.
It does not prove regex recognition or economic truth. The finite bilingual
corpus tests recognition and normalization separately.

The benchmark suite includes a 500-article/13-theme analysis case (20 ms budget)
and a 500-cached-candidate filter case (2 ms budget). Analysis is memoized
independently of filters. Each scan batch and initial rendered result count
is bounded. The existing benchmark suite was measured before the change.

## Verification record — 2026-11-07

- Targeted domain, component, pagination/error, design and Lean-conformance tests
  pass. Full repository test, lint and type checks are recorded in the
  follow-up entry in REQUIREMENTS_STATUS.md.
- Full suite: 474 test files passed, 5 skipped; 8,209 tests passed, 14 skipped.
  The first broad run exposed nine natural-wording misses; after fixes the
  complete suite was rerun and passed.
- bun run check, bun run typecheck, bun run build: passed.
- bun run bench: final run passed all budgets. New cases: 14.849 ms to analyze
  500 articles; 0.071 ms to filter 500 cached candidates. A preliminary run
  overlapped the full suite and exceeded unrelated existing budgets; the final
  run was performed after that suite finished.
- bun run formal:check: passed, proofs build and vectors are current.
- bun run review:ui newsReview.spec.ts, Chrome: four scenarios passed;
  desktop/phone populated-theme and Japanese screenshots inspected.
- REVIEW_BROWSER=webkit bun run review:ui newsReview.spec.ts: same four
  scenarios passed; desktop/phone and Japanese screenshots inspected.
- Firefox attempted: all scenarios blocked at browser launch with
  “Could not find profile folder.” This is unverified, not a UI test pass.
- RESEARCH_RUNNER=node bun run test:real devReal.spec.ts: passed using an
  isolated pristine copy, fresh database, actual development launcher, Node
  runner and a live public feed; no model used. The page read live-ingested
  stored articles and the sales brief. Live feed contents change, so this
  proves ingestion/read/UI integration, not a positive demand classification
  for every theme. No migration/schema changed; populated historical upgrades
  were not exercised for this presentation feature.

- Additional actual-backend attempt: RUN_LIVE_AGENT=claude-code
  RESEARCH_RUNNER=node bun run test:real:live. The fresh-state question
  reached the real backend but its persisted run failed with PROVIDER_AUTH.
  The browser assertion waits for completion despite that terminal failure,
  so the suite was interrupted (exit 130) after capturing the failure code.
  One scenario was interrupted, one opt-in scenario skipped, and 15 did not
  run. No model or successful AI research outcome is claimed. Fresh/upgraded
  AI-question completion remains unverified until authentication is restored.

## Limits and follow-up

This is finite-vocabulary triage with evidence for manual investigation.
Negations, complex clauses, hypothetical contracts, idioms and entity attribution
can still be misread. Classification is per passage and can preserve both growth
and weakening passages for the same article. A theme match means the article
mentions that theme; it does not establish a supply-chain relationship.

Coverage is limited to subscribed sources, available retained text and pages
loaded in this browsing session. Counts are articles, not independent reports or
demand strength. Canonical-URL deduplication cannot identify syndication across
different URLs. Source publication dates may be absent; the brief states that
explicitly. UI research modes provide questions, not invented answers.

There is no measured precision/recall against an independently labelled real
news corpus, no ranking of economic significance, and no assurance that every
real demand opportunity is represented. Use original sources, corroborate scale
and timing, and use the sourced brief in Chat or other research when evidence is
insufficient. Opening Chat neither copies nor submits the brief automatically.

## Primary-source investigation — 2026-11-09

See [Demand research sources](DEMAND_SOURCES.md) for a prioritized, linked
assessment of official orders, shipments, inventories, retail spending and
energy consumption, plus sector-specific confirmation. These recommendations
extend research beyond the subscribed headline corpus; they are not integrated
feeds and do not close the source-coverage acceptance gap automatically.
