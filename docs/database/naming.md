# Naming conventions: equities and materials libraries

Applies to new equities and materials database code and integrations. Existing public names remain compatible; do not rename unrelated tables or contracts merely for consistency.

## Database

General SQL naming — column suffixes, key and identity rules, index, trigger and migration names, aliases and formatting — is in [database conventions §4](conventions.md#4-naming). Library-specific rules:

- Table names are singular `snake_case` with the library prefix: `equity_issuer`, `equity_security`, `equity_listing`, `equity_filing`, `equity_statement`, `equity_financial_fact`. The prefix distinguishes the durable financial catalog from existing research snapshots and provider caches.
- Primary keys name the entity: `issuer_id`, `filing_id`, `fact_id`.
- `commit_sequence` / `commitSequence` is the transaction-assigned owner import order; `ingestionVersion` pins a financial query to that sequence. Do not call the earlier application receipt time a commit time.
- `period_start` and `period_end` are inclusive financial reporting dates.

## Contracts and application code

- TypeScript uses `camelCase` properties/functions, `PascalCase` types/components and `UPPER_SNAKE_CASE` constants. SQL adapters translate explicitly at the boundary: `periodEnd` ↔ `period_end`, `valueDecimal` ↔ `value_decimal`.
- Use the `Equity` prefix for exported catalog types (`EquityIssuer`, `EquityImport`, `EquityFactQuery`) and `equity` for schema/value names (`equityImportSchema`). Existing `Security` and `FinancialObservation` describe research snapshots, so do not reuse those names for authoritative catalog records.
- Schema names end in `Schema`; infer exported contract types from their schemas. Parse unknown input at every boundary; never use `any` or unchecked casts.
- Repository factories are `createEquityRepository`; use-case factories are `createEquityService`; API client operations are `listEquityIssuers`, `importEquities`, `getEquityFacts`.
- Features use `equities.ts` or an `equities/` directory. UI text is in `equities.messages.ts`, with both English and Japanese catalogs.

## Financial vocabulary

- **Issuer** means a reporting legal entity; **security** means a share class or receipt; **listing** means one instrument on a venue. A listing market is not the issuer's domicile.
- Market codes are `JP` and `US`; currencies are ISO 4217 uppercase strings; venue codes use MIC strings. Japanese securities codes are strings, including letters; CIKs retain leading zeros.
- Dimension names and values are bounded strings, with keys sorted at normalization; a numeric typed member remains exact decimal text.
- Enum values use lowercase `kebab-case` (`cash-flow`, `currency-per-share`), except externally standardized identifiers (`US-GAAP`, `IFRS`, `JGAAP`, `USD`, `JPY`). Metric codes describe the exact definition: `profit-attributable-to-owners`, not an ambiguous `profit`.
- Names ending in `Decimal` carry canonical base-unit decimal strings, never amounts in an unstated thousands/millions scale. `"123.45"`, `"0"` and `"-2"` are valid; `"01"`, `"1.0"`, `"-0"`, `"1e6"` and numbers are rejected. Preserve a source's precision separately.
- A fact includes unit, accounting standard, scope, actual/forecast classification, exact reporting dates, dimensions and source. `null` requires an unavailable reason; it never means zero.
- Use `amendmentOfFilingId` only for an explicit source-supported amendment. A new parser or import is not a new public filing. Imported fact IDs are immutable; reusing an ID with different data is a conflict.

## HTTP and diagnostics

- Routes use plural nouns and lowercase kebab-case under `/api/v1/equities`: `/issuers`, `/imports`, `/issuers/:issuerId/facts`. Query/payload properties are `camelCase`.
- Versions are explicit (`schemaVersion: 1`). Import idempotency uses `Idempotency-Key`; the same key and parsed payload replay, while a different payload conflicts.
- Errors use existing stable `UPPER_SNAKE_CASE` API codes with fixed safe messages. Logs use lowercase `snake_case` operation labels. External failure status stays numeric in `upstreamStatus`, unchanged.

## Proposal-to-implementation mapping

The earlier database proposal used unprefixed names for several entities. The implementation uniformly prefixes them: `data_source` → `equity_data_source`, `source_document` → `equity_source_document`, `financial_statement` → `equity_statement`, `financial_fact` → `equity_financial_fact`, `price_bar` → `equity_price_bar`, and `corporate_action` → `equity_corporate_action`. `equity_import` is the bounded, atomic owner-import manifest. Automated runner ingestion and raw XBRL parsing require their separate fenced manifests and parser-version model before being enabled; an owner-supplied normalized import must never be described as that parser.


## Materials extension

Physical-material catalog tables use `metal_`; contracts use `Material`/`material`. `materials_source_updated_at` / `materialsSourceUpdatedAt` is the source-supplied record update instant, distinct from retrieval/commit time ([database conventions §11](conventions.md#11-source-record-update-timestamp)). `materials:` identifies owner-imported, source-specific series versions. These follow the same owner-scoped key and exact decimal conventions as equities; see [ADR-0042](../adr/0042-material-database-widget-series.md).

## Financial statement sync (ADR-0048)

The automated sync replaced the owner import; its tables keep the `equity_` prefix and avoid the retired ledger's names: `equity_company`, `equity_report_filing`, `equity_reported_fact` (as-filed, insert-only), `equity_metric_value` (current-value projection), `equity_sync_state`, `equity_edinet_scanned_day`, `equity_sync_meta`. `company_id` is opaque; the issuer identity is `source_company_id` (CIK with leading zeros, or EDINET code). `filing_id` is `<companyId>:<provider>:<sourceDocumentId>` (SEC accession, EDINET docID) — per company, since SEC co-registrants share an accession. Metric codes are the kebab-case `EQUITY_METRIC_CODES` (`profit-attributable-to-owners`, `net-cash-from-operating-activities`, …); concepts keep their taxonomy prefix (`us-gaap:Revenues`, `jppfs_cor:NetSales`). Report forms are `10-K`, `10-K/A`, `securities-report` (有価証券報告書) and `amended-securities-report` (訂正). Contracts live in `equityFinancials.ts` with the `Equity`/`equity` prefixes; routes are under `/api/v1/equities/companies`.
