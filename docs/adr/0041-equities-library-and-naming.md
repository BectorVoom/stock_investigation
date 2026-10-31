# ADR-0041: A durable equities library with exact, source-referenced imports

Status: accepted, 2026-10-29.

## Context

The owner requested a Japanese/US equities database for financial statements and related data, then requested naming conventions, implementation and application integration. The existing stock directory is a replaceable search projection and research records are per-run snapshots; neither is a historical financial ledger. The broader [design](../EQUITIES_DATABASE_DESIGN.md) was reviewed by Claude Code before implementation.

## Decision

- Use the existing SQLite-dialect persistence port and local Workers/D1 application. Add owner-scoped `equity_*` tables through migration 0014; keep existing directory, Watchlist, research and widget contracts intact.
- Follow [NAMING_CONVENTIONS.md](../NAMING_CONVENTIONS.md): singular prefixed SQL names, explicit entity IDs, camelCase contracts, exact decimal text, explicit dates/instants, and separate receipt/commit/version meanings.
- Provide bounded, authenticated normalized owner imports as one atomic batch. Validate references and financial bases; recheck immutable identity, identifier assignment, metric definition and listing overlap conflicts within the transaction. Include the audit write in the same transaction. No unfenced runner ingestion is implied.
- Keep record bodies in an immutable repository ledger, relational projections for indexed joins/FKs, and the normalized import payload for private backup. Reusing a record ID requires identical normalized data. Keep contradictory source observations under distinct IDs.
- Assign owner commit sequences within the transaction, stamp monotonic commit times at its end, and return `ingestionVersion` for repeatable historical reads and pagination. Financial queries return all eligible disclosures, not an invented selected or aggregated total.
- Add the English/Japanese Equities page for import, search, statement/provenance inspection, related records, history/download and a bounded, exact snapshot that can be pasted into research Chat.

## Scope and consequences

This implements a normalized-data library, not a bulk filing parser. Automated SEC/EDINET/TDnet acquisition, raw artifact retention, reviewed taxonomy mappings, temporal identity correction, adjusted series, TTM and valuations remain separate implementation gates. Imported source assertions are not independently verified. No paid provider or new dependency is added.

Exact decimals are compared with integer arithmetic and never sorted as SQL floating point. Temporal eligibility, version gates and decimal order have Lean models and generated conformance vectors. The actual SQL import/read/rollback paths are tested on SQLite and local Workers D1; representative large imports are measured. Remote D1 quotas and provider coverage remain unclaimed.

The migration is additive and the launcher applies it normally. A pre-equities database upgrade is tested for preservation of existing rows. For rollback, export any newly imported normalized files first, retain the database backup, then restore through the existing release/restore procedure; the old-release newer-database guard still applies. Do not drop tables or override that guard as a routine rollback.

Usage and API: [EQUITIES_DATABASE.md](../EQUITIES_DATABASE.md). Review and validation: [EQUITIES_IMPLEMENTATION_REVIEW.md](../EQUITIES_IMPLEMENTATION_REVIEW.md).
