/**
 * The widget grid (crate `research-widget-grid`): `parseWidgetCommand` with
 * zod's exact first-issue messages (they reach the notebook assistant's
 * repair prompt), `applyWidgetLayoutEdit`, and the agent host applying
 * command sequences to a toy store. Expected values come from the real
 * TypeScript in `packages/widget-grid`; inputs are the unit tests' plus a
 * seeded corpus of systematic mutations. Commands travel as JSON text so
 * that values only `JSON.parse` produces (`1e400` → Infinity) stay exact.
 */
import { parseWidgetCommand } from "../../packages/widget-grid/src/agent/commands.ts";
import { createWidgetAgentHost } from "../../packages/widget-grid/src/agent/host.ts";
import type {
	WidgetAgentFailure,
	WidgetAgentType,
	WidgetLayoutRecord,
	WidgetLayoutStore,
} from "../../packages/widget-grid/src/agent/types.ts";
import {
	applyWidgetLayoutEdit,
	type WidgetLayoutEdit,
} from "../../packages/widget-grid/src/core/layout.ts";
import {
	err,
	ok,
	type Result,
	type WidgetBase,
	type WidgetSize,
} from "../../packages/widget-grid/src/core/types.ts";
import { seededRandom, type VectorExporter, type VectorFile } from "./shared.ts";

type Random = () => number;

const pick = <T>(random: Random, items: readonly T[]): T => {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
};
const integer = (random: Random, max: number): number => Math.floor(random() * (max + 1));

/* ----- Commands ----- */

const VALID: Record<string, string> = {
	add: '{"kind":"add","type":"note","title":"Hello","size":"medium","config":{"text":"hi"},"toIndex":2}',
	remove: '{"kind":"remove","widgetId":"a"}',
	move: '{"kind":"move","widgetId":"a","direction":"earlier"}',
	reorder: '{"kind":"reorder","widgetId":"a","toIndex":0}',
	resize: '{"kind":"resize","widgetId":"a","size":"medium"}',
	update: '{"kind":"update","widgetId":"a","title":"New","config":{"text":"x"}}',
	duplicate: '{"kind":"duplicate","widgetId":"a","title":"Copy","toIndex":0}',
};

/** Replacement values, as JSON text. */
const VALUES = [
	"1",
	"-1",
	"-0",
	"0",
	"1.5",
	"-1.5",
	"1000",
	"1001",
	"1000.5",
	"9007199254740992",
	"-9007199254740992",
	"1e21",
	"1e400",
	"-1e400",
	'""',
	'" "',
	'"\\u3000\\ufeff"',
	'"\\u0085"',
	'"x"',
	`"${"x".repeat(80)}"`,
	`"${"x".repeat(81)}"`,
	`"${"x".repeat(120)}"`,
	`"${"x".repeat(121)}"`,
	`"${"x".repeat(200)}"`,
	`" ${"x".repeat(200)} "`,
	`"${"x".repeat(201)}"`,
	`"${"😀".repeat(100)}"`,
	`"${"😀".repeat(101)}"`,
	'"small"',
	'"large"',
	'"huge"',
	'"earlier"',
	'"later"',
	'"up"',
	"null",
	"true",
	"false",
	"[]",
	"{}",
	'{"text":"a"}',
	'{"deep":[[[[[[[[[[[[1]]]]]]]]]]]]}',
	'{"deep":[[[[[[[[[[[1]]]]]]]]]]]}',
	'{"0":1,"b":2}',
];

function withKey(text: string, key: string, value: string | null): string {
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
	const entries = Object.entries(parsed).map(
		([name, entry]) => [name, JSON.stringify(entry)] as const,
	);
	const members: string[] = [];
	let replaced = false;
	for (const [name, entry] of entries) {
		if (name === key) {
			replaced = true;
			if (value !== null) members.push(`${JSON.stringify(name)}:${value}`);
		} else members.push(`${JSON.stringify(name)}:${entry}`);
	}
	if (!replaced && value !== null) members.push(`${JSON.stringify(key)}:${value}`);
	return `{${members.join(",")}}`;
}

function commandInputs(random: Random): string[] {
	const inputs = [
		'"x"',
		"1",
		"null",
		"[]",
		"true",
		"{}",
		'{"kind":"nope"}',
		'{"kind":1}',
		'{"kind":"explode","widgetId":"a"}',
		'{"kind":"remove","widgetId":"a","force":true}',
		'{"kind":"remove","widgetId":"w","d":1,"a":2}',
		'{"kind":"remove","widgetId":5,"d":1}',
		'{"kind":"remove","widgetId":"w","10":1,"2":2,"z":3}',
		'{"kind":"update","widgetId":"w"}',
		'{"kind":"update","widgetId":"","title":"t"}',
		'{"kind":"duplicate","widgetId":"a","config":{"text":"x"}}',
		'{"kind":"add","type":"note","title":"  Hello  "}',
		'{"kind":"add","type":"t","title":3,"size":4}',
		'{"widgetId":"a","kind":"remove"}',
		'{"kind":"remove","kind":"move","widgetId":"a","direction":"later"}',
		'{"kind":"remove","widgetId":"a","widgetId":"b"}',
	];
	for (const valid of Object.values(VALID)) {
		inputs.push(valid);
		const keys = Object.keys(JSON.parse(valid) as object);
		for (const key of keys) {
			if (key !== "kind") inputs.push(withKey(valid, key, null));
			for (const value of VALUES) if (key !== "kind") inputs.push(withKey(valid, key, value));
		}
		for (const extra of [
			"title",
			"config",
			"toIndex",
			"size",
			"widgetId",
			"direction",
			"type",
			"x",
			"__proto__",
		]) {
			inputs.push(withKey(valid, extra, pick(random, VALUES)));
		}
	}
	for (let index = 0; index < 600; index += 1) {
		let text = pick(random, Object.values(VALID));
		const changes = 1 + integer(random, 3);
		for (let change = 0; change < changes; change += 1) {
			const key = pick(random, [
				"type",
				"title",
				"size",
				"config",
				"toIndex",
				"widgetId",
				"direction",
				"extra",
				"kind",
			]);
			const value =
				random() < 0.15
					? null
					: key === "kind"
						? pick(random, ['"add"', '"update"', '"nope"'])
						: pick(random, VALUES);
			text = withKey(text, key, value);
		}
		inputs.push(text);
	}
	return inputs;
}

function commandsFile(): VectorFile {
	const random = seededRandom(9_090_001);
	return {
		path: "widget-grid/commands.json",
		content: commandInputs(random).map((input) => {
			const parsed = parseWidgetCommand(JSON.parse(input));
			return parsed.ok
				? { input, ok: JSON.stringify(parsed.value) }
				: { input, error: parsed.error };
		}),
	};
}

/* ----- Layout edits ----- */

interface ToyWidget extends WidgetBase {
	readonly text: string;
}

const SIZES: readonly WidgetSize[] = ["small", "medium", "large"];

const toy = (
	widgetId: string,
	size: WidgetSize = "small",
	type = "note",
	text = `Text ${widgetId}`,
): ToyWidget => ({
	widgetId,
	type,
	title: `Title ${widgetId}`,
	size,
	text,
});

function layoutFile(): VectorFile {
	const random = seededRandom(9_090_002);
	const cases = [];
	for (let index = 0; index < 2000; index += 1) {
		const count = integer(random, 6);
		const widgets = Array.from({ length: count }, (_, position) =>
			toy(`w${position}`, pick(random, SIZES)),
		);
		const id = () => (random() < 0.08 ? "" : `w${integer(random, count + 1)}`);
		const roll = integer(random, 5);
		let edit: WidgetLayoutEdit<ToyWidget>;
		let wire: Record<string, unknown>;
		if (roll === 0) {
			const widget = toy(id(), pick(random, SIZES));
			const toIndex = random() < 0.4 ? undefined : integer(random, count + 2);
			edit = toIndex === undefined ? { kind: "add", widget } : { kind: "add", widget, toIndex };
			wire = {
				kind: "add",
				widgetId: widget.widgetId,
				size: widget.size,
				toIndex: toIndex ?? null,
			};
		} else if (roll === 1) {
			const widgetId = id();
			edit = { kind: "remove", widgetId };
			wire = { kind: "remove", widgetId };
		} else if (roll === 2) {
			const widgetId = id();
			const direction = random() < 0.5 ? "earlier" : "later";
			edit = { kind: "move", widgetId, direction };
			wire = { kind: "move", widgetId, direction };
		} else if (roll === 3) {
			const widgetId = id();
			const toIndex = integer(random, count + 1);
			edit = { kind: "reorder", widgetId, toIndex };
			wire = { kind: "reorder", widgetId, toIndex };
		} else if (roll === 4) {
			const widgetId = id();
			const size = pick(random, SIZES);
			edit = { kind: "resize", widgetId, size };
			wire = { kind: "resize", widgetId, size };
		} else {
			const widget = toy(id(), pick(random, SIZES), "note", "replaced");
			edit = { kind: "replace", widget };
			wire = { kind: "replace", widgetId: widget.widgetId, size: widget.size };
		}
		const maxWidgets = 2 + integer(random, 5);
		const result = applyWidgetLayoutEdit(widgets, edit, { maxWidgets });
		cases.push({
			widgets: widgets.map((widget) => [widget.widgetId, widget.size]),
			edit: wire,
			maxWidgets,
			output: result.ok
				? result.value.map((widget) => [widget.widgetId, widget.size, widget.text])
				: null,
			error: result.ok ? null : result.error,
		});
	}
	return { path: "widget-grid/layout.json", content: cases };
}

/* ----- The agent host over a toy store ----- */

function toyType(
	type: string,
	defaultSize: WidgetSize,
	sizes: readonly WidgetSize[],
): WidgetAgentType<ToyWidget> {
	return {
		type,
		label: type,
		description: `A ${type}.`,
		defaultSize,
		sizes,
		configSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		build: (draft) => {
			const text = draft.config.text;
			if (typeof text !== "string" || text.trim().length === 0) {
				return err('config needs a non-empty "text" string.');
			}
			return ok({ widgetId: draft.widgetId, type, title: draft.title, size: draft.size, text });
		},
		configOf: (widget) => ({ text: widget.text }),
	};
}

const TYPES = [
	toyType("note", "small", ["small", "medium"]),
	toyType("banner", "large", ["large"]),
];

function memoryStore(initial: readonly ToyWidget[]): WidgetLayoutStore<ToyWidget, number> {
	let widgets = [...initial];
	let revision = 0;
	return {
		read: async (): Promise<Result<WidgetLayoutRecord<ToyWidget, number>, WidgetAgentFailure>> =>
			ok({ widgets: [...widgets], revision }),
		write: async (next, at) => {
			if (at !== revision) {
				return err({
					code: "CONFLICT",
					message: "the layout changed elsewhere; describe again and retry.",
				});
			}
			revision += 1;
			widgets = [...next];
			return ok({ widgets: [...widgets], revision });
		},
	};
}

const HOST_COMMANDS = [
	'{"kind":"add","type":"note","title":"Hello","config":{"text":"hi"}}',
	'{"kind":"add","type":"note","title":"Big","size":"medium","config":{"text":"hi"},"toIndex":0}',
	'{"kind":"add","type":"banner","title":"Banner","config":{"text":"b"}}',
	'{"kind":"add","type":"banner","title":"Banner","size":"small","config":{"text":"b"}}',
	'{"kind":"add","type":"chart","title":"Chart"}',
	'{"kind":"add","type":"note","title":"Empty","config":{"text":"  "}}',
	'{"kind":"add","type":"note","title":"Far","config":{"text":"x"},"toIndex":40}',
	'{"kind":"remove","widgetId":"a"}',
	'{"kind":"remove","widgetId":"zzz"}',
	'{"kind":"move","widgetId":"a","direction":"earlier"}',
	'{"kind":"move","widgetId":"b","direction":"later"}',
	'{"kind":"move","widgetId":"ghost","direction":"later"}',
	'{"kind":"reorder","widgetId":"b","toIndex":0}',
	'{"kind":"reorder","widgetId":"a","toIndex":9}',
	'{"kind":"resize","widgetId":"a","size":"medium"}',
	'{"kind":"resize","widgetId":"a","size":"large"}',
	'{"kind":"resize","widgetId":"ghost","size":"small"}',
	'{"kind":"resize","widgetId":"zzz","size":"small"}',
	'{"kind":"update","widgetId":"a","title":"Renamed"}',
	'{"kind":"update","widgetId":"b","config":{"text":"new","extra":1}}',
	'{"kind":"update","widgetId":"a","config":{"text":""}}',
	'{"kind":"update","widgetId":"ghost","title":"x"}',
	'{"kind":"duplicate","widgetId":"a"}',
	'{"kind":"duplicate","widgetId":"long"}',
	'{"kind":"duplicate","widgetId":"b","title":"Copy","toIndex":0}',
	'{"kind":"duplicate","widgetId":"a","toIndex":30}',
	'{"kind":"duplicate","widgetId":"ghost"}',
	'{"kind":"duplicate","widgetId":"wide"}',
	'{"kind":"remove","widgetId":"ghost"}',
	'{"kind":"explode"}',
];

async function hostFile(): Promise<VectorFile> {
	const random = seededRandom(9_090_003);
	const cases = [];
	for (let index = 0; index < 400; index += 1) {
		const initial: ToyWidget[] = [toy("a"), toy("b")];
		if (random() < 0.5) initial.push(toy("ghost", "small", "ghost"));
		if (random() < 0.5) initial.push({ ...toy("long"), title: `${"t".repeat(195)}😀` });
		if (random() < 0.3) initial.push(toy("wide", "medium", "banner"));
		const maxWidgets = 3 + integer(random, 4);
		const commands = Array.from({ length: 1 + integer(random, 5) }, () =>
			pick(random, HOST_COMMANDS),
		);
		let nextId = 0;
		const host = createWidgetAgentHost({
			store: memoryStore(initial),
			types: TYPES,
			newWidgetId: () => {
				nextId += 1;
				return `new-${nextId}`;
			},
			limits: { maxWidgets },
		});
		const results: unknown[] = [];
		for (const command of commands) {
			const result = await host.apply(JSON.parse(command));
			results.push(
				result.ok ? { widgets: JSON.stringify(result.value.widgets) } : { error: result.error },
			);
		}
		const described = await host.describe();
		results.push(
			described.ok ? { snapshot: JSON.stringify(described.value) } : { error: described.error },
		);
		cases.push({ initial, maxWidgets, commands, results });
	}
	return { path: "widget-grid/host.json", content: cases };
}

/** Commands that probe the owner-placed rule beyond the shared corpus. */
const OWNER_PLACED_COMMANDS = [
	...HOST_COMMANDS,
	'{"kind":"update","widgetId":"a","config":{"text":"Text a"}}',
	'{"kind":"update","widgetId":"a","title":"Kept","config":{"text":"Text a"}}',
	'{"kind":"update","widgetId":"a","config":{"text":"Text a","extra":{"y":1}}}',
	'{"kind":"update","widgetId":"a","config":{}}',
	'{"kind":"update","widgetId":"wide","config":{"text":"banner text"}}',
];

/**
 * The host with an owner-placed type (`ownerPlaced`, ADR-0038 §6): `note`
 * widgets can be arranged and renamed but never added, copied or
 * reconfigured by an agent; `banner` stays open.
 */
async function ownerPlacedFile(): Promise<VectorFile> {
	const random = seededRandom(9_090_004);
	const types = [
		{
			...toyType("note", "small", ["small", "medium"]),
			ownerPlaced: { reason: "the owner picks it." },
		},
		toyType("banner", "large", ["large"]),
	];
	const cases = [];
	for (let index = 0; index < 200; index += 1) {
		const initial: ToyWidget[] = [toy("a"), toy("b")];
		if (random() < 0.5) initial.push(toy("wide", "medium", "banner"));
		const commands = Array.from({ length: 1 + integer(random, 4) }, () =>
			pick(random, OWNER_PLACED_COMMANDS),
		);
		let nextId = 0;
		const host = createWidgetAgentHost({
			store: memoryStore(initial),
			types,
			newWidgetId: () => {
				nextId += 1;
				return `new-${nextId}`;
			},
			limits: { maxWidgets: 6 },
		});
		const results: unknown[] = [];
		for (const command of commands) {
			const result = await host.apply(JSON.parse(command));
			results.push(
				result.ok ? { widgets: JSON.stringify(result.value.widgets) } : { error: result.error },
			);
		}
		cases.push({ initial, commands, results });
	}
	return { path: "widget-grid/owner-placed.json", content: cases };
}

export const widgetGridExporter: VectorExporter = {
	name: "widget-grid",
	async build() {
		return [commandsFile(), layoutFile(), await hostFile(), await ownerPlacedFile()];
	},
};
