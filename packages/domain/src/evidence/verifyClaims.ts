/**
 * Deterministic claim verification (AGT-009 / AGT-013 / DATA-001). Generation
 * output is untrusted: a citation only counts when it points at evidence this
 * run actually fetched AND the quoted passage really occurs in that evidence.
 */
export type ClaimType = "observation" | "inference" | "hypothesis" | "forecast";
export type EvidenceRelation = "supports" | "contradicts" | "context";
export type ClaimStatus = "supported" | "unsupported" | "conflicting";

export interface DraftEvidenceLink {
	readonly evidenceId: string;
	readonly relation: EvidenceRelation;
	/** Verbatim passage the claim relies on; null for a link with no quoted passage. */
	readonly quote: string | null;
}

export interface DraftClaim {
	readonly claimId: string;
	readonly text: string;
	readonly claimType: ClaimType;
	readonly links: readonly DraftEvidenceLink[];
}

export interface EvidenceText {
	readonly evidenceId: string;
	/** Text the run retrieved for this evidence (title plus permitted excerpt). */
	readonly retrievedText: string;
}

export type ClaimIssue =
	| { readonly code: "UNKNOWN_EVIDENCE"; readonly evidenceId: string }
	| { readonly code: "QUOTE_NOT_FOUND"; readonly evidenceId: string }
	| { readonly code: "QUOTE_TOO_SHORT"; readonly evidenceId: string }
	| { readonly code: "MISSING_QUOTE"; readonly evidenceId: string }
	| { readonly code: "NUMBER_NOT_IN_EVIDENCE"; readonly numberText: string }
	| { readonly code: "NO_SUPPORTING_EVIDENCE" }
	/** Deterministic checks passed, but no independent verdict confirmed the claim. */
	| { readonly code: "NOT_INDEPENDENTLY_VERIFIED" };

export interface VerifiedClaim {
	readonly claimId: string;
	readonly text: string;
	readonly claimType: ClaimType;
	readonly status: ClaimStatus;
	/** Only links that passed verification; rejected ones appear in `issues`. */
	readonly links: readonly DraftEvidenceLink[];
	readonly issues: readonly ClaimIssue[];
}

/**
 * A supporting or contradicting quote must be long enough to be a passage. A
 * word or two occurs in almost any article and would "verify" anything.
 */
export const MIN_QUOTE_LENGTH = 12;

function normalizeForMatch(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether `quote` is a passage of `retrievedText`: long enough to be a passage
 * and present verbatim, ignoring case and whitespace differences.
 */
export function isPassageOf(quote: string, retrievedText: string): boolean {
	const normalized = normalizeForMatch(quote);
	return (
		normalized.length >= MIN_QUOTE_LENGTH && normalizeForMatch(retrievedText).includes(normalized)
	);
}

/** Whether `text` mentions `phrase`, ignoring case and whitespace differences. */
export function mentions(text: string, phrase: string): boolean {
	const normalized = normalizeForMatch(phrase);
	return normalized !== "" && normalizeForMatch(text).includes(normalized);
}

/** Numeric tokens with thousands separators removed, e.g. "1,234.5%" -> "1234.5". */
export function extractNumberTokens(text: string): readonly string[] {
	const matches = text.normalize("NFKC").match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
	return matches.map((token) => token.replace(/,/g, ""));
}

function verifyLink(
	link: DraftEvidenceLink,
	evidenceById: ReadonlyMap<string, string>,
): ClaimIssue | null {
	const retrieved = evidenceById.get(link.evidenceId);
	if (retrieved === undefined) return { code: "UNKNOWN_EVIDENCE", evidenceId: link.evidenceId };
	if (link.quote === null || link.quote.trim() === "") {
		// Context links may point at a source as a whole; support/contradiction must quote it.
		return link.relation === "context"
			? null
			: { code: "MISSING_QUOTE", evidenceId: link.evidenceId };
	}
	const quote = normalizeForMatch(link.quote);
	if (link.relation !== "context" && quote.length < MIN_QUOTE_LENGTH) {
		return { code: "QUOTE_TOO_SHORT", evidenceId: link.evidenceId };
	}
	return retrieved.includes(quote)
		? null
		: { code: "QUOTE_NOT_FOUND", evidenceId: link.evidenceId };
}

/** Number tokens of each evidence text, computed at most once per verification pass. */
type NumberTokenIndex = Map<string, ReadonlySet<string>>;

function numberTokensOf(
	evidenceId: string,
	evidenceById: ReadonlyMap<string, string>,
	index: NumberTokenIndex,
): ReadonlySet<string> {
	let tokens = index.get(evidenceId);
	if (tokens === undefined) {
		tokens = new Set(extractNumberTokens(evidenceById.get(evidenceId) ?? ""));
		index.set(evidenceId, tokens);
	}
	return tokens;
}

function unsupportedNumbers(
	claim: DraftClaim,
	supportingLinks: readonly DraftEvidenceLink[],
	evidenceById: ReadonlyMap<string, string>,
	index: NumberTokenIndex,
): readonly ClaimIssue[] {
	// Forecasts and hypotheses legitimately state numbers no source contains yet.
	if (claim.claimType !== "observation") return [];
	const sources = supportingLinks.map((link) =>
		numberTokensOf(link.evidenceId, evidenceById, index),
	);
	return extractNumberTokens(claim.text)
		.filter((token) => !sources.some((tokens) => tokens.has(token)))
		.map((numberText) => ({ code: "NUMBER_NOT_IN_EVIDENCE", numberText }) as const);
}

/**
 * @param numberTokenIndex cache shared across the claims of one pass, so each
 *   evidence text is scanned for numbers once however many claims cite it.
 */
export function verifyClaim(
	claim: DraftClaim,
	evidenceById: ReadonlyMap<string, string>,
	numberTokenIndex: Map<string, ReadonlySet<string>> = new Map(),
): VerifiedClaim {
	const issues: ClaimIssue[] = [];
	const validLinks: DraftEvidenceLink[] = [];
	for (const link of claim.links) {
		const issue = verifyLink(link, evidenceById);
		if (issue === null) validLinks.push(link);
		else issues.push(issue);
	}
	const supporting = validLinks.filter((link) => link.relation === "supports");
	const contradicting = validLinks.filter((link) => link.relation === "contradicts");
	const numberIssues = unsupportedNumbers(claim, supporting, evidenceById, numberTokenIndex);
	issues.push(...numberIssues);
	if (supporting.length === 0) issues.push({ code: "NO_SUPPORTING_EVIDENCE" });

	let status: ClaimStatus;
	if (supporting.length === 0 || numberIssues.length > 0) status = "unsupported";
	else if (contradicting.length > 0) status = "conflicting";
	else status = "supported";
	return {
		claimId: claim.claimId,
		text: claim.text,
		claimType: claim.claimType,
		status,
		links: validLinks,
		issues,
	};
}

/** Verifies every claim; nothing is dropped, so unsupported claims stay visible to the owner. */
export function verifyClaims(
	claims: readonly DraftClaim[],
	evidence: readonly EvidenceText[],
): readonly VerifiedClaim[] {
	const evidenceById = new Map(
		evidence.map((item) => [item.evidenceId, normalizeForMatch(item.retrievedText)]),
	);
	const numberTokenIndex: NumberTokenIndex = new Map();
	return claims.map((claim) => verifyClaim(claim, evidenceById, numberTokenIndex));
}
