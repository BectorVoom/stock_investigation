import { agentsResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import type { ApiFailure } from "../../src/api/http.ts";
import { agentSettingsModelMessages } from "../../src/settings/agentSettingsModel.messages.ts";
import { tasksModelMessages } from "../../src/tasks/tasksModel.messages.ts";
import {
	defaultTaskDraft,
	draftFromTask,
	evaluateTaskDraft,
	hasUnfinishedRun,
	lastRunText,
	nextRunText,
	orderTasks,
	relativeText,
	scheduleText,
	skipView,
	type TaskDraft,
	taskConsentNeed,
	taskFailureHint,
	toggleWeekday,
	widgetTasks,
} from "../../src/tasks/tasksModel.ts";
import { AGENT_SETTINGS, AGENTS } from "../fixtures.ts";
import { METERED_SETTINGS, makeTask, NOW_MS } from "./tasksHarness.ts";

const en = tasksModelMessages.en;
const ja = tasksModelMessages.ja;
const agentText = agentSettingsModelMessages.en;
const TOKYO = "Asia/Tokyo";
const HOUR = 3_600_000;

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
	return {
		...defaultTaskDraft(NOW_MS, TOKYO),
		title: "Morning brief",
		question: "What changed overnight?",
		...overrides,
	};
}

describe("orderTasks", () => {
	it("puts active tasks first by next run, then paused, then completed, newest first", () => {
		const later = makeTask({ taskId: "later", nextRunAt: "2026-10-26T00:00:00Z" });
		const sooner = makeTask({ taskId: "sooner", nextRunAt: "2026-10-25T00:00:00Z" });
		const oldPaused = makeTask({
			taskId: "old-paused",
			status: "paused",
			nextRunAt: null,
			createdAt: "2026-10-01T00:00:00Z",
		});
		const newPaused = makeTask({
			taskId: "new-paused",
			status: "paused",
			nextRunAt: null,
			createdAt: "2026-10-22T00:00:00Z",
		});
		const completed = makeTask({ taskId: "done", status: "completed", nextRunAt: null });
		const ordered = orderTasks([completed, oldPaused, later, newPaused, sooner]);
		expect(ordered.map((task) => task.taskId)).toEqual([
			"sooner",
			"later",
			"new-paused",
			"old-paused",
			"done",
		]);
	});
});

describe("widgetTasks", () => {
	const tasks = Array.from({ length: 10 }, (_, index) =>
		makeTask({
			taskId: `t${index}`,
			nextRunAt: new Date(NOW_MS + (index + 1) * HOUR).toISOString(),
		}),
	);

	it("shows the next task on Small, four on Medium, eight then the rest as more on Large", () => {
		expect(widgetTasks(tasks, "small").shown.map((task) => task.taskId)).toEqual(["t0"]);
		expect(widgetTasks(tasks, "small").more).toBe(0);
		expect(widgetTasks(tasks, "medium").shown).toHaveLength(4);
		expect(widgetTasks(tasks, "medium").more).toBe(0);
		const large = widgetTasks(tasks, "large");
		expect(large.shown).toHaveLength(8);
		expect(large.more).toBe(2);
	});
});

describe("scheduleText", () => {
	it("says each schedule in words, with Mon–Fri as Weekdays", () => {
		const words = (schedule: Parameters<typeof scheduleText>[0]) =>
			scheduleText(schedule, TOKYO, TOKYO, en);
		expect(words({ kind: "daily", time: "08:00" })).toBe("Every day at 08:00");
		expect(words({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" })).toBe(
			"Weekdays at 07:30",
		);
		expect(words({ kind: "weekly", days: [1, 3], time: "07:30" })).toBe("Every Mon, Wed at 07:30");
		expect(words({ kind: "monthly", day: 31, time: "09:00" })).toBe("Monthly on day 31 at 09:00");
		expect(words({ kind: "once", date: "2026-11-01", time: "10:00" })).toBe(
			"Once on 2026-11-01 at 10:00",
		);
	});

	it("names the task's zone when it is not the viewer's, and speaks Japanese", () => {
		expect(scheduleText({ kind: "daily", time: "08:00" }, "America/New_York", TOKYO, en)).toBe(
			"Every day at 08:00 (America/New_York)",
		);
		expect(scheduleText({ kind: "weekly", days: [0, 6], time: "08:00" }, TOKYO, TOKYO, ja)).toBe(
			"毎週 日・土 08:00",
		);
	});
});

describe("nextRunText", () => {
	it("is relative within a day and a local date and time beyond it", () => {
		const soon = makeTask({ nextRunAt: new Date(NOW_MS + 3 * HOUR + 20 * 60_000).toISOString() });
		expect(nextRunText(soon, NOW_MS, TOKYO, "en", en)).toBe("Next run in 3 h 20 min");
		// Two days on, 08:00 in Tokyo.
		const later = makeTask({ nextRunAt: "2026-10-26T23:00:00Z" });
		expect(nextRunText(later, NOW_MS, TOKYO, "en", en)).toBe("Next run Tue, Oct 27, 08:00");
		expect(nextRunText(later, NOW_MS, "Europe/London", "en", en)).toBe(
			"Next run Tue, Oct 27, 08:00 (Asia/Tokyo)",
		);
	});

	it("says a due task waits for the runner, and names paused and completed tasks", () => {
		const due = makeTask({ nextRunAt: new Date(NOW_MS - 60_000).toISOString() });
		expect(nextRunText(due, NOW_MS, TOKYO, "en", en)).toBe(en.dueNow);
		const paused = makeTask({ status: "paused", nextRunAt: null });
		expect(nextRunText(paused, NOW_MS, TOKYO, "en", en)).toBe(en.pausedLine);
		const completed = makeTask({ status: "completed", nextRunAt: null });
		expect(nextRunText(completed, NOW_MS, TOKYO, "en", en)).toBe(en.completedLine);
	});

	it("never says 'in 0 min'", () => {
		expect(relativeText(20_000, en)).toBe("less than a minute");
		expect(relativeText(61_000, en)).toBe("2 min");
		expect(relativeText(2 * HOUR, en)).toBe("2 h");
		expect(relativeText(25 * 60_000, ja)).toBe("25 分");
	});
});

describe("last run and skip lines", () => {
	const lastRun = {
		runId: "run_7",
		state: "failed" as const,
		slotAt: "2026-10-23T23:00:00Z",
		queuedAt: "2026-10-23T23:00:05Z",
		failureCode: "PROVIDER_UNAVAILABLE",
	};

	it("states the last run with its failure code, or that none ran yet", () => {
		const name = (state: string) => state;
		expect(lastRunText(makeTask(), name, en)).toBe("Not run yet");
		expect(lastRunText(makeTask({ lastRun }), name, en)).toBe(
			"Last run: failed (PROVIDER_UNAVAILABLE)",
		);
		expect(
			lastRunText(
				makeTask({ lastRun: { ...lastRun, state: "completed", failureCode: null } }),
				name,
				en,
			),
		).toBe("Last run: completed");
	});

	it("gives a skip its reason and fix, linking Settings only where the fix lives", () => {
		const skipped = makeTask({
			lastSkip: {
				code: "SPEND_CONSENT_REQUIRED",
				slotAt: "2026-10-24T23:00:00Z",
				at: "2026-10-24T23:00:10Z",
			},
		});
		const view = skipView(skipped, TOKYO, "en", en);
		expect(view?.headline).toBe("The run due Sun, Oct 25, 08:00 was skipped:");
		expect(view?.reason).toBe(en.skipReason("SPEND_CONSENT_REQUIRED"));
		expect(view?.settingsFix).toBe(true);
		const limited = makeTask({
			lastSkip: {
				code: "RATE_LIMITED",
				slotAt: "2026-10-24T23:00:00Z",
				at: "2026-10-24T23:00:10Z",
			},
		});
		expect(skipView(limited, TOKYO, "en", en)?.settingsFix).toBe(false);
	});

	it("hides a skip that a later queued run superseded", () => {
		const superseded = makeTask({
			lastSkip: {
				code: "RATE_LIMITED",
				slotAt: "2026-10-22T23:00:00Z",
				at: "2026-10-22T23:00:10Z",
			},
			lastRun,
		});
		expect(skipView(superseded, TOKYO, "en", en)).toBeNull();
	});

	it("polls fast only while a last run is unfinished", () => {
		expect(hasUnfinishedRun([makeTask()])).toBe(false);
		expect(hasUnfinishedRun([makeTask({ lastRun })])).toBe(false);
		expect(
			hasUnfinishedRun([
				makeTask({ lastRun: { ...lastRun, state: "pending", failureCode: null } }),
			]),
		).toBe(true);
	});
});

describe("taskConsentNeed", () => {
	it("needs consent for a metered backend with a ceiling, naming backend, model and amount", () => {
		const need = taskConsentNeed(AGENTS, METERED_SETTINGS.settings, agentText);
		expect(need).toEqual({
			kind: "needed",
			consent: { agentId: "openrouter", model: "anthropic/claude-sonnet", maxSpendUsd: 0.5 },
			backendName: "OpenRouter",
		});
	});

	it("needs none for a plan-limited backend, and says a metered one lacks a ceiling", () => {
		expect(taskConsentNeed(AGENTS, AGENT_SETTINGS, agentText)).toEqual({ kind: "none" });
		const noCeiling = {
			...METERED_SETTINGS.settings,
			budget: { ...METERED_SETTINGS.settings.budget, maxSpendUsd: null },
		};
		expect(taskConsentNeed(AGENTS, noCeiling, agentText)).toEqual({
			kind: "no-ceiling",
			backendName: "OpenRouter",
		});
		expect(taskConsentNeed(null, AGENT_SETTINGS, agentText)).toEqual({ kind: "loading" });
		const noRunner = agentsResponseSchema.parse({
			runnerOnline: false,
			runnerLastSeenAt: null,
			agents: [],
		});
		// A backend whose billing is unknown asks for consent like the composer does.
		expect(taskConsentNeed(noRunner, METERED_SETTINGS.settings, agentText).kind).toBe("needed");
	});
});

describe("evaluateTaskDraft", () => {
	const none = { kind: "none" } as const;

	it("builds a daily request in the draft's zone with no consent for a plan-limited backend", () => {
		const result = evaluateTaskDraft(draft(), none, NOW_MS, en);
		expect(result.problems).toEqual([]);
		expect(result.request).toEqual({
			title: "Morning brief",
			question: "What changed overnight?",
			horizonYears: 5,
			markets: ["JP", "US"],
			schedule: { kind: "daily", time: "08:00" },
			timeZone: TOKYO,
			spendConsent: null,
		});
	});

	it("stores Weekdays as weekly Monday to Friday, and keeps weekly days ascending", () => {
		const weekdays = evaluateTaskDraft(draft({ choice: "weekdays" }), none, NOW_MS, en);
		expect(weekdays.request?.schedule).toEqual({
			kind: "weekly",
			days: [1, 2, 3, 4, 5],
			time: "08:00",
		});
		const days = toggleWeekday(toggleWeekday([3], 6), 0);
		expect(days).toEqual([0, 3, 6]);
		const weekly = evaluateTaskDraft(draft({ choice: "weekly", days }), none, NOW_MS, en);
		expect(weekly.request?.schedule).toEqual({ kind: "weekly", days: [0, 3, 6], time: "08:00" });
	});

	it("lists every problem with what to do", () => {
		const result = evaluateTaskDraft(
			draft({
				title: " ",
				question: "hi",
				markets: { JP: false, US: false },
				choice: "weekly",
				days: [],
				time: "25:00",
				timeZone: "Mars/Olympus",
			}),
			none,
			NOW_MS,
			en,
		);
		expect(result.request).toBeNull();
		expect(result.problems).toEqual([
			en.titleMissing,
			en.questionTooShort(3),
			en.chooseMarket,
			en.timeInvalid,
			en.chooseDay,
			en.zoneUnknown,
		]);
	});

	it("refuses a one-time task whose time has passed in its zone, and a bad day of the month", () => {
		// 2026-10-24 17:00 in Tokyo is 08:00 UTC: an hour before now.
		const past = evaluateTaskDraft(
			draft({ choice: "once", date: "2026-10-24", time: "17:00" }),
			none,
			NOW_MS,
			en,
		);
		expect(past.problems).toEqual([en.inPast]);
		const future = evaluateTaskDraft(
			draft({ choice: "once", date: "2026-10-24", time: "19:00" }),
			none,
			NOW_MS,
			en,
		);
		expect(future.request?.schedule).toEqual({ kind: "once", date: "2026-10-24", time: "19:00" });
		const monthly = evaluateTaskDraft(
			draft({ choice: "monthly", dayOfMonth: "32" }),
			none,
			NOW_MS,
			en,
		);
		expect(monthly.problems).toEqual([en.dayOfMonthInvalid]);
	});

	it("asks for consent while the backend needs it and sends exactly the consent shown", () => {
		const need = taskConsentNeed(AGENTS, METERED_SETTINGS.settings, agentText);
		expect(evaluateTaskDraft(draft(), need, NOW_MS, en).problems).toEqual([en.confirmConsent]);
		const consented = evaluateTaskDraft(draft({ consent: true }), need, NOW_MS, en);
		expect(consented.request?.spendConsent).toEqual({
			agentId: "openrouter",
			model: "anthropic/claude-sonnet",
			maxSpendUsd: 0.5,
		});
		expect(evaluateTaskDraft(draft(), { kind: "loading" }, NOW_MS, en).request).toBeNull();
	});

	it("reopens a task as it was saved, its consent ticked only while it still matches", () => {
		const need = taskConsentNeed(AGENTS, METERED_SETTINGS.settings, agentText);
		const task = makeTask({
			schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:15" },
			markets: ["US"],
			spendConsent: { agentId: "openrouter", model: "anthropic/claude-sonnet", maxSpendUsd: 0.5 },
		});
		const reopened = draftFromTask(task, need, NOW_MS);
		expect(reopened.choice).toBe("weekdays");
		expect(reopened.time).toBe("07:15");
		expect(reopened.markets).toEqual({ JP: false, US: true });
		expect(reopened.consent).toBe(true);
		const otherCeiling = makeTask({
			spendConsent: { agentId: "openrouter", model: "anthropic/claude-sonnet", maxSpendUsd: 0.25 },
		});
		expect(draftFromTask(otherCeiling, need, NOW_MS).consent).toBe(false);
	});
});

describe("taskFailureHint", () => {
	const failure = (code: ApiFailure["code"], detail: string | null): ApiFailure => ({
		kind: "api",
		code,
		status: 422,
		message: "refused",
		detail,
		issues: [],
	});

	it("explains the task limits, a past time and a conflict; nothing for other failures", () => {
		expect(taskFailureHint(failure("VALIDATION_FAILED", "TASKS_FULL"), en)).toBe(
			en.tasksFull(10, 30),
		);
		expect(taskFailureHint(failure("VALIDATION_FAILED", "SCHEDULE_IN_PAST"), en)).toBe(
			en.scheduleInPast,
		);
		expect(taskFailureHint(failure("VERSION_CONFLICT", null), en)).toBe(en.versionConflict);
		expect(taskFailureHint(failure("RATE_LIMITED", null), en)).toBeNull();
	});
});
