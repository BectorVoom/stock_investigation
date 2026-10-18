/** FR-013: serve a TypeScript AgentRuntime as a protocol-1 JSON Lines process. */
import { once } from "node:events";
import type { AgentRuntime } from "@research/agent-core";
import { type AgentEvent, agentEventSchema, agentRequestSchema } from "@research/contracts";
import { z } from "zod";

const envelopeSchema = z.strictObject({
	protocol: z.literal(1),
	request: agentRequestSchema,
	context: z.strictObject({
		scratchDirectory: z.string().nullable(),
		model: z.string().nullable(),
		effort: z.enum(["low", "medium", "high"]),
	}),
});

/** Time the wrapped runtime gets to clean up its children after SIGTERM (< runner's 2 s grace). */
const ABORT_GRACE_MS = 1500;

async function write(value: unknown): Promise<void> {
	if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, "drain");
}

function endsInHighSurrogate(text: string): boolean {
	const code = text.charCodeAt(text.length - 1);
	return code >= 0xd800 && code <= 0xdbff;
}

/** Replaces genuinely unpaired surrogates after adjacent deltas have been coalesced. */
function wellFormed(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"�",
	);
}

/**
 * Call from a tiny executable module after constructing any AgentRuntime.
 * Protocol data is stdout only. Provider failures expose a fixed code.
 */
export async function serveExternalAgent(runtime: AgentRuntime): Promise<void> {
	const mode = process.argv.at(-1);
	if (mode === "probe") {
		const probe = await runtime.probe();
		await write({
			protocol: 1,
			capabilities: probe.capabilities,
			availability: probe.availability,
		});
		return;
	}
	if (mode !== "run") {
		process.exitCode = 2;
		return;
	}
	let terminal = false;
	let pending = "";
	// Cancellation protocol: the runner sends SIGTERM to this process's group (and SIGKILL
	// after its grace period). A wrapped runtime may have started CLIs in groups of their own
	// (createNodeProcessRunner is detached), which that signal does not reach, so SIGTERM
	// aborts the runtime's signal: its generator's finally blocks terminate those groups.
	// The bounded timer guarantees exit even when the runtime ignores the abort.
	const controller = new AbortController();
	process.once("SIGTERM", () => {
		controller.abort();
		setTimeout(() => process.exit(143), ABORT_GRACE_MS).unref();
	});
	const emit = async (event: AgentEvent): Promise<void> => {
		if (event.type === "text.delta") {
			pending += event.text;
			if (endsInHighSurrogate(pending)) return;
			await write({ type: "text.delta", text: wellFormed(pending) });
			pending = "";
			return;
		}
		if (pending !== "") {
			await write({ type: "text.delta", text: wellFormed(pending) });
			pending = "";
		}
		await write(event);
	};
	try {
		let stdin = "";
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) {
			if (typeof chunk !== "string") throw new TypeError("stdin chunk");
			stdin += chunk;
		}
		const envelope = envelopeSchema.parse(JSON.parse(stdin));
		for await (const raw of runtime.run(envelope.request, {
			...envelope.context,
			signal: controller.signal,
		})) {
			const event = agentEventSchema.parse(raw);
			await emit(event);
			if (event.type === "completed" || event.type === "failed") {
				terminal = true;
				break;
			}
		}
	} catch {
		// This is the process protocol's error boundary: never echo prompts or exceptions.
		if (!terminal) await emit({ type: "failed", code: "PROVIDER_ERROR", retryable: false });
		terminal = true;
	}
	if (!terminal) await emit({ type: "failed", code: "PROVIDER_OUTPUT_INVALID", retryable: false });
}
