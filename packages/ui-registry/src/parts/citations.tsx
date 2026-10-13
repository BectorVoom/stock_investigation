import type { Claim, Evidence } from "@research/contracts";
import {
	createContext,
	createMemo,
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
	useContext,
} from "solid-js";
import {
	type CitationNumbering,
	chipLabel,
	numberEvidence,
	sourceHost,
	titleOrHost,
} from "../citationModel.ts";
import { formatIsoDate, safeHttpsUrl } from "../format.ts";
import { SafeLink, type SourceMap, SourceUnavailable } from "./SourceLinks.tsx";
import { EmptyState } from "./states.tsx";

/** A claim link's relation to its evidence; null on the canvas, which has no claim link. */
export type CitationRelation = Claim["links"][number]["relation"];

const RELATION_TEXT: { readonly [R in CitationRelation]: string } = {
	supports: "Supports",
	contradicts: "Contradicts",
	context: "Context",
};

const CHIP =
	"min-h-6 min-w-6 rounded-full bg-blue-100 px-1.5 text-2xs font-semibold text-blue-900 tabular-nums hover:bg-blue-200";
const CHIP_OPEN =
	"min-h-6 min-w-6 rounded-full bg-blue-700 px-1.5 text-2xs font-semibold text-white tabular-nums";

/**
 * The open/pinned state behind citation chips: hover or keyboard focus shows
 * the source card, click pins it open for touch users, Escape or an outside
 * click closes it with focus returning to the chip. Only one card is open at
 * a time per scope (one chat answer or one canvas component). Shared by the
 * chat and every canvas component so the behaviour cannot drift apart.
 */
export interface CitationInteraction {
	readonly openKey: () => string | null;
	readonly pinnedKey: () => string | null;
	readonly preview: (key: string) => void;
	readonly enterChip: (key: string) => void;
	readonly hoverEnd: () => void;
	readonly togglePin: (key: string) => void;
	readonly closeAndRefocus: (key: string, from: HTMLElement | null) => void;
}

export function createCitationInteraction(): CitationInteraction {
	const [openKey, setOpenKey] = createSignal<string | null>(null);
	const [pinnedKey, setPinnedKey] = createSignal<string | null>(null);
	// Escape closes the card and returns focus to its chip; that programmatic
	// focus must not preview the card straight back open, so the next focus
	// of the same chip is consumed once. Every other interaction clears it.
	let refocusGuard: string | null = null;
	const preview = (key: string) => {
		if (refocusGuard === key) {
			refocusGuard = null;
			return;
		}
		setOpenKey(key);
	};
	const enterChip = (key: string) => {
		refocusGuard = null;
		setOpenKey(key);
	};
	const hoverEnd = () => {
		refocusGuard = null;
		setOpenKey(pinnedKey());
	};
	const togglePin = (key: string) => {
		refocusGuard = null;
		if (pinnedKey() === key) {
			setPinnedKey(null);
			setOpenKey(null);
		} else {
			setPinnedKey(key);
			setOpenKey(key);
		}
	};
	const closeAndRefocus = (key: string, from: HTMLElement | null) => {
		setPinnedKey(null);
		setOpenKey(null);
		if (from === null) return;
		// Keys are ids joined with "::"; quoted attribute values need no
		// escaping for the wrapping quotes.
		const group = from.closest("[data-citation-group]");
		const chip = group?.querySelector<HTMLElement>(`[data-citation-chip="${key}"]`);
		if (chip === undefined || chip === null) return;
		refocusGuard = key;
		chip.focus();
	};
	// A click outside every citation group closes the pinned card (Escape and
	// pinning another chip are handled on the groups themselves).
	const onPointerDown = (event: PointerEvent) => {
		if (openKey() === null) return;
		const target = event.target;
		if (target instanceof Element && target.closest("[data-citation-group]") !== null) return;
		setPinnedKey(null);
		setOpenKey(null);
	};
	document.addEventListener("pointerdown", onPointerDown);
	onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));
	return { openKey, pinnedKey, preview, enterChip, hoverEnd, togglePin, closeAndRefocus };
}

/**
 * Focus leaving a citation group: moving between a chip and its open card
 * stays inside the group (the card is a DOM descendant of it), so only focus
 * truly leaving the group previews nothing. Shared by chat claim groups and
 * canvas component groups.
 */
export function citationGroupFocusOut(event: FocusEvent, onHoverEnd: () => void): void {
	const current = event.currentTarget;
	const next = event.relatedTarget;
	if (current instanceof HTMLElement && next instanceof Node && current.contains(next)) return;
	onHoverEnd();
}

/** Escape on a chip closes its card and returns focus to the chip. */
export function citationChipEscape(
	event: KeyboardEvent,
	key: string,
	interaction: CitationInteraction,
): void {
	if (event.key !== "Escape") return;
	if (interaction.openKey() !== key) return;
	event.preventDefault();
	const target = event.currentTarget;
	interaction.closeAndRefocus(key, target instanceof HTMLElement ? target : null);
}

/** One numbered evidence reference. The card it opens is rendered by the caller. */
export function CitationChip(props: {
	readonly chipKey: string;
	readonly number: number;
	readonly label: string;
	readonly relation?: CitationRelation | null;
	readonly open: boolean;
	readonly interaction: CitationInteraction;
}): JSX.Element {
	return (
		<button
			type="button"
			data-citation-chip={props.chipKey}
			data-relation={props.relation ?? undefined}
			aria-label={props.label}
			aria-expanded={props.open}
			class={props.open ? CHIP_OPEN : CHIP}
			onMouseEnter={() => props.interaction.enterChip(props.chipKey)}
			onFocus={() => props.interaction.preview(props.chipKey)}
			onClick={(event) => {
				// Safari does not move focus to a clicked button: focus it
				// explicitly, so Escape closes the card there too.
				event.currentTarget.focus();
				props.interaction.togglePin(props.chipKey);
			}}
			onKeyDown={(event) => citationChipEscape(event, props.chipKey, props.interaction)}
		>
			{props.number}
		</button>
	);
}

/**
 * Hover/focus/click detail for one cited source, floating below its anchor
 * without pushing content around. The quote and relation come from a claim
 * link in the chat; on the canvas there is no claim link, so the card shows
 * the stored excerpt and no relation instead. Published, retrieved and
 * data-as-of dates are each labelled (DATA-002); a missing date says so.
 */
export function SourceCard(props: {
	readonly number: number;
	readonly cardId: string;
	readonly evidence: Evidence | undefined;
	readonly evidenceId: string;
	readonly quote?: string | null;
	readonly relation?: CitationRelation | null;
	readonly onEscape: (from: HTMLElement) => void;
}): JSX.Element {
	const source = () => props.evidence;
	const host = createMemo(() =>
		source() === undefined ? null : sourceHost(source()?.sourceUrl ?? ""),
	);
	const href = createMemo(() =>
		source() === undefined ? null : safeHttpsUrl(source()?.sourceUrl ?? ""),
	);
	const published = createMemo(() => {
		const iso = source()?.publishedAt ?? null;
		return iso === null ? null : formatIsoDate(iso);
	});
	const retrieved = createMemo(() => {
		const iso = source()?.retrievedAt ?? null;
		return iso === null ? null : formatIsoDate(iso);
	});
	const effective = createMemo(() => {
		const iso = source()?.effectiveAt ?? null;
		return iso === null ? null : formatIsoDate(iso);
	});
	// The link's own quote names what backs this claim; the stored excerpt is
	// the fallback when the license kept no quote (DATA-010).
	const passage = createMemo(() => props.quote ?? source()?.excerpt ?? null);
	const relation = () => props.relation ?? null;
	let card: HTMLDivElement | undefined;
	// A card opened near the end of a scrolling list would hang below the fold
	// of it; "nearest" scrolls only when it is actually cut off.
	onMount(() => {
		if (card !== undefined && typeof card.scrollIntoView === "function") {
			card.scrollIntoView({ block: "nearest" });
		}
	});
	return (
		// Floats over the content like NotebookLM's hover card, so previewing
		// a source never pushes the answer around. The wrapper's top padding
		// (not a margin) bridges chip and card: the pointer stays inside the
		// citation group on the way down, so the preview does not close. The
		// card is never wider than its anchor, so it stays inside the narrow
		// canvas panel too.
		<div class="absolute left-0 top-full z-20 w-full max-w-md pt-1">
			<div
				ref={(element) => {
					card = element;
				}}
				data-citation-card={props.cardId}
				class="rounded bg-blue-100 p-2 wrap-anywhere"
			>
				<p class="flex flex-wrap items-baseline gap-1 text-xs">
					<span
						aria-hidden="true"
						class="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full border border-blue-700 bg-blue-700 px-1 text-2xs font-semibold text-white tabular-nums"
					>
						{props.number}
					</span>
					<Show
						when={source()}
						fallback={
							<span class="font-semibold italic text-amber-900">
								Source unavailable (id {props.evidenceId})
							</span>
						}
					>
						{(item) => <span class="font-semibold text-slate-900">{item().title}</span>}
					</Show>
				</p>
				<Show when={source()}>
					{(item) => (
						<>
							<p class="mt-0.5 text-2xs text-slate-600">
								{item().publisher}
								<Show when={host()}>{(name) => <span> · {name()}</span>}</Show>
							</p>
							<p class="mt-0.5 text-2xs text-slate-600">
								<span>
									published{" "}
									<Show when={published()} fallback={<span class="italic">date not stated</span>}>
										{(date) => <time datetime={item().publishedAt ?? undefined}>{date()}</time>}
									</Show>
								</span>
								<span>
									{" · retrieved "}
									<Show when={retrieved()} fallback={<span class="italic">date not stated</span>}>
										{(date) => <time datetime={item().retrievedAt}>{date()}</time>}
									</Show>
								</span>
								<Show when={item().effectiveAt !== null}>
									<span>
										{" · data as of "}
										<Show when={effective()} fallback={<span class="italic">date not stated</span>}>
											{(date) => <time datetime={item().effectiveAt ?? undefined}>{date()}</time>}
										</Show>
									</span>
								</Show>
							</p>
						</>
					)}
				</Show>
				{/* Colour is never the only signal: a non-support relation is a word. */}
				<Show when={relation() !== null && relation() !== "supports" ? relation() : null}>
					{(rel) => (
						<p class="mt-0.5 text-2xs font-semibold text-slate-800">{RELATION_TEXT[rel()]}</p>
					)}
				</Show>
				<Show
					when={passage()}
					fallback={
						<p class="mt-0.5 text-2xs italic text-slate-600">No excerpt stored for this source.</p>
					}
				>
					{(passageText) => (
						<p class="mt-0.5 line-clamp-4 text-xs text-slate-800">{passageText()}</p>
					)}
				</Show>
				<p class="mt-1 text-xs">
					<Show
						when={href()}
						fallback={
							<span class="italic text-slate-600">
								Open source <span>(link unavailable)</span>
							</span>
						}
					>
						{(safeHref) => (
							<a
								href={safeHref()}
								target="_blank"
								rel="noopener noreferrer"
								class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
								onKeyDown={(event) => {
									if (event.key !== "Escape") return;
									event.preventDefault();
									props.onEscape(event.currentTarget);
								}}
							>
								Open source
							</a>
						)}
					</Show>
				</p>
			</div>
		</div>
	);
}

export interface CitationScopeValue extends CitationInteraction {
	readonly numbering: CitationNumbering;
}

const scopeContext = createContext<CitationScopeValue | null>(null);

/** The numbering and open-card state of one canvas component. */
export function useCitationScope(): CitationScopeValue | null {
	return useContext(scopeContext);
}

/**
 * One citation scope: a canvas component's distinct source ids in order of
 * first appearance. The numbering is computed once per component in a memo,
 * not per chip; the same source keeps the same number everywhere inside the
 * component, and at most one card is open per component.
 */
export function CitationScope(props: {
	readonly sourceIdsInOrder: readonly string[];
	readonly children: JSX.Element;
}): JSX.Element {
	const numbering = createMemo(() =>
		numberEvidence([
			{
				claimId: "component",
				links: props.sourceIdsInOrder.map((evidenceId) => ({ evidenceId })),
			},
		]),
	);
	const interaction = createCitationInteraction();
	return (
		<scopeContext.Provider value={{ numbering: numbering(), ...interaction }}>
			{props.children}
		</scopeContext.Provider>
	);
}

/**
 * A numbered chip for one source cited inside a `CitationScope`, with its
 * floating card. The chip anchors to the scope's wide group element (a
 * statement, a card body, a table), so the card stays inside the panel.
 * Renders nothing when the id has no number; scopes list every id they cite.
 */
export function ComponentCitation(props: {
	readonly sourceId: string;
	readonly chipKey: string;
	readonly sources: SourceMap;
}): JSX.Element {
	const scope = useCitationScope();
	return (
		<Show when={scope} fallback={null}>
			{(interaction) => (
				<Show when={interaction().numbering.numberByEvidenceId.get(props.sourceId)} fallback={null}>
					{(number) => {
						const evidence = () => props.sources.get(props.sourceId);
						const label = () =>
							evidence() === undefined
								? `Source ${number()}: unavailable`
								: chipLabel(number(), evidence()?.title ?? "", evidence()?.sourceUrl ?? "");
						const open = () => interaction().openKey() === props.chipKey;
						return (
							<>
								<CitationChip
									chipKey={props.chipKey}
									number={number()}
									label={label()}
									open={open()}
									interaction={interaction()}
								/>
								<Show when={open()}>
									<SourceCard
										number={number()}
										cardId={props.chipKey}
										evidence={evidence()}
										evidenceId={props.sourceId}
										onEscape={(from) => interaction().closeAndRefocus(props.chipKey, from)}
									/>
								</Show>
							</>
						);
					}}
				</Show>
			)}
		</Show>
	);
}

/**
 * Provenance block every component ends with: the same compact "N sources"
 * disclosure the chat uses, with numbered rows (number, safely linked title,
 * host) whose numbers match the component's chips. Inside a `CitationScope`
 * the rows follow the scope's numbering; standalone it numbers its own ids.
 */
export function SourceList(props: {
	readonly sourceIds: readonly string[];
	readonly sources: SourceMap;
	readonly heading?: string;
}): JSX.Element {
	const scope = useCitationScope();
	// Numbering is computed once per component in a memo, not per row.
	const ownNumbering = createMemo(() =>
		numberEvidence([
			{ claimId: "sources", links: props.sourceIds.map((evidenceId) => ({ evidenceId })) },
		]),
	);
	const orderedIds = () => scope?.numbering.evidenceIdsInOrder ?? ownNumbering().evidenceIdsInOrder;
	const count = () => orderedIds().length;
	return (
		<section aria-label={props.heading ?? "Sources"} class="mt-2 text-xs">
			<h4 class="font-semibold text-slate-700">{props.heading ?? "Sources"}</h4>
			<Show
				when={count() > 0}
				fallback={<EmptyState>No sources cited for this component.</EmptyState>}
			>
				<details class="group mt-1 text-xs">
					<summary class="flex min-h-6 cursor-pointer items-center gap-1 text-slate-700">
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
						<span class="min-w-0 flex-1">
							{count()} {count() === 1 ? "source" : "sources"}
						</span>
					</summary>
					<ol aria-label="Sources" class="mt-1 space-y-0.5">
						<For each={orderedIds()}>
							{(evidenceId, index) => {
								const item = () => props.sources.get(evidenceId);
								const host = () =>
									item() === undefined ? null : sourceHost(item()?.sourceUrl ?? "");
								return (
									<li data-source-id={evidenceId}>
										<span class="font-semibold tabular-nums">{index() + 1}. </span>
										<Show when={item()} fallback={<SourceUnavailable sourceId={evidenceId} />}>
											{(source) => (
												<>
													<SafeLink url={source().sourceUrl}>
														{titleOrHost(source().title, source().sourceUrl)}
													</SafeLink>
													<Show when={host()}>
														{(name) => <span class="text-slate-600"> · {name()}</span>}
													</Show>
												</>
											)}
										</Show>
									</li>
								);
							}}
						</For>
					</ol>
				</details>
			</Show>
		</section>
	);
}
