import { useMessages } from "@research/i18n/solid";
import { type JSX, onMount, Show } from "solid-js";
import { IconButton } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { resetDialogMessages } from "./home.messages.ts";
import "./shoelace.ts";

/**
 * The confirmation of Home's "Reset to default arrangement" (`sl-dialog`):
 * the one Home-only dialog left once the widget dialogs became the shared
 * ones (ADR-0024). Focus moves into the dialog on open and returns to the
 * explicit opener on close.
 */
export function ResetDialog(props: {
	readonly open: boolean;
	/** Element that opened the dialog; focus returns to it on close. */
	readonly opener: HTMLElement | null;
	readonly onConfirm: () => void;
	readonly onClose: () => void;
}): JSX.Element {
	return (
		<Show when={props.open} fallback={null}>
			<ResetDialogBody {...props} />
		</Show>
	);
}

function ResetDialogBody(props: {
	readonly opener: HTMLElement | null;
	readonly onConfirm: () => void;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(resetDialogMessages);
	const common = useMessages(commonMessages);
	const closeAndReturnFocus = (event?: Event) => {
		// H1: only the dialog's own hide event closes it, never a bubbled one.
		if (event !== undefined && event.target !== event.currentTarget) return;
		props.onClose();
		props.opener?.focus();
	};
	// Focus starts on Cancel, the safe choice (rAF: after the Shoelace upgrade).
	onMount(() => {
		requestAnimationFrame(() => {
			const button = document.querySelector("sl-dialog button");
			if (button instanceof HTMLElement) button.focus({ preventScroll: true });
		});
	});
	return (
		<sl-dialog attr:label={m().title} open on:sl-after-hide={closeAndReturnFocus}>
			<p class="text-sm text-slate-800">{m().body}</p>
			<div slot="footer" class="flex justify-end gap-1">
				<IconButton label={common().cancel} icon="x-lg" onClick={() => closeAndReturnFocus()} />
				<IconButton
					label={m().confirm}
					icon="arrow-counterclockwise"
					variant="danger"
					onClick={() => props.onConfirm()}
				/>
			</div>
		</sl-dialog>
	);
}
