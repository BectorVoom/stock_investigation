# ADR-0043: Widget data is read back from the database

Status: accepted, 2026-10-31.

Home and Notebook render persisted records. Providers and agents collect or propose data; they never supply a widget's read model directly. Owner input, templates, clipboard copies and Undo bodies are write proposals until saved and read back. Values derived from stored observations (change, chart windows and formatting), editor drafts and drag previews remain presentation concerns.

```text
provider / agent / owner / clipboard
                ↓ validated write
          SQLite or D1
                ↓ repository read + validated API response
          shared widget renderers
```

| Widget content | Database read path |
|---|---|
| Home arrangement, inline text/metric/chart/table | `home_dashboards` through the Home repository |
| Notebook arrangement and inline content | notebook repository after CAS write; session exposes confirmed state only |
| Research components, datasets and evidence | workspace and research-record repositories; command responses re-read the workspace |
| Market and material observations and attribution | market repository, including the imported material tables; no catalog substitution for stored titles |
| Watchlist prices and earnings | stock/list/event repositories; attribution from `earnings_sources` |
| Scheduled tasks and latest answers | scheduled-task/job/chat repositories; task creation responses re-read the committed task |

The SQL Home repository initializes an absent arrangement with an insert that does nothing on conflict, then reads it back. Version zero preserves the existing first-save CAS contract and `origin: defaults`; its API timestamp remains null. Existing arrangements, including unreadable records, are never replaced by initialization. Home reads fail if an adapter supplies no initialized record. Default constants remain seed/reset inputs, not read responses.

Series with no metadata show their stored configuration's symbol and an unavailable state, with no invented source URL. Metadata rows, including failure placeholders, are displayed as stored. Observation rows without metadata fail closed. Catalog suggestions remain available in the widget editor.

Migration `0018_widget_earnings_sources.sql` adds two shared provider reference rows without rewriting stocks or earnings events. The database, rather than the domain provider table, supplies widget publisher names and links. Existing deployments must restart through the supported launcher to apply the migration before using the new API. Restore a pre-migration backup for rollback; older releases ignore the additive table.

Previously read database snapshots may remain visible during polling or a failed refresh; they are not raw provider data. Stored inline content remains supported: database persistence does not itself establish that a financial statement is true. Existing evidence validation is retained.

Validation includes held/rejected saves for all inline widget types, server readback differing from a submitted draft, SQLite and Workers/D1 API tests, populated schema-17 upgrades, and the real development launcher with a held browser save, migration and restart. See [review and execution record](../database/reviews/widget-database-review.md).
