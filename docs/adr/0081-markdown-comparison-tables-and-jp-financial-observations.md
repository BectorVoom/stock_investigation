# ADR-0081: Markdown pipe tables in chat, Japanese financial observations, and cited comparison tables

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

When asked to create a table comparing net profit margins across Japanese stocks (e.g. `日本の造船銘柄の純利益率を比較する表を作成してください。`), the research assistant previously produced prose claims without any table component or formatted table because:

1. **Chat Markdown table ban:** Chat replies rendered exclusively inside `<p class="whitespace-pre-wrap">` and prompts banned all Markdown, even GitHub-style pipe tables, under `UI-005`.
2. **Japanese `stocks.search` lacked structured `financialObservations`:** Unlike `finance.sec_company_financials` for US issuers, `stocks.search` (`kind: "financials"`) returned text passages only without `Security` or `FinancialObservation` records, so `buildPresentation` never emitted a `financial-table` component (`{runId}_financials`) for Japanese stocks.
3. **No general comparison table in analysis:** `buildPresentation` only built domain-specific tables (`scenarios`, `suppliers`, `financials`, `positions`), offering no verified multi-entity comparison table when the owner asked to compare figures across companies or items.

## Decision

1. **Structured GFM pipe tables in Chat (`UI-005` refined) and Notebook saving:**
   - `parseMarkdownTables` (`packages/domain/src/text/markdownTable.ts`, rectangular row geometry proved in `formal/ResearchFormal/ComparisonTable.lean`) segments chat replies and claim text into plain-text runs and GitHub-style Markdown pipe tables in linear time while ignoring fenced code blocks and keeping all HTML tags as literal text (`innerHTML` is never used).
   - `ChatMarkdownText` renders pipe tables as accessible `<table>` components with plain-text cells and provides an **Add table to Notebook** (`表をノートブックに追加`) action (`widgetFromMarkdownTable`) that saves the table as an editable `type: "table"` Notebook widget (`origin.kind: "chat"`, `origin.componentId: "<scopeId>_mdtable_<i>"`). A table-only reply saved via the message-level **Add to Notebook** action also converts directly into a `table` widget.

2. **Structured `Security` and `FinancialObservation` records for Japanese stocks (`stocks.search` v1.2.0):**
   - `StockResearchRepository.search` enriches matched Japanese `financials` hits with `jpFinancials` (`StockResearchResponse.jpFinancials`, up to 12 `(company, fiscalYear)` entries) from `equity_company`, `stock_directory`, `equity_metric_value` (`revenue`, `profit-attributable-to-owners`) and `equity_report_filing`.
   - Both the TypeScript (`packages/adapters/src/tools/stockResearch.ts`) and Rust (`crates/research-runner/src/stock_research.rs`) `stocks.search` tools emit a `Security` (`JP`, `TSE`), a J-Quants summary `Evidence` (`retainQuotes: false`), and three `FinancialObservation`s (`revenue`, `net-income`, and derived `net-profit-margin` via `computeNetProfitMargin`) in identical deterministic ID order.
   - Tool-output collection in both runners deduplicates `securities` by `(country, exchange, ticker)` and `financialObservations` by `(securityId, metricCode, fiscalYear, fiscalPeriod)` across repeated `stocks.search` calls so `buildPresentation` automatically emits a clean `{runId}_financials` (`financial-table`) component.

3. **Cited comparison tables in the analysis step (`PROMPT_VERSION = "research-v12"`):**
   - `analysisDraftSchema` accepts optional `comparisonTables` (up to 2 tables, 2–12 columns, up to 30 rows) whose rows reference 0-based `claimIndices` and/or `evidence` links with verbatim quotes.
   - `buildComparisonTables` (mirrored in Rust `records::build_comparison_tables` and backed by `selectVerifiedComparisonRowIndices` proved in `ComparisonTable.lean`) verifies that every kept row has independently verified claim or passage backing and zero stray numbers outside its verified backing, attributing direct source numbers with `sourceId` + `asOf` and supported derived figures with `basis: "derived"`.
   - `buildPresentation` emits each verified comparison table within `BUNDLE_LIMITS` (`datasets <= 8`, `datasetCells <= 3,000`) as `{runId}_ds_comparison<i>` and `{runId}_comparison<i>` (`data-table`).

## Consequences

- Multi-entity comparisons and Japanese stock screenings produce verified `data-table` and `financial-table` canvas previews automatically, while Markdown pipe tables in direct answers or claims render cleanly in Chat and save to the Notebook as editable `table` widgets.
- Untrusted text and raw HTML remain strictly non-executable (`UI-005`, `SEC-001`).
- TypeScript and Rust runners stay byte-for-byte identical across contracts, prompts (`research-v12`), `stocks.search` (`1.2.0`) and pipeline transcripts.
