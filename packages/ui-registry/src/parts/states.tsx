import { useMessages } from "@research/i18n/solid";
import type { JSX } from "solid-js";
import { cellReasonMessages } from "../cellReasons.messages.ts";
import { cellReasonText } from "../cellReasonText.ts";
import { stateMessages } from "./parts.messages.tsx";

const FALLBACK_KEY = {
	UNKNOWN_COMPONENT_TYPE: "unknownComponentType",
	UNSUPPORTED_SCHEMA_VERSION: "unsupportedSchemaVersion",
	INVALID_PROPS: "invalidProps",
	RENDERER_FAILED: "rendererFailed",
} as const;

export type CannotRenderReason = keyof typeof FALLBACK_KEY;

/** Explicit fallback shown instead of throwing or rendering unvalidated data. */
export function CannotRender(props: {
	readonly reason: CannotRenderReason;
	readonly componentType: string;
	readonly schemaVersion?: number;
}): JSX.Element {
	const m = useMessages(stateMessages);
	return (
		<output
			data-fallback={props.reason}
			class="block rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
		>
			{m().cannotRender(m()[FALLBACK_KEY[props.reason]], props.componentType, props.schemaVersion)}
		</output>
	);
}

/** A referenced dataset is not part of the workspace view. */
export function DataUnavailable(props: { readonly datasetRef: string }): JSX.Element {
	const m = useMessages(stateMessages);
	return (
		<output
			data-state="data-unavailable"
			class="block rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
		>
			{m().dataUnavailable(props.datasetRef)}
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

/**
 * Inline marker for a single missing value: never a blank and never 0
 * (DATA-011). A reason the registry gave is worded in the UI language; a
 * reason from the data is shown as written.
 */
export function Unavailable(props: { readonly reason: string }): JSX.Element {
	const m = useMessages(stateMessages);
	const reasons = useMessages(cellReasonMessages);
	return (
		<span data-unavailable="true" class="italic text-slate-600">
			{m().unavailable(cellReasonText(props.reason, reasons()))}
		</span>
	);
}
