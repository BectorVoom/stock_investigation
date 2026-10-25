import { useMessages } from "@research/i18n/solid";
import { type JSX, Show } from "solid-js";
import { commonMessages } from "../i18n/common.messages.ts";

/**
 * " (service answered HTTP 404)" after a failure code shown on its own
 * (ADR-0037): the external service's status, unchanged, as secondary text.
 * Renders nothing when no external service caused the failure.
 */
export function UpstreamStatusAside(props: {
	readonly status: number | null | undefined;
	/** `data-field` value, so a test or the UI review can find the note. */
	readonly field: string;
}): JSX.Element {
	const common = useMessages(commonMessages);
	return (
		<Show when={props.status ?? null}>
			{(status) => (
				<span data-field={props.field} class="font-normal text-slate-700">
					{common().aside(common().serviceAnswered(status()))}
				</span>
			)}
		</Show>
	);
}
