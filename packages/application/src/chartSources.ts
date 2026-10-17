import type { Evidence } from "@research/contracts";
import type { ResearchRecordRepository } from "./ports.ts";

/**
 * ADR-0026: a `chart` widget carries copies of the evidence it cites, and a
 * copy is only accepted when it equals the owner's stored record with that
 * id — so no client or agent can attach a made-up source to a number.
 *
 * Only copies that are not already, unchanged, in the stored version are
 * looked up, all in one batched query; an ordinary save (a move, a resize, a
 * text edit) looks up nothing.
 */

interface ChartLike {
	readonly type: string;
	readonly title: string;
	readonly sources?: readonly Evidence[];
}

/** One string per record, independent of key order, for equality. */
function canonical(record: Evidence): string {
	return JSON.stringify(
		Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}

function copiesOf(widgets: readonly ChartLike[]): readonly {
	readonly title: string;
	readonly copy: Evidence;
}[] {
	return widgets.flatMap((widget) =>
		widget.type === "chart"
			? (widget.sources ?? []).map((copy) => ({ title: widget.title, copy }))
			: [],
	);
}

/**
 * Null when every source copy in `next` is either unchanged from `previous`
 * or equal to the owner's stored record; otherwise one sentence naming the
 * first chart whose copy is not.
 */
export async function chartSourceProblem(
	records: Pick<ResearchRecordRepository, "resolve">,
	ownerId: string,
	next: readonly ChartLike[],
	previous: readonly ChartLike[],
): Promise<string | null> {
	const accepted = new Set(copiesOf(previous).map(({ copy }) => canonical(copy)));
	const pending = copiesOf(next).filter(({ copy }) => !accepted.has(canonical(copy)));
	if (pending.length === 0) return null;
	const resolved = await records.resolve(ownerId, {
		datasetIds: [],
		evidenceIds: [...new Set(pending.map(({ copy }) => copy.evidenceId))],
		claimIds: [],
	});
	const stored = new Map(
		resolved.evidence.map((record) => [record.evidenceId, canonical(record)] as const),
	);
	const mismatch = pending.find(({ copy }) => stored.get(copy.evidenceId) !== canonical(copy));
	return mismatch === undefined
		? null
		: `Chart "${mismatch.title}" cites a source that is not one of your records; add the chart again from the conversation that found it.`;
}
