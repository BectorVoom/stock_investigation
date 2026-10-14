import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	applyDashboardEdit,
	applyUiCommand,
	buildMonthGrid,
	type CommandContext,
	checkBudget,
	checkLease,
	classifyReportedPositionChange,
	daysInMonth,
	decideClaim,
	emptyWorkspaceState,
	encodeBase32Hex,
	foldIcsLine,
	type GoogleEventBody,
	googleEventId,
	isLeasedJobState,
	isTerminalJobState,
	JOB_STATES,
	JOB_TRANSITIONS,
	type ManagedGoogleEvent,
	NO_REFERENCES,
	planGoogleSync,
	rateWindowPermit,
	recentCountWithinBudget,
	selectUpcomingEarnings,
	transitionJob,
	type UiCommand,
	verifyClaim,
	type WorkspaceState,
	weekdayOf,
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
	foldIcs: z.array(z.object({ widths: z.array(z.number()), lines: z.array(z.array(z.number())) })),
	upcomingEarnings: z.array(
		z.object({
			rows: z.array(z.object({ stock: z.number(), date: z.number().nullable() })),
			today: z.number(),
			daysAhead: z.number(),
			maxItems: z.number(),
			selected: z.array(z.object({ date: z.number(), stock: z.number() })),
		}),
	),
	monthGrid: z.array(
		z.object({
			year: z.number(),
			month: z.number(),
			weekStart: z.number(),
			firstWeekday: z.number(),
			days: z.number(),
			leading: z.number(),
			rows: z.number(),
			first: z.string(),
			inMonth: z.array(z.string()),
		}),
	),
	syncPlan: z.array(
		z.object({
			desired: z.array(z.object({ id: z.number(), fp: z.number() })),
			existing: z.array(z.object({ id: z.number(), cancelled: z.boolean(), fp: z.number() })),
			inserts: z.array(z.object({ id: z.number(), fp: z.number() })),
			updates: z.array(z.object({ id: z.number(), fp: z.number() })),
			deletes: z.array(z.number()),
			unchanged: z.array(z.number()),
		}),
	),
	base32hex: z.array(z.object({ bytes: z.array(z.number()), chars: z.array(z.number()) })),
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

describe("Lean model conformance: ICS line folding", () => {
	// One character per octet width: `for...of` and `codePointAt` in the
	// implementation observe exactly these widths (1..4 octets in UTF-8).
	const charForWidth = (width: number): string => {
		switch (width) {
			case 1:
				return "a";
			case 2:
				return "é";
			case 3:
				return "あ";
			case 4:
				return "𝄞";
			default:
				throw new Error(`unexpected width ${width}`);
		}
	};
	const encoder = new TextEncoder();
	const widthsOf = (text: string): number[] => [...text].map((char) => encoder.encode(char).length);

	it(`agrees with foldIcsLine on all ${vectors.foldIcs.length} vectors`, () => {
		expect(vectors.foldIcs.length).toBe(111);
		for (const vector of vectors.foldIcs) {
			const input = vector.widths.map(charForWidth).join("");
			const folded = foldIcsLine(input);
			const pieces = folded.split("\r\n ");
			const label = JSON.stringify(vector.widths);
			// Joining the pieces after removing each CRLF + space yields the input.
			expect(pieces.join(""), `rejoin ${label}`).toBe(input);
			expect(pieces.map(widthsOf), `lines ${label}`).toEqual(vector.lines);
			expect(pieces.flatMap(widthsOf), `flatten ${label}`).toEqual(vector.widths);
			// The proved bound, checked on the wire: the first line carries up
			// to 75 octets; every continuation line adds one space to at most
			// 74 content octets.
			for (const [index, piece] of pieces.entries()) {
				expect(encoder.encode(piece).length, `limit ${label}#${index}`).toBeLessThanOrEqual(
					index === 0 ? 75 : 74,
				);
			}
		}
	});
});

describe("Lean model conformance: upcoming earnings selection", () => {
	// The model's day offsets count from a fixed base; validated ISO dates
	// order exactly like the offsets, which is what the implementation's
	// string comparison assumes.
	const BASE_MS = Date.UTC(2026, 9, 10);
	const isoOf = (offset: number): string =>
		new Date(BASE_MS + offset * 86_400_000).toISOString().slice(0, 10);

	it(`agrees with selectUpcomingEarnings on all ${vectors.upcomingEarnings.length} vectors`, () => {
		expect(vectors.upcomingEarnings.length).toBe(1032);
		for (const vector of vectors.upcomingEarnings) {
			const rows = vector.rows.map((row) => ({
				stockId: `s${row.stock}`,
				announcementDate: row.date === null ? null : isoOf(row.date),
			}));
			const today = isoOf(vector.today);
			const selected = selectUpcomingEarnings(rows, today, vector.daysAhead, vector.maxItems);
			const label = JSON.stringify(vector);
			expect(
				selected.map((entry) => ({
					date:
						entry.announcementDate === null
							? null
							: Math.round(
									(Date.parse(`${entry.announcementDate}T00:00:00.000Z`) - BASE_MS) / 86_400_000,
								),
					stock: Number(entry.stockId.slice(1)),
				})),
				label,
			).toEqual(vector.selected);
			// The proved bounds, checked independently.
			expect(selected.length, label).toBeLessThanOrEqual(vector.maxItems);
			const end = isoOf(vector.today + vector.daysAhead);
			const keys: string[] = [];
			for (const entry of selected) {
				const date = entry.announcementDate ?? "";
				expect(date >= today && date <= end, label).toBe(true);
				keys.push(`${date} ${entry.stockId}`);
			}
			expect([...keys].sort(), label).toEqual(keys);
		}
	});

	it("fails closed outside the model: invalid inputs select nothing", () => {
		// The Lean model counts days in Nat, so invalid date strings, negative
		// or fractional counts, undecided dates and malformed dates are outside
		// it; the implementation fails closed to [] (also covered by unit tests).
		const rows = [{ stockId: "s0", announcementDate: "2026-10-10" }];
		expect(selectUpcomingEarnings(rows, "not-a-date", 30, 10)).toEqual([]);
		expect(selectUpcomingEarnings(rows, "2026-10-10", -1, 10)).toEqual([]);
		expect(selectUpcomingEarnings(rows, "2026-10-10", 30, -1)).toEqual([]);
		expect(selectUpcomingEarnings(rows, "2026-10-10", 1.5, 10)).toEqual([]);
		expect(
			selectUpcomingEarnings(
				[
					{ stockId: "s0", announcementDate: null },
					{ stockId: "s1", announcementDate: "2026-02-30" },
				],
				"2026-10-10",
				185,
				10,
			),
		).toEqual([]);
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

describe("Lean model conformance: earnings month grid", () => {
	it(`agrees with buildMonthGrid on all ${vectors.monthGrid.length} vectors`, () => {
		expect(vectors.monthGrid.length).toBe(27);
		for (const vector of vectors.monthGrid) {
			const grid = buildMonthGrid(vector.year, vector.month, vector.weekStart);
			const label = JSON.stringify(vector);
			expect(grid.ok, label).toBe(true);
			if (!grid.ok) continue;
			const flat = grid.value.weeks.flat();
			expect(grid.value.weeks.length, label).toBe(vector.rows);
			expect(flat.length % 7, label).toBe(0);
			expect(flat[0]?.date, label).toBe(vector.first);
			expect(
				flat.filter((cell) => cell.inMonth).map((cell) => cell.date),
				label,
			).toEqual(vector.inMonth);
			// The proved properties, checked independently on the wire values.
			const [fy, fm, fd] = vector.first.split("-");
			expect(weekdayOf(Number(fy), Number(fm), Number(fd)), label).toBe(vector.weekStart);
			expect(daysInMonth(vector.year, vector.month), label).toBe(vector.days);
			expect(weekdayOf(vector.year, vector.month, 1), label).toBe(vector.firstWeekday);
			expect(
				flat.findIndex((cell) => cell.inMonth),
				label,
			).toBe(vector.leading);
		}
	});

	it("fails closed outside the model: invalid inputs build nothing", () => {
		// The Lean model counts grid offsets in Nat, so out-of-range years,
		// months and week starts are outside it; the implementation fails
		// closed (also covered by unit tests).
		expect(buildMonthGrid(1969, 1, 0)).toEqual({ ok: false, error: "INVALID_YEAR" });
		expect(buildMonthGrid(10_000, 1, 0)).toEqual({ ok: false, error: "INVALID_YEAR" });
		expect(buildMonthGrid(2026, 0, 0)).toEqual({ ok: false, error: "INVALID_MONTH" });
		expect(buildMonthGrid(2026, 13, 0)).toEqual({ ok: false, error: "INVALID_MONTH" });
		expect(buildMonthGrid(2026, 10, -1)).toEqual({ ok: false, error: "INVALID_WEEK_START" });
		expect(buildMonthGrid(2026, 10, 7)).toEqual({ ok: false, error: "INVALID_WEEK_START" });
	});
});

describe("Lean model conformance: Google sync plan", () => {
	// Fingerprint n maps to one fixed assignment of the compared fields
	// (start/end/summary/description); differing fingerprints always differ.
	const fpBody = (id: number, fp: number): GoogleEventBody => ({
		id: `s${id}`,
		summary: `fp-${fp}`,
		description: `desc-${fp}`,
		startDate: "2026-10-29",
		endDate: "2026-10-30",
		privateProperties: {
			researchWorkspace: "earnings",
			stockId: "us:AAPL",
			periodKey: "2026-q4",
		},
		sourceTitle: "Finnhub",
		sourceUrl: "https://finnhub.io/",
	});
	const fpManaged = (row: { id: number; cancelled: boolean; fp: number }): ManagedGoogleEvent => ({
		id: `s${row.id}`,
		status: row.cancelled ? "cancelled" : "confirmed",
		startDate: "2026-10-29",
		endDate: "2026-10-30",
		summary: `fp-${row.fp}`,
		description: `desc-${row.fp}`,
	});
	const pairOf = (body: GoogleEventBody) => ({
		id: Number(body.id.slice(1)),
		fp: Number(body.summary.slice("fp-".length)),
	});
	const idOf = (id: string) => Number(id.slice(1));
	const sortedIds = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

	it(`agrees with planGoogleSync on all ${vectors.syncPlan.length} vectors`, () => {
		expect(vectors.syncPlan.length).toBe(638);
		for (const vector of vectors.syncPlan) {
			const label = JSON.stringify(vector);
			const plan = planGoogleSync(
				vector.desired.map((entry) => fpBody(entry.id, entry.fp)),
				vector.existing.map(fpManaged),
			);
			expect(plan.ok, label).toBe(true);
			if (!plan.ok) continue;
			expect(plan.value.inserts.map(pairOf), label).toEqual(
				vector.inserts.map((entry) => ({ id: entry.id, fp: entry.fp })),
			);
			expect(plan.value.updates.map(pairOf), label).toEqual(
				vector.updates.map((entry) => ({ id: entry.id, fp: entry.fp })),
			);
			expect(plan.value.deletes.map(idOf), label).toEqual(vector.deletes);
			expect(plan.value.unchanged.map(idOf), label).toEqual(vector.unchanged);
			// Deterministic order (by id), asserted on the wire values.
			expect(
				plan.value.inserts.map((body) => idOf(body.id)),
				label,
			).toEqual(sortedIds(plan.value.inserts.map((body) => idOf(body.id))));
			expect(
				plan.value.updates.map((body) => idOf(body.id)),
				label,
			).toEqual(sortedIds(plan.value.updates.map((body) => idOf(body.id))));
			expect(plan.value.deletes.map(idOf), label).toEqual(sortedIds(plan.value.deletes.map(idOf)));
			expect(plan.value.unchanged.map(idOf), label).toEqual(
				sortedIds(plan.value.unchanged.map(idOf)),
			);
		}
	});

	it("fails closed outside the model: duplicate ids plan nothing", () => {
		// Duplicate ids are outside the Nat model (its buckets assume
		// distinct ids); the implementation rejects them instead of
		// double-writing (also covered by unit tests).
		const body = fpBody(0, 0);
		expect(planGoogleSync([body, body], []).ok).toBe(false);
		expect(
			planGoogleSync(
				[],
				[
					fpManaged({ id: 0, cancelled: false, fp: 0 }),
					fpManaged({ id: 0, cancelled: false, fp: 0 }),
				],
			).ok,
		).toBe(false);
	});
});

describe("Lean model conformance: base32hex encoder", () => {
	// Nats 0..31 in the RFC 4648 base32hex alphabet order (`0-9a-v`).
	const ALPHABET = "0123456789abcdefghijklmnopqrstuv";

	it(`agrees with encodeBase32Hex on all ${vectors.base32hex.length} vectors`, () => {
		expect(vectors.base32hex.length).toBe(17);
		for (const vector of vectors.base32hex) {
			const label = JSON.stringify(vector.bytes);
			const encoded = encodeBase32Hex(vector.bytes);
			expect(encoded.ok, label).toBe(true);
			if (!encoded.ok) continue;
			expect(
				[...encoded.value].map((char) => ALPHABET.indexOf(char)),
				label,
			).toEqual(vector.chars);
			// The proved length property, checked on the wire value.
			expect(encoded.value.length, label).toBe((vector.bytes.length * 8) / 5);
			if (vector.bytes.length === 20) {
				const id = googleEventId(vector.bytes);
				expect(id.ok, label).toBe(true);
				if (id.ok) expect(id.value, label).toBe(encoded.value);
			}
		}
	});

	it("fails closed outside the model: bad lengths and bytes encode nothing", () => {
		// Lengths that are not a multiple of 5 bytes (and out-of-range
		// bytes) are outside the model; the implementation fails closed
		// (also covered by unit tests).
		expect(encodeBase32Hex([0, 1, 2]).ok).toBe(false);
		expect(encodeBase32Hex([0, 0, 0, 0, 256]).ok).toBe(false);
		expect(encodeBase32Hex([0, 0, 0, 0, -1]).ok).toBe(false);
		expect(googleEventId([0, 0, 0]).ok).toBe(false);
		expect(googleEventId(Array.from({ length: 21 }, () => 0)).ok).toBe(false);
	});
});
