import {
	type ChatMessage,
	CONVERSATION_CONTEXT_LIMITS,
	type ConversationContextMessage,
} from "@research/contracts";
import { recentCountWithinBudget, truncateText } from "@research/domain";

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
	return encoder.encode(text).byteLength;
}

/**
 * Pure slice of earlier conversation a research job carries (ARCH-002/003).
 *
 * Input is stored chat messages in any order; output is the bounded context for
 * the run, oldest first. The message that belongs to `currentRunId` and
 * anything after it (by `seq`) is dropped, so the current question is never
 * echoed back. Each remaining text is trimmed, skipped when empty, cut to
 * `maxMessageChars` without splitting a surrogate pair, then the most recent
 * ones that fit `maxTotalBytes` and `maxMessages` (via
 * `recentCountWithinBudget`) are kept contiguously. When `currentRunId` is
 * absent the answer is empty: when in doubt, send nothing (ARCH-017).
 */
export function buildConversationContext(
	messages: readonly ChatMessage[],
	currentRunId: string,
): ConversationContextMessage[] {
	const ordered = [...messages].sort((a, b) => a.seq - b.seq);
	const currentSeqs = ordered.filter((message) => message.runId === currentRunId);
	if (currentSeqs.length === 0) return [];
	let cutoff = currentSeqs[0]?.seq ?? 0;
	for (const message of currentSeqs) {
		if (message.seq < cutoff) cutoff = message.seq;
	}
	return boundedTail(ordered.filter((message) => message.seq < cutoff));
}

/**
 * Context for a run from its stable anchor: the `seq` of the owner message
 * that asked it. Callers pass messages already limited to `seq < anchorSeq`
 * (one bounded query with `beforeSeq`); this trims, cuts and budgets them like
 * above. A null anchor (news-ingest, imported or pre-migration rows) yields an
 * empty context: when in doubt, send nothing (ARCH-017).
 */
export function buildConversationContextBeforeAnchor(
	messages: readonly ChatMessage[],
	anchorSeq: number | null,
): ConversationContextMessage[] {
	if (anchorSeq === null) return [];
	return boundedTail([...messages].filter((message) => message.seq < anchorSeq));
}

/** Trims, cuts and budgets eligible messages, oldest first (shared tail). */
function boundedTail(eligible: readonly ChatMessage[]): ConversationContextMessage[] {
	// Terminates: one sort plus one pass; the budget walk is inside
	// `recentCountWithinBudget` (single backwards scan).
	const ordered = [...eligible].sort((a, b) => a.seq - b.seq);
	const truncated: ConversationContextMessage[] = [];
	for (const message of ordered) {
		const trimmed = message.text.trim();
		if (trimmed === "") continue;
		truncated.push({
			role: message.role,
			text: truncateText(trimmed, CONVERSATION_CONTEXT_LIMITS.maxMessageChars),
		});
	}
	const sizes = truncated.map((entry) => utf8Bytes(entry.text));
	const keep = recentCountWithinBudget(
		sizes,
		CONVERSATION_CONTEXT_LIMITS.maxTotalBytes,
		CONVERSATION_CONTEXT_LIMITS.maxMessages,
	);
	return truncated.slice(truncated.length - keep);
}
