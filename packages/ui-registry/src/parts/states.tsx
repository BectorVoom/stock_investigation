import type { JSX } from "solid-js";

const FALLBACK_TEXT = {
	UNKNOWN_COMPONENT_TYPE: "unknown component type",
	UNSUPPORTED_SCHEMA_VERSION: "unsupported schema version",
	INVALID_PROPS: "invalid props",
	RENDERER_FAILED: "the renderer failed",
} as const;

export type CannotRenderReason = keyof typeof FALLBACK_TEXT;

/** Explicit fallback shown instead of throwing or rendering unvalidated data. */
export function CannotRender(props: {
	readonly reason: CannotRenderReason;
	readonly componentType: string;
	readonly schemaVersion?: number;
}): JSX.Element {
	return (
		<output
			data-fallback={props.reason}
			class="block rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
		>
			Cannot render: {FALLBACK_TEXT[props.reason]} (component type "{props.componentType}"
			{props.schemaVersion === undefined ? "" : `, schema version ${props.schemaVersion}`}).
		</output>
	);
}

/** A referenced dataset is not part of the workspace view. */
export function DataUnavailable(props: { readonly datasetRef: string }): JSX.Element {
	return (
		<output
			data-state="data-unavailable"
			class="block rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
		>
			Data unavailable — dataset "{props.datasetRef}" is not available in this workspace.
		</output>
	);
}

export function EmptyState(props: { readonly children: JSX.Element }): JSX.Element {
	return (
		<p
			data-state="empty"
			class="rounded border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600"
		>
			{props.children}
		</p>
	);
}

/** Inline marker for a single missing value: never a blank and never 0 (DATA-011). */
export function Unavailable(props: { readonly reason: string }): JSX.Element {
	return (
		<span data-unavailable="true" class="italic text-slate-600">
			N/A — {props.reason}
		</span>
	);
}
