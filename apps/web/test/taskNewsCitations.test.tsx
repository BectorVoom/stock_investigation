import { SCHEDULED_TASK_LIMITS } from "@research/contracts";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { TaskNews } from "../src/news/TaskNews.tsx";
import { createFakeBackend, jsonResponse } from "./fakeBackend.ts";

afterEach(cleanup);

it("renders stored news claims with their original source links", async () => {
	const backend = createFakeBackend();
	const date = "2026-11-09T00:00:00Z";
	backend.on("GET", /\/scheduled-tasks$/, () =>
		jsonResponse({
			limits: {
				maxActive: SCHEDULED_TASK_LIMITS.maxActive,
				maxTasks: SCHEDULED_TASK_LIMITS.maxTasks,
			},
			tasks: [
				{
					taskId: "task_1",
					workspaceId: "workspace_1",
					outputType: "news",
					title: "Energy brief",
					question: "Report energy demand",
					horizonYears: 3,
					markets: ["US"],
					schedule: { kind: "daily", time: "09:00" },
					timeZone: "UTC",
					spendConsent: null,
					status: "active",
					nextRunAt: date,
					lastRun: null,
					lastSkip: null,
					version: 0,
					createdAt: date,
					updatedAt: date,
				},
			],
		}),
	);
	backend.on("GET", /\/messages/, () =>
		jsonResponse({
			messages: [
				{
					messageId: "message_1",
					seq: 1,
					role: "assistant",
					text: "Pipeline summary",
					runId: "run_1",
					claimIds: ["claim_1"],
					createdAt: date,
				},
			],
			claims: [
				{
					claimId: "claim_1",
					text: "Electricity consumption rose, EIA reported.",
					claimType: "observation",
					status: "supported",
					links: [{ evidenceId: "evidence_1", relation: "supports", quote: "Consumption rose." }],
					issues: [],
				},
			],
			evidence: [
				{
					evidenceId: "evidence_1",
					sourceUrl: "https://www.eia.gov/report",
					title: "Electricity report",
					publisher: "EIA",
					publishedAt: date,
					retrievedAt: date,
					effectiveAt: null,
					excerpt: "Consumption rose.",
					checksum: "a".repeat(64),
					sourceClass: "news",
				},
			],
			hasEarlier: false,
		}),
	);
	render(() => <TaskNews api={createApiClient({ fetch: backend.fetch })} />);
	expect(await screen.findByText("Electricity consumption rose, EIA reported.")).toBeTruthy();
	expect(screen.getByRole("link", { name: /Electricity report/ }).getAttribute("href")).toBe(
		"https://www.eia.gov/report",
	);
	expect(screen.queryByText("Pipeline summary")).toBeNull();
});
