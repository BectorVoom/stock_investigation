import { useMessages } from "@research/i18n/solid";
import {
	type Accessor,
	createEffect,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
	splitProps,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { ApiFailure } from "../api/http.ts";
import type { Remote } from "../lib/remote.ts";
import { pageMessages } from "../pages.messages.ts";
import type { ViewName } from "../pages.ts";

export const BUTTON =
	"min-h-6 rounded bg-slate-200 px-2 py-1 text-xs font-medium text-slate-900 hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50";
export const BUTTON_PRIMARY =
	"min-h-6 rounded bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600";
export const BUTTON_DANGER =
	"min-h-6 rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-900 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-50";
/**
 * Full-width pill variant of `BUTTON` for the one primary creation action
 * per panel (the "New chat" button, guideline section 6). Same fill, tones
 * and 24 px floor as `BUTTON`, with centred content; the plus icon arrives
 * from the caller.
 */
export const BUTTON_PILL =
	"flex min-h-6 w-full items-center justify-center gap-1 rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-900 hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Icon-only button glyphs on Home (guideline section 6): inline Bootstrap
 * Icons paths (MIT), 16 px glyphs in the same pattern as
 * `PanelCollapseButton`, so they work outside the lazy Home chunk too
 * (`ErrorNotice` is app-wide). Menu leading icons reuse the same paths.
 */
export type IconButtonName =
	| "plus-lg"
	| "arrow-clockwise"
	| "arrow-counterclockwise"
	| "arrow-repeat"
	| "three-dots"
	| "x-lg"
	| "check-lg"
	| "pencil"
	| "trash"
	| "arrow-left"
	| "arrow-right"
	| "download"
	| "copy"
	| "chat"
	| "scissors"
	| "clipboard"
	| "search"
	| "journal-text"
	| "plus-square";

function IconGlyphPaths(props: { readonly name: IconButtonName }): JSX.Element {
	switch (props.name) {
		case "plus-lg":
			return (
				<path
					fill-rule="evenodd"
					d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2"
				/>
			);
		case "arrow-clockwise":
			return (
				<>
					<path
						fill-rule="evenodd"
						d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"
					/>
					<path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466" />
				</>
			);
		case "arrow-repeat":
			return (
				<>
					<path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41m-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9" />
					<path
						fill-rule="evenodd"
						d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5 5 0 0 0 8 3M3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9z"
					/>
				</>
			);
		case "arrow-counterclockwise":
			return (
				<>
					<path
						fill-rule="evenodd"
						d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2z"
					/>
					<path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466" />
				</>
			);
		case "three-dots":
			return (
				<path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3" />
			);
		case "x-lg":
			return (
				<path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8z" />
			);
		case "check-lg":
			return (
				<path d="M12.736 3.97a.733.733 0 0 1 1.047 0c.286.289.29.756.01 1.05L7.88 12.01a.733.733 0 0 1-1.065.02L3.217 8.384a.757.757 0 0 1 0-1.06.733.733 0 0 1 1.047 0l3.052 3.093 5.4-6.425z" />
			);
		case "pencil":
			return (
				<path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325" />
			);
		case "trash":
			return (
				<>
					<path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z" />
					<path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z" />
				</>
			);
		case "arrow-left":
			return (
				<path
					fill-rule="evenodd"
					d="M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8"
				/>
			);
		case "arrow-right":
			return (
				<path
					fill-rule="evenodd"
					d="M1 8a.5.5 0 0 1 .5-.5h11.793l-3.147-3.146a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L13.293 8.5H1.5A.5.5 0 0 1 1 8"
				/>
			);
		case "download":
			return (
				<>
					<path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5" />
					<path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708z" />
				</>
			);
		// Notebook panel (MIT Bootstrap Icons, like every glyph above): the
		// selection bar and widget menus need duplicate and ask actions.
		case "copy":
			return (
				<path
					fill-rule="evenodd"
					d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1z"
				/>
			);
		case "chat":
			return (
				<path d="M2.678 11.894a1 1 0 0 1 .287.801 11 11 0 0 1-.398 2c1.395-.323 2.247-.697 2.634-.893a1 1 0 0 1 .71-.074A8 8 0 0 0 8 14c3.996 0 7-2.807 7-6s-3.004-6-7-6-7 2.808-7 6c0 1.468.617 2.83 1.678 3.894m-.493 3.905a22 22 0 0 1-.713.129c-.2.032-.352-.176-.273-.362a10 10 0 0 0 .244-.637l.003-.01c.248-.72.45-1.548.524-2.319C.743 11.37 0 9.76 0 8c0-3.866 3.582-7 8-7s8 3.134 8 7-3.582 7-8 7a9 9 0 0 1-2.347-.306c-.52.263-1.639.742-3.468 1.105" />
			);
		// ADR-0023: widget cut / paste, and the composer's mode menu
		// (Research, Notebook).
		case "scissors":
			return (
				<path d="M3.5 3.5c-.614-.884-.074-1.962.858-2.5L8 7.226 11.642 1c.932.538 1.472 1.616.858 2.5L8.81 8.61l1.556 2.661a2.5 2.5 0 1 1-.794.637L8 9.73l-1.572 2.177a2.5 2.5 0 1 1-.794-.637L7.19 8.61zm2.5 10a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0m7 0a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0" />
			);
		case "clipboard":
			return (
				<>
					<path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1z" />
					<path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0z" />
				</>
			);
		case "search":
			return (
				<path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0" />
			);
		// Duplicate in the Notebook: "copy" now means Copy (ADR-0023), and the
		// two sit side by side in the selection toolbar.
		case "plus-square":
			return (
				<>
					<path d="M14 1a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zM2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z" />
					<path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4" />
				</>
			);
		case "journal-text":
			return (
				<>
					<path d="M5 10.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5m0-2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5" />
					<path d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2" />
					<path d="M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z" />
				</>
			);
	}
}

/** A 16 px inline glyph for menu leading icons (aria-hidden, currentColor). */
export function IconGlyph(props: { readonly name: IconButtonName }): JSX.Element {
	return (
		<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
			<IconGlyphPaths name={props.name} />
		</svg>
	);
}

export type IconButtonVariant = "plain" | "primary" | "danger";

const ICON_BUTTON_TONE: { readonly [V in IconButtonVariant]: string } = {
	plain: "text-slate-700 hover:bg-slate-200 active:bg-slate-300",
	primary: "bg-blue-700 text-white hover:bg-blue-800 active:bg-blue-800",
	danger: "bg-red-100 text-red-900 hover:bg-red-200 active:bg-red-200",
};

/**
 * The ONE icon-only button part on Home (guideline section 6): a native
 * round button with a 16 px inline glyph, no visible text — the accessible
 * name (the former visible text, exactly) and the same words in the `title`
 * tooltip carry the words instead. Round, borderless, 28 px hit area
 * (44 px on coarse pointers), at least 4 px from neighbours via the parent's
 * `gap-1`; the `:focus-visible` ring stays. Disabled reads through fill and
 * cursor, never a border.
 */
export function IconButton(props: {
	readonly label: string;
	readonly icon: IconButtonName;
	readonly variant?: IconButtonVariant;
	readonly disabled?: boolean;
	readonly describedBy?: string;
	readonly expanded?: boolean;
	readonly hasPopup?: "menu" | "dialog";
	readonly widgetActions?: string;
	readonly onClick?: (event: MouseEvent & { readonly currentTarget: HTMLButtonElement }) => void;
	readonly onKeyDown?: (
		event: KeyboardEvent & { readonly currentTarget: HTMLButtonElement },
	) => void;
	readonly ref?: (element: HTMLButtonElement) => void;
}): JSX.Element {
	const tone = () => ICON_BUTTON_TONE[props.variant ?? "plain"];
	return (
		<button
			type="button"
			ref={props.ref}
			class={`inline-flex min-h-7 min-w-7 items-center justify-center rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-50 ${tone()}`}
			aria-label={props.label}
			title={props.label}
			aria-describedby={props.describedBy}
			aria-expanded={props.expanded}
			aria-haspopup={props.hasPopup}
			data-widget-actions={props.widgetActions}
			disabled={props.disabled}
			onClick={props.onClick}
			onKeyDown={props.onKeyDown}
		>
			<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
				<IconGlyphPaths name={props.icon} />
			</svg>
		</button>
	);
}
export const INPUT =
	"min-h-6 w-full rounded border border-slate-400 bg-white px-2 py-1 text-sm text-slate-900 disabled:bg-slate-100";
export const LABEL = "block text-xs font-medium text-slate-700";
export const PANEL = "rounded border border-slate-300 bg-white p-3";
/**
 * The Chat page's own panel surface (guideline section 5): plain white
 * rounded blocks on the grey page background, with no outline — separation
 * is by background tone. `PANEL` above stays bordered for Sources and
 * Settings, which keep every border they have.
 */
export const CHAT_PANEL = "rounded bg-white p-3";
export const HEADING = "text-sm font-semibold text-slate-900";

/**
 * Native select with an explicit chevron (guideline section 6: an expandable
 * control draws its marker instead of assuming the native one). WHY
 * `appearance-none`: a native menulist ignores author padding and clamps its
 * height below the 24 px target floor in WebKit (measured 22 px with
 * `min-h-6` in place and even with an inline `min-height: 40px`), so every
 * select is custom-surfaced for one identical look in all engines; the
 * chevron keeps the affordance the native arrow provided. Height then comes
 * from the font and padding like a text input, with `min-h-6` as the floor.
 */
export function Select(props: {
	readonly id?: string;
	readonly disabled?: boolean;
	readonly describedBy?: string;
	readonly onChange?: (event: Event & { readonly currentTarget: HTMLSelectElement }) => void;
	readonly children: JSX.Element;
}): JSX.Element {
	return (
		<span class="relative inline-flex w-full items-center">
			<select
				id={props.id}
				disabled={props.disabled}
				aria-describedby={props.describedBy}
				onChange={props.onChange}
				class="min-h-6 w-full appearance-none rounded border border-slate-400 bg-white py-1 pl-2 pr-7 text-sm text-slate-900 disabled:bg-slate-100"
			>
				{props.children}
			</select>
			<svg
				aria-hidden="true"
				width="10"
				height="10"
				viewBox="0 0 10 10"
				fill="none"
				class="pointer-events-none absolute right-2 shrink-0 text-slate-700"
			>
				<path
					d="M2 3 5 6 8 3"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</span>
	);
}

/**
 * The marker of every expandable `<summary>` (guideline section 6). WHY a
 * shared part: a `<summary>` only draws its native disclosure triangle while
 * it is `display: list-item`, and the Chat page lays summaries out with
 * `inline-flex`/`flex` (24 px minimum height, guideline section 9) — so the
 * native marker is gone everywhere and each summary needs an explicit chevron.
 * The parent `<details>` carries `group`; the chevron points right when closed
 * and rotates down while its details is open (ARCH-013).
 */
export function DisclosureSummary(props: {
	readonly class?: string;
	readonly children: JSX.Element;
}): JSX.Element {
	const extra = () => props.class ?? "";
	return (
		<summary class={`flex min-h-6 cursor-pointer items-center gap-1 ${extra()}`}>
			<svg
				aria-hidden="true"
				width="10"
				height="10"
				viewBox="0 0 10 10"
				fill="none"
				class="shrink-0 transition-transform motion-safe:transition-transform group-open:rotate-90"
			>
				<path
					d="M3 1.5 7.5 5 3 8.5"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			<span class="min-w-0 flex-1">{props.children}</span>
		</summary>
	);
}

/**
 * One panel section of a page: a labelled `<section>` with its `h3` heading
 * (guideline sections 5–7). `actions` renders header controls beside the
 * heading, e.g. a reload button or the workspace version line.
 */
export function Section(props: {
	readonly title: string;
	readonly label?: string;
	readonly busy?: boolean;
	readonly actions?: JSX.Element;
	readonly children: JSX.Element;
}): JSX.Element {
	return (
		<section aria-label={props.label ?? props.title} aria-busy={props.busy} class={PANEL}>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h3 class={HEADING}>{props.title}</h3>
				{props.actions}
			</div>
			{props.children}
		</section>
	);
}

/** Status is never colour alone (guideline section 1): each tone pairs colour with text. */
export const NOTICE_TONES = {
	info: "block rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800",
	warning: "block rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900",
	error: "block rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900",
	success:
		"block rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900",
} as const;

export type NoticeTone = keyof typeof NOTICE_TONES;

type NoticeDomProps = Omit<
	JSX.OutputHTMLAttributes<HTMLOutputElement>,
	"children" | "class" | "classList" | "style"
>;

/**
 * An announced status notice (`<output>`, implicit `status` role; guideline
 * section 6). API failures use `ErrorNotice` instead so the stable code
 * travels with the message. Extra output attributes (e.g. stable test hooks
 * such as `data-runner-offline`) pass through untouched.
 */
export function Notice(
	props: { readonly tone: NoticeTone; readonly children: JSX.Element } & NoticeDomProps,
): JSX.Element {
	const [local, rest] = splitProps(props, ["tone", "children"]);
	return (
		<output {...rest} class={NOTICE_TONES[local.tone]}>
			{local.children}
		</output>
	);
}

/**
 * Label + control + help text (guideline section 6). Owns the `for`/`id`
 * link and the hint id, so callers cannot wire a label to the wrong control.
 */
export function Field(props: {
	readonly label: string;
	readonly hint?: string;
	readonly layoutClass?: string;
	readonly children: (id: string) => JSX.Element;
}): JSX.Element {
	const id = createUniqueId();
	return (
		<div class={props.layoutClass}>
			<label for={id} class={LABEL}>
				{props.label}
			</label>
			{props.children(id)}
			<Show when={props.hint}>
				{(hint) => (
					<p id={`${id}-hint`} class="text-2xs text-slate-600">
						{hint()}
					</p>
				)}
			</Show>
		</div>
	);
}

/** An API failure always shows its stable code and message; never a blank area. */
export function ErrorNotice(props: {
	/**
	 * The failure to state. `ApiFailure` fits, and so does any other stable
	 * code + message pair (e.g. the Google Calendar step's fixed reason
	 * sentence for its code) — the notice only reads these four fields.
	 */
	readonly failure: {
		readonly code: string;
		readonly message: string;
		readonly detail: string | null;
		readonly issues: readonly string[];
	};
	readonly title?: string;
	readonly onRetry?: () => void;
	/** Opt-in icon-only retry for Home (other pages keep the text button). */
	readonly iconRetry?: boolean;
}): JSX.Element {
	return (
		<div
			role="alert"
			class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
		>
			<p>
				<Show when={props.title}>
					<span class="font-semibold">{props.title} </span>
				</Show>
				<span data-error-code={props.failure.code} class="font-mono text-xs font-semibold">
					{props.failure.code}
				</span>
				{": "}
				{props.failure.message}
				<Show when={props.failure.detail}>{(detail) => <span> ({detail()})</span>}</Show>
			</p>
			<Show when={props.failure.issues.length > 0}>
				<ul aria-label="Validation errors" class="mt-1 list-disc pl-5 text-xs">
					<For each={props.failure.issues}>{(issue) => <li>{issue}</li>}</For>
				</ul>
			</Show>
			<Show when={props.onRetry}>
				{(retry) => (
					<Show
						when={props.iconRetry}
						fallback={
							<button type="button" class={`${BUTTON} mt-1`} onClick={() => retry()()}>
								Try again
							</button>
						}
					>
						<span class="mt-1 inline-flex">
							<IconButton label="Try again" icon="arrow-clockwise" onClick={() => retry()()} />
						</span>
					</Show>
				)}
			</Show>
		</div>
	);
}

export function Loading(props: { readonly label: string }): JSX.Element {
	return (
		<output aria-busy="true" class="block text-sm text-slate-600">
			Loading {props.label}…
		</output>
	);
}

/** Renders the three states of a remote resource. */
export function RemoteView<T>(props: {
	readonly remote: Remote<T>;
	readonly label: string;
	readonly onRetry: () => void;
	/** Receives an accessor so the content stays reactive when the value is replaced. */
	readonly children: (value: Accessor<T>) => JSX.Element;
}): JSX.Element {
	const ready = () => (props.remote.status === "ready" ? { value: props.remote.value } : null);
	const failure = () => (props.remote.status === "error" ? props.remote.error : null);
	return (
		<Switch>
			<Match when={props.remote.status === "loading"}>
				<Loading label={props.label} />
			</Match>
			<Match when={failure()}>
				{(error) => (
					<ErrorNotice
						failure={error()}
						title={`Could not load ${props.label}.`}
						onRetry={props.onRetry}
					/>
				)}
			</Match>
			<Match when={ready()}>{(current) => props.children(() => current().value)}</Match>
		</Switch>
	);
}

export function Empty(props: { readonly children: JSX.Element }): JSX.Element {
	return (
		<p class="rounded border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600">
			{props.children}
		</p>
	);
}

/**
 * The one page header every page starts with: the title as the page's `<h2>`
 * and the purpose sentence from `PAGES` beneath it (ARCH-010: no copies),
 * in the UI language (`pages.messages.ts`).
 * The Chat page shows the title only (owner's decision of 2026-10-12): its
 * three panels say what the page is for, and the line cost thread height.
 */
export function PageHeader(props: { readonly view: ViewName }): JSX.Element {
	const pages = useMessages(pageMessages);
	return (
		<div class="mb-3">
			<h2 class="text-lg font-semibold text-slate-900">{pages().title(props.view)}</h2>
			<Show when={props.view !== "chat"}>
				<p class="text-sm text-slate-600">{pages().purpose(props.view)}</p>
			</Show>
		</div>
	);
}

/**
 * Icon-only collapse/expand button for the Chat page side panels, in
 * NotebookLM's manner: one small side-panel glyph (an outlined rounded
 * rectangle with a vertical divider near one side; inline SVG using
 * `currentColor`), sitting in the top corner of the panel header, and the
 * same glyph at the top of the collapsed rail to expand. No visible text:
 * the accessible name, `aria-expanded` and the `title` tooltip carry the
 * words instead. The divider side mirrors for the left (Chats) and right
 * (Canvas) panels. The filled borderless tone matches `BUTTON`.
 */
export function PanelCollapseButton(props: {
	readonly label: string;
	readonly expanded: boolean;
	readonly onToggle: () => void;
	readonly side: "left" | "right";
}): JSX.Element {
	return (
		<button
			type="button"
			class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-900 hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
			aria-expanded={props.expanded}
			aria-label={props.label}
			title={props.label}
			onClick={() => props.onToggle()}
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
					d={props.side === "left" ? "M5 2v10" : "M9 2v10"}
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
			</svg>
		</button>
	);
}

/**
 * Small header for one panel of the Chat page (guideline section 5): the
 * panel title as an `h3` plus header actions (collapse/expand, count). WHY a
 * shared part: the three panels repeat the same title-plus-button row, and
 * the guideline requires the same thing to look the same everywhere.
 */
export function PanelHeader(props: {
	readonly title: string;
	readonly count?: string;
	readonly expanded: boolean;
	readonly collapseLabel: string;
	readonly expandLabel: string;
	readonly onToggle: () => void;
	readonly actions?: JSX.Element;
	readonly side: "left" | "right";
}): JSX.Element {
	return (
		<div class="flex items-center gap-2">
			<h3 class={`${HEADING} min-w-0 flex-1 truncate`}>
				{props.title}
				<Show when={props.count}>
					{(count) => <span class="font-normal text-slate-600"> {count()}</span>}
				</Show>
			</h3>
			<Show when={props.actions}>{(actions) => actions()}</Show>
			<PanelCollapseButton
				label={props.expanded ? props.collapseLabel : props.expandLabel}
				expanded={props.expanded}
				onToggle={props.onToggle}
				side={props.side}
			/>
		</div>
	);
}

export interface ActionMenuItem {
	readonly label: string;
	readonly onSelect: () => void;
	readonly icon?: IconButtonName;
	readonly disabled?: boolean;
	readonly value?: string;
	/**
	 * Opt-in radio state (ADR-0023): when ANY item of a menu defines it,
	 * every item renders as `menuitemradio` with `aria-checked`, and a
	 * checked item shows a trailing check glyph. Menus without it render
	 * exactly as before.
	 */
	readonly checked?: boolean;
}

/** The viewport rectangle of a menu's button, as `getBoundingClientRect` reports it. */
export interface MenuAnchorRect {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

const MENU_GAP_PX = 4;
const MENU_VIEWPORT_MARGIN_PX = 8;

/**
 * Where an open menu goes, in viewport coordinates (it is `position: fixed`,
 * so no `overflow` container — the Notebook's narrow scrolling panel, a
 * widget frame — can clip it). `below-end` hangs under the button with
 * right edges aligned, `above-start` stands on it with left edges aligned;
 * either flips to the other side when it does not fit, and the result is
 * clamped inside the viewport with a small margin.
 */
export function placeActionMenu(
	anchor: MenuAnchorRect,
	size: { readonly width: number; readonly height: number },
	viewport: { readonly width: number; readonly height: number },
	placement: "below-end" | "above-start",
): { readonly left: number; readonly top: number } {
	const margin = MENU_VIEWPORT_MARGIN_PX;
	const below = anchor.bottom + MENU_GAP_PX;
	const above = anchor.top - MENU_GAP_PX - size.height;
	const fitsBelow = below + size.height <= viewport.height - margin;
	const fitsAbove = above >= margin;
	const top =
		placement === "above-start"
			? fitsAbove || !fitsBelow
				? above
				: below
			: fitsBelow || !fitsAbove
				? below
				: above;
	const left = placement === "above-start" ? anchor.left : anchor.right - size.width;
	const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max));
	return {
		left: clamp(left, viewport.width - size.width - margin),
		top: clamp(top, viewport.height - size.height - margin),
	};
}

/**
 * Menu-button pattern for row actions (guideline section 6): Enter/Space/
 * ArrowDown on the button opens the menu, arrows move between items, Escape
 * closes and returns focus to the button, click outside closes. Status is
 * never colour alone: items are text verbs, not colour swatches.
 *
 * One implementation (guideline principle 5): the Chats rows use the default
 * filled trigger with text items, while Home widget frames pass `iconTrigger`
 * (an `IconButton` with `three-dots`) and items with leading icons plus
 * per-item `disabled` (skipped by arrow keys). Items without icons render
 * exactly as before, so existing uses are unchanged.
 *
 * Two opt-in props (ADR-0023, composer's mode menu): `checked` on the items
 * turns the menu into radios, and `placement="above-start"` opens it upward
 * from the button's leading edge (the composer sits at the page bottom).
 * Both default off, so existing menus render and behave exactly as today.
 *
 * The open menu renders in a portal on <body> at a fixed position, so no
 * overflow container clips it. Not for use inside a modal <dialog>: content
 * outside the dialog's top layer is inert.
 */
export function ActionMenu(props: {
	readonly buttonLabel: string;
	readonly menuLabel: string;
	readonly items: readonly ActionMenuItem[];
	readonly iconTrigger?: {
		readonly icon: IconButtonName;
		readonly disabled?: boolean;
		readonly widgetActions?: string;
	};
	readonly placement?: "below-end" | "above-start";
}): JSX.Element {
	const [open, setOpen] = createSignal(false);
	/** Radio menu: any item defines `checked` (ADR-0023). */
	const radio = () => props.items.some((item) => item.checked !== undefined);
	let button: HTMLButtonElement | undefined;
	let menu: HTMLDivElement | undefined;
	const itemElements: (HTMLButtonElement | undefined)[] = [];

	const close = (returnFocus: boolean) => {
		setOpen(false);
		if (returnFocus) button?.focus();
	};

	const firstEnabled = (): number => {
		const index = props.items.findIndex((item) => item.disabled !== true);
		return index < 0 ? 0 : index;
	};

	const lastEnabled = (): number => {
		for (let index = props.items.length - 1; index >= 0; index -= 1) {
			if (props.items[index]?.disabled !== true) return index;
		}
		return props.items.length - 1;
	};

	/**
	 * Pins the open menu to its button in viewport coordinates (see
	 * `placeActionMenu`). The CSSOM writes are allowed under the app's
	 * `style-src 'self'`, like the widget drag's. It runs before the first
	 * paint of the open menu.
	 */
	const place = () => {
		if (button === undefined || menu === undefined) return;
		const spot = placeActionMenu(
			button.getBoundingClientRect(),
			{ width: menu.offsetWidth, height: menu.offsetHeight },
			{ width: window.innerWidth, height: window.innerHeight },
			props.placement ?? "below-end",
		);
		menu.style.setProperty("left", `${spot.left}px`);
		menu.style.setProperty("top", `${spot.top}px`);
	};

	const openAndFocus = (index: number) => {
		if (props.iconTrigger?.disabled === true) return;
		setOpen(true);
		// Place and focus after Solid renders the menu (a microtask runs
		// before the next paint, so the menu never shows unplaced).
		queueMicrotask(() => {
			place();
			focusItem(index);
		});
	};

	const onButtonKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
			event.preventDefault();
			if (!open()) openAndFocus(firstEnabled());
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (!open()) openAndFocus(lastEnabled());
		}
	};

	const focusItem = (index: number) => {
		const count = props.items.length;
		if (count === 0) return;
		const wrapped = (index + count) % count;
		for (let step = 0; step < count; step += 1) {
			const candidate = (wrapped + step) % count;
			const entry = props.items[candidate];
			const element = itemElements[candidate];
			if (entry?.disabled !== true && element !== undefined) {
				element.focus();
				return;
			}
		}
	};

	const currentIndex = (): number => {
		const active = document.activeElement;
		if (!(active instanceof HTMLButtonElement)) return -1;
		return itemElements.indexOf(active);
	};

	const onMenuKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close(true);
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			focusItem(currentIndex() + 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			focusItem(currentIndex() - 1);
		} else if (event.key === "Home") {
			event.preventDefault();
			focusItem(0);
		} else if (event.key === "End") {
			event.preventDefault();
			focusItem(props.items.length - 1);
		} else if (event.key === "Tab") {
			// The menu lives at the end of <body>: hand focus back to its
			// button first, so Tab continues from there in page order.
			close(true);
		}
	};

	createEffect(() => {
		if (!open()) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (button?.contains(target) === true || menu?.contains(target) === true) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		// A fixed menu follows its button when anything scrolls or the
		// window resizes (capture: scrolls of inner panels do not bubble).
		const onMove = () => place();
		window.addEventListener("scroll", onMove, { capture: true, passive: true });
		window.addEventListener("resize", onMove, { passive: true });
		onCleanup(() => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("scroll", onMove, { capture: true });
			window.removeEventListener("resize", onMove);
		});
	});

	return (
		<div class="relative inline-flex">
			<Show
				when={props.iconTrigger}
				fallback={
					<button
						ref={(element) => {
							button = element;
						}}
						type="button"
						class={`${BUTTON} min-w-6`}
						aria-label={props.buttonLabel}
						aria-haspopup="menu"
						aria-expanded={open()}
						onClick={() => {
							if (open()) close(false);
							else openAndFocus(firstEnabled());
						}}
						onKeyDown={onButtonKeyDown}
					>
						<span aria-hidden="true">⋮</span>
					</button>
				}
			>
				{(trigger) => (
					<IconButton
						label={props.buttonLabel}
						icon={trigger().icon}
						disabled={trigger().disabled}
						expanded={open()}
						hasPopup="menu"
						widgetActions={trigger().widgetActions}
						ref={(element) => {
							button = element;
						}}
						onKeyDown={(event) => onButtonKeyDown(event)}
						onClick={() => {
							if (open()) close(false);
							else openAndFocus(firstEnabled());
						}}
					/>
				)}
			</Show>
			<Show when={open()}>
				{/* A portal on <body>: an ancestor with `container-type` (the
				    widget grid) or a transform is the containing block of a
				    fixed descendant, and the Notebook's scrolling panel then
				    clipped the menu. Placed by `place()`. */}
				<Portal>
					<div
						ref={(element) => {
							menu = element;
						}}
						role="menu"
						aria-label={props.menuLabel}
						class={
							props.items.some((item) => item.icon !== undefined)
								? "fixed top-0 left-0 z-50 min-w-44 rounded border border-slate-200 bg-white p-1"
								: "fixed top-0 left-0 z-50 min-w-32 rounded bg-slate-100 p-1"
						}
						onKeyDown={onMenuKeyDown}
					>
						<For each={props.items}>
							{(item, index) => (
								<>
									{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menuitemradio (which supports aria-checked) whenever any item defines checked */}
									<button
										ref={(element) => {
											itemElements[index()] = element;
										}}
										type="button"
										role={radio() ? "menuitemradio" : "menuitem"}
										aria-checked={radio() ? item.checked === true : undefined}
										data-menu-value={item.value}
										disabled={item.disabled}
										class={
											item.icon === undefined && !radio()
												? "block min-h-6 w-full rounded px-2 py-1 text-left text-sm text-slate-900 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
												: "flex min-h-7 w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-slate-900 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
										}
										onClick={() => {
											if (item.disabled === true) return;
											setOpen(false);
											button?.focus();
											item.onSelect();
										}}
									>
										<Show when={item.icon}>
											{(glyph) => (
												<span aria-hidden="true" class="inline-flex shrink-0">
													<IconGlyph name={glyph()} />
												</span>
											)}
										</Show>
										<span class={radio() ? "flex-1" : undefined}>{item.label}</span>
										<Show when={item.checked === true}>
											<span aria-hidden="true" class="inline-flex shrink-0">
												<IconGlyph name="check-lg" />
											</span>
										</Show>
									</button>
								</>
							)}
						</For>
					</div>
				</Portal>
			</Show>
		</div>
	);
}

/**
 * Modal confirmation built on the native `<dialog>` (guideline section 6):
 * focus is trapped while open, Escape/Cancel closes and returns focus to the
 * opener. The opener arrives explicitly so Safari (which does not focus a
 * clicked button) still returns focus correctly.
 */
export function ConfirmDialog(props: {
	readonly title: string;
	readonly opener: HTMLElement | null;
	readonly confirmLabel: string;
	readonly pending: boolean;
	readonly failure: ApiFailure | null;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
	readonly children: JSX.Element;
}): JSX.Element {
	const headingId = createUniqueId();
	let dialog: HTMLDialogElement | undefined;
	let cancelButton: HTMLButtonElement | undefined;

	const closeToOpener = () => {
		props.opener?.focus();
	};

	onMount(() => {
		dialog?.showModal();
		cancelButton?.focus();
	});
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			class="rounded bg-slate-100 p-4"
			onCancel={(event) => {
				event.preventDefault();
				props.onCancel();
				closeToOpener();
			}}
			onClose={() => closeToOpener()}
		>
			<h3 id={headingId} class="text-base font-semibold text-slate-900">
				{props.title}
			</h3>
			<div class="mt-2 max-w-md text-sm text-slate-800">{props.children}</div>
			<Show when={props.failure}>
				{(failure) => (
					<div class="mt-2">
						<ErrorNotice failure={failure()} title="The chat was not deleted." />
					</div>
				)}
			</Show>
			<div class="mt-3 flex gap-2">
				<button
					ref={(element) => {
						cancelButton = element;
					}}
					type="button"
					class={BUTTON}
					disabled={props.pending}
					onClick={() => {
						props.onCancel();
						closeToOpener();
					}}
				>
					Cancel
				</button>
				<button
					type="button"
					class={BUTTON_DANGER}
					disabled={props.pending}
					onClick={() => props.onConfirm()}
				>
					{props.pending ? "Deleting…" : props.confirmLabel}
				</button>
			</div>
		</dialog>
	);
}
