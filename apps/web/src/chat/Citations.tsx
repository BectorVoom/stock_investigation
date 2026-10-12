import type { Claim, Evidence } from "@research/contracts";
import {
	ClaimStatusBadge,
	ClaimTypeBadge,
	formatIsoDate,
	safeHttpsUrl,
} from "@research/ui-registry";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { DisclosureSummary } from "../components/ui.tsx";
import {
	type CitationNumbering,
	chipLabel,
	numberEvidence,
	numbersForClaim,
	sourceHost,
	titleOrHost,
} from "./citationModel.ts";

type EvidenceLink = Claim["links"][number];

const RELATION_TEXT: { readonly [R in EvidenceLink["relation"]]: string } = {
	supports: "Supports",
	contradicts: "Contradicts",
	context: "Context",
};

const CHIP =
	"min-h-6 min-w-6 rounded-full border border-blue-700 bg-blue-50 px-1.5 text-2xs font-semibold text-blue-900 tabular-nums hover:bg-blue-100";
const CHIP_OPEN =
	"min-h-6 min-w-6 rounded-full border border-blue-700 bg-blue-700 px-1.5 text-2xs font-semibold text-white tabular-nums";

/** Key of the card a chip opens: one chip per (claim, evidence) pair. */
function cardKey(claimId: string, evidenceId: string): string {
	return `${claimId}::${evidenceId}`;
}

function SourceCard(props: {
	readonly number: number;
	readonly cardId: string;
	readonly link: EvidenceLink;
	readonly evidence: Evidence | undefined;
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
	// The link's own quote names what backs this claim; the stored excerpt is
	// the fallback when the license kept no quote (DATA-010).
	const passage = createMemo(() => props.link.quote ?? source()?.excerpt ?? null);
	let card: HTMLDivElement | undefined;
	// A card opened near the end of the thread would hang below the fold of
	// the scrolling list; "nearest" scrolls only when it is actually cut off.
	onMount(() => {
		if (card !== undefined && typeof card.scrollIntoView === "function") {
			card.scrollIntoView({ block: "nearest" });
		}
	});
	return (
		// Floats over the thread like NotebookLM's hover card, so previewing a
		// source never pushes the answer around. The wrapper's top padding
		// (not a margin) bridges chip and card: the pointer stays inside the
		// claim's group on the way down, so the preview does not close.
		<div class="absolute left-0 top-full z-20 w-full max-w-md pt-1">
			<div
				ref={(element) => {
					card = element;
				}}
				data-citation-card={props.cardId}
				class="rounded border border-slate-400 bg-white p-2 wrap-anywhere"
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
								Source unavailable (id {props.link.evidenceId})
							</span>
						}
					>
						{(item) => <span class="font-semibold text-slate-900">{item().title}</span>}
					</Show>
				</p>
				<Show when={source()}>
					{(item) => (
						<p class="mt-0.5 text-2xs text-slate-600">
							{item().publisher}
							<Show when={host()}>{(name) => <span> · {name()}</span>}</Show>
							<Show when={published()}>
								{(date) => (
									<span>
										{" · published "}
										<time datetime={item().publishedAt ?? undefined}>{date()}</time>
									</span>
								)}
							</Show>
						</p>
					)}
				</Show>
				{/* Colour is never the only signal: a non-support relation is a word. */}
				<Show when={props.link.relation !== "supports"}>
					<p class="mt-0.5 text-2xs font-semibold text-slate-800">
						{RELATION_TEXT[props.link.relation]}
					</p>
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

function ClaimItem(props: {
	readonly claimId: string;
	readonly claims: ReadonlyMap<string, Claim>;
	readonly evidence: ReadonlyMap<string, Evidence>;
	readonly numbering: CitationNumbering;
	readonly openKey: () => string | null;
	readonly pinnedKey: () => string | null;
	readonly onPreview: (key: string) => void;
	readonly onEnterChip: (key: string) => void;
	readonly onHoverEnd: () => void;
	readonly onTogglePin: (key: string) => void;
	readonly onEscape: (key: string, from: HTMLElement | null) => void;
}): JSX.Element {
	const claim = createMemo(() => props.claims.get(props.claimId));
	const numbers = createMemo(() => {
		const current = claim();
		if (current === undefined) return [] as const;
		return numbersForClaim({ claimId: current.claimId, links: current.links }, props.numbering);
	});
	const openCard = createMemo(() => {
		const key = props.openKey();
		if (key === null) return null;
		const current = claim();
		if (current === undefined) return null;
		const link = current.links.find((entry) => cardKey(current.claimId, entry.evidenceId) === key);
		if (link === undefined) return null;
		const number = props.numbering.numberByEvidenceId.get(link.evidenceId);
		if (number === undefined) return null;
		return { key, link, number };
	});
	const onFocusOut = (event: FocusEvent & { readonly currentTarget: HTMLElement }) => {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		props.onHoverEnd();
	};
	const onEscapeKey = (event: KeyboardEvent, key: string) => {
		if (event.key !== "Escape") return;
		if (props.openKey() !== key) return;
		event.preventDefault();
		props.onEscape(key, event.currentTarget as HTMLElement);
	};
	return (
		<li data-claim-id={props.claimId} class="border-l-2 border-slate-300 pl-2">
			<Show
				when={claim()}
				fallback={<span class="italic text-amber-900">Claim unavailable (id {props.claimId})</span>}
			>
				{(current) => (
					<fieldset
						data-citation-group={props.claimId}
						class="relative m-0 min-w-0 border-0 p-0"
						onMouseLeave={() => props.onHoverEnd()}
						onFocusOut={onFocusOut}
					>
						{/* Plain text only: agent output is data, never markup (UI-005). */}
						<p class="text-sm text-slate-900">{current().text}</p>
						<p class="mt-0.5 flex flex-wrap items-center gap-1">
							<ClaimTypeBadge claimType={current().claimType} />
							<ClaimStatusBadge status={current().status} />
							<For each={current().links}>
								{(link, index) => {
									const key = () => cardKey(current().claimId, link.evidenceId);
									const number = () => numbers()[index()];
									const item = () => props.evidence.get(link.evidenceId);
									return (
										<Show when={number() !== undefined}>
											<button
												type="button"
												data-citation-chip={key()}
												data-relation={link.relation}
												aria-label={
													item() === undefined
														? `Source ${number() ?? 0}: unavailable`
														: chipLabel(number() ?? 0, item()?.title ?? "", item()?.sourceUrl ?? "")
												}
												aria-expanded={props.openKey() === key()}
												class={props.openKey() === key() ? CHIP_OPEN : CHIP}
												onMouseEnter={() => props.onEnterChip(key())}
												onFocus={() => props.onPreview(key())}
												onClick={() => props.onTogglePin(key())}
												onKeyDown={(event) => onEscapeKey(event, key())}
											>
												{number()}
											</button>
										</Show>
									);
								}}
							</For>
						</p>
						<Show
							when={current().links.length > 0}
							fallback={
								<p class="text-xs italic text-amber-900">No evidence linked to this claim.</p>
							}
						>
							<Show when={openCard()}>
								{(open) => (
									<SourceCard
										number={open().number}
										cardId={open().key}
										link={open().link}
										evidence={props.evidence.get(open().link.evidenceId)}
										onEscape={(from) => props.onEscape(open().key, from)}
									/>
								)}
							</Show>
						</Show>
					</fieldset>
				)}
			</Show>
		</li>
	);
}

/**
 * One answer's claims with NotebookLM-style citation chips.
 *
 * Each claim is a sentence followed by numbered chips; hover or keyboard
 * focus shows the source card, click pins it open for touch users. The card
 * floats below its claim, anchored to the claim's own box: it is never wider
 * than the claim (so it cannot leave the viewport sideways), and because it
 * lives inside the scrolling message list it extends that list instead of
 * being clipped by it. Positioning is classes only (no inline styles, per the
 * design guideline). Only one card is open at a time per answer.
 */
export function AnswerClaims(props: {
	readonly claimIds: readonly string[];
	readonly claims: ReadonlyMap<string, Claim>;
	readonly evidence: ReadonlyMap<string, Evidence>;
}): JSX.Element {
	const numbering = createMemo(() =>
		numberEvidence(
			props.claimIds.map((claimId) => ({
				claimId,
				links: props.claims.get(claimId)?.links ?? [],
			})),
		),
	);
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
		// Keys are `claimId::evidenceId` of validated ids; quoted attribute
		// values need no escaping for the wrapping quotes.
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

	const sources = createMemo(() => numbering().evidenceIdsInOrder);
	return (
		<>
			<h4 class="mt-2 text-xs font-semibold text-slate-700">Claims in this answer</h4>
			<ul aria-label="Claims" class="mt-0.5 space-y-1.5">
				<For each={props.claimIds}>
					{(claimId) => (
						<ClaimItem
							claimId={claimId}
							claims={props.claims}
							evidence={props.evidence}
							numbering={numbering()}
							openKey={openKey}
							pinnedKey={pinnedKey}
							onPreview={preview}
							onEnterChip={enterChip}
							onHoverEnd={hoverEnd}
							onTogglePin={togglePin}
							onEscape={closeAndRefocus}
						/>
					)}
				</For>
			</ul>
			<Show when={sources().length > 0}>
				<details class="group mt-2 text-xs">
					<DisclosureSummary class="text-slate-700">
						{sources().length} {sources().length === 1 ? "source" : "sources"}
					</DisclosureSummary>
					<ol aria-label="Sources" class="mt-1 space-y-0.5">
						<For each={sources()}>
							{(evidenceId, index) => {
								const item = createMemo(() => props.evidence.get(evidenceId));
								const host = createMemo(() =>
									item() === undefined ? null : sourceHost(item()?.sourceUrl ?? ""),
								);
								const href = createMemo(() =>
									item() === undefined ? null : safeHttpsUrl(item()?.sourceUrl ?? ""),
								);
								return (
									<li data-source-id={evidenceId}>
										<span class="font-semibold tabular-nums">{index() + 1}. </span>
										<Show
											when={item()}
											fallback={
												<span class="italic text-amber-900">
													Source unavailable (id {evidenceId})
												</span>
											}
										>
											{(source) => (
												<>
													<Show
														when={href()}
														fallback={
															<span>
																{titleOrHost(source().title, source().sourceUrl)}{" "}
																<span class="italic text-slate-600">(link unavailable)</span>
															</span>
														}
													>
														{(safeHref) => (
															<a
																href={safeHref()}
																target="_blank"
																rel="noopener noreferrer"
																class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
															>
																{titleOrHost(source().title, source().sourceUrl)}
															</a>
														)}
													</Show>
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
		</>
	);
}
