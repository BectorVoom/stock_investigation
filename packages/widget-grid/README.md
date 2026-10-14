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
import {
	MoveAnnouncerView,
	WidgetFrame,
	WidgetGrid,
	WIDGET_GRID_CLASS,
	createMoveAnnouncer,
} from "@research/widget-grid";
import "@research/widget-grid/styles.css";

const announcer = createMoveAnnouncer();
const onSave = (widgetId: string, toIndex: number) =>
	save(widgetId, toIndex).then((saved) => {
		announcer.announceMove(saved.title, toIndex + 1, saved.total);
	});

<WidgetGrid
	widgets={widgets()}
	ignoreDragFrom="my-dialog,my-select,my-input,my-option"
	onReorder={(drop) => onSave(drop.widgetId, drop.toIndex)}
>
	{(widget, index) => (
		<WidgetFrame widget={widget} actions={<MyMenu widget={widget} />}>
			<MyWidgetBody widget={widget} position={index()} />
		</WidgetFrame>
	)}
</WidgetGrid>;
<MoveAnnouncerView message={announcer.message()} />;

// A skeleton grid while loading reuses the package class, never a literal:
<div class={WIDGET_GRID_CLASS}>…</div>;
```

- `WidgetGrid<W extends WidgetBase>` props: `widgets` (server order),
  `canDrag` (optional, defaults to `true`; the host's own condition, for
  example `!busy()`), `ignoreDragFrom` (optional extra selector for controls
  that never start a drag, read lazily on every press),
  `onReorder` receiving `{ widgetId, fromIndex, toIndex, preview }`, and
  `children` as a render function for one widget with `<For>`'s index
  accessor: `(widget, index) => …`, so a reorder updates every child's
  reported position without re-creating it. When `onReorder` returns a
  promise, the previewed order stays on screen and no new drag starts until
  it settles, then the preview `order` values are cleared. A synchronous
  throw clears the preview and propagates to the host; a rejected promise
  only clears the preview (the host owns its own failure handling).
  `columnsFrom` (`"viewport"` default, `"container"`: see below) and
  `variant` (`"card"` default, `"quiet"`: see below) change only the grid's
  own layout and frame tone; Home keeps the defaults.
- Class names hosts need are exported as constants
  (`WIDGET_GRID_CLASS`, `WIDGET_GRID_CONTAINER_CLASS`, `WIDGET_FRAME_CLASS`,
  `WIDGET_BODY_CLASS`, `WIDGET_HEADER_CLASS`, `WIDGET_PLACEHOLDER_CLASS`):
  hosts that render their own grid markup (for example loading skeletons)
  use the constants instead of repeating the literals.
- `WidgetFrame<W extends WidgetBase>` props: `widget`, an `actions` slot for
  the host's menu, and `children` for the body. Both stay live. The frame is
  an `article` with `data-widget-id`, `data-widget-type` and
  `data-widget-size`; the header strip carries `data-widget-drag-handle`; the
  body is a `tabindex="0"` `role="group"` labelled by the title.
  `selected` marks the frame with `data-widget-selected`; with
  `onSelectChange(widgetId, mode)` a header click selects (`"replace"`, or
  `"toggle"` with Shift/Ctrl/Meta) and the header gains a select toggle
  button — see below. Without `onSelectChange` nothing changes.
- `WidgetSizePicker` props: `value`, `sizes` (optional subset the type
  allows, defaults to all three), `onChange`, `label` (the accessible group
  name, for example `Size of “Revenue”`) and `disabled` (optional). One
  compact S/M/L segmented group (`wg-size-picker`, `wg-size-option`) with
  radiogroup semantics: roving tabindex (only the checked option is in the
  tab order), Arrow keys, Home/End, disabled sizes skipped.
- `createWidgetDrag` owns the pointer/DOM engine. A drag starts from the
  header strip after 4 px of movement; a press on a button, link or form
  control never starts one (`button,a,input,select,textarea,summary`,
  `[role="menu"]`, `[role="menuitem"]` plus the host's `extraIgnoreSelector`,
  passed through the grid's `ignoreDragFrom` prop). `Escape`,
  `pointercancel` or the window losing focus cancels it. The lifted widget is
  marked with `data-widget-dragging` and the slot with
  `data-widget-placeholder` plus `data-widget-size`.
- `createMoveAnnouncer()` returns `{ message, announceMove }`;
  `MoveAnnouncerView` renders the polite live region. Every completed move
  announces `Moved “<title>” to position <i> of <n>.`, clearing first so a
  repeated sentence announces again.
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
(`WIDGET_GRID_METRICS`, `WIDGET_SIZE_SPANS`, `WIDGET_SIZE_SHAPES`) and are
stated again in `src/solid/styles.css`; `test/solid/stylesMetrics.test.ts`
fails when the two disagree.

### Container-sized columns

`columnsFrom="container"` sizes the columns by the grid's own width instead
of the viewport — for a grid inside a side panel, which may hold ~25 % of the
window in one state and ~75 % in another. The grid element is wrapped in a
`wg-grid-container` (`container-type: inline-size`) ancestor; the grid keeps
`data-widget-grid`, its ref and its pointer handler, so dragging works
unchanged. Columns are the same 2 and 4, switching at the container width
`WIDGET_GRID_METRICS.containerWideMinWidthRem` (40rem) with the same spans
as above.

```tsx
<WidgetGrid widgets={widgets()} columnsFrom="container" onReorder={onSave}>
  {(widget) => <WidgetFrame widget={widget}>{body(widget)}</WidgetFrame>}
</WidgetGrid>;
```

### Quiet variant and selection

`variant="quiet"` drops the frame hairline and shadow: widgets are separated
by surface tone and spacing, and a subtle boundary (`--wg-border-hover`)
appears on `:hover`, `:focus-within` and selection. The grip, the actions
slot and the select toggle fade in on hover / focus-within / selection, stay
in the accessibility tree throughout, are always visible on devices without
hover, and never animate under `prefers-reduced-motion`. The default
`variant="card"` is exactly today's look.

Selection is opt-in per frame: `selected` marks the frame with
`data-widget-selected` (a 1–2 px `--wg-selected` ring in both variants) and
`onSelectChange(widgetId, mode)` is called by a header click that is neither
a drag (the drag engine swallows the click a completed drag fires) nor on a
control: `"replace"` normally, `"toggle"` with Shift, Ctrl or Meta held. With
`onSelectChange` the header also renders a compact check-circle toggle
(`aria-pressed`, named `Select “<title>”`) — the keyboard and
assistive-technology path, revealed with the grip in the quiet variant.

```tsx
<WidgetGrid widgets={widgets()} variant="quiet" onReorder={onSave}>
  {(widget) => (
    <WidgetFrame
      widget={widget}
      selected={selectedIds().has(widget.widgetId)}
      onSelectChange={(id, mode) => updateSelection(id, mode)}
    >
      {body(widget)}
    </WidgetFrame>
  )}
</WidgetGrid>;
```

### Theming

The stylesheet reads `--wg-*` custom properties and falls back to neutral
defaults. Set them on any ancestor of the grid (this app maps them in
`apps/web/src/styles.css`).

| Property | Default | Used for |
|---|---|---|
| `--wg-surface` | `#ffffff` | frame background |
| `--wg-border` | `#e2e8f0` | frame hairline |
| `--wg-border-hover` | `#cbd5e1` | quiet-variant boundary on hover/focus |
| `--wg-selected` | `#94a3b8` | selected boundary (1–2 px ring/outline) |
| `--wg-text` | `#0f172a` | title text |
| `--wg-text-muted` | `#475569` | grip glyph |
| `--wg-accent` | `#2563eb` | lifted-widget 2 px ring |
| `--wg-focus` | `#1d4ed8` | body `:focus-visible` outline |
| `--wg-placeholder-border` | `#cbd5e1` | placeholder dashed border |
| `--wg-radius` | `1rem` | frame and placeholder radius |
| `--wg-gap` | `1rem` | grid gap |
| `--wg-row-height` | `17rem` | one grid row |

### DOM contract

`data-widget-grid` on the grid; `data-widget-columns-from` (`viewport` or
`container`) and `data-widget-variant` (`card` or `quiet`) beside it;
`data-widget-id`, `data-widget-type` and `data-widget-size` on each widget
`article`, plus `data-widget-selected` when the host selects it;
`data-widget-drag-handle` on the header strip; `data-widget-dragging` on the
lifted widget while dragged; `data-widget-placeholder` (plus
`data-widget-size`) on the slot shown during a drag.

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

Commands: `add`, `remove`, `duplicate`, `move`, `reorder`, `resize`,
`update` (see `src/agent/types.ts`). Positions (`toIndex`) are 0-based:
`reorder` lands the widget at `toIndex` of the result while the others keep
their order, and `add` with `toIndex` is append followed by reorder to that
position. `duplicate` copies a widget through its own type (`configOf` into
`build`) with a fresh id, the title defaulting to `"<title> (copy)"`
(trimmed to the 200-character title limit), landing right after the original
unless `toIndex` is given — implemented as an `add` edit, so the Lean
dashboard model still covers it, with the same failure codes as `add`.
`update` shallow-merges `config` over the widget's current config. A command
that fails validation changes nothing and returns a failure code with one
sentence.

```ts
const copy = await host.apply({ kind: "duplicate", widgetId: "w1" });
```

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
| `widgets_duplicate` | Copy a widget by id, right after the original by default |
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
