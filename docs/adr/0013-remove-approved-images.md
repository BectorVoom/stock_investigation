# ADR-0013: Remove owner-approved images entirely

**Status:** Accepted · **Date:** 2026-10-13

## Context

The owner decided on 2026-10-13 to remove images from this research
application entirely. The Settings UI for approving images had already been
removed (2026-10-12); what remained was everything behind it: the `/assets`
API routes, the approved-asset use cases and `AssetRepository` port, the
`approved_assets` table, the `approvedAssetSchema` / approve-request / list
contracts, the `workspaceViewSchema.assets` and export `assets` fields, the
`image-gallery` component type with its `assetRefs` references, asset checks in
the canvas reducer (`UNKNOWN_ASSET`), the image gallery renderer and
`RenderContext.assets`, and the approval plumbing in workspace view, export and
import. The agent was never offered the type (`MODEL_CREATABLE_TYPES` lists
only tables, charts and source lists) and no prompt mentions images, so the
removal touches the offering side only in the registry.

Stored data outlives the code: `workspaces.state_json` and
`workspace_commands.command_json` may contain `image-gallery` components and
asset references written before this change, and the contracts are strict zod
objects. Existing conversations must keep loading through the workspace view,
the events endpoint and export.

## Decision

1. **Remove the whole feature.** No approval API, no approved-asset storage, no
   asset fields in any contract, no `image-gallery` component type, no asset
   references in the reducer (`ComponentReferences`, `CommandContext` and the
   `UNKNOWN_ASSET` check are gone), no gallery renderer, no `RenderContext.assets`,
   no asset-only fixtures, prompts or tool schemas. Nine V1 component types remain.
2. **Destructive, one-way migration.** `0005_remove_approved_images.sql` drops
   the `approved_assets` table, deleting the owner's stored approvals for good
   (the owner's explicit decision, stated in the migration's header comment).
   Rollback is restoring a pre-migration backup of `data/`; running old code
   against the migrated database is refused as a newer database, and the old
   approval endpoints would find no table anyway (`docs/OPERATIONS.md`).
3. **Legacy-read strip, not migration rewrite.** Stored states and commands are
   read through `toWorkspaceRecord` / `toAppliedCommand` in
   `packages/adapters/src/sql/rows.ts`, validated by `workspaceStateSchema` /
   `uiCommandSchema`, which accept any well-formed `componentType` (regex only)
   and therefore still parse pre-removal rows. A single clearly named step,
   `dropWithdrawnImageComponents`, drops `image-gallery` components from the
   decoded state on every read and repairs `layout.order`, focus and selection;
   the version is untouched. Rewriting stored JSON in SQL was rejected: it
   would need identical JSON surgery on both persistence backends (D1 and
   SQLite, ADR-0008) and would have to neutralise history entries without
   breaking the `(owner_id, workspace_id, version)` continuity that
   compare-and-set writes and event polling rely on. Stripping on read keeps the
   version sequence intact on both backends (shared TypeScript, not per-engine
   SQL), preserves history verbatim for audit, and lets the next owner or agent
   write persist the stripped state naturally.
4. **Import refuses image files; export carries none.** New exports have no
   image data. Import probes the raw payload first: a non-empty `assets` array
   or any `image-gallery` component is refused with `VALIDATION_FAILED` naming
   approved images and the removal decision — never silently trimmed. An empty
   legacy `assets` array is dropped before validation so pre-removal files
   without images still import at the same format version (1). The web client
   mirrors the empty-array tolerance so old clean files still validate
   client-side; image-bearing files reach the server and get its message.

## Alternatives rejected

- **Migration rewrites stored data.** Would need per-engine SQL JSON surgery
  with identical behaviour on D1 and SQLite, plus a no-op encoding for history
  entries that preserves the version uniqueness the events endpoint and
  compare-and-set depend on. Higher risk than one shared TypeScript function,
  and irreversible where the read-time strip is not.
- **Bumping the export format version.** Unnecessary: the refusal happens
  before schema validation on the raw payload, and the empty-array strip keeps
  version 1 files importing. A version bump would strand every existing file
  for no gain.
- **Silently dropping galleries on import.** Rejected: an owner-chosen file must
  never lose visible content without being told. The refusal names the reason.

## Consequences

- Old conversations load everywhere (view, events, export, browser render)
  with a consistent version sequence; galleries are gone from what is shown,
  focus/selection pointing at them reset to null.
- The Lean workspace model needed no change: it abstracts component types and
  reference checks (only the structural create/remove/reorder/touch alphabet is
  modelled), so `bun run formal:check` and the conformance vectors pass
  untouched.
- FR-011 is annotated as withdrawn in part (not silently rewritten);
  FR-015 records the refusal rule; the threat model notes no `<img>` is
  rendered from stored data.
