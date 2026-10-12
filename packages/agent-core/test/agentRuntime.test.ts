import { agentDescriptorSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createAgentRegistry } from "../src/agentRuntime.ts";
import { fakeRuntime } from "./support.ts";

describe("createAgentRegistry (ARCH-006 / FR-012)", () => {
	it("returns registered runtimes by id, in registration order", () => {
		const opencode = fakeRuntime("opencode");
		const codex = fakeRuntime("codex");
		const registry = createAgentRegistry([opencode, codex]);
		expect(registry.ids()).toEqual(["opencode", "codex"]);
		expect(registry.get("opencode")).toBe(opencode);
		expect(registry.get("codex")).toBe(codex);
	});

	it("returns undefined for an unknown backend instead of falling back to another", () => {
		const registry = createAgentRegistry([fakeRuntime("opencode")]);
		expect(registry.get("openrouter")).toBeUndefined();
		expect(registry.get("")).toBeUndefined();
		expect(registry.get("constructor")).toBeUndefined();
		expect(registry.get("__proto__")).toBeUndefined();
	});

	it("throws on duplicate agent ids", () => {
		expect(() => createAgentRegistry([fakeRuntime("codex"), fakeRuntime("codex")])).toThrow(
			'duplicate agent id "codex"',
		);
	});

	it("accepts an empty registry", async () => {
		const registry = createAgentRegistry([]);
		expect(registry.ids()).toEqual([]);
		await expect(registry.describeAll()).resolves.toEqual([]);
	});

	it("registers a new backend without touching the existing ones (FR-013)", async () => {
		const baseline = [fakeRuntime("opencode"), fakeRuntime("codex")];
		const before = await createAgentRegistry(baseline).describeAll();
		const extended = createAgentRegistry([...baseline, fakeRuntime("local-llm")]);
		const after = await extended.describeAll();
		expect(after.slice(0, 2)).toEqual(before);
		expect(after[2]?.agentId).toBe("local-llm");
	});

	it("does not let later mutation of the input list change the registry", () => {
		const runtimes = [fakeRuntime("opencode")];
		const registry = createAgentRegistry(runtimes);
		runtimes.push(fakeRuntime("codex"));
		expect(registry.ids()).toEqual(["opencode"]);
		expect(registry.get("codex")).toBeUndefined();
	});
});

describe("AgentRegistry.describeAll", () => {
	it("combines static metadata with each runtime's probe", async () => {
		const registry = createAgentRegistry([
			fakeRuntime("claude-code", {
				displayName: "Claude Code",
				costModel: "plan-limited",
				toolIsolation: "enforced",
				probe: async () => ({
					capabilities: { supported: ["stream", "cancel"], model: "some-model" },
					availability: { status: "available" },
				}),
			}),
			fakeRuntime("openrouter", {
				displayName: "OpenRouter",
				costModel: "metered",
				toolIsolation: "enforced",
				probe: async () => ({
					capabilities: { supported: ["stream", "tool-calls"] },
					availability: {
						status: "unavailable",
						reasonCode: "NOT_CONFIGURED",
						detail: "OPENROUTER_API_KEY is not set",
					},
				}),
			}),
		]);
		expect(await registry.describeAll()).toEqual([
			{
				agentId: "claude-code",
				displayName: "Claude Code",
				capabilities: { supported: ["stream", "cancel"], model: "some-model" },
				costModel: "plan-limited",
				toolIsolation: "enforced",
				availability: { status: "available" },
			},
			{
				agentId: "openrouter",
				displayName: "OpenRouter",
				capabilities: { supported: ["stream", "tool-calls"] },
				costModel: "metered",
				toolIsolation: "enforced",
				availability: {
					status: "unavailable",
					reasonCode: "NOT_CONFIGURED",
					detail: "OPENROUTER_API_KEY is not set",
				},
			},
		]);
	});

	it("surfaces an unavailable backend honestly rather than hiding it", async () => {
		const registry = createAgentRegistry([
			fakeRuntime("codex", {
				probe: async () => ({
					capabilities: { supported: [] },
					availability: {
						status: "unavailable",
						reasonCode: "NOT_INSTALLED",
						detail: "not on PATH",
					},
				}),
			}),
		]);
		const [descriptor] = await registry.describeAll();
		expect(descriptor?.availability).toEqual({
			status: "unavailable",
			reasonCode: "NOT_INSTALLED",
			detail: "not on PATH",
		});
		expect(descriptor?.capabilities.supported).toEqual([]);
	});

	it("produces descriptors that satisfy the shared contract", async () => {
		const registry = createAgentRegistry([fakeRuntime("opencode"), fakeRuntime("codex")]);
		for (const descriptor of await registry.describeAll()) {
			expect(agentDescriptorSchema.safeParse(descriptor).success).toBe(true);
		}
	});

	it("probes each runtime once per call and never runs a model turn", async () => {
		let probes = 0;
		let runs = 0;
		const registry = createAgentRegistry([
			fakeRuntime("opencode", {
				probe: async () => {
					probes += 1;
					return { capabilities: { supported: [] }, availability: { status: "available" } };
				},
				async *run() {
					runs += 1;
					yield { type: "completed" };
				},
			}),
		]);
		await registry.describeAll();
		await registry.describeAll();
		expect(probes).toBe(2);
		expect(runs).toBe(0);
	});
});
