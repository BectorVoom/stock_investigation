import { parseUrl } from "@research/domain";
import type { MessagesOf } from "@research/i18n";
import type { citationMessages } from "./citations.messages.ts";
/**
 * Numbering for NotebookLM-style citation chips in one scope (one chat answer
 * or one canvas component).
 *
 * Numbers are per scope: the distinct evidence ids in order of first
 * appearance, starting at 1; the same evidence always gets the same number
 * within the scope. Pure over ids, so unit-testable without Solid.
 */

export interface ClaimLinksInput {
	readonly claimId: string;
	readonly links: readonly { readonly evidenceId: string }[];
}

export interface CitationNumbering {
	/** Evidence id -> 1-based number, in order of first appearance. */
	readonly numberByEvidenceId: ReadonlyMap<string, number>;
	/** Evidence ids of the scope in number order (index 0 is source 1). */
	readonly evidenceIdsInOrder: readonly string[];
}

/** Assigns per-scope citation numbers over the claims in display order. */
export function numberEvidence(claims: readonly ClaimLinksInput[]): CitationNumbering {
	const numberByEvidenceId = new Map<string, number>();
	const evidenceIdsInOrder: string[] = [];
	for (const claim of claims) {
		for (const link of claim.links) {
			if (!numberByEvidenceId.has(link.evidenceId)) {
				numberByEvidenceId.set(link.evidenceId, evidenceIdsInOrder.length + 1);
				evidenceIdsInOrder.push(link.evidenceId);
			}
		}
	}
	return { numberByEvidenceId, evidenceIdsInOrder };
}

/** The chip numbers for one claim's links, in link order. Unknown ids are skipped. */
export function numbersForClaim(
	claim: ClaimLinksInput,
	numbering: CitationNumbering,
): readonly number[] {
	const numbers: number[] = [];
	for (const link of claim.links) {
		const number = numbering.numberByEvidenceId.get(link.evidenceId);
		if (number !== undefined) numbers.push(number);
	}
	return numbers;
}

/** Host of a source URL for the card and sources row; null when unparseable. */
export function sourceHost(sourceUrl: string): string | null {
	const hostname = parseUrl(sourceUrl)?.hostname ?? "";
	return hostname === "" ? null : hostname;
}

type CitationText = MessagesOf<typeof citationMessages>;

/**
 * Title with host fallback for accessible names and the sources row. `text`
 * is the current language's citation words (English when omitted).
 */
export function titleOrHost(title: string, sourceUrl: string, text: CitationText): string {
	const trimmed = title.trim();
	if (trimmed !== "") return trimmed;
	return sourceHost(sourceUrl) ?? text.untitledSource;
}

/** Accessible name of a chip button: "Source N: <title or host>". */
export function chipLabel(
	number: number,
	title: string,
	sourceUrl: string,
	text: CitationText,
): string {
	return text.chipLabel(number, titleOrHost(title, sourceUrl, text));
}
