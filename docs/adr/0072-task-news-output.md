# ADR-0072: News output for scheduled tasks

Tasks select News or Chat in their editor. Existing tasks default to Chat; migration 0038 adds a checked output_type column. News tasks ask the research agent for dated reporting with source links. Both scheduled and Run now executions use this instruction.

The News page reads the persisted task conversations and displays assistant reports as text, with creation timestamps and paginated older history. Reusing chat_messages keeps one source of truth and preserves every answer between runs and restarts. Reports retain the existing conversation limits and owner authorization.

Current limitations: changing a task's destination changes the visibility of its whole conversation; deleting a task removes its listing from News, although its conversation remains. Deleting the conversation deletes the reports. Independent report retention and citation rendering are follow-up work. News reads issue one bounded conversation request per News task, at most the existing 30-task limit.

Validation: 97 targeted scheduling, SQLite storage, canonical schema and table documentation tests pass. No domain algorithm changed; the schedule's existing Lean proofs remain applicable.

## Citation and editorial correction — 2026-11-09

News now renders the conversation's stored claims with the shared claim/source
citation component rather than displaying only the pipeline's mechanical text
summary. Older history accumulates its claims and evidence alongside messages,
so loading another page preserves existing citations. Claims retain verification
and claim-type labels, source links and quoted-evidence cards. Legacy replies
without claim IDs retain their text; citations cannot be reconstructed when no
evidence was stored. HTML from agents is never rendered.

News task instructions ask for attributed, dated, concrete journalistic sentences,
ordered by significance, with no promotional boilerplate or invented quotations.
The existing evidence verification still applies. Existing stored prose is not
rewritten. Source selection guidance uses the research in
[Demand research sources](../DEMAND_SOURCES.md); it adds no provider integration.

## Sentence format — 2026-11-10

Both automatic and Run now News tasks now receive the same explicit lead,
detail, context and outlook sentence patterns, preserving the existing claim
JSON and evidence verification. Dates and numeric comparisons retain their
basis; missing fields are omitted. The [editorial comparison](../reviews/news-sentence-format.md)
records a manual comparison with Reuters and AP reporting and a primary-source
fact check, plus the limits of that verification.

## News has its own destination — 2026-11-10

News task conversations are excluded from the Chat list in the database query,
before the list limit. Tasks and both task widgets link to News for a News
task, and to Chat for a Chat task. Creation and run notices name the selected
destination. Changing the output type updates the list visibility immediately.
The existing conversation remains the report's storage, so News retains its
history and citations. There is no schema change or rewrite of stored reports.
This is navigation separation, not a new authorization boundary: the underlying
message API remains available to the owner. The existing task-deletion retention
limitation above remains; removing the task also removes its destination association.

## Evidence-complete sentences — 2026-11-10

Prompt version `research-v7` requires every part of a dated news sentence to
follow from its attached quotations, including a separate quoted date heading
when needed. A recent production or margin change is not evidence of a
multi-year service-demand forecast. An outlook requires a source that states
the measured product/service and horizon; otherwise the report omits that
outlook. Genuine contrary evidence remains visible; a background caveat is
context rather than an invented contradiction.

News mode is now optional `outputType` on the research request, understood by
both runner implementations. The task's question remains unchanged, so its
2,000-character allowance never competes with editorial instructions. The
analysis builder adds the News format. Existing request JSON without the field
is still valid; no database migration is needed. Contract mutation vectors and
News/Chat prompt parity vectors cover this addition. Verification remains
strict and unchanged; the live acceptance test now requires every claim to be
supported and overall status `verified`.

## Conventional article and investigation presentation — 2026-11-10

News uses the task title as headline, a lead and body paragraphs with inline
numbered references. Investigation answers use Summary, Findings, Analysis and
outlook, a supported-inference Conclusion when available, and an explicit
uncertainty section. Both render the existing verified claim text; they do not
publish unchecked narrative. The mechanical stored summary remains under
Research notes and verification instead of preceding the answer. Copy answer
copies the prose, uncertainty section and sources. A duplicate report widget
is omitted from Chat when the answer already renders its claims; legacy
reports and other previews retain their behavior.

Multiple passages from the same source and relation share a reference and
remain available together in its source card. Supported factual sentences do
not repeat Observation/Supported badges. Observation/Inference type badges are
omitted from News and Chat, including the evidence drawer; Hypothesis/Forecast
labels and verification warnings remain visible. Stored classifications are
unchanged. UI labels exist in English and Japanese.
Prompt version `research-v8` asks for that reading order and natural news
transitions. [Formats, references and live validation](../REPORT_FORMATS.md).

## Publishable sentences and no success badge — 2026-11-10

News and Chat reports omit `unsupported` sentences and references used only by
those sentences; copied answers apply the same rule. A report with no remaining
statements shows an empty state. Unsupported claims remain stored for audit and
available in the evidence drawer. Conflicting claims keep their warning and
their separate section. The shared claim-status badge no longer renders the
Supported / ✓ 裏付けあり label; supported report borders use neutral colours.
Nothing is upgraded, reclassified or deleted from research records.
