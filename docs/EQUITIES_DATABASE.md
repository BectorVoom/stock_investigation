# Equities database: implementation and usage

The Equities page (`#/equities`) is the application's durable company-data library for Japanese and US equities. Migration `0014_equities.sql` is applied by the existing launcher/migration process to SQLite/D1. All records, joins, imports, downloads and audits are owner-scoped. Existing Watchlist, research records and market widgets keep their contracts.

Naming: [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md). Broader roadmap: [EQUITIES_DATABASE_DESIGN.md](EQUITIES_DATABASE_DESIGN.md).

## What is implemented

- Separate issuers, official issuer identifiers, securities and venue listings; JP symbols are strings and can contain letters.
- Data-source permissions, source documents, financial filings and explicit amendment links; statements carry standard, scope, reporting currency and exact inclusive period dates.
- Metric definitions unique on `(metricCode, version)` and immutable source-referenced financial facts, including segment dimensions, reported precision, actual/estimate classification and share basis.
- Daily price observations, corporate actions, FX and management guidance; corrections use new IDs and ordered predecessor references, never destructive updates.
- An atomic normalized JSON import protocol, immutable ID validation, content/idempotency checks inside the transaction, audit history, paginated company search and financial/source inspection.
- Independent public-information and system-ingestion cutoffs for financial facts, plus immutable `ingestionVersion` snapshots. Queries return **all eligible observations**, preserving disagreements and amendments. They do not silently select or aggregate one latest metric.
- Exact decimal comparison and temporal eligibility modeled in Lean 4, with generated vectors replayed in TypeScript and SQL differential tests.

This is an implemented normalized-data library, not an implementation of every future ingestion/calculation phase in the proposal. It does not yet automatically download SEC/EDINET filing packages, parse XBRL, resolve historical ticker ownership, choose reviewed taxonomy mappings, compute TTM/ratios, derive split adjustments, or claim full-market history. Those operations must meet the proposal's separate parser, rights, temporal identity and lease-fencing gates before enablement. Source assertions in imported files are supplied by the owner and are not independently verified by the importer. No synthetic dataset is loaded into operational databases automatically.

## Import a file

1. Open **Equities** in the navigation.
2. Choose a normalized JSON file in **Import financial data**.
3. Review its record count and coverage note, then select **Import file**.
4. Search and select a company to inspect financial facts and source links.

An explicitly synthetic two-market sample is in [examples/equities/synthetic.json](../examples/equities/synthetic.json). Its invented issuers and values demonstrate the format and must not be used as financial data. The schema is [packages/contracts/src/equities.ts](../packages/contracts/src/equities.ts).

Each file has `schemaVersion: 1`, a required `coverageNote`, and optional arrays: `issuers`, `identifiers`, `securities`, `listings`, `sources`, `documents`, `filings`, `statements`, `metrics`, `facts`, `prices`, `actions`, `fx`, `guidance`. Omitted arrays become empty arrays. Reference an existing owner record or include its parent in the same file. Revision/amendment predecessors must already exist or appear earlier in their collection; forward/cyclic/cross-entity revisions fail. Record IDs must be globally unique within an owner across record kinds. Reusing an ID requires identical parsed content.

Decimal values are strings in base units, with at most 100 significant and 30 fractional digits: `"9007199254740993.25"` survives exactly. Noncanonical forms and JSON numbers are rejected. Null financial values require an explicit unavailable reason. Currency-per-share/share-count facts require a stated share basis. Prices validate OHLC ordering, nonnegative volume and listing currency. Split ratios and FX rates must be positive; guidance bounds must be ordered.

All instants are fixed-width UTC with milliseconds. A historical public cutoff excludes a filing with unknown public availability. A date-only source should be conservatively bounded to the next midnight in the source time zone and labeled `conservative-date-bound` by the producer; the importer does not guess a time zone. `ingestionCutoff` additionally checks all contributing source/document/filing/statement/metric/fact import times and document retrieval time. Future retrieval times are rejected. Import timestamps are assigned at the end of the atomic database batch and are strictly increasing per owner, with a wall-clock floor. Timestamp cutoffs describe those recorded transaction stamps; they are not a nanosecond-accurate physical commit clock. For deterministic replay and pagination, financial responses return `ingestionVersion`: an owner-scoped commit sequence assigned inside the transaction. Send that version on subsequent reads to exclude every later import, independently of clock skew or when the read occurs. Issuer names/listings and the “other company data” section are current catalog views, not historical identity resolution.

Limit: 750,000 bytes of normalized payload, 2,000 records total and the smaller per-collection bounds in the schema. One import is one complete declared extraction scope committed in one transaction (at most 18 SQL statements, with set-based inserts). There are no partially visible multi-request staging rows. A failed request leaves no import manifest, records or audit entry. `Idempotency-Key` must be reused when retrying the same logical request. A different key is a distinct import, even if it repeats identical records; original records keep their original ingestion provenance. The SHA-256 covers parsed schema-ordered fields. Dimension keys are sorted and their values are bounded strings (typed members may use a canonical string representation); array order remains significant. An amount in a typed member must be represented as exact text, never a JSON number. Reordering dimension keys alone preserves identity.

Record bodies are stored once in `equity_record` and validated with zod on read. Relational projections enforce composite owner foreign keys and index issuer/filing/statement/listing access paths. SQLite connections explicitly enable foreign keys. An import's original normalized payload is also retained for private download and restore. The database retains the source URL and optional content hash; it does not claim that original PDF/XBRL bytes have been archived merely because a hash is supplied.

## HTTP API

Owner authentication is required throughout; writes also require the existing same-origin/CSRF headers.

| Method / path under `/api/v1` | Purpose |
| --- | --- |
| `POST /equities/imports` | Validate and atomically import a normalized file; requires `Idempotency-Key`; 201 new, 200 replay, 409 stored identity/key conflict, 422 invalid references/bases or conflicting identity assertions within a file. |
| `GET /equities/records?recordType=&after=&limit=` | All catalog record kinds, including source documents, definitions and FX. |
| `GET /equities/issuers?q=&after=&limit=` | Name/symbol search with keyset pagination. |
| `GET /equities/issuers/:issuerId/facts?informationCutoff=&ingestionCutoff=&ingestionVersion=&after=&limit=` | Financial facts with full statement, metric, filing, document and effective ingestion provenance. |
| `GET /equities/issuers/:issuerId/records?after=&limit=` | Current related company records, including prices/actions/guidance. |
| `GET /equities/imports?after=&limit=` | Import audit/coverage history. |
| `GET /equities/imports/:importId` | Original normalized file for private backup/reimport. |

Default page sizes are 50 for lists and 100 for financial facts; maximum 200. Company and record pages sort by stable ID and return `nextCursor`; import history sorts by commit time descending, then ID, using a validated composite cursor. `q` is supported only by company search; other list endpoints reject it rather than silently ignoring it. Company search folds ASCII case and matches Japanese substrings; it does not perform general Unicode case folding or transliteration. Dates/periods and basis remain in each financial observation; ID order does not imply financial recency. The snapshot copied for research includes exact values, definition, accounting/share basis, period, source URL, fact ID, applied cutoffs and ingestion version. It uses the existing Lean-verified budget selector to fit within 1,800 UTF-8 bytes so it can be pasted into Chat with a question. It retains a contiguous prefix, never truncates a financial value, and reports omitted displayed facts and a partial-data flag. If even one complete fact cannot fit, use the import download instead. Private authenticated downloads do not grant permission to redistribute licensed data.

## Operations

Use the existing `bun run dev` / `bun run prod` launcher to apply the migration. Never run the migration directly against an owner's operational database just to test it. Back up the database through the established export procedure before upgrades. For rollback, disable the new feature and restore a verified pre-upgrade database export if needed; the migration is additive and changes none of the earlier tables. Future automated ingestion must use separate bounded, fenced jobs and cannot repurpose this owner-only import endpoint as an unfenced runner completion.

An identifier scheme/value cannot be assigned to different issuers, and listing episodes for a venue/symbol cannot overlap; unknown listing dates are open bounds. Dates for listing episodes are inclusive, so a reused symbol needs a distinct, nonoverlapping episode. Prices must fall inside stated listing dates. These checks run within the import transaction as well as on in-file assertions. The initial library does not automatically reconcile identities or perform identifier unifications. Metric code/version has one owner-scoped definition ID. A source-document row is an immutable captured observation: different captures may share a source/external ID, but each has its own document ID and retrieval metadata. This intentionally preserves corrections and repeated retrievals instead of selecting a canonical latest document implicitly. The reviewed initial venue registry is in [equityVenues.ts](../packages/contracts/src/equityVenues.ts), checked against [ISO MIC data](https://www.iso20022.org/market-identifier-codes). It currently includes 15 Japanese/US venue and segment codes; unknown venues are rejected. Extend the registry after review, retaining historical codes because persisted records also decode through it. Full venue, OTC and PTS coverage is not claimed.

Until temporal identity assertions/resolution are implemented, use verified stable issuer/listing IDs and do not infer identity from ticker equality. Reimports cannot update a legal name, listing date or publication timestamp in place; a future correction protocol must preserve historical assertions rather than rewriting immutable imports.

## Validation record

See [EQUITIES_IMPLEMENTATION_REVIEW.md](EQUITIES_IMPLEMENTATION_REVIEW.md) for Claude Code reviews, finding dispositions, exact validation commands, live-environment coverage and the Firefox launch limitation.


## Source update timestamp

Migration `0015_materials_source_updated_at.sql` adds nullable `materials_source_updated_at` to `equity_source_document`. Import documents accept optional nullable `materialsSourceUpdatedAt`; omitted legacy values project to SQL NULL without changing old JSON or idempotency hashes. Source-backed facts/prices reference their document, preserving distinct source records. Use a separate document snapshot when individual records have different update timestamps. This is a source-supplied timestamp, not retrieval or import time.

Values must be canonical UTC milliseconds, exactly 24 ASCII characters (`2026-10-29T09:30:45.000Z`). The contract validates real dates; SQL checks type, length, shape and calendar round trip. Unknown values remain NULL, with no fabricated backfill/default. Raw source precision and timezone belong in provenance; normalize before import and retain higher precision externally. No timestamp index is added without a query requiring it. Metals uses these same proposed limits but has no implemented tables yet.
