# Table: metal_observation

## Overview

| Property | Value |
|---|---|
| Table Name | `metal_observation` |
| Purpose | One row per assessment date of an imported material series: the exact price as decimal text and the source's own update instant. |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 14. Materials (metals) |
| Created By | `infra/migrations/0016_material_series.sql` |
| Primary Key | `owner_id`, `series_id`, `observed_on` |
| Storage | `WITHOUT ROWID` |
| Code | `packages/adapters/src/sql/materials.ts` (`createMaterialRepository`), `packages/adapters/src/sql/repositories.ts` (`getObservations`) |
| Update Strategy | Insert-only, in the same guarded batch as the parent series; triggers abort every UPDATE and DELETE |
| Data Retention | Kept forever; at most 800 rows per series |

The materials import writes a series' observations together with its `metal_series` row, from the same validated payload. `getObservations` merges them with `market_observations` for the Home and Notebook chart, indicator and metric widgets, returning the newest N per series, with the decimal text and source update time for the widget's material details. Rows never change: a corrected or extended history is imported as a new series id.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (API-004). |
| `series_id` | TEXT | No | - | The parent series (`metal_series.series_id`), `materials:<ID>`. |
| `observed_on` | TEXT | No | - | Assessment date, `YYYY-MM-DD` (`isoDateSchema`); unique within the series and not after the series' `retrieved_at` date. |
| `value_decimal` | TEXT | No | - | Exact price as canonical decimal text (`equityDecimalSchema`: no exponent, no padded zeros, up to 132 characters) that must be a finite number; charts read `CAST(value_decimal AS REAL)`. |
| `materials_source_updated_at` | TEXT | Yes | - | The source's own record-update instant, ISO-8601 UTC with milliseconds (exactly 24 characters, e.g. `2026-10-29T09:30:45.000Z`), not after the series' `retrieved_at`; NULL when the source gives none (never invented from a date). |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id`, `series_id`, `observed_on` | - | One price per series and date; the import's `ON CONFLICT DO NOTHING` makes a replay a no-op. |
| (unnamed) | FOREIGN KEY | `owner_id`, `series_id` | `metal_series (owner_id, series_id) ON DELETE RESTRICT` | The series row must exist; it is inserted first in the same batch. |
| (unnamed) | CHECK | `observed_on` | `length(observed_on) = 10` | Shape of a `YYYY-MM-DD` date; the API validates the calendar date. |
| (unnamed) | CHECK | `value_decimal` | `length(value_decimal) BETWEEN 1 AND 132` | Bounds the decimal text as `equityDecimalSchema` does. |
| (unnamed) | CHECK | `materials_source_updated_at` | `materials_source_updated_at IS NULL OR (typeof(materials_source_updated_at) = 'text' AND length(materials_source_updated_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ', materials_source_updated_at, '+0 seconds') = materials_source_updated_at)` | NULL or canonical 24-character UTC text that round-trips through `strftime`, which rejects impossible dates and other formats. |

## Indexes

None. The primary key serves every read: `getObservations` reads each requested series as a `(owner_id, series_id)` prefix range in date order.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|
| `owner_id`, `series_id` | `metal_series` | `owner_id`, `series_id` | Many-to-one | Foreign key, ON DELETE RESTRICT |

## Triggers

| Trigger | Event | Body | Description |
|---|---|---|---|
| `metal_observation_immutable_delete` | BEFORE DELETE | `SELECT RAISE(ABORT, 'material observations are immutable');` | Rejects every delete of an observation. |
| `metal_observation_immutable_update` | BEFORE UPDATE | `SELECT RAISE(ABORT, 'material observations are immutable');` | Rejects every update of an observation. |

## Data Lifecycle

### Insert

`POST /api/v1/materials/imports` → `materials.import`: the second statement of the import batch inserts every observation of every incoming series (`json_each` over the series and their `observations`), under the same guard as the series insert (no conflicting stored series, at most 200 stored series).

### Update

Never: `metal_observation_immutable_update` aborts any UPDATE.

### Delete

Never: `metal_observation_immutable_delete` aborts any DELETE. Market-cache pruning deletes only `market_observations`.

### Synchronization

Not applicable: observations come only from owner imports; the runner never refreshes material series.

### Retention

Kept forever. The contract allows at most 800 observations per series, and the 200-series cap bounds the owner's total to 160,000 rows.

## Notes

- Created by 0016 and rebuilt by `0017_material_series_upgrade.sql` (see `metal_series`), which preserves existing rows and backfills observations held only in `metal_series.body_json`.
- Plotted values are floating-point projections; the exact decimal text and per-observation source update time stay available in the widget's material details.
