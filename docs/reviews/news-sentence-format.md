# Agent news sentence format

Reviewed 2026-11-10. Implemented in
`packages/application/src/research/newsSentenceFormat.ts`, applied by the
analysis prompt builder when a scheduled or Run now request has `outputType: "news"`.
`questionOf` preserves the original question and carries that optional field. The agent returns its
existing claim/evidence JSON; verified claims provide the displayed prose.

| Position | Sentence pattern | Evidence requirement |
| --- | --- | --- |
| Lead | Subject + action + change + event date + source | Most important verified development; absolute date |
| Detail | Source + figure/unit + reporting period + comparison | Same basis and units; omit unavailable comparisons |
| Context | Source + attributed explanation/background | No inferred causation presented as fact |
| Outlook | Named forecaster + expectation + horizon/condition | Separate forecast from observation |

Use natural English or Japanese to match the question. These are optional
roles, not four mandatory claims. Each claim carries its own evidence and
verbatim supporting passage. Do not insert template labels into the prose.

## Comparison with published reporting

Read these articles on 2026-11-10 (historical examples, not current news):

- [Reuters, September 17, 2025, syndicated by Kitco](https://www.kitco.com/news/off-the-wire/2025-09-17/fed-lowers-interest-rates-signals-more-cuts-ahead-miran-dissents).
- [AP, September 17, 2025, syndicated by Value The Markets](https://www.valuethemarkets.com/news/federal-reserve-cuts-key-rate-for-first-time-this-year).
- [Federal Reserve statement, September 17, 2025](https://www.federalreserve.gov/newsevents/pressreleases/monetary20250917a.htm), used to check the underlying event.

| Criterion | Reuters / AP observation | Format decision |
| --- | --- | --- |
| News first | Both open with the policy decision and size of the change | Lead with a named actor and concrete action |
| Details after lead | Both follow with rate levels and background | Add figures and context only when supported |
| Attribution | Both distinguish officials' projections from decisions | Name the forecaster; never imply a forecast is an accomplished event |
| Time | Both use a publication dateline and relative weekdays | Use absolute dates because stored reports are read later |
| Numeric precision | Reuters gives a target range; AP uses an approximate rate | Preserve the source's basis; do not equate a range with a rounded midpoint |
| Sentence scope | Their leads combine a decision with an outlook | Split claims so evidence checking can reject one without losing the other |

Manually composed example using the format (not an observed agent output):

> The Federal Reserve lowered its policy target by 0.25 percentage points on September 17, 2025, according to its statement.
>
> The resulting target band was 4.00%–4.25%, the statement showed.
>
> The committee assessed employment risks as having increased.

Manual check: the statement's decision paragraph supports the first two
sentences; its risk assessment supports the third. Both articles agree on
the direction and magnitude. The example avoids claims about later cuts,
market reactions or causation that would require additional evidence. A
Japanese rendering of the lead follows the same fields:

> 米連邦準備制度理事会（FRB）は2025年9月17日、政策金利の誘導目標を0.25ポイント引き下げたと発表した。

This comparison checks editorial structure and this example's facts. It is
not a representative quality benchmark or proof of model compliance.

## Validation scope

`bunx vitest run --project node packages/application/test/scheduledTasks.test.ts`:
36 tests passed. Targeted Biome checks and the full `bun run typecheck` passed.

The scheduling service regression checks identical instructions on automatic
and manual News runs, preservation of the original question, and the date,
numeric-basis and JSON requirements. Existing Chat task tests check that the
question stays unchanged. No domain algorithm or hot path changes, so no new
Lean model or performance benchmark is required.

The initial format change had no live agent verification. The follow-up below
checks actual output; upgraded-installation coverage remains unverified.

## Actual agent article — 2026-11-10

Command: `RUN_LIVE_AGENT=codex RUN_LIVE_MODEL=gpt-6.1-sol RESEARCH_RUNNER=node bun run test:real news.live.spec.ts --output=test-results-real/news-sentence-check`.
Main working tree, Chrome, isolated fresh `bun run dev`, real Node runner and
Codex CLI, real EIA feed and three full pages, no synthetic article data.
Run `run_d26ea1b877c298aabdb5f1f1` completed and its persisted prose was
displayed on News. The browser test subsequently failed because its link
assertion did not open the source citation card first; the harness was corrected.

The [actual claims, quotations and evidence metadata](news-agent-live-2026-11-10.json)
were recovered read-only from the isolated test database. No operational data
was modified. The article has seven claims: two supported, three unsupported
(`NOT_INDEPENDENTLY_VERIFIED`), and two conflicting hypotheses. Completion of
the job does **not** establish editorial acceptance.

Manual comparison with the original pages:

| Claim | Original page | Finding |
| --- | --- | --- |
| U.S. refinery inputs increased 0.5 million barrels/day in Q3 | [EIA November 3](https://www.eia.gov/todayinenergy/detail.php?id=68404), paragraph beginning “Although crude oil inputs” | Magnitude and quarter match. The claim also contains the publication date, which is outside its quoted paragraph; automated verification did not establish the complete sentence. |
| Refiners shifted toward diesel and jet fuel as margins improved | [EIA November 5](https://www.eia.gov/todayinenergy/detail.php?id=68424), opening and gasoline-yield explanation | Direction and attributed explanation match. Publication date is again outside the attached quote. |
| Gasoline yield below 45%, January–August | Same November 5 page, gasoline-yield paragraph | Matches; automated status supported. |
| Venezuelan crude imports 701,000 barrels/day in July, 655,000 in August | [EIA November 6](https://www.eia.gov/todayinenergy/detail.php?id=68425), opening paragraph | Values and periods match. Publication date is outside the attached quote; automated status unsupported. |
| Reports cover the prior week, not a verified November 9 release | All three dated page headings | Appropriate freshness caveat, supported. It should lead the answer to a question about “this week”, rather than appear fifth. |
| Maintenance/process services demand in 2029–2031 | November 3 and November 5 pages | Conditional hypothesis is clearly labelled, but these pages do not establish that service-demand horizon. Do not publish as verified demand growth. |
| Gulf Coast transport/handling demand in 2029–2031 | November 6 page | Same extrapolation problem. August's decline is a caveat, not a logical disproof of a conditional future hypothesis. |

Compared with the Reuters/AP structures above, the prose uses concrete actors,
figures, attribution and dated reporting. It is less concise: the lead combines
an input change, export context and date, and the demand hypotheses extend
beyond the source reporting. The date evidence and freshness ordering need
improvement. Existing source quotes and source metadata must be checked
together before treating these dated sentences as supported; weakening the
verifier to accept them would conceal the gap.

**Assessment: sentence style is usable, but this article fails full verified-news
acceptance.** Facts checked against the original pages match; the pipeline's
evidence support and speculative demand sections still need work. This is one
English report, not proof for Japanese, other models or general news coverage.
Live collection also encountered `news.search` failure/cooldown; EIA retrieval
worked. Missing financial-provider configuration in the isolated environment
caused unrelated background sync failures, not an article-generation failure.

Recheck with `--output=test-results-real/news-sentence-recheck` passed the full
Chrome browser flow, including source-card link, reload and phone overflow
checks (one test, 3.8 minutes). Run `run_d16064b00fb84a0f402057fc` produced
seven claims: two supported and five unsupported; overall
`partially-verified`. Its actual report/evidence JSON is attached under that
test output directory. Browser success does not change the quality assessment.

## Correction and verified article — 2026-11-10

The preceding assessment describes the original reports. After the correction,
the actual regenerated report passes the stricter check: **6 supported,
0 unsupported, 0 conflicting; overall `verified`.**

Command:
`RUN_LIVE_AGENT=codex RUN_LIVE_MODEL=gpt-6.1-sol RESEARCH_RUNNER=node bun run test:real news.live.spec.ts --output=test-results-real/news-evidence-fix-v2`.
Chrome, main working tree, isolated fresh `bun run dev`, real Node runner,
Codex CLI and public EIA retrieval; one test passed in 4.1 minutes.
Run `run_ea8089329c8e576d92d52e71`. The test requires all claims to be supported;
a partially verified report now fails. The factual verifier was unchanged.

The [regenerated article and its exact evidence](news-agent-verified-2026-11-10.json)
are retained for review. Manual inspection confirmed all six claims against
the EIA pages already linked above: the shift in refinery yields, its margin
explanation, the two quarterly U.S. input increases, global inputs about 5%
below a year earlier, the two Venezuelan import figures, and EIA's explanation
for those imports. The dated sentences now attach a separate exact quotation
of the date heading. Both actual quotations and date headings survived storage.
The report explicitly calls the November 3–6 articles earlier reporting.
It omits the previously unsourced multi-year service-demand hypotheses rather
than relabelling them as verified facts. Genuine disagreement is still allowed
and must retain evidence; zero conflict is the result for this sample.

The first attempt at this correction exposed a request-length regression:
prepending expanded instructions exceeded the 2,000-character request limit,
causing `StoredDataError` on isolated job reads/claims. That attempt was stopped
before generation. The fix moves instructions into the analysis prompt and
carries News mode as an optional request field. A D1/SQLite HTTP regression
now queues and reads back a full 2,000-character News question without changing
it. Historical requests without the new field remain valid. The passing live
run above covers the corrected path, not the stopped attempt.

Desktop and phone screenshots from the passing live run were inspected;
citations, source links, reload and exclusion from Chat passed. Existing stored
articles were not rewritten. One observed presentation limitation remains:
multiple quotations from the same source produce repeated numbered chips,
and the source card shows the first quote. All passages remain in the stored
claim evidence. Improving that card is separate from factual verification.

Validation: full typecheck passed; targeted prompt/scheduling/research-run/API
tests passed (including the maximum-length regression), as did 99 pipeline and
Node runner tests, 38 outgoing-contract tests, Rust contract mutation vectors,
TypeScript/Rust prompt and transcript parity (including News mode), and 73 Rust
runner job tests. Targeted Biome, Rust formatting and diff checks passed.
No domain algorithm or hot path changed; no Lean model or benchmark change was
needed. Japanese and upgraded-installation live runs remain unverified; one
passing English report is not a guarantee for every future model response.
