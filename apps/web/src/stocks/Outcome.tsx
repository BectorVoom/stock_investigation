import { type JSX, Show } from "solid-js";
import type { ApiFailure } from "../api/http.ts";
import { ErrorNotice, Notice } from "../components/ui.tsx";

/** What an action says when it ends: a sentence, or a failure with its stable code. */
export type Outcome =
	| {
			readonly kind: "notice";
			readonly tone: "success" | "info" | "warning";
			readonly text: string;
	  }
	| { readonly kind: "failure"; readonly title: string; readonly error: ApiFailure };

/** One outcome, replaced whole by the next (a notice or a failure). */
export function OutcomeNotice(props: {
	readonly outcome: Outcome | null;
	/** A stable hook for tests and reviews (`data-field` of a notice). */
	readonly field: string;
}): JSX.Element {
	return (
		<Show when={props.outcome} keyed>
			{(value) =>
				value.kind === "failure" ? (
					<ErrorNotice failure={value.error} title={value.title} />
				) : (
					<Notice tone={value.tone} data-field={props.field}>
						{value.text}
					</Notice>
				)
			}
		</Show>
	);
}
