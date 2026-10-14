# ADR-0001: Package boundaries and where types live

**Status:** Accepted · **Date:** 2026-10-11

## Context

The architecture names six packages and three apps and gives an allowed dependency direction, but it does not say which package owns the record *types* versus their runtime *schemas*, nor where `agent-core` and `contracts` sit relative to `domain` and `application`. Rule ARCH-004 forbids the domain from depending on anything but TypeScript; the rules also say schemas SHOULD be defined once in `packages/contracts`.

## Decision

```text
domain        -> (nothing; no npm packages, no node:*, not even zod)
contracts     -> domain, zod
agent-core    -> contracts, domain, zod
application   -> domain, contracts, agent-core, zod
ui-registry   -> contracts, domain, solid-js, zod
widget-grid   -> solid-js, zod (no workspace package)
adapters      -> application, agent-core, contracts, domain, external SDKs
apps/api      -> application, contracts, domain, adapters/{d1,worker,feed,runtime}, hono, jose
apps/runner   -> application, agent-core, contracts, domain, adapters/{node,providers,tools,finance,feed,runtime}
apps/mcp      -> contracts, widget-grid/{core,agent}, zod
apps/web      -> contracts, ui-registry, domain, widget-grid, solid-js
```

- **Domain owns calculation types** (e.g. `DemandScenarioInput`, `PositionFigures`, `UiCommand`, `WorkspaceState`, `JobState` and its transition matrix) because the pure functions need them and may import nothing.
- **Contracts owns every runtime schema** and the persisted/API record shapes. Where a schema corresponds to a domain type it is declared `satisfies z.ZodType<DomainType>` (or typed as it), so the two cannot drift without a compile error. The job transition matrix is defined once in the domain and re-exported from contracts, which is the package the Worker, runner and SPA share.
- **`agent-core` is a ports package** (agent runtime port, tool definition/policy, model-text handling). `application` may import it as "declared ports".
- **Adapters are split by runtime** through separate entry points; `d1`, `worker`, `feed` and `runtime` use web-standard APIs only, so the Worker bundle can never pull in Node code.

## Enforcement

`tests/architecture/importBoundaries.test.ts` parses every source file with the TypeScript compiler API and fails on a forbidden specifier, a deep cross-package import, a relative import escaping its package, or an import cycle. Runtime separation is additionally enforced by typechecking each project against only its runtime's globals (`scripts/typecheck.ts`).

## Consequences

Schemas and domain types for the same concept exist in two files. That duplication is deliberate and compiler-checked; the alternative (zod in the domain) would break ARCH-004.
