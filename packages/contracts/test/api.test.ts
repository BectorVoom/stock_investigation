import { describe, expect, it } from "vitest";
import {
	API_PREFIX,
	agentsResponseSchema,
	approveRunRequestSchema,
	articleListResponseSchema,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	chatMessageSchema,
	conversationResponseSchema,
	createResearchRunRequestSchema,
	createWorkspaceRequestSchema,
	EXPORT_FORMAT_VERSION,
	IDEMPOTENCY_KEY_HEADER,
	idempotencyKeySchema,
	issuedRunnerCredentialSchema,
	issueRunnerCredentialRequestSchema,
	MAX_REQUEST_BODY_BYTES,
	previewSourceRequestSchema,
	RUNNER_API_PREFIX,
	recommendedSourceSchema,
	recommendedSourcesResponseSchema,
	registerSourceRequestSchema,
	researchExportSchema,
	researchRunListResponseSchema,
	researchRunResponseSchema,
	runnerCredentialListResponseSchema,
	runnerCredentialSchema,
	runRecordsResponseSchema,
	sessionResponseSchema,
	sourceListResponseSchema,
	sourcePreviewSchema,
	submitCommandResponseSchema,
	updateSourceRequestSchema,
	workspaceEventSchema,
	workspaceEventsResponseSchema,
	workspaceListResponseSchema,
	workspaceSummarySchema,
	workspaceViewSchema,
} from "../src/index.ts";
import {
	agentDescriptor,
	article,
	chatMessage,
	claim,
	dataset,
	evidence,
	newsSource,
	researchBudget,
	researchRequest,
	researchRun,
	runRecords,
	SECTION_7_EXAMPLE_COMMAND,
	T0,
	T1,
	workspaceState,
	workspaceSummary,
} from "./fixtures.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

describe("API constants", () => {
	it("versions the API and scopes runner endpoints under their own prefix", () => {
		expect(API_PREFIX).toBe("/api/v1");
		expect(RUNNER_API_PREFIX).toBe("/api/v1/runner");
		expect(RUNNER_API_PREFIX.startsWith(`${API_PREFIX}/`)).toBe(true);
	});

	it("bounds request bodies and names the CSRF and idempotency headers", () => {
		expect(MAX_REQUEST_BODY_BYTES).toBe(1_000_000);
		expect(CSRF_HEADER).toBe("X-Research-Csrf");
		expect(CSRF_HEADER_VALUE).toBe("1");
		expect(IDEMPOTENCY_KEY_HEADER).toBe("Idempotency-Key");
	});
});

describe("session", () => {
	it("accepts the two auth modes and the two environments, and rejects others", () => {
		expectAccepted(sessionResponseSchema, {
			ownerId: "owner",
			authMode: "cloudflare-access",
			environment: "production",
		});
		expectAccepted(sessionResponseSchema, {
			ownerId: "owner",
			authMode: "local-dev",
			environment: "development",
		});
		expectRejected(
			sessionResponseSchema,
			{ ownerId: "owner", authMode: "anonymous", environment: "production" },
			["authMode"],
		);
		expectRejected(
			sessionResponseSchema,
			{ ownerId: "owner", authMode: "local-dev", environment: "staging" },
			["environment"],
		);
		expectRejected(sessionResponseSchema, { ownerId: "owner", authMode: "local-dev" }, [
			"environment",
		]);
		expectRejected(sessionResponseSchema, {
			ownerId: "owner",
			authMode: "local-dev",
			environment: "production",
			token: "t",
		});
	});
});

describe("source endpoints (FR-001 / FR-002)", () => {
	const preview = {
		canonicalUrl: "https://news.example.com/rss",
		sourceType: "rss",
		title: "Example Wire",
		siteLink: "https://news.example.com/",
		suggestedPublisher: "Example Media",
		itemCount: 20,
		rejectedItemCount: 1,
		sampleItems: [
			{
				title: "Battery makers expand",
				canonicalUrl: "https://news.example.com/a",
				publishedAt: null,
			},
		],
		alreadySubscribed: false,
	};
	const registration = {
		url: "https://news.example.com/rss",
		licensePolicy: "headline-and-link-only",
		trustClassification: "established-media",
	};
	const recommended = {
		catalogId: "cat_1",
		title: "Example Wire",
		publisher: "Example Media",
		feedUrl: "https://news.example.com/rss",
		homepageUrl: "https://news.example.com/",
		region: "JP",
		language: "ja",
		trustClassification: "established-media",
		licensePolicy: "headline-and-link-only",
		rationale: "Primary-source corporate announcements.",
		feedCheckedOn: "2026-10-11",
	};

	it("accepts a preview request and bounds the URL", () => {
		expectAccepted(previewSourceRequestSchema, { url: "https://news.example.com/rss" });
		expectRejected(previewSourceRequestSchema, { url: "" }, ["url"]);
		expectRejected(
			previewSourceRequestSchema,
			{ url: `https://x.example.org/${"a".repeat(2048)}` },
			["url"],
		);
		expectRejected(previewSourceRequestSchema, {}, ["url"]);
		expectRejected(previewSourceRequestSchema, {
			url: "https://news.example.com/rss",
			follow: true,
		});
	});

	it("accepts a source preview and bounds its sample", () => {
		expectAccepted(sourcePreviewSchema, preview);
		expectAccepted(sourcePreviewSchema, { ...preview, siteLink: null });
		expectRejected(
			sourcePreviewSchema,
			{ ...preview, sampleItems: repeat(preview.sampleItems[0], 6) },
			["sampleItems"],
		);
		expectRejected(
			sourcePreviewSchema,
			{ ...preview, canonicalUrl: "http://news.example.com/rss" },
			["canonicalUrl"],
		);
		expectRejected(sourcePreviewSchema, without(preview, "alreadySubscribed"), [
			"alreadySubscribed",
		]);
	});

	it("requires licensing and trust to be chosen when registering", () => {
		expectAccepted(registerSourceRequestSchema, registration);
		expectAccepted(registerSourceRequestSchema, { ...registration, title: "T", publisher: "P" });
		expectRejected(registerSourceRequestSchema, without(registration, "licensePolicy"), [
			"licensePolicy",
		]);
		expectRejected(registerSourceRequestSchema, without(registration, "trustClassification"), [
			"trustClassification",
		]);
		expectRejected(registerSourceRequestSchema, { ...registration, ownerId: "other" });
	});

	it("accepts a partial source update but not an empty one", () => {
		expectAccepted(updateSourceRequestSchema, { feedStatus: "paused" });
		expectAccepted(updateSourceRequestSchema, {
			title: "New",
			licensePolicy: "short-excerpt-permitted",
		});
		expectRejected(updateSourceRequestSchema, {});
	});

	it("does not let a client set server-owned source fields", () => {
		expectRejected(updateSourceRequestSchema, { feedStatus: "failing" }, ["feedStatus"]);
		expectRejected(updateSourceRequestSchema, { canonicalUrl: "https://other.example.org/rss" });
		expectRejected(updateSourceRequestSchema, { sourceId: "src_2" });
	});

	it("accepts source and article listings", () => {
		expectAccepted(sourceListResponseSchema, { sources: [newsSource] });
		expectAccepted(sourceListResponseSchema, { sources: [] });
		expectAccepted(articleListResponseSchema, { articles: [article], nextCursor: null });
		expectAccepted(articleListResponseSchema, { articles: [], nextCursor: "opaque" });
		expectRejected(articleListResponseSchema, { articles: [] }, ["nextCursor"]);
		expectRejected(sourceListResponseSchema, { sources: [{ ...newsSource, feedStatus: "x" }] }, [
			"sources",
			0,
			"feedStatus",
		]);
	});

	it("accepts a recommended source and requires its rationale and check date", () => {
		expectAccepted(recommendedSourceSchema, recommended);
		expectAccepted(recommendedSourcesResponseSchema, { entries: [recommended] });
		expectRejected(recommendedSourceSchema, without(recommended, "rationale"), ["rationale"]);
		expectRejected(recommendedSourceSchema, without(recommended, "feedCheckedOn"), [
			"feedCheckedOn",
		]);
		expectRejected(
			recommendedSourceSchema,
			{ ...recommended, feedUrl: "http://news.example.com/rss" },
			["feedUrl"],
		);
		expectRejected(recommendedSourceSchema, { ...recommended, region: "EU" }, ["region"]);
		expectRejected(recommendedSourceSchema, { ...recommended, language: "fr" }, ["language"]);
	});
});

describe("research run endpoints", () => {
	it("creates a run from a research request", () => {
		expectAccepted(createResearchRunRequestSchema, researchRequest);
		expectRejected(createResearchRunRequestSchema, without(researchRequest, "budget"), ["budget"]);
	});

	it.each([
		"abcdefgh",
		"A1b2C3d4-e5_f6",
		"k".repeat(64),
	])("accepts the idempotency key %s", (key) => {
		expectAccepted(idempotencyKeySchema, key);
	});

	it.each([
		"",
		"short",
		"has space!",
		"k".repeat(65),
		"ключ-ключ",
	])("rejects the idempotency key %j", (key) => {
		expectRejected(idempotencyKeySchema, key);
	});

	it("accepts run responses and listings", () => {
		expectAccepted(researchRunResponseSchema, { run: researchRun });
		expectAccepted(researchRunListResponseSchema, { runs: [researchRun, researchRun] });
		expectRejected(researchRunResponseSchema, { run: { ...researchRun, state: "running" } }, [
			"run",
			"state",
		]);
		expectRejected(researchRunResponseSchema, {}, ["run"]);
	});

	it("requires an explicit replacement budget to approve a waiting run", () => {
		expectAccepted(approveRunRequestSchema, { budget: { ...researchBudget, maxSpendUsd: 1 } });
		expectRejected(approveRunRequestSchema, {}, ["budget"]);
		expectRejected(approveRunRequestSchema, { budget: without(researchBudget, "maxSpendUsd") }, [
			"budget",
			"maxSpendUsd",
		]);
		expectRejected(approveRunRequestSchema, { budget: researchBudget, approveAll: true });
	});

	it("accepts run records and validates each nested record", () => {
		expectAccepted(runRecordsResponseSchema, runRecords);
		expectRejected(
			runRecordsResponseSchema,
			{ ...runRecords, securities: [{ ...runRecords.securities[0], exchange: "NASDAQ" }] },
			["securities", 0, "exchange"],
		);
		expectRejected(runRecordsResponseSchema, without(runRecords, "claims"), ["claims"]);
	});

	it("reports runner presence alongside the backends", () => {
		expectAccepted(agentsResponseSchema, {
			agents: [agentDescriptor],
			runnerLastSeenAt: null,
			runnerOnline: false,
		});
		expectAccepted(agentsResponseSchema, { agents: [], runnerLastSeenAt: T0, runnerOnline: true });
		expectRejected(agentsResponseSchema, { agents: [], runnerOnline: true }, ["runnerLastSeenAt"]);
	});
});

describe("workspace endpoints", () => {
	const view = {
		workspace: workspaceSummary,
		state: workspaceState,
		datasets: [dataset],
		sources: [evidence],
	};
	const event = { version: 5, command: SECTION_7_EXAMPLE_COMMAND, appliedAt: T1, origin: "agent" };

	it("accepts workspace summaries, listings and creation requests", () => {
		expectAccepted(workspaceSummarySchema, workspaceSummary);
		expectAccepted(workspaceListResponseSchema, { workspaces: [workspaceSummary] });
		expectAccepted(createWorkspaceRequestSchema, { title: "Energy storage" });
		expectRejected(createWorkspaceRequestSchema, { title: "   " }, ["title"]);
		expectRejected(createWorkspaceRequestSchema, { title: "T", workspaceId: "ws_chosen" });
		expectRejected(workspaceSummarySchema, { ...workspaceSummary, version: -1 }, ["version"]);
	});

	it("accepts a full workspace view and validates its nested state", () => {
		expectAccepted(workspaceViewSchema, view);
		expectRejected(workspaceViewSchema, without(view, "datasets"), ["datasets"]);
		expectRejected(
			workspaceViewSchema,
			{ ...view, state: { ...workspaceState, layout: { order: [], columns: 4 } } },
			["state", "layout", "columns"],
		);
		expectRejected(workspaceViewSchema, { ...view, assets: [] });
	});

	it("accepts workspace events and validates the embedded command", () => {
		expectAccepted(workspaceEventSchema, event);
		expectAccepted(workspaceEventSchema, { ...event, origin: "owner" });
		expectAccepted(workspaceEventsResponseSchema, { events: [event], currentVersion: 5 });
		expectAccepted(workspaceEventsResponseSchema, { events: [], currentVersion: 0 });
		expectRejected(workspaceEventSchema, { ...event, origin: "system" }, ["origin"]);
		expectRejected(workspaceEventSchema, { ...event, version: 0 }, ["version"]);
		expectRejected(
			workspaceEventSchema,
			{ ...event, command: { ...(event.command as object), operation: "component.eval" } },
			["command"],
		);
	});

	it("accepts a command submission response, including a replay", () => {
		expectAccepted(submitCommandResponseSchema, { state: workspaceState, replayed: false });
		expectAccepted(submitCommandResponseSchema, { state: workspaceState, replayed: true });
		expectRejected(submitCommandResponseSchema, { state: workspaceState }, ["replayed"]);
	});
});

describe("conversation", () => {
	it("accepts owner and assistant messages", () => {
		expectAccepted(chatMessageSchema, chatMessage);
		expectAccepted(chatMessageSchema, {
			...chatMessage,
			messageId: "msg_2",
			seq: 1,
			role: "assistant",
			runId: "run_1",
			claimIds: ["claim_1"],
		});
	});

	it("rejects other roles, oversized text and HTML payload fields", () => {
		expectRejected(chatMessageSchema, { ...chatMessage, role: "system" }, ["role"]);
		expectRejected(chatMessageSchema, { ...chatMessage, text: "x".repeat(6001) }, ["text"]);
		expectRejected(chatMessageSchema, { ...chatMessage, html: "<p>hi</p>" });
		expectRejected(chatMessageSchema, { ...chatMessage, seq: -1 }, ["seq"]);
	});

	it("returns the cited claims and evidence with the messages", () => {
		expectAccepted(conversationResponseSchema, {
			messages: [chatMessage],
			claims: [claim],
			evidence: [evidence],
			hasEarlier: false,
		});
		expectAccepted(conversationResponseSchema, {
			messages: [chatMessage],
			claims: [claim],
			evidence: [evidence],
			hasEarlier: true,
		});
		expectRejected(
			conversationResponseSchema,
			{ messages: [chatMessage], claims: [claim], hasEarlier: false },
			["evidence"],
		);
		expectRejected(
			conversationResponseSchema,
			{ messages: [chatMessage], claims: [claim], evidence: [evidence] },
			["hasEarlier"],
		);
	});
});

describe("runner credentials", () => {
	const credential = {
		credentialId: "cred_1",
		label: "Home PC",
		createdAt: T0,
		expiresAt: "2026-11-10T00:00:00Z",
		revokedAt: null,
		lastUsedAt: null,
	};

	it("accepts a runner credential record that never contains the token", () => {
		expectAccepted(runnerCredentialSchema, credential);
		expectAccepted(runnerCredentialListResponseSchema, { credentials: [credential] });
		expectRejected(runnerCredentialSchema, { ...credential, token: "t".repeat(48) });
		expectRejected(runnerCredentialSchema, { ...credential, tokenHash: "abc" });
		expectRejected(runnerCredentialSchema, without(credential, "expiresAt"), ["expiresAt"]);
		expectRejected(runnerCredentialSchema, { ...credential, expiresAt: null }, ["expiresAt"]);
	});

	it("bounds credential lifetime to between 1 and 90 days", () => {
		expectAccepted(issueRunnerCredentialRequestSchema, { label: "Home PC", expiresInDays: 1 });
		expectAccepted(issueRunnerCredentialRequestSchema, { label: "Home PC", expiresInDays: 90 });
		for (const expiresInDays of [0, 91, 365, 1.5, -1]) {
			expectRejected(issueRunnerCredentialRequestSchema, { label: "Home PC", expiresInDays }, [
				"expiresInDays",
			]);
		}
		expectRejected(issueRunnerCredentialRequestSchema, { label: "Home PC" }, ["expiresInDays"]);
	});

	it("returns a sufficiently long token exactly once, at issue time", () => {
		expectAccepted(issuedRunnerCredentialSchema, { credential, token: "t".repeat(40) });
		expectRejected(issuedRunnerCredentialSchema, { credential, token: "t".repeat(39) }, ["token"]);
		expectRejected(issuedRunnerCredentialSchema, { credential }, ["token"]);
	});
});

describe("researchExportSchema (FR-015)", () => {
	const exported = {
		format: "research-workspace-export",
		formatVersion: 1,
		exportedAt: T1,
		workspace: { title: "Energy storage", state: workspaceState },
		messages: [chatMessage],
		datasets: [dataset],
		records: runRecords,
	};

	it("accepts a version-1 export", () => {
		expect(EXPORT_FORMAT_VERSION).toBe(1);
		expectAccepted(researchExportSchema, exported);
	});

	it("round-trips through JSON unchanged", () => {
		const parsed = expectAccepted(researchExportSchema, exported);
		expect(expectAccepted(researchExportSchema, JSON.parse(JSON.stringify(parsed)))).toEqual(
			parsed,
		);
	});

	it.each([0, 2, 99, 1.5, "1", null])("rejects format version %j", (formatVersion) => {
		expectRejected(researchExportSchema, { ...exported, formatVersion }, ["formatVersion"]);
	});

	it("rejects a file with no version or the wrong format marker", () => {
		expectRejected(researchExportSchema, without(exported, "formatVersion"), ["formatVersion"]);
		expectRejected(researchExportSchema, { ...exported, format: "something-else" }, ["format"]);
		expectRejected(researchExportSchema, without(exported, "format"), ["format"]);
	});

	it("rejects an import whose nested records are invalid", () => {
		expectRejected(
			researchExportSchema,
			{
				...exported,
				records: {
					...runRecords,
					financialObservations: [
						{ ...runRecords.financialObservations[0], sourceEvidenceId: null },
					],
				},
			},
			["records", "financialObservations", 0, "sourceEvidenceId"],
		);
		expectRejected(
			researchExportSchema,
			{ ...exported, workspace: { title: "T", state: { ...workspaceState, version: -1 } } },
			["workspace", "state", "version"],
		);
		expectRejected(
			researchExportSchema,
			{ ...exported, datasets: [{ ...dataset, rows: [{ product: { v: null } }] }] },
			["datasets", 0, "rows", 0, "product", "reason"],
		);
	});

	it("rejects unknown top-level keys and non-object input", () => {
		expectRejected(researchExportSchema, { ...exported, secrets: { apiKey: "sk-test" } });
		for (const value of [null, "{}", [], 1]) expectRejected(researchExportSchema, value);
	});

	it("bounds messages and datasets", () => {
		expectRejected(researchExportSchema, { ...exported, messages: repeat(chatMessage, 2001) }, [
			"messages",
		]);
		expectRejected(researchExportSchema, { ...exported, datasets: repeat(dataset, 401) }, [
			"datasets",
		]);
	});

	it("rejects the withdrawn `assets` array", () => {
		// Pre-removal files carried owner-approved images here; the field no longer exists.
		expectRejected(researchExportSchema, { ...exported, assets: [] });
	});
});
