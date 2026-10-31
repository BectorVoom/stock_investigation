# Naming conventions

Applies to new equities database code and integrations. Existing public names remain compatible; do not rename unrelated tables or contracts merely for consistency.

## Database

- Use singular `snake_case` table names prefixed with `equity_`: `equity_issuer`, `equity_security`, `equity_listing`, `equity_filing`, `equity_statement`, `equity_financial_fact`. The prefix distinguishes the durable financial catalog from existing research snapshots and provider caches.
- Column names are `snake_case`. Primary keys name the entity: `issuer_id`, `filing_id`, `fact_id`. Every key and foreign key starts with `owner_id`. Never use ticker symbols, issuer names or array positions as durable identity.
- Use `_id` for references, `_code` for controlled codes, `_json` for validated JSON, `_decimal` for exact decimal text, `_sha256` for lowercase SHA-256 hex, `_version` for explicit contract/definition versions, and `_count` for integer counts. `commit_sequence` / `commitSequence` is the transaction-assigned owner import order; `ingestionVersion` pins a financial query to that sequence. Do not call the earlier application receipt time a commit time.
- `_on` is a calendar date; `_at` is a UTC instant. `period_start` and `period_end` are inclusive financial reporting dates. `published_at`, `retrieved_at` and `committed_at` have different meanings and are never interchangeable.
- Index, unique-index, trigger and migration names, table aliases and SQL formatting follow [DATABASE_CONVENTIONS.md](DATABASE_CONVENTIONS.md): indexes `idx_<table>__<columns>`, unique indexes `uq_<table>__<columns>`, triggers `<table>_<invariant>_<event>`, migrations the next zero-padded sequence with a descriptive name (`0014_equities.sql`). Every schema change also updates `db/schema.sql`.

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

Physical-material catalog tables use `metal_`; contracts use `Material`/`material`. `materials_source_updated_at` / `materialsSourceUpdatedAt` is the source-supplied record update instant, distinct from retrieval/commit time. `materials:` identifies owner-imported, source-specific series versions. These follow the same owner-scoped key and exact decimal conventions as equities; see [ADR-0042](adr/0042-material-database-widget-series.md).
