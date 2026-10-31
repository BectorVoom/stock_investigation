# Table: articles

## Overview

| Property | Value |
|---|---|
| Table Name | `articles` |
| Purpose | One row per news article retrieved from a subscribed source, deduplicated by URL and by content fingerprint (FR-003). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 1. Sources and articles |
| Created By | `infra/migrations/0001_initial.sql` |
| Primary Key | `owner_id`, `article_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/unitOfWork.ts` (`commitCompletion`), `packages/adapters/src/sql/repositories.ts` (`createArticleRepository`), `packages/adapters/src/sql/rows.ts` (`toArticle`) |
| Update Strategy | Insert-only (`INSERT OR IGNORE`) |
| Data Retention | Kept indefinitely; no code path deletes articles |

The runner fetches the owner's feeds during news-ingest and research jobs and submits the articles with its completion. The API keeps only articles of sources the owner still has, drops the excerpt where the source's license forbids it, and stores the rest in the completion batch. The Sources page reads them newest first, 50 per page, optionally filtered by source (`GET /api/v1/articles`).

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; API-004). |
| `article_id` | TEXT | No | - | Deterministic id `art_` plus the first 32 hex characters of `content_fingerprint` (`toArticle` in `runnerJobs.ts`), so a resubmitted article maps to the same id. |
| `source_id` | TEXT | No | - | The `news_sources` row the article came from. |
| `canonical_url` | TEXT | No | - | Canonical HTTPS URL of the article (`httpsUrlSchema`); unique per owner. |
| `publisher` | TEXT | No | - | Publisher name as submitted by the runner. |
| `title` | TEXT | No | - | Headline, 1–300 characters (`articleSchema`). |
| `published_at` | TEXT | Yes | - | ISO-8601 UTC publication time from the feed; NULL when the feed gives none. |
| `retrieved_at` | TEXT | No | - | ISO-8601 UTC time the runner retrieved the article; the list's sort key. |
| `content_fingerprint` | TEXT | No | - | SHA-256 of the article content, 64 lowercase hex characters; unique per owner. |
| `excerpt` | TEXT | Yes | - | Up to 500 characters, kept only when the source's `license_policy` is `short-excerpt-permitted`; otherwise NULL. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `article_id` | - | Identifies one article; with the deterministic id, a repeated submission is ignored. |
| (unnamed) | UNIQUE | `owner_id`, `content_fingerprint` | - | FR-003: one article per content fingerprint; `INSERT OR IGNORE` skips a duplicate. |
| (unnamed) | UNIQUE | `owner_id`, `canonical_url` | - | FR-003: one article per canonical URL; `INSERT OR IGNORE` skips a duplicate. |

## Indexes

| Index Name | Columns | Unique | Purpose |
|---|---|---|---|
| `idx_articles__owner_id_retrieved_at_article_id` | `owner_id`, `retrieved_at`, `article_id` | No | `ArticleRepository.list`: newest first, keyset-paged on `(retrieved_at, article_id)`, optionally filtered by source. Scanned backwards, so `ORDER BY retrieved_at DESC, article_id DESC` needs no temporary sort. |

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `source_id` | `news_sources` | `owner_id`, `source_id` | Many-to-one | Logical |

## Data Lifecycle

### Insert

`ResearchUnitOfWork.commitCompletion` inserts the completion's articles with one `INSERT OR IGNORE ... FROM json_each` statement, guarded on the job compare-and-set. The runner submits them with a news-ingest (`ingested`) or research (`completed` / `partial`) completion (`POST /api/v1/runner/jobs/:id/complete`). `ownedArticles` first drops articles of unknown sources and clears excerpts the license does not permit. The statement's change count becomes the completion's `newArticleCount`.

### Update

Never: rows are immutable. A duplicate URL or fingerprint is skipped, not merged.

### Delete

Never: no code path deletes articles, including when their source is removed.

### Synchronization

Each news-ingest or research claim fetches every non-paused source in full. Deduplication on URL and fingerprint makes re-fetching the same items a no-op, so the table grows only by new articles.

### Retention

Kept indefinitely. Nothing bounds the table's size except the number of distinct articles the owner's feeds publish.

## Notes

- Articles of a removed source stay, with a `source_id` that no longer resolves; the unfiltered list still shows them.
- The list's `(retrieved_at, article_id) < (?, ?)` row-value comparison relies on the index order; `article_id` is the tie-breaker for equal retrieval times.
- No retention or pruning exists yet; on D1 the table grows without bound (technical debt).
