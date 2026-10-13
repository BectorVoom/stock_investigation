import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	applyDashboardEdit,
	applyUiCommand,
	type CommandContext,
	checkBudget,
	checkLease,
	classifyReportedPositionChange,
	decideClaim,
	emptyWorkspaceState,
	isLeasedJobState,
	isTerminalJobState,
	JOB_STATES,
	JOB_TRANSITIONS,
	NO_REFERENCES,
	rateWindowPermit,
	recentCountWithinBudget,
	transitionJob,
	type UiCommand,
	verifyClaim,
	type WorkspaceState,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between the TypeScript domain and the Lean 4 models in `formal/`.
 *
 * The theorems in `formal/ResearchFormal/*.lean` are about Lean definitions,
 * not about this TypeScript. What connects them is `formal/vectors.json`:
 * the Lean executable `export-vectors` evaluates the *verified* definitions
 * over exhaustive small grids, and every vector is replayed here against the
 * implementation. A divergence between model and code fails this suite.
 */
const jobState = z.enum(JOB_STATES);
const operation = z.discriminatedUnion("op", [
	z.object({ op: z.literal("create"), id: z.number() }),
	z.object({ op: z.literal("remove"), id: z.number() }),
	z.object({ op: z.literal("reorder"), order: z.array(z.number()) }),
	z.object({ op: z.literal("touch"), id: z.number() }),
]);
const quad = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const vectorsSchema = z.object({
	leanVersion: z.string(),
	states: z.array(jobState),
	terminalStates: z.array(jobState),
	leasedStates: z.array(jobState),
	transitions: z.record(jobState, z.array(jobState)),
	decideClaim: z.array(
		z.object({
			state: jobState,
			attempt: z.number(),
			maxAttempts: z.number(),
			leaseExpired: z.boolean(),
			cancelRequested: z.boolean(),
			leaseGeneration: z.number(),
			decision: z.unknown(),
		}),
	),
	checkLease: z.array(
		z.object({
			state: jobState,
			leaseOwner: z.number().nullable(),
			leaseGeneration: z.number(),
			runner: z.number(),
			proofGeneration: z.number(),
			result: z.string(),
		}),
	),
	budget: z.object({
		limits: z.object({
			maxAgentSteps: z.number(),
			maxToolCalls: z.number(),
			maxWallClockMs: z.number(),
			maxInputBytes: z.number(),
			maxSpendUsd: z.number(),
		}),
		vectors: z.array(
			z.object({ usage: quad, elapsedMs: z.number(), next: quad, limit: z.string().nullable() }),
		),
	}),
	positionChange: z.array(
		z.object({ previous: z.number(), current: z.number(), change: z.string() }),
	),
	claimStatus: z.array(
		z.object({
			supports: z.number(),
			contradicts: z.number(),
			unsupportedNumbers: z.number(),
			status: z.string(),
		}),
	),
	commandGuard: z.array(
		z.object({
			setup: z.array(operation),
			operation,
			expectedVersion: z.number(),
			accepted: z.boolean(),
			version: z.number(),
			replayAccepted: z.boolean(),
		}),
	),
	dashboard: z.array(
		z.object({
			dashboard: z.array(z.number()),
			edit: z.object({ kind: z.string(), id: z.number(), toIndex: z.number().optional() }),
			accepted: z.boolean(),
			ids: z.array(z.number()),
		}),
	),
	ratePermit: z.array(
		z.object({
			grants: z.array(z.number()),
			now: z.number(),
			maxPer: z.number(),
			window: z.number(),
			allowed: z.boolean(),
			retryAfter: z.number().nullable(),
		}),
	),
	rateRecord: z.array(
		z.object({
			times: z.array(z.number()),
			maxPer: z.number(),
			window: z.number(),
			recorded: z.array(z.number()),
		}),
	),
	workspace: z.array(
		z.object({
			operations: z.array(operation),
			version: z.number(),
			components: z.array(z.number()),
			order: z.array(z.number()),
		}),
	),
	recentWithinBudget: z.array(
		z.object({
			sizes: z.array(z.number()),
			budget: z.number(),
			maxItems: z.number(),
			count: z.number(),
		}),
	),
});

const vectors = vectorsSchema.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

const NOW_MS = Date.parse("2026-10-11T00:00:00.000Z");
const PAST = "2026-10-10T23:59:00.000Z";
const FUTURE = "2026-10-11T00:01:00.000Z";

describe("Lean model conformance: job state machine", () => {
	it("has the same states, terminal states and leased states", () => {
		expect([...JOB_STATES]).toEqual(vectors.states);
		expect(JOB_STATES.filter(isTerminalJobState)).toEqual(vectors.terminalStates);
		expect(JOB_STATES.filter(isLeasedJobState)).toEqual(vectors.leasedStates);
	});

	it("has exactly the verified transition matrix", () => {
		expect(JOB_TRANSITIONS).toEqual(vectors.transitions);
	});
});

describe("Lean model conformance: leases", () => {
	it(`agrees with decideClaim on all ${vectors.decideClaim.length} vectors`, () => {
		expect(vectors.decideClaim.length).toBeGreaterThan(500);
		for (const vector of vectors.decideClaim) {
			// The model's single "lease expired" bit covers both a past expiry and a missing one.
			for (const leaseExpiresAt of vector.leaseExpired ? [PAST, null] : [FUTURE]) {
				const decision = decideClaim(
					{
						state: vector.state,
						leaseGeneration: vector.leaseGeneration,
						leaseOwnerId: "runner-1",
						leaseExpiresAt,
						attempt: vector.attempt,
						maxAttempts: vector.maxAttempts,
						cancelRequested: vector.cancelRequested,
					},
					NOW_MS,
				);
				expect(decision, JSON.stringify(vector)).toEqual(vector.decision);
			}
		}
	});

	it(`agrees with checkLease on all ${vectors.checkLease.length} vectors`, () => {
		for (const vector of vectors.checkLease) {
			const result = checkLease(
				{
					state: vector.state,
					leaseGeneration: vector.leaseGeneration,
					leaseOwnerId: vector.leaseOwner === null ? null : `runner-${vector.leaseOwner}`,
					leaseExpiresAt: FUTURE,
					attempt: 1,
					maxAttempts: 3,
					cancelRequested: false,
				},
				{ runnerId: `runner-${vector.runner}`, leaseGeneration: vector.proofGeneration },
			);
			expect(result.ok ? "OK" : result.error, JSON.stringify(vector)).toBe(vector.result);
		}
	});
});

describe("Lean model conformance: budgets", () => {
	it(`agrees with checkBudget on all ${vectors.budget.vectors.length} vectors`, () => {
		for (const vector of vectors.budget.vectors) {
			const [agentSteps, toolCalls, inputBytes, knownCostUsd] = vector.usage;
			const [nextSteps, nextTools, nextBytes, nextCost] = vector.next;
			const result = checkBudget(
				vectors.budget.limits,
				{ agentSteps, toolCalls, inputBytes, knownCostUsd, hasUnmeteredUsage: false },
				vector.elapsedMs,
				{ agentSteps: nextSteps, toolCalls: nextTools, inputBytes: nextBytes, costUsd: nextCost },
			);
			expect(result.ok ? null : result.error, JSON.stringify(vector)).toBe(vector.limit);
		}
	});
});

describe("Lean model conformance: classifiers", () => {
	it("agrees on reported position changes, with 0 and null both meaning 'not reported'", () => {
		for (const vector of vectors.positionChange) {
			const forms = (shares: number) => (shares === 0 ? [0, null] : [shares]);
			for (const previous of forms(vector.previous)) {
				for (const current of forms(vector.current)) {
					expect(classifyReportedPositionChange(previous, current), JSON.stringify(vector)).toBe(
						vector.change,
					);
				}
			}
		}
	});

	it("agrees on claim status from verified links and unsupported numbers", () => {
		const evidence = new Map([
			["ev", "revenue rose 12 percent year on year according to the filing"],
		]);
		for (const vector of vectors.claimStatus) {
			const links = [
				...Array.from({ length: vector.supports }, () => ({
					evidenceId: "ev",
					relation: "supports" as const,
					quote: "revenue rose 12 percent year on year",
				})),
				...Array.from({ length: vector.contradicts }, () => ({
					evidenceId: "ev",
					relation: "contradicts" as const,
					quote: "according to the filing",
				})),
			];
			const verified = verifyClaim(
				{
					claimId: "c",
					// 99 appears nowhere in the evidence; 12 does.
					text:
						vector.unsupportedNumbers > 0 ? "Revenue rose 99 percent." : "Revenue rose 12 percent.",
					claimType: "observation",
					links,
				},
				evidence,
			);
			expect(verified.status, JSON.stringify(vector)).toBe(vector.status);
		}
	});
});

describe("Lean model conformance: workspace reducer", () => {
	const context: CommandContext = {
		validateProps: (_type, schemaVersion, props) => ({
			ok: true,
			value: { props, schemaVersion, references: NO_REFERENCES },
		}),
		knownDatasetRefs: new Set(),
		knownSourceIds: new Set(),
		knownClaims: new Map(),
		maxComponents: 100,
	};
	const componentId = (id: number) => `c${id}`;

	function toCommand(
		state: WorkspaceState,
		step: z.infer<typeof operation>,
		index: number,
		expectedWorkspaceVersion = state.version,
	): UiCommand {
		const envelope = {
			protocolVersion: 1,
			commandId: `cmd_${index}`,
			workspaceId: state.workspaceId,
			expectedWorkspaceVersion,
		};
		switch (step.op) {
			case "create":
				return {
					...envelope,
					operation: "component.create",
					componentId: componentId(step.id),
					componentType: "panel",
					schemaVersion: 1,
					props: {},
				};
			case "remove":
				return { ...envelope, operation: "component.remove", componentId: componentId(step.id) };
			case "reorder":
				return {
					...envelope,
					operation: "layout.update",
					order: step.order.map(componentId),
					columns: 1,
				};
			case "touch":
				return { ...envelope, operation: "component.focus", componentId: componentId(step.id) };
		}
	}

	it(`reaches the model's final state on all ${vectors.workspace.length} operation sequences`, () => {
		expect(vectors.workspace.length).toBeGreaterThan(1000);
		for (const vector of vectors.workspace) {
			let state = emptyWorkspaceState("ws");
			vector.operations.forEach((step, index) => {
				// As in a research run: each instruction targets the current version; rejected ones are skipped.
				const applied = applyUiCommand(state, toCommand(state, step, index), context);
				if (applied.ok) state = applied.value;
			});
			const label = JSON.stringify(vector.operations);
			expect(state.version, label).toBe(vector.version);
			expect(
				state.components.map((component) => component.componentId),
				label,
			).toEqual(vector.components.map(componentId));
			expect(state.layout.order, label).toEqual(vector.order.map(componentId));
		}
	});

	it(`agrees on the version guard and replay rejection for all ${vectors.commandGuard.length} vectors`, () => {
		// Sanity: the grid really contains stale, current and future expected versions.
		expect(vectors.commandGuard.some((vector) => vector.accepted)).toBe(true);
		expect(vectors.commandGuard.some((vector) => !vector.accepted)).toBe(true);
		for (const vector of vectors.commandGuard) {
			let state = emptyWorkspaceState("ws");
			vector.setup.forEach((step, index) => {
				const applied = applyUiCommand(state, toCommand(state, step, index), context);
				if (!applied.ok) throw new Error("setup operations must all apply");
				state = applied.value;
			});
			const label = JSON.stringify(vector);
			const command = toCommand(state, vector.operation, 99, vector.expectedVersion);
			const first = applyUiCommand(state, command, context);
			expect(first.ok, label).toBe(vector.accepted);
			expect(first.ok ? first.value.version : state.version, label).toBe(vector.version);
			// The identical command submitted again against the resulting state.
			const replay = first.ok ? applyUiCommand(first.value, command, context) : first;
			expect(replay.ok, label).toBe(vector.replayAccepted);
			if (vector.accepted) expect(vector.replayAccepted, label).toBe(false);
		}
	});
});

describe("Lean model conformance: transition helper", () => {
	it("accepts exactly the modelled transitions for every pair of states", () => {
		for (const from of JOB_STATES) {
			for (const to of JOB_STATES) {
				const modelled = (vectors.transitions[from] ?? []).includes(to);
				const result = transitionJob(from, to);
				expect(result.ok, `${from}->${to}`).toBe(modelled);
				if (result.ok) expect(result.value).toBe(to);
				else expect(result.error).toEqual({ code: "ILLEGAL_TRANSITION", from, to });
			}
		}
	});
});

describe("Lean model conformance: recent message count within budget", () => {
	it(`agrees with recentCountWithinBudget on all ${vectors.recentWithinBudget.length} vectors`, () => {
		expect(vectors.recentWithinBudget.length).toBe(2040);
		for (const vector of vectors.recentWithinBudget) {
			// The model's list is newest first; the TypeScript array is oldest first.
			const oldestFirst = [...vector.sizes].reverse();
			expect(
				recentCountWithinBudget(oldestFirst, vector.budget, vector.maxItems),
				JSON.stringify(vector),
			).toBe(vector.count);
		}
	});
});

describe("Lean model conformance: home dashboard edits", () => {
	const widgetId = (id: number) => `w${id}`;
	const toDashboard = (ids: readonly number[]) => ({
		schemaVersion: 1 as const,
		widgets: ids.map((id) => ({
			widgetId: widgetId(id),
			title: `Widget ${id}`,
			size: "small" as const,
			type: "metric" as const,
			seriesId: "fred:VIXCLS",
		})),
	});

	it(`reaches the model's accept/reject and final ids on all ${vectors.dashboard.length} vectors`, () => {
		expect(vectors.dashboard.length).toBe(612);
		for (const vector of vectors.dashboard) {
			const dashboard = toDashboard(vector.dashboard);
			const label = JSON.stringify(vector);
			const id = widgetId(vector.edit.id);
			const edit = (() => {
				switch (vector.edit.kind) {
					case "add":
						return {
							kind: "add" as const,
							widget: {
								widgetId: id,
								title: `Widget ${vector.edit.id}`,
								size: "small" as const,
								type: "metric" as const,
								seriesId: "fred:VIXCLS",
							},
						};
					case "remove":
						return { kind: "remove" as const, widgetId: id };
					case "moveEarlier":
						return { kind: "move" as const, widgetId: id, direction: "earlier" as const };
					case "moveLater":
						return { kind: "move" as const, widgetId: id, direction: "later" as const };
					case "reorder": {
						if (vector.edit.toIndex === undefined) {
							throw new Error(`reorder vector without toIndex: ${label}`);
						}
						return { kind: "reorder" as const, widgetId: id, toIndex: vector.edit.toIndex };
					}
					default:
						throw new Error(`unknown dashboard edit kind: ${label}`);
				}
			})();
			const result = applyDashboardEdit(dashboard, edit);
			expect(result.ok, label).toBe(vector.accepted);
			const ids = result.ok
				? result.value.widgets.map((widget) => widget.widgetId)
				: dashboard.widgets.map((widget) => widget.widgetId);
			expect(ids, label).toEqual(vector.ids.map(widgetId));
		}
	});
});

describe("Lean model conformance: fixed-window rate gate", () => {
	it(`agrees with rateWindowPermit on all ${vectors.ratePermit.length} vectors`, () => {
		expect(vectors.ratePermit.length).toBe(1092);
		for (const vector of vectors.ratePermit) {
			const result = rateWindowPermit(vector.grants, vector.now, vector.maxPer, vector.window);
			const label = JSON.stringify(vector);
			expect(result.allowed, label).toBe(vector.allowed);
			if (!result.allowed) {
				expect(result.retryAfterMs, label).toBe(vector.retryAfter);
			}
		}
	});

	it(`replays the recorded-grant trace on all ${vectors.rateRecord.length} vectors`, () => {
		expect(vectors.rateRecord.length).toBe(120);
		for (const vector of vectors.rateRecord) {
			// The model's times are non-decreasing (clock order); the test folds
			// them through the real implementation and checks the model's trace.
			const recorded: number[] = [];
			for (const at of vector.times) {
				if (rateWindowPermit(recorded, at, vector.maxPer, vector.window).allowed) {
					recorded.push(at);
				}
			}
			const label = JSON.stringify(vector);
			expect(recorded, label).toEqual(vector.recorded);
			// The proved bound, checked independently: no window holds more than maxPer.
			for (let now = 0; now <= 5; now += 1) {
				const inWindow = recorded.filter((at) => at > now - vector.window && at <= now);
				expect(inWindow.length, `${label} @${now}`).toBeLessThanOrEqual(vector.maxPer);
			}
		}
	});
});
