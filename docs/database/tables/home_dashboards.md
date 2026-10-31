# Table: home_dashboards

## Overview

| Property | Value |
|---|---|
| Table Name | `home_dashboards` |
| Purpose | One row holds the owner's Home page arrangement: its widgets and their content (FR-017). |
| Database | Application database (Cloudflare D1; `node:sqlite` as the portable engine) |
| Schema Section | 6. Home and market data |
| Created By | `infra/migrations/0006_market_data.sql` |
| Primary Key | `owner_id` |
| Storage | Rowid table |
| Code | `packages/adapters/src/sql/repositories.ts` (`createHomeDashboardRepository`, `createChartEvidenceReferences`) |
| Update Strategy | Compare-and-set on `version`; an unconditional upsert for reset |
| Data Retention | One row per owner, never deleted |

The first read of Home inserts the default dashboard at version 0, so the first save keeps the compare-and-set contract. Owner saves (`PUT /home/dashboard`) replace the whole document and raise `version`; a reset (`POST /home/dashboard/reset`) replaces it with the defaults whatever is stored. After every save or reset the Home service deletes market series that no page tracks any more. The stored document also tells the market-refresh claim which series to fetch.

## Columns

| Column | Data Type | Nullable | Default | Description |
|---|---|---|---|---|
| `owner_id` | TEXT | No | - | The single owner's id (no owners table; every key starts with it, API-004). |
| `dashboard_json` | TEXT | No | - | JSON of the dashboard `{ schemaVersion: 2, widgets: [...] }` (at most 24 widgets). Validated by `homeDashboardSchema` on write; read through `storedHomeDashboardSchema` (`packages/contracts/src/home.ts`), which upgrades a version-1 document (ADR-0024). A document that no longer parses is reported as `STORED_DASHBOARD_UNREADABLE`, never replaced silently. |
| `version` | INTEGER | No | - | Monotonic version: 0 for the bootstrapped default, raised by 1 on every save and reset; saves are compare-and-set on it. |
| `updated_at` | TEXT | No | - | ISO-8601 UTC time of the last save or reset; the bootstrap row stores `1970-01-01T00:00:00.000Z`, which the API reports as null. |

## Constraints

| Name | Type | Columns | Definition | Description |
|---|---|---|---|---|
| (unnamed) | PRIMARY KEY | `owner_id` | - | One dashboard per owner; serves every read and write. |

## Indexes

None. The primary key serves every read: `get`, `put`, `reset` and the chart-evidence scan all look up the single row by `owner_id`.

## Relationships

| Column | Referenced Table | Referenced Column | Relationship | Enforcement |
|---|---|---|---|---|

## Data Lifecycle

### Insert

`createHomeDashboardRepository().get` inserts `DEFAULT_HOME_DASHBOARD` at version 0 with `ON CONFLICT (owner_id) DO NOTHING` when no row exists (first `GET /home/dashboard` or any service read). `put` with `expectedVersion` 0 and `reset` also insert at version 1 through `ON CONFLICT DO UPDATE`.

### Update

`put` (`PUT /home/dashboard`, `HomeService.putDashboard`) runs `UPDATE ... WHERE owner_id = ? AND version = ?`, setting `dashboard_json`, `version = version + 1` and `updated_at`; no row matched means `VERSION_CONFLICT`. `reset` (`POST /home/dashboard/reset`) upserts the default widgets unconditionally and raises `version`.

### Delete

Never: no code path deletes the row.

### Synchronization

Not applicable: the owner writes the arrangement. Market values shown by the widgets live in `market_series` and `market_observations`.

### Retention

One row per owner for the life of the installation; its size is bounded by `homeDashboardSchema` (24 widgets).

## Notes

- Saves validate chart widgets that carry `sources` against the owner's research records before writing (ADR-0026).
- `listChartEvidenceIds` reads chart `sources` out of this document and the notebooks, so deleting a conversation keeps evidence a Home chart still cites.
