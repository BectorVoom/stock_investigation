import type { Claim, Evidence } from "@research/contracts";
import {
	ClaimStatusBadge,
	ClaimTypeBadge,
	citationGroupFocusOut,
	CitationChip,
	createCitationInteraction,
	type CitationInteraction,
	type CitationNumbering,
	numberEvidence,
	numbersForClaim,
	chipLabel,
	SourceCard,
	sourceHost,
	titleOrHost,
	safeHttpsUrl,
} from "@research/ui-registry";
import { createMemo, For, type JSX, Show } from "solid-js";
import { DisclosureSummary } from "../components/ui.tsx";

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
}): JSX.Element {
	const claim = createMemo(() => props.claims.get(props.claimId));
	const numbers = createMemo(() => {
		const current = claim();
		if (current === undefined) return [] as const;
		return numbersForClaim({ claimId: current.claimId, links: current.links }, props.numbering);
	});
	const openCard = createMemo(() => {
		const key = props.interaction.openKey();
		if (key === null) return null;
		const current = claim();
		if (current === undefined) return null;
		const link = current.links.find((entry) => cardKey(current.claimId, entry.evidenceId) === key);
		if (link === undefined) return null;
		const number = props.numbering.numberByEvidenceId.get(link.evidenceId);
		if (number === undefined) return null;
		return { key, link, number };
	});
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
						onMouseLeave={() => props.interaction.hoverEnd()}
						onFocusOut={(event) => citationGroupFocusOut(event, props.interaction.hoverEnd)}
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
											<CitationChip
												chipKey={key()}
												number={number() ?? 0}
												label={
													item() === undefined
														? `Source ${number() ?? 0}: unavailable`
														: chipLabel(number() ?? 0, item()?.title ?? "", item()?.sourceUrl ?? "")
												}
												relation={link.relation}
												open={props.interaction.openKey() === key()}
												interaction={props.interaction}
											/>
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
}): JSX.Element {
	const numbering = createMemo(() =>
		numberEvidence(
			props.claimIds.map((claimId) => ({
				claimId,
				links: props.claims.get(claimId)?.links ?? [],
			})),
		),
	);
	const interaction = createCitationInteraction();

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
							interaction={interaction}
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
