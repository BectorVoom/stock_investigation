# News and investigation formats

Reports use conventional prose with numbered references. The internal claim
verification list is not the report's main reading view. Every displayed
sentence still comes from a stored, independently checked claim; formatting
never turns unsupported material into a finding.

## News

1. Headline: the task's title, chosen by the owner.
2. Publication time, shown separately from dates discussed in the article.
3. Lead paragraph: the most important supported development.
4. Body paragraphs: relevant facts, comparisons, attributed explanations and
   background, ordered by importance. Use a sourced outlook only when available.
5. Numbered references and the source list.

There is no “Claims in this answer” heading, checklist border, repeated
Observation/Supported badge, verification tally or compulsory conclusion in
the article body. Earlier reporting remains identified as earlier reporting.
Unsupported sentences are omitted from the article, copied answer and its
reference list. Conflicting material is separated under an explicit uncertainty
heading, retaining its warning. Unsupported records remain in evidence/audit
storage. If no publishable statements remain, the report shows a scoped empty
state instead of the rejected sentences.

## Investigation

The response starts with a Summary, followed by Findings, Analysis and outlook,
and a Conclusion when a supported inference is available. Conflicting findings
have their own uncertainty section; unsupported sentences are withheld from
the answer and clipboard. Only populated sections appear:
the format does not invent analysis or a conclusion to fill a template.

The first supported claim supplies the summary. Subsequent observations are
findings; inferences, hypotheses and forecasts are analysis. The last supported
inference supplies the conclusion; other inferences remain in analysis. The
agent is instructed to write and order claims accordingly. Legacy records
use the same deterministic grouping without rewriting their text. A legacy
inference's original meaning is preserved; the heading is a reading aid, not
an additional verification verdict.

Technical verification counts, collection notes and the stored pipeline summary
remain under Research notes and verification. Copy answer copies the report's
paragraphs, clearly separated uncertain claims and source links, rather than
the mechanical pipeline summary. Notebook audit components retain their existing
stored structure; this change concerns the News article and investigation answer.
When that answer already contains the report, Chat omits the duplicate report
widget preview; charts, tables and sources still appear, and the stored report
remains available to save to the Notebook. Legacy replies without claim IDs
retain their report preview.

## References and evidence

Numbered references sit beside the prose. Multiple passages from one source
with the same relation share a single reference, and its source card retains
all those passages, including publication headings and factual quotations.
Supporting and contradicting relations remain distinct. Source URLs retain
the existing HTTPS validation, keyboard interaction and plain-text rendering.
Uncertainty labels stay visible; supported factual paragraphs do not repeat
the same verification badge on every sentence.
News, Chat and the Chat evidence drawer omit claim-type badges and show
verification warnings where applicable. Chat and News use muted numbered
source buttons that highlight on hover or focus. Shared saved-report renderers
omit the ✓ 裏付けあり / Supported success badge.
Stored classifications and verification are unchanged.

The structure follows ordinary journalistic attribution and report conventions,
not a claimed publisher-specific house style:

- [AP: Telling the story](https://www.ap.org/about/news-values-and-principles/telling-the-story/): source attribution and checking internet information.
- [Reuters: Standards and values](https://reutersagency.com/about/standards-values/): accuracy, attribution and independence.
- [University of Melbourne: Research reports](https://students.unimelb.edu.au/academic-skills/reading-writing-and-referencing/reports/research-reports): summary, findings, discussion and conclusion serve distinct purposes.

The TypeScript and Rust runners use byte-identical `research-v10` templates.
Analysis defaults to concise claims with verbatim quotes covering each factual detail.
It includes forecasts, suppliers, pricing power, or canvas operations when
they help answer the question and omits unused JSON keys. News jobs receive
the detailed journalistic instructions. Direct answers retain the routing
introduced in [ADR-0079](adr/0079-direct-answers-for-questions-that-need-no-research.md).

## Validation — 2026-11-10

- Actual scheduled News: `RUN_LIVE_AGENT=codex RUN_LIVE_MODEL=gpt-6.1-sol RESEARCH_RUNNER=node bun run test:real news.live.spec.ts --output=test-results-real/news-article-format` passed in an isolated fresh development environment, Chrome, real Node runner and Codex CLI. Run `run_e520e1e64c2a7377b10521dc`: six supported claims, no unsupported or conflicting claims. Actual article and source card inspected.
- Actual investigation: `RUN_LIVE_INVESTIGATION=1 RUN_LIVE_AGENT=codex RUN_LIVE_MODEL=gpt-6.1-sol RESEARCH_RUNNER=node bun run test:real news.live.spec.ts -g 'live investigation report' --output=test-results-real/investigation-format` passed. Run `run_e09f63e2bc937a88acf876ba`: nine supported claims, none unsupported/conflicting. Real EIA retrieval; Summary/Findings, hidden technical tally, source link and reload checked in the browser. [Stored investigation and evidence](reviews/investigation-format-2026-11-10.json). Desktop and phone screenshots inspected. This is a fresh-state real run, not an upgraded-installation run.
- Targeted English/Japanese report, citation, chat and News tests passed. They cover grouping, uncertainty separation, merging date/fact quotes into one reference and copying the prose. Prompt/pipeline/Node runner tests and TypeScript/Rust prompt/transcript parity passed; the independent verifier is unchanged.
- Chrome and WebKit News/Chat reviews completed. The first combined WebKit run found shared test-owner state and an exact-text selector invalidated by inline references; those harness defects were corrected and the individual reviews passed. Firefox was attempted but could not start (`Could not find profile folder`); no Firefox visual acceptance is claimed.
- Existing review findings about offscreen/covered elements, the evidence drawer's heading order and input position remain recorded in each browser's `findings.json`; completion of a review is not a claim that every heuristic finding is resolved. No new source, schema or domain algorithm is introduced.
