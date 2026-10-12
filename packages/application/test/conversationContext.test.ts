import type { ChatMessage } from "@research/contracts";
import { CONVERSATION_CONTEXT_LIMITS } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	buildConversationContext,
	buildConversationContextBeforeAnchor,
} from "../src/research/conversationContext.ts";

const T0 = "2026-10-11T00:00:00.000Z";

function message(overrides: Partial<ChatMessage> & { seq: number }): ChatMessage {
	const { seq, ...rest } = overrides;
	return {
		messageId: `msg_${seq}`,
		seq,
		role: "owner",
		text: `message ${seq}`,
		runId: null,
		claimIds: [],
		createdAt: T0,
		...rest,
	};
}

function current(seq: number): ChatMessage {
	return message({ seq, role: "owner", text: "current question", runId: "run_now" });
}

describe("buildConversationContext", () => {
	it("keeps the most recent eligible messages, oldest first", () => {
		const messages = [
			message({ seq: 0, text: "first" }),
			message({ seq: 1, role: "assistant", text: "second" }),
			message({ seq: 2, text: "third" }),
			current(3),
		];
		expect(buildConversationContext(messages, "run_now")).toEqual([
			{ role: "owner", text: "first" },
			{ role: "assistant", text: "second" },
			{ role: "owner", text: "third" },
		]);
	});

	it("excludes the current question and anything after it", () => {
		const messages = [
			message({ seq: 0, text: "before" }),
			current(1),
			message({ seq: 2, text: "after", runId: "run_later" }),
			message({ seq: 3, role: "assistant", text: "also after", runId: "run_later" }),
		];
		expect(buildConversationContext(messages, "run_now")).toEqual([
			{ role: "owner", text: "before" },
		]);
	});

	it("sends nothing when the current run is absent (ARCH-017)", () => {
		const messages = [message({ seq: 0, text: "older" })];
		expect(buildConversationContext(messages, "run_missing")).toEqual([]);
		expect(buildConversationContext([], "run_now")).toEqual([]);
	});

	it("skips messages that are empty after trimming", () => {
		const messages = [
			message({ seq: 0, text: "   " }),
			message({ seq: 1, text: "\n\t " }),
			message({ seq: 2, text: "kept" }),
			current(3),
		];
		expect(buildConversationContext(messages, "run_now")).toEqual([
			{ role: "owner", text: "kept" },
		]);
	});

	it("truncates each text to maxMessageChars without splitting a surrogate pair", () => {
		const long = `😀${"a".repeat(CONVERSATION_CONTEXT_LIMITS.maxMessageChars)}`;
		const messages = [message({ seq: 0, text: long }), current(1)];
		const [kept] = buildConversationContext(messages, "run_now");
		expect(kept?.text.length).toBeLessThanOrEqual(CONVERSATION_CONTEXT_LIMITS.maxMessageChars);
		expect(kept?.text.endsWith("…")).toBe(true);
		expect(kept?.text).not.toContain("�");
	});

	it("keeps at most maxMessages, preferring the newest", () => {
		const messages = Array.from({ length: CONVERSATION_CONTEXT_LIMITS.maxMessages + 3 }, (_, seq) =>
			message({ seq, text: `m${seq}` }),
		);
		const all = [...messages, current(messages.length)];
		const context = buildConversationContext(all, "run_now");
		expect(context).toHaveLength(CONVERSATION_CONTEXT_LIMITS.maxMessages);
		expect(context[0]).toEqual({ role: "owner", text: "m3" });
		expect(context.at(-1)).toEqual({ role: "owner", text: `m${messages.length - 1}` });
	});

	it("drops an overflowing message together with everything older (byte budget, Japanese)", () => {
		// Each Japanese character is 3 UTF-8 bytes; two such messages exceed 2_400 bytes
		// only when combined with a third, so size the texts to force a contiguous cut.
		const japanese = "日".repeat(300);
		const encoder = new TextEncoder();
		expect(encoder.encode(japanese).byteLength).toBe(900);
		const messages = [
			message({ seq: 0, text: "oldest, dropped with the overflow" }),
			message({ seq: 1, text: japanese }),
			message({ seq: 2, text: japanese }),
			message({ seq: 3, text: japanese }),
			current(4),
		];
		const context = buildConversationContext(messages, "run_now");
		// 3 x 900 = 2_700 > 2_400, so only the two newest fit; the oldest pair is gone.
		expect(context.map((entry) => entry.text)).toEqual([japanese, japanese]);
		for (const entry of context) {
			expect(encoder.encode(entry.text).byteLength).toBeLessThanOrEqual(
				CONVERSATION_CONTEXT_LIMITS.maxTotalBytes,
			);
		}
		const total = context.reduce((sum, entry) => sum + encoder.encode(entry.text).byteLength, 0);
		expect(total).toBeLessThanOrEqual(CONVERSATION_CONTEXT_LIMITS.maxTotalBytes);
	});

	it("orders by seq even when the input is not sorted", () => {
		const messages = [current(2), message({ seq: 0, text: "a" }), message({ seq: 1, text: "b" })];
		expect(buildConversationContext(messages, "run_now")).toEqual([
			{ role: "owner", text: "a" },
			{ role: "owner", text: "b" },
		]);
	});
});

describe("buildConversationContextBeforeAnchor", () => {
	it("sends nothing for a null anchor: imported and pre-migration jobs fail closed", () => {
		const messages = [message({ seq: 0, text: "older" })];
		expect(buildConversationContextBeforeAnchor(messages, null)).toEqual([]);
		expect(buildConversationContextBeforeAnchor([], 5)).toEqual([]);
	});

	it("keeps messages before the anchor even when later messages outnumber the window", () => {
		const before = [
			message({ seq: 0, text: "first" }),
			message({ seq: 1, role: "assistant", text: "second" }),
		];
		const later = Array.from({ length: 10 }, (_, index) =>
			message({ seq: 3 + index, text: `later ${index}` }),
		);
		const context = buildConversationContextBeforeAnchor([...before, ...later], 3);
		expect(context).toEqual([
			{ role: "owner", text: "first" },
			{ role: "assistant", text: "second" },
		]);
	});

	it("excludes the anchor message itself and bounds the tail like the run-based builder", () => {
		const messages = Array.from({ length: CONVERSATION_CONTEXT_LIMITS.maxMessages + 3 }, (_, seq) =>
			message({ seq, text: `m${seq}` }),
		);
		const context = buildConversationContextBeforeAnchor(messages, messages.length);
		expect(context).toHaveLength(CONVERSATION_CONTEXT_LIMITS.maxMessages);
		expect(context[0]).toEqual({ role: "owner", text: "m3" });
	});

	it("orders by seq even when the input is not sorted", () => {
		const messages = [message({ seq: 2, text: "c" }), message({ seq: 0, text: "a" })];
		expect(buildConversationContextBeforeAnchor(messages, 5)).toEqual([
			{ role: "owner", text: "a" },
			{ role: "owner", text: "c" },
		]);
	});
});
