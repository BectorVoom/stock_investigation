# Table: news_sources

## Overview

| Property | Value |
|---|---|
| Table Name | `news_sources` |
| Purpose | One row per news feed the owner subscribes to; the runner fetches every non-paused source on a news-ingest or research claim. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 1. Sources and articles |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `source_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createSourceRepository`), `packages/adapters/src/sql/unitOfWork.ts` (`commitCompletion`), `packages/adapters/src/sql/rows.ts` (`toNewsSource`) |
| Update Strategy | Insert once per canonical URL; owner edits and fetch reports update the row in place |
| Data Retention | Kept until the owner removes the source; at most 100 per owner (`MAX_SOURCES`) |

The owner registers a source on the Sources page (`createSourceService.register`, `POST /api/v1/sources`), after the API re-validates the feed itself. The owner can then edit its labels, license and trust class, or pause it. Every news-ingest or research completion that fetched feeds writes back the fetch time, error code and feed status. Removing a source deletes only this row; its articles stay.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `source_id` | TEXT | No | - | Source id, `src_` plus random hex (`IdGenerator.newId("src")`). |
| `canonical_url` | TEXT | No | - | The feed's canonical HTTPS URL as returned by feed inspection (`httpsUrlSchema`); unique per owner. |
| `source_type` | TEXT | No | - | Feed format detected at registration: `rss`, `atom`, `api` or `html` (`sourceTypeSchema`). |
| `title` | TEXT | No | - | Display title; defaults to the publisher name. Owner-editable. |
| `publisher` | TEXT | No | - | Publisher name, from the request or suggested from the feed. Owner-editable. |
| `license_policy` | TEXT | No | - | `headline-and-link-only` or `short-excerpt-permitted` (`licensePolicySchema`); decides whether an article may keep its excerpt (DATA-010). |
| `trust_classification` | TEXT | No | - | `official`, `established-media`, `trade-press` or `unclassified` (`trustClassificationSchema`). |
| `feed_status` | TEXT | No | - | `active`, `failing` or `paused` (`feedStatusSchema`). Starts `active`; a fetch report sets `active` or `failing` unless the owner paused the source. |
| `last_fetched_at` | TEXT | Yes | - | ISO-8601 UTC time of the last fetch the runner reported; NULL until the first one. |
| `last_error_code` | TEXT | Yes | - | Stable error code of the last fetch (at most 100 characters); NULL when it succeeded. |
| `created_at` | TEXT | No | - | ISO-8601 UTC registration time; the list's sort key. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last owner edit. Fetch reports do not change it. |
| `last_error_upstream_status` | INTEGER | Yes | - | HTTP status the feed host answered the last failed fetch with, unchanged (ADR-0037); NULL when no external answer caused the failure. Read only beside `last_error_code` (`statusBesideCode`). Added by 0012. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `source_id` | - | Identifies one source; serves `get`, `update`, `delete` and the completion's fetch-report update. |
| (unnamed) | UNIQUE | `owner_id`, `canonical_url` | - | One subscription per feed URL: `insert` uses `ON CONFLICT (owner_id, canonical_url) DO NOTHING` and the service answers `DUPLICATE_SOURCE`. Also serves `findByCanonicalUrl` (the preview's "already subscribed" flag). |

## Indexes

None. The primary key serves every read: `list` scans the owner's range (at most 100 rows) and sorts by `created_at, source_id`. The UNIQUE key's automatic index serves the lookup by URL.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`SourceRepository.insert`, called by `createSourceService.register` (`POST /api/v1/sources`) after `inspect` re-fetches and parses the feed. The service checks the 100-source cap first. A second registration of the same canonical URL inserts nothing and returns `DUPLICATE_SOURCE`.

### Update

The owner's `PATCH /api/v1/sources/:id` (`SourceRepository.update`) sets any of `title`, `publisher`, `license_policy`, `trust_classification`, `feed_status` and `updated_at`. Column names come from the fixed `SOURCE_PATCH_COLUMNS` map. A runner completion with `sourceReports` (`commitCompletion`, one set-based `UPDATE ... FROM json_each`) sets `last_fetched_at`, `last_error_code`, `last_error_upstream_status` and `feed_status`, guarded on the job compare-and-set. Only sources the owner still has are reported (`ownedArticles`).

### Delete

`SourceRepository.delete`, called by `createSourceService.remove` (`DELETE /api/v1/sources/:id`). Nothing cascades: the source's `articles` rows are kept.

### Synchronization

The runner fetches each non-paused source (`activeSources`) when it claims a news-ingest or research job. The completion stores new articles and updates this row's fetch state in the same batch. Feeds are fetched in full each time; there is no incremental cursor in this table.

### Retention

Rows stay until the owner removes them. The service caps an owner at 100 sources.

## Notes

- Fetch reports do not touch `updated_at`, so `updated_at` means "last owner edit", not "last change".
- The feed host's answer status is stored as a number only, never provider text (SEC-010).
