# ADR-0042: Imported physical-material series in shared market widgets

Status: accepted for the first import/read/display phase, 2026-10-29.

The existing widgets accept provider-qualified market series. Physical critical-mineral prices cannot be represented by mining stocks or ETFs. Add a distinct `materials:` namespace backed by owner-scoped, immutable SQLite/D1 snapshots and exact observations. Supply the shared Home/Notebook market read model and dynamic widget catalog from those tables. Preserve per-source update instants and explicit product/grade/basis in widget details.

An import atomically creates at most 20 bounded series; same-content replay is allowed. A series version cannot be overwritten, including by runner refresh or dashboard pruning. New observations/corrections require a new version and explicit owner selection. This deliberate first-phase limitation avoids silently replacing historical definitions until the full revision ledger is implemented. The catalog is capped at 200 stored versions per owner.

No external feed, composite-index calculation or automatic material discovery by the Notebook assistant is implied. Future phases follow METALS_DATABASE_DESIGN.md. See [implemented behavior and limits](../METALS_DATABASE.md) for the import API, validation and remaining scope. Rollback disables new imports/widgets and restores a compatible backup; migrations are additive and no live owner data is seeded.
