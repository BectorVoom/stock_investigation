import type { JSX } from "solid-js";
import type { WorkspaceMode } from "../notebook/types.ts";

/**
 * The manual workspace control (ADR-0020): one icon button per state,
 * rendered in both panels' headers. The accessible name names the action
 * ("Focus Chat" / "Focus Notebook"), the `title` tooltip carries the same
 * words, and `aria-pressed` marks the active state — so the pair works as a
 * two-option segmented control. It never switches by itself.
 */
export function ModeSwitch(props: {
	readonly mode: WorkspaceMode;
	readonly onChange: (mode: WorkspaceMode) => void;
}): JSX.Element {
	const button = (label: string, target: WorkspaceMode, side: "left" | "right"): JSX.Element => {
		const pressed = () => props.mode === target;
		return (
			<button
				type="button"
				class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
				classList={{
					"bg-blue-700 text-white": pressed(),
					"bg-slate-200 text-slate-900 hover:bg-slate-300": !pressed(),
				}}
				aria-pressed={pressed()}
				aria-label={label}
				title={label}
				onClick={() => props.onChange(target)}
			>
				<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
					<rect
						x="1.5"
						y="2"
						width="11"
						height="10"
						rx="2"
						stroke="currentColor"
						stroke-width="1.5"
					/>
					<path
						d={side === "left" ? "M5 2v10" : "M9 2v10"}
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
					/>
				</svg>
			</button>
		);
	};
	return (
		<fieldset class="inline-flex items-center gap-1">
			<legend class="sr-only">Workspace focus</legend>
			{button("Focus Chat", "chat", "left")}
			{button("Focus Notebook", "notebook", "right")}
		</fieldset>
	);
}
