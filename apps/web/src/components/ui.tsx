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
import type { ApiFailure } from "../api/http.ts";
import type { Remote } from "../lib/remote.ts";
import { PAGES, type ViewName } from "../pages.ts";

export const BUTTON =
	"rounded border border-slate-400 bg-white px-2 py-1 text-xs font-medium text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50";
export const BUTTON_PRIMARY =
	"rounded border border-blue-800 bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:border-slate-400 disabled:bg-slate-300 disabled:text-slate-600";
export const BUTTON_DANGER =
	"rounded border border-red-700 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";
export const INPUT =
	"min-h-6 w-full rounded border border-slate-400 bg-white px-2 py-1 text-sm text-slate-900 disabled:bg-slate-100";
export const LABEL = "block text-xs font-medium text-slate-700";
export const PANEL = "rounded border border-slate-300 bg-white p-3";
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
	readonly failure: ApiFailure;
	readonly title?: string;
	readonly onRetry?: () => void;
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
					<button type="button" class={`${BUTTON} mt-1`} onClick={() => retry()()}>
						Try again
					</button>
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
 * and the purpose sentence from `PAGES` beneath it (ARCH-010: no copies).
 */
export function PageHeader(props: { readonly view: ViewName }): JSX.Element {
	const page = () => PAGES.find((entry) => entry.view === props.view) ?? PAGES[0];
	return (
		<div class="mb-3">
			<h2 class="text-lg font-semibold text-slate-900">{page()?.title}</h2>
			<p class="text-sm text-slate-600">{page()?.purpose}</p>
		</div>
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
			<button
				type="button"
				class={BUTTON}
				aria-expanded={props.expanded}
				aria-label={props.expanded ? props.collapseLabel : props.expandLabel}
				onClick={() => props.onToggle()}
			>
				{props.expanded ? "Collapse" : "Expand"}
			</button>
		</div>
	);
}

export interface ActionMenuItem {
	readonly label: string;
	readonly onSelect: () => void;
}

/**
 * Menu-button pattern for row actions (guideline section 6): Enter/Space/
 * ArrowDown on the button opens the menu, arrows move between items, Escape
 * closes and returns focus to the button, click outside closes. Status is
 * never colour alone: items are text verbs, not colour swatches.
 */
export function ActionMenu(props: {
	readonly buttonLabel: string;
	readonly menuLabel: string;
	readonly items: readonly ActionMenuItem[];
}): JSX.Element {
	const [open, setOpen] = createSignal(false);
	let button: HTMLButtonElement | undefined;
	let menu: HTMLDivElement | undefined;
	const itemElements: (HTMLButtonElement | undefined)[] = [];

	const close = (returnFocus: boolean) => {
		setOpen(false);
		if (returnFocus) button?.focus();
	};

	const openAndFocus = (index: number) => {
		setOpen(true);
		// Focus after Solid renders the menu.
		queueMicrotask(() => {
			itemElements[index]?.focus();
		});
	};

	const onButtonKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
			event.preventDefault();
			if (!open()) openAndFocus(0);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (!open()) openAndFocus(props.items.length - 1);
		}
	};

	const focusItem = (index: number) => {
		const count = props.items.length;
		if (count === 0) return;
		const wrapped = (index + count) % count;
		itemElements[wrapped]?.focus();
	};

	const currentIndex = (): number => {
		const active = document.activeElement;
		return itemElements.indexOf(active as HTMLButtonElement | undefined);
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
			setOpen(false);
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
		onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));
	});

	return (
		<div class="relative inline-flex">
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
					else openAndFocus(0);
				}}
				onKeyDown={onButtonKeyDown}
			>
				<span aria-hidden="true">⋮</span>
			</button>
			<Show when={open()}>
				<div
					ref={(element) => {
						menu = element;
					}}
					role="menu"
					aria-label={props.menuLabel}
					class="absolute right-0 z-20 min-w-32 rounded border border-slate-300 bg-white p-1"
					onKeyDown={onMenuKeyDown}
				>
					<For each={props.items}>
						{(item, index) => (
							<button
								ref={(element) => {
									itemElements[index()] = element;
								}}
								type="button"
								role="menuitem"
								class="block min-h-6 w-full rounded px-2 py-1 text-left text-sm text-slate-900 hover:bg-slate-100"
								onClick={() => {
									setOpen(false);
									button?.focus();
									item.onSelect();
								}}
							>
								{item.label}
							</button>
						)}
					</For>
				</div>
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
			class="rounded border border-slate-300 bg-white p-4"
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
