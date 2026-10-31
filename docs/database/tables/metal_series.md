# Table: metal_series

## Overview

| Property | Value |
|---|---|
| Table Name | `metal_series` |
| Purpose | One row per owner-imported physical-material price series version (`materials:<ID>`): an immutable source snapshot with its provenance, charted by the shared market widgets (ADR-0042). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 14. Materials (metals) |
| Created By | `infra/migrations/0016_material_series.sql` |
| Primary Key | `owner_id`, `series_id` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/materials.ts` (`createMaterialRepository`), `packages/adapters/src/sql/repositories.ts` (`getSeriesMeta`) |
| Update Strategy | Insert-only; triggers abort every UPDATE and DELETE; an identical replay is a no-op |
| Data Retention | Kept forever; at most 200 series (including old versions) per owner |

`POST /api/v1/materials/imports` stores up to 20 validated series per request in one guarded batch with their `metal_observation` rows and an audit row. The full snapshot stays in `body_json`, returned unchanged by `GET /api/v1/materials/series/:seriesId`; the metadata columns are copies of its fields for the catalog and widget reads. `listCatalog` adds the owner's series to the Home / Notebook widget catalog (`GET /api/v1/home/catalog`), and `getSeriesMeta` returns them beside `market_series` rows with provider `materials`. A correction or new dates need a new series id, because a stored series can never change.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `series_id` | TEXT | No | - | `materials:` plus 1–25 uppercase ASCII letters or digits (`materialSeriesSchema`); different sources, grades, bases or versions use different ids. |
| `body_json` | TEXT | No | - | The imported series exactly as validated (`materialSeriesSchema`), observations sorted by date; at most 750,000 characters. The import's replay comparison and `get` read it. |
| `committed_at` | TEXT | No | - | ISO-8601 UTC time the API accepted the import; shown as the series' `lastRefreshedAt`. |
| `title` | TEXT | No | - | Series title, 1–120 characters (copied from `$.title`); the catalog label. |
| `material` | TEXT | No | - | Material name, 1–200 characters (copied from `$.material`). |
| `product` | TEXT | No | - | Product, 1–200 characters (copied from `$.product`); part of the catalog description and the widget's material details. |
| `grade` | TEXT | No | - | Grade, 1–200 characters (copied from `$.grade`). |
| `basis` | TEXT | No | - | Assessment basis (delivery, tax, currency basis), 1–200 characters (copied from `$.basis`). |
| `source_id` | TEXT | No | - | Source identifier, 1–64 characters `[a-zA-Z0-9][a-zA-Z0-9_-]*` (copied from `$.sourceId`). |
| `unit` | TEXT | No | - | Price unit, 1–80 characters (copied from `$.unit`). |
| `frequency` | TEXT | No | - | `daily`, `weekly`, `monthly`, `quarterly` or `annual` (copied from `$.frequency`; `unknown` is refused). |
| `publisher` | TEXT | No | - | Publisher name, 1–200 characters (copied from `$.publisher`). |
| `source_url` | TEXT | No | - | HTTPS link to the source (copied from `$.sourceUrl`, `httpsUrlSchema`). |
| `retrieved_at` | TEXT | No | - | ISO-8601 UTC instant with milliseconds (24 characters) when the owner retrieved the data (copied from `$.retrievedAt`); not in the future at import. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `series_id` | - | One row per series version per owner; the import's `ON CONFLICT DO NOTHING` makes an identical replay a no-op. |
| (unnamed) | CHECK | `series_id` | `series_id GLOB 'materials:*' AND length(series_id) BETWEEN 11 AND 35` | Keeps ids in the `materials:` namespace with 1–25 characters after the prefix. |
| (unnamed) | CHECK | `series_id`, `body_json` | `json_valid(body_json) AND length(body_json) <= 750000 AND json_extract(body_json, '$.seriesId') = series_id` | The snapshot is valid JSON within the import byte bound and names the same series as its key. |
| (unnamed) | CHECK | `title` | `length(title) BETWEEN 1 AND 120` | Bounds the title as the contract does. |

## Indexes

None. The primary key serves every read: `get` and the import's conflict check seek one full key, and `listCatalog`, `getSeriesMeta` and the stored-series count read the owner's prefix range.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Triggers

| Trigger | Event | Body | Description |
|---|---|---|---|
| `metal_series_immutable_delete` | BEFORE DELETE | `SELECT RAISE(ABORT, 'material series is immutable');` | Rejects every delete: a stored series version is permanent. |
| `metal_series_immutable_update` | BEFORE UPDATE | `SELECT RAISE(ABORT, 'material series is immutable; import a new version');` | Rejects every update: a correction is imported as a new series version. |

## Data Lifecycle

### Insert

`POST /api/v1/materials/imports` → `materials.import`: one batch inserts the series (`INSERT … SELECT … FROM json_each(?)`, metadata via `json_extract`), their observations and the audit row `materials.import`. Every statement carries the same guard: no incoming series may exist with a different `body_json`, and the owner's stored plus new series must stay within 200. When the guard fails, nothing is written and the API answers 409 `CONFLICT`.

### Update

Never: `metal_series_immutable_update` aborts any UPDATE. Corrections are imported as a new series id.

### Delete

Never: `metal_series_immutable_delete` aborts any DELETE, and `metal_observation` references the row with `ON DELETE RESTRICT`. Market-cache pruning (`deleteSeriesNotIn`) touches only `market_series`.

### Synchronization

Not applicable: series are imported by the owner; the runner never fetches or refreshes them.

### Retention

Kept forever. `MATERIAL_LIMITS.maxStoredSeries` (200 per owner, old versions included) bounds the table; an import that would add series beyond it returns 409. An identical replay adds no series, so it still succeeds at the limit.

## Notes

- Migration history: `0016_material_series.sql` created the table in its current form. `0017_material_series_upgrade.sql` then rebuilds it so both layouts that existed before 0017 converge: an early 0016 that had only `owner_id`, `series_id`, `body_json` and `committed_at` (and no `metal_observation`), and the current one. It copies the rows to backup tables, drops and recreates `metal_series`, `metal_observation` and their four triggers, fills the metadata columns from `body_json`, restores the observation rows and adds any observations found only in `body_json`'s `observations` array. Applied history is not edited.
- The importer stores user-supplied provenance; it does not verify provider claims or licences. There is no deletion, archive or import UI yet ([materials library guide](../libraries/materials.md)).
- Decimal and calendar validation is authoritative at the typed API boundary; direct SQL writes are not a supported import path.
