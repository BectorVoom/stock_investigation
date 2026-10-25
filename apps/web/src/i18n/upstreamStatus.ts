import type { MessagesOf } from "@research/i18n";
import type { commonMessages } from "./common.messages.ts";

/**
 * How the owner sees the status an external service answered with when it
 * caused a failure (ADR-0037): the number exactly as received, as secondary
 * words after our own code or reason. With no status the text is unchanged.
 */
export type UpstreamStatusText = Pick<
	MessagesOf<typeof commonMessages>,
	"serviceAnswered" | "serviceAnsweredSentence" | "withNote" | "withSentence"
>;

/** After a code: "RATE_LIMITED, service answered HTTP 429". */
export function withUpstreamStatus(
	code: string,
	upstreamStatus: number | null,
	words: UpstreamStatusText,
): string {
	return upstreamStatus === null
		? code
		: words.withNote(code, words.serviceAnswered(upstreamStatus));
}

/** After a reason sentence: "The provider rate limit was reached. The service answered HTTP 429." */
export function reasonWithUpstreamStatus(
	reason: string,
	upstreamStatus: number | null,
	words: UpstreamStatusText,
): string {
	return upstreamStatus === null
		? reason
		: words.withSentence(reason, words.serviceAnsweredSentence(upstreamStatus));
}
