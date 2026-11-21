import type { Claim, Evidence } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import {
	CitationChip,
	type CitationInteraction,
	type CitationNumbering,
	ClaimStatusBadge,
	chipLabel,
	citationGroupFocusOut,
	citationMessages,
	createCitationInteraction,
	numberEvidence,
	numbersForClaim,
	SourceCard,
	safeHttpsUrl,
	sourceHost,
	titleOrHost,
} from "@research/ui-registry";
import { createMemo, For, type JSX, Show } from "solid-js";
import { DisclosureSummary } from "../components/ui.tsx";
import { ChatMarkdownText, type MarkdownTableNotebookSave } from "./ChatMarkdownText.tsx";
import { citationsMessages } from "./conversation.messages.ts";

/** Key of the card a chip opens: one chip per (claim, evidence) pair. */
function cardKey(claimId: string, evidenceId: string): string {
	return `${claimId}::${evidenceId}`;
}

function ClaimItem(props: {
	readonly claimId: string;
	readonly claims: ReadonlyMap<string, Claim>;
	readonly evidence: ReadonlyMap<string, Evidence>;
	readonly numbering: CitationNumbering;
	readonly interaction: CitationInteraction;
	readonly prose?: boolean;
	readonly lead?: boolean;
	readonly notebookSaveForClaim?: (claimId: string) => MarkdownTableNotebookSave | null;
}): JSX.Element {
	const m = useMessages(citationsMessages);
	const cm = useMessages(citationMessages);
	const claim = createMemo(() => props.claims.get(props.claimId));
	const keyFor = (link: Claim["links"][number]) =>
		cardKey(props.claimId, props.prose ? `${link.evidenceId}:${link.relation}` : link.evidenceId);
	// One reference per source/relation, with every supporting passage retained in the card.
	const links = createMemo(() => {
		const original = claim()?.links ?? [];
		if (!props.prose) return original;
		const groups = new Map<string, Claim["links"][number]>();
		for (const link of original) {
			const key = `${link.evidenceId}:${link.relation}`;
			const prior = groups.get(key);
			groups.set(
				key,
				prior === undefined
					? link
					: {
							...link,
							quote:
								[...new Set([prior.quote, link.quote].filter((quote) => quote !== null))].join(
									"\n\n",
								) || null,
						},
			);
		}
		return [...groups.values()];
	});
	const numbers = createMemo(() => {
		const current = claim();
		if (current === undefined) return [] as const;
		return numbersForClaim({ claimId: current.claimId, links: links() }, props.numbering);
	});
	const openCard = createMemo(() => {
		const key = props.interaction.openKey();
		if (key === null) return null;
		const current = claim();
		if (current === undefined) return null;
		const link = links().find((entry) => keyFor(entry) === key);
		if (link === undefined) return null;
		const number = props.numbering.numberByEvidenceId.get(link.evidenceId);
		if (number === undefined) return null;
		return { key, link, number };
	});
	const referenceChips = () => (
		<For each={links()}>
			{(link, index) => {
				const key = () => keyFor(link);
				const number = () => numbers()[index()];
				const item = () => props.evidence.get(link.evidenceId);
				return (
					<Show when={number() !== undefined}>
						<CitationChip
							chipKey={key()}
							number={number() ?? 0}
							label={
								item() === undefined
									? cm().chipUnavailable(number() ?? 0)
									: chipLabel(number() ?? 0, item()?.title ?? "", item()?.sourceUrl ?? "", cm())
							}
							relation={link.relation}
							subtle={props.prose === true}
							open={props.interaction.openKey() === key()}
							interaction={props.interaction}
						/>
					</Show>
				);
			}}
		</For>
	);

	return (
		<li
			data-claim-id={props.claimId}
			class={props.prose ? "list-none" : "border-l-2 border-slate-300 pl-2"}
		>
			<Show
				when={claim()}
				fallback={<span class="italic text-amber-900">{m().claimUnavailable(props.claimId)}</span>}
			>
				{(current) => (
					<fieldset
						data-citation-group={props.claimId}
						class="relative m-0 min-w-0 border-0 p-0"
						onMouseLeave={() => props.interaction.hoverEnd()}
						onFocusOut={(event) => citationGroupFocusOut(event, props.interaction.hoverEnd)}
					>
						{/* Approved structured pipe tables only; all other agent text stays plain text (UI-005). */}
						<ChatMarkdownText
							text={current().text}
							textClass={
								props.lead
									? "text-base font-medium leading-relaxed text-slate-900"
									: "text-sm leading-relaxed text-slate-900"
							}
							trailing={
								<Show when={props.prose}>
									<span class="ml-1 inline-flex flex-wrap gap-1 align-baseline">
										{referenceChips()}
									</span>
								</Show>
							}
							notebookSave={props.notebookSaveForClaim?.(props.claimId) ?? null}
						/>
						<Show when={!props.prose || current().status !== "supported"}>
							<p class="mt-0.5 flex flex-wrap items-center gap-1">
								<ClaimStatusBadge status={current().status} />
								<Show when={!props.prose}>{referenceChips()}</Show>
							</p>
						</Show>
						<Show
							when={current().links.length > 0}
							fallback={<p class="text-xs italic text-amber-900">{m().noEvidenceLinked}</p>}
						>
							<Show when={openCard()}>
								{(open) => (
									<SourceCard
										number={open().number}
										cardId={open().key}
										evidence={props.evidence.get(open().link.evidenceId)}
										evidenceId={open().link.evidenceId}
										quote={open().link.quote}
										relation={open().link.relation}
										onEscape={(from) => props.interaction.closeAndRefocus(open().key, from)}
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
 * design guideline). Only one card is open at a time per answer. Chips, card
 * and numbering are the shared `@research/ui-registry` parts the canvas uses
 * too, so the two cannot drift apart.
 */
export function AnswerClaims(props: {
	readonly claimIds: readonly string[];
	readonly claims: ReadonlyMap<string, Claim>;
	readonly evidence: ReadonlyMap<string, Evidence>;
	readonly variant?: "news" | "investigation";
	readonly notebookSaveForClaim?: (claimId: string) => MarkdownTableNotebookSave | null;
}): JSX.Element {
	const m = useMessages(citationsMessages);
	const cm = useMessages(citationMessages);
	const visibleClaimIds = createMemo(() =>
		props.variant === undefined
			? props.claimIds
			: props.claimIds.filter((id) => props.claims.get(id)?.status !== "unsupported"),
	);
	const numbering = createMemo(() =>
		numberEvidence(
			visibleClaimIds().map((claimId) => ({
				claimId,
				links: props.claims.get(claimId)?.links ?? [],
			})),
		),
	);
	const interaction = createCitationInteraction();

	const sources = createMemo(() => numbering().evidenceIdsInOrder);
	const supported = createMemo(() =>
		props.claimIds.filter((id) => props.claims.get(id)?.status === "supported"),
	);
	const summary = createMemo(() => supported().slice(0, 1));
	const conclusion = createMemo(() =>
		supported()
			.slice(1)
			.filter((id) => props.claims.get(id)?.claimType === "inference")
			.slice(-1),
	);
	const sections = createMemo(() =>
		props.variant === "news"
			? [{ heading: null, ids: supported() }]
			: [
					{ heading: m().summary, ids: summary() },
					{
						heading: m().findings,
						ids: supported()
							.slice(1)
							.filter((id) => props.claims.get(id)?.claimType === "observation"),
					},
					{
						heading: m().analysis,
						ids: supported()
							.slice(1)
							.filter(
								(id) =>
									props.claims.get(id)?.claimType !== "observation" && !conclusion().includes(id),
							),
					},
					{ heading: m().conclusion, ids: conclusion() },
				],
	);
	const uncertain = createMemo(() =>
		visibleClaimIds().filter((id) => props.claims.get(id)?.status !== "supported"),
	);
	const item = (claimId: string, lead = false) => (
		<ClaimItem
			claimId={claimId}
			claims={props.claims}
			evidence={props.evidence}
			numbering={numbering()}
			interaction={interaction}
			prose={props.variant !== undefined}
			lead={lead}
			notebookSaveForClaim={props.notebookSaveForClaim}
		/>
	);
	return (
		<>
			<Show
				when={props.variant !== undefined}
				fallback={
					<>
						<h4 class="mt-2 text-xs font-semibold text-slate-700">{m().claimsInAnswer}</h4>
						<ul aria-label={m().claims} class="mt-0.5 space-y-1.5">
							<For each={props.claimIds}>{(claimId) => item(claimId)}</For>
						</ul>
					</>
				}
			>
				<div class="max-w-prose space-y-5" data-report-format={props.variant}>
					<Show when={visibleClaimIds().length === 0}>
						<p class="text-sm text-slate-700">{m().noPublishableFindings}</p>
					</Show>
					<For each={sections().filter((section) => section.ids.length > 0)}>
						{(section) => (
							<section>
								<Show when={section.heading}>
									{(heading) => (
										<h4 class="mb-2 text-sm font-semibold text-slate-900">{heading()}</h4>
									)}
								</Show>
								<ul class="space-y-4" aria-label={section.heading ?? m().findings}>
									<For each={section.ids}>
										{(id, index) => item(id, props.variant === "news" && index() === 0)}
									</For>
								</ul>
							</section>
						)}
					</For>
					<Show when={uncertain().length > 0}>
						<section>
							<h4 class="mb-2 text-sm font-semibold text-amber-900">{m().limitations}</h4>
							<ul class="space-y-3">
								<For each={uncertain()}>{(id) => item(id)}</For>
							</ul>
						</section>
					</Show>
				</div>
			</Show>
			<Show when={sources().length > 0}>
				<details class="group mt-2 text-xs">
					<DisclosureSummary class="text-slate-700">
						{cm().sourceCount(sources().length)}
					</DisclosureSummary>
					<ol aria-label={cm().sources} class="mt-1 space-y-0.5">
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
													{cm().sourceUnavailable(evidenceId)}
												</span>
											}
										>
											{(source) => (
												<>
													<Show
														when={href()}
														fallback={
															<span>
																{titleOrHost(source().title, source().sourceUrl, cm())}{" "}
																<span class="italic text-slate-600">{cm().linkUnavailable}</span>
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
																{titleOrHost(source().title, source().sourceUrl, cm())}
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
