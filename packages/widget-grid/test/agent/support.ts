import type {
	WidgetAgentFailure,
	WidgetAgentType,
	WidgetLayoutRecord,
	WidgetLayoutStore,
} from "../../src/agent/types.ts";
import type { WidgetBase } from "../../src/core/types.ts";
import { err, ok, type Result } from "../../src/core/types.ts";

/**
 * Two toy widget types over one structural widget, plus an in-memory store
 * with flags for the failure paths. Nothing here leaves the test process.
 */

export interface ToyWidget extends WidgetBase {
	readonly text: string;
}

export const toy = (widgetId: string, type = "note", text = `Text ${widgetId}`): ToyWidget => ({
	widgetId,
	type,
	title: `Title ${widgetId}`,
	size: "small",
	text,
});

export const noteType: WidgetAgentType<ToyWidget> = {
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
		const text = draft.config.text;
		if (typeof text !== "string" || text.trim().length === 0) {
			return err('config needs a non-empty "text" string.');
		}
		return ok({
			widgetId: draft.widgetId,
			type: "note",
			title: draft.title,
			size: draft.size,
			text,
		});
	},
	configOf: (widget) => ({ text: widget.text }),
};

export const bannerType: WidgetAgentType<ToyWidget> = {
	type: "banner",
	label: "Banner",
	description: "A full-width banner.",
	defaultSize: "large",
	sizes: ["large"],
	configSchema: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
	},
	build: (draft) => {
		const text = draft.config.text;
		if (typeof text !== "string" || text.trim().length === 0) {
			return err('config needs a non-empty "text" string.');
		}
		return ok({
			widgetId: draft.widgetId,
			type: "banner",
			title: draft.title,
			size: draft.size,
			text,
		});
	},
	configOf: (widget) => ({ text: widget.text }),
};

export interface ToyStoreControls {
	readonly store: WidgetLayoutStore<ToyWidget, number>;
	/** Simulate an external writer: the next write at the old revision conflicts. */
	readonly bumpRevision: () => void;
	/** Fail the next write with CONFLICT, as if a writer slipped in mid-command. */
	readonly conflictNextWrite: () => void;
	readonly throwOnRead: () => void;
	readonly throwOnWrite: () => void;
	readonly snapshot: () => { readonly widgets: readonly ToyWidget[]; readonly revision: number };
}

export function createToyStore(
	initial: readonly ToyWidget[] = [toy("a"), toy("b")],
): ToyStoreControls {
	const state: {
		widgets: ToyWidget[];
		revision: number;
		conflictOnce: boolean;
		failRead: boolean;
		failWrite: boolean;
	} = {
		widgets: [...initial],
		revision: 0,
		conflictOnce: false,
		failRead: false,
		failWrite: false,
	};
	const store: WidgetLayoutStore<ToyWidget, number> = {
		read: async (): Promise<Result<WidgetLayoutRecord<ToyWidget, number>, WidgetAgentFailure>> => {
			if (state.failRead) throw new Error("read failed");
			return ok({ widgets: [...state.widgets], revision: state.revision });
		},
		write: async (
			widgets: readonly ToyWidget[],
			revision: number,
		): Promise<Result<WidgetLayoutRecord<ToyWidget, number>, WidgetAgentFailure>> => {
			if (state.failWrite) throw new Error("write failed");
			if (state.conflictOnce || revision !== state.revision) {
				state.conflictOnce = false;
				return err({
					code: "CONFLICT",
					message: "the layout changed elsewhere; describe again and retry.",
				});
			}
			state.revision += 1;
			state.widgets = [...widgets];
			return ok({ widgets: [...state.widgets], revision: state.revision });
		},
	};
	return {
		store,
		bumpRevision: () => {
			state.revision += 1;
		},
		conflictNextWrite: () => {
			state.conflictOnce = true;
		},
		throwOnRead: () => {
			state.failRead = true;
		},
		throwOnWrite: () => {
			state.failWrite = true;
		},
		snapshot: () => ({ widgets: [...state.widgets], revision: state.revision }),
	};
}

let nextId = 0;
export const freshId = (): string => {
	nextId += 1;
	return `new-${nextId}`;
};
