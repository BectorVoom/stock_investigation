# @research/widget-grid

A widget grid for SolidJS applications: three fixed sizes on a grid of equal
cells, a frame whose header is the drag handle, drag and drop to reposition,
and a command layer through which AI agents can read and rearrange the grid.

It imports no other workspace package. Dependencies: `solid-js` and `zod`.
Decision record: `docs/adr/0019-reusable-widget-grid-and-agent-layer.md`.

## Entry points

| Import | Runs in | Contents |
|---|---|---|
| `@research/widget-grid` | browser | `WidgetGrid`, `WidgetFrame`, the drag engine, the move announcer; re-exports `core` |
| `@research/widget-grid/core` | anywhere | sizes, layout edits, the drop-target decision |
| `@research/widget-grid/agent` | anywhere | command schema, snapshot, agent host, tools, MCP message handler |
| `@research/widget-grid/styles.css` | browser | the stylesheet (import it once) |

## Your widget type

Any object with these four fields is a widget; add your own fields beside
them.

```ts
import type { WidgetBase } from "@research/widget-grid/core";

interface NoteWidget extends WidgetBase {
	readonly type: "note";
	readonly text: string;
}
```

## UI

<!-- UI section: owned by the UI extraction task -->

```tsx
import { WidgetFrame, WidgetGrid } from "@research/widget-grid";
import "@research/widget-grid/styles.css";

<WidgetGrid
	widgets={widgets()}
	canDrag={!saving()}
	onReorder={(drop) => save(drop.widgetId, drop.toIndex)}
>
	{(widget) => (
		<WidgetFrame widget={widget} actions={<MyMenu widget={widget} />}>
			<MyWidgetBody widget={widget} />
		</WidgetFrame>
	)}
</WidgetGrid>;
```

- `onReorder` receives `{ widgetId, fromIndex, toIndex, preview }`. When it
  returns a promise, the previewed order stays on screen and no new drag
  starts until the promise settles.
- A drag starts from the header strip after 4 px of movement; a press on a
  button, link or form control never starts one. `Escape`, `pointercancel`
  or the window losing focus cancels it.
- Offer every move without a pointer as well (for example "Move earlier" /
  "Move later" in the `actions` menu) and announce completed moves with the
  move announcer.

### Sizes

| Size | Narrow (2 columns) | Wide (4 columns, from 64rem) |
|---|---|---|
| `small` | 1 × 1 | 1 × 1 |
| `medium` | 2 × 2 | 2 × 2 |
| `large` | 2 × 2 | 4 × 2 |

Rows are 17rem tall with a 1rem gap. The numbers live in `core/sizes.ts`
(`WIDGET_GRID_METRICS`, `WIDGET_SIZE_SPANS`).

### Theming

The stylesheet reads `--wg-*` custom properties and falls back to neutral
defaults. Set them on any ancestor of the grid.

### DOM contract

`data-widget-grid` on the grid; `data-widget-id`, `data-widget-type` and
`data-widget-size` on each widget `article`; `data-widget-drag-handle` on the
header strip; `data-widget-placeholder` on the slot shown during a drag.

## Agents

<!-- Agent section: owned by the agent layer task -->

```ts
import {
	createMcpToolServer,
	createWidgetAgentHost,
	createWidgetAgentTools,
} from "@research/widget-grid/agent";

const host = createWidgetAgentHost({ store, types, newWidgetId });
const tools = createWidgetAgentTools(host);
```

- `store` reads and writes your widgets with a revision (compare-and-set).
- `types` lists your widget types: label, description, allowed sizes, the
  JSON Schema of the configuration, and `build` / `configOf`.
- Each tool has `name`, `description`, `inputSchema` (JSON Schema) and
  `execute(input)`; pass them to an MCP server, a function-calling loop or a
  page-level tool registry.

Commands: `add`, `remove`, `move`, `reorder`, `resize`, `update` (see
`src/agent/types.ts`). A command that fails validation changes nothing and
returns a failure code with one sentence.
