/**
 * Test fixture: a runtime whose turn starts a CLI in a process group of its own (as the
 * real backends do through createNodeProcessRunner) and reports its pid in $PIDFILE.
 */
import type { AgentProbe, AgentRuntime } from "@research/agent-core";
import { createNodeProcessRunner } from "../../../packages/adapters/src/providers/processRunner.ts";
import { serveExternalAgent } from "./serve.ts";

const pidFile = process.env.PIDFILE ?? "";

const runtime: AgentRuntime = {
	agentId: "detached",
	displayName: "Detached child fixture",
	costModel: "plan-limited",
	toolIsolation: "enforced",
	async probe(): Promise<AgentProbe> {
		return { capabilities: { supported: [] }, availability: { status: "available" } };
	},
	async *run(_request, context) {
		const handle = createNodeProcessRunner().run({
			command: "sh",
			args: ["-c", `echo $$ > "${pidFile}"; exec sleep 313`],
			cwd: "/",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			signal: context.signal,
		});
		try {
			for await (const _line of handle.stdoutLines) {
				// The fixture's child prints nothing; the loop only drains until it is killed.
			}
			await handle.exit;
		} catch {
			// An aborted child is reported below.
		}
		yield { type: "failed", code: "ABORTED", retryable: false };
	},
};

await serveExternalAgent(runtime);
