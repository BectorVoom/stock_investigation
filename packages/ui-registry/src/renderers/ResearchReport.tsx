import type { ResearchReportProps } from "@research/contracts";
import { createMemo, For, type JSX, Show } from "solid-js";
import { ClaimStatusBadge, ClaimTypeBadge } from "../parts/Badges.tsx";
import {
	CitationScope,
	ComponentCitation,
	citationGroupFocusOut,
	useCitationScope,
} from "../parts/citations.tsx";
import { DateText } from "../parts/SourceLinks.tsx";
import { EmptyState } from "../parts/states.tsx";
import type { RendererProps } from "../registry.tsx";

type Statement = ResearchReportProps["sections"][number]["statements"][number];

/** A stored claim's verification result; exists only when the statement names a claim. */
interface VerifiedClaim {
	readonly claimId: string;
	readonly claimType: NonNullable<Statement["claimType"]>;
	readonly status: NonNullable<Statement["status"]>;
}

/**
 * A badge is shown only for a statement backed by a stored claim, whose type
 * and status the server checked against that claim. A statement without a
 * claim id is a free-form note: it gets no badge, whatever else its props say.
 */
function verifiedClaim(statement: Statement): VerifiedClaim | null {
	const { claimId, claimType, status } = statement;
	return claimId === null || claimType === null || status === null
		? null
		: { claimId, claimType, status };
}

function StatementItem(props: {
	readonly statement: Statement;
	readonly groupKey: string;
	readonly sources: RendererProps<ResearchReportProps>["context"]["sources"];
}): JSX.Element {
	const claim = createMemo(() => verifiedClaim(props.statement));
	const status = () => claim()?.status ?? null;
	const scope = useCitationScope();
	const hoverEnd = () => scope?.hoverEnd();
	const uniqueSourceIds = createMemo(() => [...new Set(props.statement.sourceIds)]);
	return (
		<li
			data-statement-kind={claim() === null ? "note" : "claim"}
			data-claim-id={claim()?.claimId}
			data-citation-group={props.groupKey}
			class="relative border-l-2 pl-2"
			classList={{
				"border-emerald-600": status() === "supported",
				"border-red-600": status() === "unsupported",
				"border-amber-600": status() === "conflicting",
				"border-dashed border-slate-400": status() === null,
			}}
			onMouseLeave={hoverEnd}
			onFocusOut={(event) => citationGroupFocusOut(event, hoverEnd)}
		>
			<p class="text-sm text-slate-900">{props.statement.text}</p>
			<Show
				when={claim()}
				fallback={
					<p
						data-unverified-note="true"
						class="mt-0.5 inline-block rounded border border-dashed border-slate-500 px-1.5 py-px text-2xs font-medium leading-4 text-slate-800"
					>
						Unverified note — not checked against stored evidence
					</p>
				}
			>
				{(verified) => (
					<p class="mt-0.5 flex flex-wrap gap-1">
						<ClaimTypeBadge claimType={verified().claimType} />
						<ClaimStatusBadge status={verified().status} />
					</p>
				)}
			</Show>
			<Show
				when={uniqueSourceIds().length > 0}
				fallback={
					<p data-no-sources="true" class="mt-0.5 text-xs italic text-amber-900">
						No sources cited for this statement.
					</p>
				}
			>
				<p class="mt-0.5 flex flex-wrap items-center gap-1">
					<For each={uniqueSourceIds()}>
						{(sourceId) => (
							<ComponentCitation
								sourceId={sourceId}
								chipKey={`${props.groupKey}::${sourceId}`}
								sources={props.sources}
							/>
						)}
					</For>
				</p>
			</Show>
		</li>
	);
}

export function ResearchReport(props: RendererProps<ResearchReportProps>): JSX.Element {
	// The component's distinct source ids in order of first appearance: the
	// same source keeps one number in every statement of the report.
	const sourceIdsInOrder = createMemo(() =>
		props.props.sections.flatMap((section) =>
			section.statements.flatMap((statement) => statement.sourceIds),
		),
	);
	return (
		<CitationScope sourceIdsInOrder={sourceIdsInOrder()}>
			<div>
				<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
				<p class="text-xs text-slate-700">
					Generated <DateText iso={props.props.generatedAt} missing="date not stated" />
					{" · "}
					<span data-field="data-cutoff">
						Data cut-off: <DateText iso={props.props.dataCutoffAt} missing="date not stated" /> —
						nothing retrieved after this date informed the report.
					</span>
				</p>
				<For each={props.props.sections}>
					{(section, sectionIndex) => (
						<section class="mt-2">
							<h4 class="text-sm font-semibold text-slate-800">{section.heading}</h4>
							<Show
								when={section.statements.length > 0}
								fallback={<EmptyState>No statements in this section.</EmptyState>}
							>
								<ul class="mt-1 space-y-2">
									<For each={section.statements}>
										{(statement, statementIndex) => (
											<StatementItem
												statement={statement}
												groupKey={`${props.componentId}::s${sectionIndex()}::${statementIndex()}`}
												sources={props.context.sources}
											/>
										)}
									</For>
								</ul>
							</Show>
						</section>
					)}
				</For>
				<p
					role="note"
					data-field="disclaimer"
					class="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-700"
				>
					{props.props.disclaimer}
				</p>
			</div>
		</CitationScope>
	);
}
