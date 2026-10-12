# ADR-0008: Switchable persistence behind two seams

**Status:** Accepted · **Date:** 2026-10-12 · Amends ADR-0004 (D1 write model)

## Context

Persistence already sat behind ports (`packages/application/src/ports.ts`), but the only implementation was typed against Cloudflare D1, and nothing proved a second engine would work. The owner requires that switching the database to another DB works without issues. Two findings shaped the design:

- The repositories use a small, stable slice of D1: `prepare`/`bind`/`first`/`all`/`run`/`batch`, atomic batches, `meta.changes`, and the SQLite dialect (`json_each`, `json_extract`, `ON CONFLICT`, `INSERT OR IGNORE`, `RETURNING`). That slice is worth naming, because any SQLite-dialect engine can serve it.
- `node:sqlite` (Node 23, no dependency) is close to D1 but not identical: it rejects `?NNN` numbered placeholders, drops `RETURNING` rows from `run()`, and yields batch rows only through `all()`. The differences belong in the driver, not in the repositories: the SQL text is frozen so both engines share one dialect.

## Decision

**Two seams, from narrow to wide.**

1. **`SqlDatabase` (`packages/adapters/src/sql/database.ts`): the narrow SQL driver interface.** Exactly what the repositories use and nothing more. Its contract: `batch` is atomic (the guarded writes of ADR-0004 rely on it); `meta.changes` counts changed rows; the SQL is the SQLite dialect. Rows are `Record<string, unknown>`, decoded with zod in `rows.ts` as before.
2. **`Persistence` (`packages/application/src/ports.ts`): the wide ports bundle.** All twelve repositories, the rate limiter, the audit log and the unit of work as one readonly bundle. The composition root depends on it (`overrides.persistence ?? createD1Adapters(env.DB)` in `apps/api/src/composition.ts`), never on an engine type.

**Repositories moved, SQL unchanged.** `repositories.ts`, `rows.ts` and `unitOfWork.ts` moved from `src/d1/` to `src/sql/` and are typed against `SqlDatabase`. No SQL text changed, with two engine-neutrality fixes inside the same statements: a D1-only `.first<T>()` type argument became a zod row decode, and the D1 binding (`src/d1/index.ts`, now only the binding) adapts `D1Database` to `SqlDatabase` with an explicit wrapper — no casts — that only touches the narrow surface, which is why any SQLite-dialect engine flows through the same composition code at runtime.

**A second engine: SQLite through `node:sqlite` (`src/sqlite/`, Node-only, no dependency).** Atomic `batch` via `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`; `?N` placeholders rewritten to positional with value duplication for reused numbers (three repository statements reuse a number); `RETURNING` and batched `SELECT` rows read through `all()`; file-based migrations with a `schema_migrations` table, each in its own transaction. A test scans the tree and fails on `D1Database`/`D1PreparedStatement` outside the D1 binding, the Worker env declaration and the workerd test setup.

## Evidence

The SAME six API test files run unedited on both engines: the existing workerd project (real local D1) and the new `api-sqlite` vitest project (Node + in-memory `node:sqlite`, with `cloudflare:test` aliased to `tests/persistence/cloudflareTestShim.ts`).

- D1: 6 files, 126 tests, all pass (the workerd project additionally runs the fetcher suite: 7 files, 178 tests total).
- `node:sqlite`: the same 6 files, the same 126 tests, all pass. No test file was edited; no file was excluded.

`bun run check`, `bun run typecheck`, `bun run test`, `bun run build` and `bun run bench` all pass.

## How to switch

- **Another SQLite-dialect engine** (Turso, Bun's SQLite, wrangler-local D1 over a new path): implement `SqlDatabase` (about five methods), add a vitest project like `api-sqlite` that runs `apps/api/test/**/*.test.ts` against it, and keep the 126 tests green. The three known dialect gaps to cover are in `src/sqlite/index.ts`'s header: `?NNN` placeholders, `RETURNING` row visibility, and batched-`SELECT` rows.
- **A non-SQLite database such as PostgreSQL:** the SQL in `src/sql` is not reusable (it is SQLite-dialect by contract). Implement the twelve `Persistence` ports in a new adapter directory, inject them through `CompositionOverrides.persistence`, and run the same suite against it. The suite is the portability bar: it exercises every guarded write, lease race, idempotency replay and migration the design relies on.

## What is NOT covered

- **Moving existing data between engines.** There is no dump-and-restore across engines; the portable path is the workspace export/import (a versioned JSON document), exercised on both engines by the suite.
- **Performance of another engine.** `bun run bench` measures the hot paths of this codebase, not the engine; re-measure after switching.
- **`node:sqlite` is the portability proof, not a supported production store.** Production stays D1 (local file today, Cloudflare tomorrow). The sqlite driver exists so the second-engine claim is tested, not asserted.

## Consequences

After independent review (2026-10-12), the driver's statement classification (skip all leading comments, classify a CTE by its main statement, write change counts from SQLite) and SQLite-accurate literal scanning (`''` doubling, no backslash escapes, bracket identifiers) were corrected, proven by `packages/adapters/test/sqlite/driver.test.ts`.

## Alternatives considered

- **An ORM or query builder.** Would hide the dialect but also the query count, and ADR-0004's budget (about a dozen queries per completion) is met by hand-written set-based statements. Rejected.
- **Rewriting the SQL to the lowest common denominator.** Would have changed tested statements to accommodate one immature driver; containing the three gaps in the driver keeps the dialect portable to mature SQLite engines as-is.
