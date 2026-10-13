# ADR-0019: The widget grid is an independent package, and agents can rearrange it

**Status:** Accepted · **Date:** 2026-10-14

## Context

The Home page's widget system — fixed sizes on a grid of equal cells, the
frame, drag and drop to reposition (ADR-0017) — lived in `apps/web/src/home/`
and was written against this app's market contracts, its Tailwind theme and
its Shoelace elements. The owner asked for two things: the widgets, the drag
and drop and the sizing system as an independent package other applications
can use, and a way for AI agents to manipulate the widgets.

Two facts shaped the decision. The domain package may import nothing
(ADR-0001), and it already owns `applyDashboardEdit`, proved in Lean
(`Dashboard.lean`). And the research agents of this app are text-in/text-out
with read-only tools, because the text they read is untrusted (ADR-0003).

## Decision

### One package, three layers

`packages/widget-grid` (`@research/widget-grid`) imports no other workspace
package. Its only npm dependencies are `solid-js` and `zod`.

| Entry | Directory | May import | Holds |
|---|---|---|---|
| `@research/widget-grid/core` | `src/core` | nothing | sizes and grid metrics, the layout edits (`applyWidgetLayoutEdit`), the drop-target decision (`nextDropTarget`) |
| `@research/widget-grid/agent` | `src/agent` | `core`, `zod` | the versioned command schema, the snapshot, the agent host, the tools, the MCP message handler |
| `@research/widget-grid` | `src/solid` | `core`, `solid-js` | `WidgetGrid`, `WidgetFrame`, the pointer/DOM drag engine, the move announcer, `styles.css` |

The import-boundary test enforces the table by directory, and `core` and
`agent` are additionally typechecked without the DOM library
(`tsconfig.neutral.json`), so they run unchanged in Node and in a Worker.

### What moved and what stayed

Moved: the sizing table, the grid, the frame (article, header strip as the
drag handle, scrolling body), the drag engine and its pure decision, the
move announcement. Stayed in `apps/web/src/home/`: the five market widgets,
the widget dialog, the registry entries and everything that talks to the
API. They are this app's content: they read market series, the watchlist,
the router and the API client. `HomeView` composes the package with them.

The package is generic over the widget: anything with `widgetId`, `type`,
`title` and `size` (`WidgetBase`). `HomeWidget` already has that shape, so
the app needed no mapping. The frame takes its actions menu as a slot; the
app keeps passing its own `ActionMenu`.

### Its own stylesheet, themed by custom properties

The package ships `styles.css` with `wg-` class names and `--wg-*` custom
properties and uses no Tailwind class, so a host needs no Tailwind and no
`@source` line. This app maps every `--wg-*` property to its own theme
variables in `apps/web/src/styles.css` (the same pattern as the Shoelace
token mapping), so Home looks exactly as before. The sizes are stated twice,
in `core/sizes.ts` and in the stylesheet, because CSS cannot import
TypeScript; a test reads the stylesheet and fails when they disagree.

### The DOM contract

Stable attributes, usable by tests, by browser automation and by
assistive technology alike: `data-widget-grid` on the grid; on each
`article` `data-widget-id`, `data-widget-type` and `data-widget-size`;
`data-widget-drag-handle` (the header strip); `data-widget-placeholder`
during a drag. Every move a pointer can make is also available without a
pointer through the host's actions menu (ADR-0017).

### Layout edits exist twice, tied by one model

`applyWidgetLayoutEdit` in the package and `applyDashboardEdit` in the
domain both implement add, remove, move and reorder. The domain cannot
import the package and the package must not import the domain, so the
duplication is deliberate. The Lean model's dashboard vectors are replayed
against both implementations in the conformance tests, so neither can drift
from the proved model or from the other. `resize` keeps every id in place
and `add` at a position is `add` followed by `reorder`, so neither needs a
new operation in the model. The drop-target decision gets its own Lean model
(`DragTarget.lean`) now that it is a package algorithm.

### The agent layer

An agent works through two operations: `describe` returns a snapshot (the
grid, the sizes, the widget types with the JSON Schema of their
configuration, and the widgets in order), and `apply` takes one command —
`add`, `remove`, `move`, `reorder`, `resize` or `update`. Commands are a
versioned discriminated union validated with zod; unknown kinds and unknown
fields are rejected. A command is applied only when the type is registered,
the size is allowed for the type, the type's own `build` accepts the widget,
and the store accepts the write at the revision that was read
(compare-and-set). Otherwise the layout is untouched and the agent gets a
stable failure code and one sentence (UI-004, ARCH-017).

`createWidgetAgentTools(host)` turns a host into tools with a name, a
description and a JSON Schema generated from the same zod schemas — the
shape MCP, function calling and WebMCP share. `createMcpToolServer` answers
the MCP messages (`initialize`, `tools/list`, `tools/call`, `ping`) as a
pure function of the message, so a host supplies only the transport.

### This app: an MCP server for the Home dashboard

`apps/mcp` is a stdio MCP server. Its store reads and writes the Home
dashboard through the existing owner API (`GET`/`PUT /home/dashboard` with
the version as the revision), so every agent edit passes the same schema
validation, the same limits and the same audit log as an edit made in the
browser, and no new route was added. It accepts loopback API addresses only.
Any MCP client (OpenCode, Codex, Claude Code) can connect to it; see
`docs/OPERATIONS.md`.

The research agents inside the app do not get these tools. They read
untrusted text; a tool that writes the owner's dashboard would be the first
write capability reachable from that text, which ADR-0003 rules out.

## Consequences

- `apps/web` depends on `@research/widget-grid`; the Home chunk carries the
  package stylesheet.
- A new widget type in another application is a registry entry plus a
  component; a new command kind is one schema member plus one reducer case.
- An open Home page learns of an agent's edit when it next reads the
  dashboard (it re-reads when the tab becomes visible again); an edit made
  from a stale page is refused with the existing "changed elsewhere" notice.
- Local trust model unchanged (ADR-0006): anything that can open a loopback
  connection could already edit the dashboard. The MCP server adds a
  convenient way to do it, not a new permission (`docs/THREAT_MODEL.md`).

## Alternatives considered

- **Keep Tailwind classes in the package** (as `ui-registry` does). Rejected:
  every host would need Tailwind v4 and a `@source` line pointing into the
  package, and would inherit this app's theme tokens.
- **Move the market widgets into the package.** Rejected: they depend on the
  market contracts, the API client, the router and the watchlist; a package
  holding them is not independent.
- **Let the domain import the package's layout edits** (one implementation).
  Rejected: the domain imports nothing (ADR-0001); the shared Lean vectors
  give the same guarantee without the dependency.
- **The official MCP SDK.** Rejected for now: the server needs four methods
  over newline-delimited JSON, and the SDK brings an HTTP stack this app does
  not use. Revisit if the server needs resources, prompts or HTTP transport.
- **A write tool for the research agents.** Rejected, see above.
