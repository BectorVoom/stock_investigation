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

An agent reads the grid with `describe` and rearranges it with one command at
a time through `apply`. Commands are a versioned discriminated union on
`kind`, validated with zod: unknown kinds and unknown fields are rejected.

```ts
import {
	createWidgetAgentHost,
	createWidgetAgentTools,
	type WidgetAgentType,
} from "@research/widget-grid/agent";
import type { JsonObject } from "@research/widget-grid/agent";

interface NoteWidget {
	readonly widgetId: string;
	readonly type: "note";
	readonly title: string;
	readonly size: "small" | "medium" | "large";
	readonly text: string;
}

const noteType: WidgetAgentType<NoteWidget> = {
	type: "note",
	label: "Note",
	description: "A sticky note.",
	defaultSize: "small",
	sizes: ["small", "medium"],
	configSchema: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	build: (draft) => {
		const text = draft.config["text"];
		if (typeof text !== "string" || text.trim().length === 0) {
			return { ok: false, error: 'config needs a non-empty "text" string.' };
		}
		return {
			ok: true,
			value: {
				widgetId: draft.widgetId,
				type: "note",
				title: draft.title,
				size: draft.size,
				text,
			},
		};
	},
	configOf: (widget) => ({ text: widget.text }),
};

let widgets: NoteWidget[] = [];
let revision = 0;
let nextId = 0;

const host = createWidgetAgentHost({
	store: {
		read: async () => ({ ok: true as const, value: { widgets, revision } }),
		write: async (next, seen) => {
			if (seen !== revision) {
				return {
					ok: false as const,
					error: {
						code: "CONFLICT" as const,
						message: "the layout changed elsewhere; describe again and retry.",
					},
				};
			}
			revision += 1;
			widgets = [...next];
			return { ok: true, value: { widgets, revision } };
		},
	},
	types: [noteType],
	newWidgetId: () => `w${(nextId += 1)}`,
});

const snapshot = await host.describe();
const added = await host.apply({
	kind: "add",
	type: "note",
	title: "Todo",
	config: { text: "Buy milk" },
});
```

- `store` reads and writes your widgets with a revision (compare-and-set):
  `write` rejects with `CONFLICT` when the revision is no longer current.
- `types` lists your widget types: label, description, allowed sizes, the
  JSON Schema of the configuration, and `build` / `configOf`.
- `newWidgetId` allocates the id of an added widget.
- `limits` (default 24 widgets) and `validateLayout` (whole-layout rules
  beyond the per-widget checks) are optional.

Commands: `add`, `remove`, `move`, `reorder`, `resize`, `update` (see
`src/agent/types.ts`). Positions (`toIndex`) are 0-based: `reorder` lands the
widget at `toIndex` of the result while the others keep their order, and
`add` with `toIndex` is append followed by reorder to that position. `update`
shallow-merges `config` over the widget's current config. A command that
fails validation changes nothing and returns a failure code with one
sentence.

### Tools

`createWidgetAgentTools(host, { prefix = "widgets_" })` turns a host into one
tool per operation, each with `name`, `title`, `description`, `inputSchema`
(JSON Schema generated from the same zod schemas) and `execute(input)`. Pass
them to an MCP server, a function-calling loop or a page-level tool registry.

| Tool | What it does |
|---|---|
| `widgets_describe` | Read-only: the grid, sizes, types and widgets in order |
| `widgets_add` | Add a widget of a registered type |
| `widgets_remove` | Delete one widget by id |
| `widgets_move` | Swap a widget with its earlier/later neighbour |
| `widgets_reorder` | Move a widget to an absolute 0-based position |
| `widgets_resize` | Change a widget's size to one its type allows |
| `widgets_update` | Rename and/or reconfigure a widget |

Call `widgets_describe` first to learn ids, types and config schemas.

### Failure codes

`INVALID_COMMAND` (the input did not match the command schema),
`UNKNOWN_WIDGET_TYPE`, `SIZE_NOT_ALLOWED`, `INVALID_WIDGET` (the type's
`build` or the host's `validateLayout` rejected the widget or layout),
`WIDGET_NOT_FOUND`, `DUPLICATE_WIDGET_ID`, `MOVE_AT_END`,
`POSITION_OUT_OF_RANGE`, `TOO_MANY_WIDGETS`, `CONFLICT` (the layout changed
between read and write; describe again and retry), `STORE_UNAVAILABLE`,
`UNKNOWN_TOOL`.

### Serve it over MCP

`createMcpToolServer({ name, version, tools })` answers the MCP messages
(`initialize`, `tools/list`, `tools/call`, `ping`) as a pure function of the
message — a host supplies only the transport:

```ts
import { createMcpToolServer } from "@research/widget-grid/agent";

const server = createMcpToolServer({
	name: "my-widgets",
	version: "1.0.0",
	tools: createWidgetAgentTools(host),
});

// One newline-delimited JSON message in, one out (or null for notifications).
const response = await server.handle({
	jsonrpc: "2.0",
	id: 1,
	method: "tools/call",
	params: { name: "widgets_describe", arguments: {} },
});
```

A failed tool is a normal result with `isError: true`; an unknown tool name
is JSON-RPC error `-32602`. The server speaks MCP protocol versions
`2024-11-05`, `2025-03-26` and `2025-06-18` (newest by default).
