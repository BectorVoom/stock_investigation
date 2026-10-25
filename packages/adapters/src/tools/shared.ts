/**
 * Helpers every research tool shares: evidence construction, bounded model
 * text and failure translation. Tool output is data for the
 * model and the verifier; nothing in here interprets retrieved content.
 */
import type { CollectedEvidence, ToolFailure } from "@research/agent-core";
import { type Hasher, type SafeFetchError, upstreamStatusOf } from "@research/application";
import type { Evidence } from "@research/contracts";
import { truncateText } from "@research/domain";

export { truncateText };

/** UTF-8 byte ceiling for `ToolOutput.modelText` per call. */
export const MAX_MODEL_TEXT_BYTES = 6_000;
export const MAX_EXCERPT_CHARS = 500;
export const MAX_TITLE_CHARS = 300;
export const MAX_RETRIEVED_TEXT_CHARS = 20_000;

const TRUNCATION_NOTE = "[output truncated]";
const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
	return encoder.encode(text).byteLength;
}

function cutToBytes(text: string, maxBytes: number): string {
	let kept = "";
	let usedBytes = 0;
	for (const character of text) {
		const characterBytes = utf8Bytes(character);
		if (usedBytes + characterBytes > maxBytes) break;
		kept += character;
		usedBytes += characterBytes;
	}
	return kept;
}

/**
 * Joins lines into model text of at most `MAX_MODEL_TEXT_BYTES` UTF-8 bytes.
 * The first line that does not fit is cut, later lines are dropped, and the
 * model is told that it happened.
 */
export function boundModelText(lines: readonly string[]): string {
	const budgetBytes = MAX_MODEL_TEXT_BYTES - utf8Bytes(`\n${TRUNCATION_NOTE}`);
	const kept: string[] = [];
	let usedBytes = 0;
	for (const line of lines) {
		const lineBytes = utf8Bytes(line) + 1;
		if (usedBytes + lineBytes <= budgetBytes) {
			kept.push(line);
			usedBytes += lineBytes;
			continue;
		}
		const partial = cutToBytes(line, budgetBytes - usedBytes - 1);
		if (partial !== "") kept.push(partial);
		kept.push(TRUNCATION_NOTE);
		break;
	}
	return kept.join("\n");
}

export interface EvidenceInput {
	readonly evidenceId: string;
	readonly sourceUrl: string;
	readonly title: string;
	readonly publisher: string;
	readonly publishedAt: string | null;
	readonly retrievedAt: string;
	readonly effectiveAt: string | null;
	readonly sourceClass: Evidence["sourceClass"];
	/** Text kept in memory for quote/number verification; hashed into the checksum. */
	readonly retrievedText: string;
	/**
	 * Whether a verbatim passage of this evidence may be stored (DATA-010): true
	 * for sources licensed for short excerpts and for public-domain government
	 * data, false for headline-and-link-only sources and wherever the terms are
	 * unknown. Stated by every caller; there is deliberately no default.
	 */
	readonly retainQuotes: boolean;
	/** Excerpt to store. Dropped when `retainQuotes` is false, whatever is passed here. */
	readonly excerpt: string | null;
}

/**
 * Builds one evidence record. Invariant relied on by verification:
 * `checksum === sha256(retrievedText)`, so a later run can tell whether the
 * text a claim was checked against has changed.
 */
export async function collectEvidence(
	hasher: Hasher,
	input: EvidenceInput,
): Promise<CollectedEvidence> {
	const retrievedText = truncateText(input.retrievedText, MAX_RETRIEVED_TEXT_CHARS);
	return {
		evidence: {
			evidenceId: input.evidenceId,
			sourceUrl: input.sourceUrl,
			title: truncateText(input.title, MAX_TITLE_CHARS),
			publisher: truncateText(input.publisher, MAX_TITLE_CHARS),
			publishedAt: input.publishedAt,
			retrievedAt: input.retrievedAt,
			effectiveAt: input.effectiveAt,
			excerpt:
				input.retainQuotes && input.excerpt !== null
					? truncateText(input.excerpt, MAX_EXCERPT_CHARS)
					: null,
			checksum: await hasher.sha256Hex(retrievedText),
			sourceClass: input.sourceClass,
		},
		retrievedText,
		retainQuotes: input.retainQuotes,
	};
}

function isRetryableFetchError(error: SafeFetchError): boolean {
	if (error.code === "TIMEOUT" || error.code === "NETWORK_ERROR") return true;
	if (error.code !== "HTTP_ERROR") return false;
	return error.status === 429 || error.status >= 500;
}

/** A fetch failure as a tool failure, keeping the external service's status unchanged (§4a). */
export function fetchFailure(error: SafeFetchError): ToolFailure {
	return toolFailure(
		error.code,
		error.detail,
		isRetryableFetchError(error),
		upstreamStatusOf(error),
	);
}

/**
 * A tool failure. `upstreamStatus` is the status the external service the
 * tool called answered with, passed through unchanged; null when nothing
 * answered or the failure is the tool's own (docs/rule/error_handling.md §4a).
 */
export function toolFailure(
	code: string,
	detail: string,
	retryable = false,
	upstreamStatus: number | null = null,
): ToolFailure {
	return upstreamStatus === null
		? { code, detail, retryable }
		: { code, detail, retryable, upstreamStatus };
}
