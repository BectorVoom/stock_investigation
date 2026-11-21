# ADR-0071: Agent retrieval of stored stock research

Status: accepted, 2026-11-05. Amended 2026-11-21 by [ADR-0080](0080-stock-screening-relevance-and-planning-leads.md) (company relevance tiers `name → theme → body`, Japanese `local_name` in AI overview titles, token-bounded digit/ticker terms, `issuer=` in financial passages, `stocks.search` v1.1.0 compact context-only hits and short-form reserve, `ToolOutput.planningLeads`, `research-v11`, and `research_planning_round` logging).

## Context

The owner requested an agent tool inside the app for RAG over company descriptions, financial statements and news. The existing research tools retrieve external data, while the Stocks page already reads these three corpora from storage. Both the TypeScript and Rust runners must expose the same tool.

## Decision

Register `stocks.search` for every research job. Arguments are `query` (1–128 characters, at most eight whitespace-separated terms), optional `kind` (`company`, `financials`, `news`) and `limit` (1–12, default 6). The tool works when public web access is off. It contacts only the app's authenticated runner API, with a host-bound run id and lease generation. Model arguments cannot choose an owner, credential, destination or lease.

`POST /api/v1/runner/jobs/:id/stock-search` authenticates the runner and checks the owner's research job, credential, generation, active state, expiry and cancellation before reading. The SQL adapter applies the authenticated owner to every corpus and every join. No schema changes or migrations are needed.

The tool searches:

- **Company:** individual paragraphs of the stored SEC business description, plus stored AI-written descriptions, themes and company overviews. Original SEC paragraphs carry filing references. Generated descriptions/overviews are explicitly AI context with no citeable evidence id; a stored quote inside an AI overview is not independently promoted to source evidence.
- **Financials:** every stored fiscal year's current normalized annual metric projection, including unavailable and ambiguous values. Passages include exact decimal strings, reporting currency (base currency units), fiscal year, period, scope, derived flag, revision count, concept and filing id. Available values link to their stored filing. Derived metrics remain labelled derived. The raw as-filed revision corpus and legacy owner-import tables are outside this first retrieval surface.
- **News:** stored article titles and permitted short excerpts, with their original URLs, publisher and publication/retrieval dates. Headline-only sources and articles whose source was deleted expose only their title; they do not search or return the retained excerpt. The existing evidence pipeline enforces quote retention.

This is **lexical retrieval**, without embeddings, generated query expansion, a vector database or a paid service. All terms must occur in a document's title and text, with ASCII case folding identical to SQLite's `lower`; Japanese terms match literally. Financial metric names also have Japanese search aliases. There is no synonym inference or relevance model. Within a corpus, results are newest-first with a deterministic record-id tie break; corpora are interleaved so news cannot monopolize the output. Limits and truncation are explicit. A miss means no matching stored passage, not proof that a fact does not exist.

Each corpus returns at most `limit + 1` candidates in one SQL request, with no per-stock reads. SQL filters before returning rows. The tool returns passages of at most 2,400 characters and the common 6,000-byte model-text limit; the verifier receives the matching source evidence, bounded and hashed by the common evidence collector. Tool version 1.0.2 includes clearly labelled stored source metadata (title, publisher, publication/retrieval/effective dates) in the same passage shown to the agent and checked by the verifier. Passages are shown as plain text after their JSON reference header so the model can copy exact quotes without nested JSON escaping. These labels are not publisher quotations; stored excerpts remain the original passage body. This fixes publication-date claims losing their citations because the model could see a date that the verifier could not. Content is untrusted data, including embedded instructions. The tool never executes it. It never fetches providers, refreshes a stock or changes storage.

## Agent screening and empty analysis (2026-11-06 amendment)

Prompt version `research-v6` separates thematic discovery from numeric comparison. `stocks.search` remains lexical retrieval: a query such as a theme plus "20%" is not a financial filter. The planner first discovers company candidates, then requests their financial records by ticker/company and metric, including both comparable fiscal years. Japanese/English search variants are separate queries. AI-written themes remain candidate context; thematic exposure needs a primary-source passage. Missing data and truncated retrieval do not establish that no stock qualifies or that the market was screened exhaustively.

The analyst answers in the question's language and uses cited claims for screening instead of forcing the forecast/scenario example. For an unspecified profit-growth basis it compares the latest stored full fiscal year with its preceding year, same metric/currency/scope, and labels `(current - prior) / prior * 100` as an inference with both source inputs. The prior profit must be positive; loss narrowing, missing comparisons and incompatible periods are not silently called annual profit growth. The independent verifier recomputes arithmetic inferences from their quoted inputs. This is agent reasoning over retrieved records, not a new database screening endpoint or a proved decimal arithmetic implementation.

An empty `claims` array with source evidence and no structured tool financial/position/filing records is no longer accepted as a successful analysis. Both runners spend the existing analysis repair turn asking for sourced findings, cited exclusions or candidate-specific data limitations. A second empty draft fails `ANALYSIS_OUTPUT_INVALID`; it does not publish the generic "No findings" placeholder as a completed answer. Existing structured-record fallback behavior, evidence checks and run budgets are preserved.

Tool version **1.0.3** additionally normalizes a canonical positive decimal string in the agent tool's `limit` field (for example OpenCode native calls emitting `"12"`) into the existing bounded integer. Only 1–12 are accepted; leading zeros, fractions, whitespace, exponent notation, booleans and null are refused. Query/ticker text is unchanged. The authenticated HTTP request schema remains strictly numeric; only the tool boundary accepts this transport variation. Both runners apply the same normalization before the strict contract and send numeric limits to the API.

## Verification

- SQLite tests cover the canonical schema and the complete migration chain, all three corpora, exact decimals, Japanese terms, all-term matching, literal SQL metacharacters, owner isolation, limits, corpus diversity and restricted/orphaned source retention.
- API tests run against both node:sqlite and Workers/local D1, including missing authentication, another owner's run, another credential, stale/expired leases and malformed arguments.
- TypeScript tool tests cover evidence checksums, source dates, prompt-like content, AI context, restricted excerpts, typed failures and empty results.
- Shared zod contract vectors are replayed by the Rust decoder; tool-output vectors compare the Rust tool against TypeScript using the real HTTP runner client and a synthetic local Worker response. Host-injected lease and run bindings are checked.
- `ResearchRetrieval.lean` proves the round-robin result bound, empty zero-limit output and that every returned passage came from an input corpus. Exported vectors cover empty/uneven groups and limits and are replayed against TypeScript. SQL matching, Unicode handling and network authorization are tested separately; they are not claimed as Lean-proved.
- `bun run bench` includes retrieval with 20,000 stored news articles (40 ms budget). This measures local SQLite, not D1 latency or a full-market financial corpus.
- `tests/real/stockResearch.live.spec.ts` exercises the actual development launcher, D1, browser and subscription CLI against explicitly synthetic stored records, checking all three corpora, supported claims, visible citations, source cards, reload and restart with carried-over settings. It runs with `RUN_LIVE_AGENT=codex` or `claude-code`, and `RESEARCH_RUNNER=rust` or `node`. This does not test provider ingestion.
- `tests/real/live.spec.ts` includes a real-backend question explicitly requesting `stocks.search` against news previously ingested from a real feed, requiring an executed tool step, completed run and citation. Actual execution outcomes are recorded in `docs/REQUIREMENTS_STATUS.md`.

## Trade-offs and follow-up

Substring search scans the owner's relevant rows; the current schema has no substring index. It avoids index maintenance and a migration but is not a claim of constant-time search or full-market scalability. A large financial corpus needs measured indexing/ranking work before promising latency at that scale. Search aliases are vocabulary, not translated UI messages. AI-only context cannot support a verified claim until a primary source is retrieved. Stored data can be stale or incomplete; every result preserves its dates and a miss is explicit.

Deployment requires restarting the updated server and runner together; the tool endpoint is a new capability. There is no database migration, embedding backfill or external API key to configure.
