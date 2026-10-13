import { env } from "cloudflare:test";
import {
	type ComponentDefinition,
	conversationResponseSchema,
	defineComponent,
	researchExportSchema,
	runRecordsResponseSchema,
	submitCommandResponseSchema,
	workspaceEventsResponseSchema,
	workspaceSummarySchema,
	workspaceViewSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	apiError,
	body,
	completeRun,
	createHarness,
	createWorkspace,
	errorCode,
	type Harness,
	issueRunnerToken,
} from "./helpers.ts";

async function view(harness: Harness, workspaceId: string) {
	return body(await harness.call("GET", `/workspaces/${workspaceId}`), workspaceViewSchema);
}

let commandCounter = 0;
function command(workspaceId: string, expectedWorkspaceVersion: number, operation: object) {
	commandCounter += 1;
	return {
		protocolVersion: 1,
		commandId: `cmd_${commandCounter}_${crypto.randomUUID().slice(0, 8)}`,
		workspaceId,
		expectedWorkspaceVersion,
		...operation,
	};
}

async function seeded() {
	const harness = createHarness();
	const workspaceId = await createWorkspace(harness);
	const token = await issueRunnerToken(harness);
	const { runId } = await completeRun(harness, token, workspaceId);
	return { harness, workspaceId, runId, token };
}

describe("workspace commands (section 7, UI-004/UI-006, hard gate 4)", () => {
	it("applies owner commands, bumps the version by one each, and survives reload", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const before = await view(harness, workspaceId);
		expect(before.state.version).toBe(2);

		const created = await body(
			await harness.call(
				"POST",
				`/workspaces/${workspaceId}/commands`,
				command(workspaceId, 2, {
					operation: "component.create",
					componentId: "news1",
					componentType: "news-card",
					schemaVersion: 1,
					props: { headline: "Grid storage orders rise", sourceId: `${runId}_ev1`, summary: null },
				}),
			),
			submitCommandResponseSchema,
		);
		expect(created.replayed).toBe(false);
		expect(created.state.version).toBe(3);

		const reordered = await body(
			await harness.call(
				"POST",
				`/workspaces/${workspaceId}/commands`,
				command(workspaceId, 3, {
					operation: "layout.update",
					order: ["news1", `${runId}_sources`, `${runId}_table`],
					columns: 2,
				}),
			),
			submitCommandResponseSchema,
		);
		expect(reordered.state.layout).toEqual({
			order: ["news1", `${runId}_sources`, `${runId}_table`],
			columns: 2,
		});

		await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			command(workspaceId, 4, { operation: "component.remove", componentId: `${runId}_table` }),
		);

		// "Reload": a fresh read returns exactly the accepted state.
		const after = await view(harness, workspaceId);
		expect(after.state.version).toBe(5);
		expect(after.state.components.map((component) => component.componentId)).toEqual([
			`${runId}_sources`,
			"news1",
		]);
		expect(after.state.layout.order).toEqual(["news1", `${runId}_sources`]);
		// The removed table's dataset is no longer shipped; the cited source still is.
		expect(after.datasets).toHaveLength(0);
		expect(after.sources.map((source) => source.evidenceId)).toEqual([`${runId}_ev1`]);

		const events = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/events?after=2`),
			workspaceEventsResponseSchema,
		);
		expect(events.currentVersion).toBe(5);
		expect(
			events.events.map((event) => [event.version, event.command.operation, event.origin]),
		).toEqual([
			[3, "component.create", "owner"],
			[4, "layout.update", "owner"],
			[5, "component.remove", "owner"],
		]);
		const all = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/events`),
			workspaceEventsResponseSchema,
		);
		expect(all.events.slice(0, 2).map((event) => event.origin)).toEqual(["agent", "agent"]);
	});

	it("applies a duplicate command id once and rejects reuse for a different command", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const focus = command(workspaceId, 2, {
			operation: "component.focus",
			componentId: `${runId}_table`,
		});
		const first = await body(
			await harness.call("POST", `/workspaces/${workspaceId}/commands`, focus),
			submitCommandResponseSchema,
		);
		const second = await body(
			await harness.call("POST", `/workspaces/${workspaceId}/commands`, focus),
			submitCommandResponseSchema,
		);
		expect(first).toMatchObject({ replayed: false });
		expect(second).toMatchObject({ replayed: true });
		expect(second.state.version).toBe(3);
		expect((await view(harness, workspaceId)).state.version).toBe(3);

		const reused = await harness.call("POST", `/workspaces/${workspaceId}/commands`, {
			...focus,
			componentId: `${runId}_sources`,
		});
		expect(reused.status).toBe(409);
		expect(await errorCode(reused)).toBe("CONFLICT");
	});

	it("rejects a stale expected version without changing anything", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const stale = await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			command(workspaceId, 1, { operation: "component.remove", componentId: `${runId}_table` }),
		);
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("VERSION_CONFLICT");
		expect((await view(harness, workspaceId)).state.components).toHaveLength(2);
	});

	it("lets exactly one of two concurrent commands at the same version win", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const send = (componentId: string) =>
			harness.call(
				"POST",
				`/workspaces/${workspaceId}/commands`,
				command(workspaceId, 2, { operation: "component.focus", componentId }),
			);
		const responses = await Promise.all([send(`${runId}_table`), send(`${runId}_sources`)]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
		expect((await view(harness, workspaceId)).state.version).toBe(3);
	});

	it.each([
		[
			"an unregistered component type",
			{
				operation: "component.create",
				componentId: "x1",
				componentType: "iframe-embed",
				schemaVersion: 1,
				props: {},
			},
			422,
			"UNKNOWN_COMPONENT_TYPE",
		],
		[
			"props carrying markup-bearing extra fields",
			{
				operation: "component.create",
				componentId: "x1",
				componentType: "source-list",
				schemaVersion: 1,
				props: { title: "t", sourceIds: ["RUN_ev1"], html: "<img src=x onerror=alert(1)>" },
			},
			422,
			"INVALID_PROPS",
		],
		[
			"an unsupported schema version",
			{
				operation: "component.create",
				componentId: "x1",
				componentType: "source-list",
				schemaVersion: 2,
				props: { title: "t", sourceIds: ["RUN_ev1"] },
			},
			422,
			"UNSUPPORTED_SCHEMA_VERSION",
		],
		[
			"a dataset the owner does not hold",
			{
				operation: "component.create",
				componentId: "x1",
				componentType: "data-table",
				schemaVersion: 1,
				props: { title: "t", datasetRef: "not_my_dataset", sourceIds: [] },
			},
			422,
			"UNKNOWN_DATASET",
		],
		[
			"a source id that is not stored evidence",
			{
				operation: "component.create",
				componentId: "x1",
				componentType: "news-card",
				schemaVersion: 1,
				props: { headline: "h", sourceId: "invented_source", summary: null },
			},
			422,
			"UNKNOWN_SOURCE",
		],
		[
			"an existing component id",
			{
				operation: "component.create",
				componentId: "RUN_table",
				componentType: "source-list",
				schemaVersion: 1,
				props: { title: "t", sourceIds: ["RUN_ev1"] },
			},
			422,
			"COMPONENT_EXISTS",
		],
		[
			"a missing component",
			{ operation: "component.remove", componentId: "ghost" },
			422,
			"COMPONENT_NOT_FOUND",
		],
		[
			"a layout that is not a permutation of the components",
			{ operation: "layout.update", order: ["RUN_table"], columns: 1 },
			422,
			"LAYOUT_MISMATCH",
		],
		[
			"navigation to evidence that is not stored",
			{ operation: "navigation.open", target: { kind: "evidence", evidenceId: "nope" } },
			422,
			"UNKNOWN_EVIDENCE",
		],
	])("rejects %s", async (_name, operation, status, detail) => {
		const { harness, workspaceId, runId } = await seeded();
		const resolved: unknown = JSON.parse(JSON.stringify(operation).replaceAll("RUN", runId));
		const response = await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			command(workspaceId, 2, z.record(z.string(), z.unknown()).parse(resolved)),
		);
		expect(response.status).toBe(status);
		const error = await apiError(response);
		expect(error.code).toBe("UI_COMMAND_REJECTED");
		expect(error.detail).toBe(detail);
		expect((await view(harness, workspaceId)).state.version).toBe(2);
	});

	it.each([
		["an unknown operation", { operation: "script.run", source: "alert(1)" }],
		[
			"an unknown protocol version",
			{ operation: "component.focus", componentId: "a", protocolVersion: 2 },
		],
		["extra envelope fields", { operation: "component.focus", componentId: "a", onload: "x" }],
		[
			"an external navigation target",
			{ operation: "navigation.open", target: { kind: "url", url: "https://evil.example" } },
		],
	])("rejects %s at the protocol boundary", async (_name, operation) => {
		const { harness, workspaceId } = await seeded();
		const response = await harness.call("POST", `/workspaces/${workspaceId}/commands`, {
			...command(workspaceId, 2, {}),
			...operation,
		});
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
	});

	it("rejects a command addressed to a different workspace than the URL", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const other = await createWorkspace(harness, "Other");
		const response = await harness.call(
			"POST",
			`/workspaces/${other}/commands`,
			command(workspaceId, 0, { operation: "component.focus", componentId: `${runId}_table` }),
		);
		expect(response.status).toBe(422);
	});

	it("answers conditional reads with 304 until the workspace changes", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const first = await harness.call("GET", `/workspaces/${workspaceId}`);
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		const unchanged = await harness.raw("GET", `/workspaces/${workspaceId}`, {
			headers: { "If-None-Match": etag ?? "" },
		});
		expect(unchanged.status).toBe(304);

		await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			command(workspaceId, 2, { operation: "component.focus", componentId: `${runId}_table` }),
		);
		const changed = await harness.raw("GET", `/workspaces/${workspaceId}`, {
			headers: { "If-None-Match": etag ?? "" },
		});
		expect(changed.status).toBe(200);
	});
});

describe("extension components (FR-013, hard gate 9)", () => {
	const timelineProps = z.strictObject({
		title: z.string().min(1).max(100),
		sourceIds: z.array(z.string()).min(1),
	});
	const timeline: ComponentDefinition = defineComponent({
		componentType: "timeline",
		schemaVersion: 1,
		propsSchema: timelineProps,
		capabilities: ["sources"],
		requiredPermission: "owner",
		references: (props) => ({ datasetRefs: [], sourceIds: props.sourceIds }),
		migrations: {},
	});

	it("accepts a component type registered at the composition root, with no core change", async () => {
		const base = await seeded();
		const createTimeline = (harness: Harness) =>
			harness.call(
				"POST",
				`/workspaces/${base.workspaceId}/commands`,
				command(base.workspaceId, 2, {
					operation: "component.create",
					componentId: "timeline1",
					componentType: "timeline",
					schemaVersion: 1,
					props: { title: "Milestones", sourceIds: [`${base.runId}_ev1`] },
				}),
			);
		// Without the extension the type is unknown and denied.
		expect(await errorCode(await createTimeline(base.harness))).toBe("UI_COMMAND_REJECTED");

		const extended = createHarness({ ownerId: base.harness.ownerId, extraComponents: [timeline] });
		const response = await createTimeline(extended);
		expect(response.status).toBe(200);
		const state = (await body(response, submitCommandResponseSchema)).state;
		expect(state.components.at(-1)).toMatchObject({
			componentId: "timeline1",
			componentType: "timeline",
		});
		// The extension's own reference rules are enforced too.
		const bad = await extended.call(
			"POST",
			`/workspaces/${base.workspaceId}/commands`,
			command(base.workspaceId, 3, {
				operation: "component.create",
				componentId: "timeline2",
				componentType: "timeline",
				schemaVersion: 1,
				props: { title: "Milestones", sourceIds: ["invented"] },
			}),
		);
		expect((await apiError(bad)).detail).toBe("UNKNOWN_SOURCE");
	});
});

describe("withdrawn approved images (owner decision 2026-10-13)", () => {
	/**
	 * A workspace as stored before the removal: its canvas state and command
	 * history name an `image-gallery` component. Written with plain SQL because
	 * the API no longer accepts the withdrawn type.
	 */
	async function seedLegacyWorkspace(harness: Harness) {
		const workspaceId = `ws_legacy_${crypto.randomUUID().slice(0, 8)}`;
		const at = harness.time.clock.nowIso();
		const galleryCreate = {
			protocolVersion: 1,
			commandId: "cmd_legacy_gallery",
			workspaceId,
			expectedWorkspaceVersion: 1,
			operation: "component.create",
			componentId: "gallery_1",
			componentType: "image-gallery",
			schemaVersion: 1,
			props: { title: "Plant photos", images: [{ assetRef: "asset_1", caption: null }] },
		};
		const state = {
			workspaceId,
			version: 2,
			components: [
				{
					componentId: "table_1",
					componentType: "data-table",
					schemaVersion: 1,
					props: { title: "Demand", datasetRef: "ds_1", sourceIds: [] },
				},
				{
					componentId: "gallery_1",
					componentType: "image-gallery",
					schemaVersion: 1,
					props: { title: "Plant photos", images: [{ assetRef: "asset_1", caption: null }] },
				},
			],
			layout: { order: ["table_1", "gallery_1"], columns: 1 },
			focusedComponentId: "gallery_1",
			selection: { componentId: "gallery_1", itemKey: "img_0" },
			lastNavigation: null,
		};
		const tableCreate = {
			protocolVersion: 1,
			commandId: "cmd_legacy_table",
			workspaceId,
			expectedWorkspaceVersion: 0,
			operation: "component.create",
			componentId: "table_1",
			componentType: "data-table",
			schemaVersion: 1,
			props: { title: "Demand", datasetRef: "ds_1", sourceIds: [] },
		};
		await env.DB.prepare(
			`INSERT INTO workspaces (owner_id, workspace_id, title, version, state_json, last_mutation_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				harness.ownerId,
				workspaceId,
				"Legacy research",
				2,
				JSON.stringify(state),
				crypto.randomUUID(),
				at,
				at,
			)
			.run();
		for (const [version, command] of [
			[1, tableCreate],
			[2, galleryCreate],
		] as const) {
			await env.DB.prepare(
				`INSERT INTO workspace_commands (owner_id, workspace_id, command_id, version, command_json, origin, applied_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					harness.ownerId,
					workspaceId,
					command.commandId,
					version,
					JSON.stringify(command),
					"owner",
					at,
				)
				.run();
		}
		return workspaceId;
	}

	it("has no approved_assets table left", async () => {
		const harness = createHarness();
		const gone = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approved_assets'",
		)
			.bind()
			.first();
		expect(gone).toBeNull();
		// The migration only drops that table.
		const kept = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
		)
			.bind()
			.first<{ name: string }>();
		expect(kept?.name).toBe("workspaces");
		expect(harness.ownerId).toContain("owner-");
	});

	it("keeps a pre-removal conversation loading through view, events and export with a consistent version sequence", async () => {
		const harness = createHarness();
		const workspaceId = await seedLegacyWorkspace(harness);

		const seen = await view(harness, workspaceId);
		expect(seen.state.version).toBe(2);
		expect(seen.state.components.map((component) => component.componentType)).toEqual([
			"data-table",
		]);
		expect(seen.state.layout.order).toEqual(["table_1"]);
		expect(seen.state.focusedComponentId).toBeNull();
		expect(seen.state.selection).toBeNull();
		expect(seen).not.toHaveProperty("assets");

		// History is preserved verbatim, so a client polling after its last seen
		// version sees the same sequence with no gaps.
		const fromStart = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/events?after=0`),
			workspaceEventsResponseSchema,
		);
		expect(fromStart.currentVersion).toBe(2);
		expect(fromStart.events.map((event) => event.version)).toEqual([1, 2]);
		const caughtUp = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/events?after=2`),
			workspaceEventsResponseSchema,
		);
		expect(caughtUp.events).toEqual([]);
		expect(caughtUp.currentVersion).toBe(2);

		const exported = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/export`),
			researchExportSchema,
		);
		expect(exported.workspace.state.components.map((component) => component.componentType)).toEqual(
			["data-table"],
		);
		expect(exported).not.toHaveProperty("assets");

		// The stripped state keeps compare-and-set working: the next command applies at version 2.
		const focused = await body(
			await harness.call(
				"POST",
				`/workspaces/${workspaceId}/commands`,
				command(workspaceId, 2, { operation: "component.focus", componentId: "table_1" }),
			),
			submitCommandResponseSchema,
		);
		expect(focused.state.version).toBe(3);
		expect(focused.state.focusedComponentId).toBe("table_1");
	});

	it("rejects a new image-gallery command as an unknown component type", async () => {
		const harness = createHarness();
		const workspaceId = await createWorkspace(harness);
		const response = await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			command(workspaceId, 0, {
				operation: "component.create",
				componentId: "gallery",
				componentType: "image-gallery",
				schemaVersion: 1,
				props: { title: "Images", images: [{ assetRef: "asset_1", caption: null }] },
			}),
		);
		expect(response.status).toBe(422);
		const error = await apiError(response);
		expect(error.code).toBe("UI_COMMAND_REJECTED");
		expect(error.detail).toBe("UNKNOWN_COMPONENT_TYPE");
	});

	it("refuses to import an older file with images, naming the reason", async () => {
		const { harness, workspaceId } = await seeded();
		const exported = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/export`),
			researchExportSchema,
		);
		const galleryState = {
			...exported.workspace.state,
			components: [
				...exported.workspace.state.components,
				{
					componentId: "gallery_1",
					componentType: "image-gallery",
					schemaVersion: 1,
					props: { title: "Plant photos", images: [{ assetRef: "asset_1", caption: null }] },
				},
			],
			layout: {
				...exported.workspace.state.layout,
				order: [...exported.workspace.state.layout.order, "gallery_1"],
			},
		};
		const withGallery = await harness.call("POST", "/workspaces/import", {
			...exported,
			workspace: { ...exported.workspace, state: galleryState },
		});
		expect(withGallery.status).toBe(400);
		const galleryError = await apiError(withGallery);
		expect(galleryError.code).toBe("VALIDATION_FAILED");
		expect(galleryError.message).toContain("approved images");

		const withAssets = await harness.call("POST", "/workspaces/import", {
			...exported,
			assets: [
				{
					assetId: "asset_1",
					imageUrl: "https://images.example.org/a.png",
					altText: "A plant",
					permissionBasis: "Press kit.",
					sourceEvidenceId: null,
					createdAt: "2026-10-11T00:00:00Z",
				},
			],
		});
		expect(withAssets.status).toBe(400);
		const assetsError = await apiError(withAssets);
		expect(assetsError.code).toBe("VALIDATION_FAILED");
		expect(assetsError.message).toContain("approved images");
	});

	it("imports an older file without images that still carries an empty assets array", async () => {
		const { harness, workspaceId } = await seeded();
		const exported = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/export`),
			researchExportSchema,
		);
		const legacy = { ...exported, assets: [] };
		const imported = await harness.call("POST", "/workspaces/import", legacy);
		expect(imported.status).toBe(201);
		const summary = await body(imported, workspaceSummarySchema);
		expect((await view(harness, summary.workspaceId)).state.version).toBe(
			exported.workspace.state.version,
		);
	});
});

describe("export and import (FR-015)", () => {
	it("exports a versioned record with citations and re-imports it under fresh ids", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const exported = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/export`),
			researchExportSchema,
		);
		expect(exported.formatVersion).toBe(1);
		expect(exported.records.evidence.map((item) => item.evidenceId)).toEqual([`${runId}_ev1`]);
		expect(exported.records.claims).toHaveLength(1);
		expect(exported.datasets).toHaveLength(1);
		expect(exported.messages).toHaveLength(2);

		const markdown = await harness.call("GET", `/workspaces/${workspaceId}/export?format=markdown`);
		expect(markdown.headers.get("Content-Type")).toContain("text/markdown");
		const text = await markdown.text();
		expect(text).toContain("## Sources");
		expect(text).toContain("<https://news.example.org/articles/grid-storage>");
		expect(text).toContain("Grid storage orders reached 100 GWh in 2026. [1]");
		expect(text).toContain("| Base | 207.36 | 20.00% |");
		expect(text).toContain("N/A — no licensed price source configured");
		expect(text).toContain("not investment advice");

		const imported = await harness.call("POST", "/workspaces/import", exported);
		expect(imported.status).toBe(201);
		const summary = await body(imported, workspaceSummarySchema);
		expect(summary.workspaceId).not.toBe(workspaceId);
		expect(summary.title).toBe("Test workspace (imported)");

		const copy = await view(harness, summary.workspaceId);
		expect(copy.state.components.map((component) => component.componentType)).toEqual([
			"data-table",
			"source-list",
		]);
		// Every reference was re-keyed and still resolves; nothing points at the original run.
		expect(copy.datasets).toHaveLength(1);
		expect(copy.sources).toHaveLength(1);
		const referenced = JSON.stringify([
			copy.datasets,
			copy.sources,
			copy.state.components.map((c) => c.props),
		]);
		expect(referenced).not.toContain(runId);
		const conversation = await body(
			await harness.call("GET", `/workspaces/${summary.workspaceId}/messages`),
			conversationResponseSchema,
		);
		expect(conversation.messages).toHaveLength(2);
		expect(conversation.claims).toHaveLength(1);
		expect(conversation.evidence).toHaveLength(1);

		// The original is untouched, and a second import does not collide with the first.
		const original = await body(
			await harness.call("GET", `/research-runs/${runId}/records`),
			runRecordsResponseSchema,
		);
		expect(original.evidence).toHaveLength(1);
		expect((await harness.call("POST", "/workspaces/import", exported)).status).toBe(201);
	});

	it("rejects malformed, wrongly-versioned and internally inconsistent files", async () => {
		const { harness, workspaceId } = await seeded();
		const exported = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/export`),
			researchExportSchema,
		);

		const garbage = await harness.call("POST", "/workspaces/import", { hello: "world" });
		expect(garbage.status).toBe(400);
		expect(await errorCode(garbage)).toBe("VALIDATION_FAILED");

		const future = await harness.call("POST", "/workspaces/import", {
			...exported,
			formatVersion: 2,
		});
		expect(future.status).toBe(422);
		expect(await errorCode(future)).toBe("UNSUPPORTED_EXPORT_VERSION");

		const dangling = await harness.call("POST", "/workspaces/import", {
			...exported,
			records: { ...exported.records, evidence: [] },
		});
		expect(dangling.status).toBe(422);
		expect(await errorCode(dangling)).toBe("INTEGRITY_VIOLATION");

		const smuggled = await harness.call("POST", "/workspaces/import", {
			...exported,
			workspace: {
				...exported.workspace,
				state: {
					...exported.workspace.state,
					components: [
						{
							componentId: "x",
							componentType: "raw-html",
							schemaVersion: 1,
							props: { html: "<script>" },
						},
					],
					layout: { order: ["x"], columns: 1 },
				},
			},
		});
		expect(smuggled.status).toBe(422);
		expect(await errorCode(smuggled)).toBe("UI_COMMAND_REJECTED");
	});
});

describe("report badges are bound to stored claims (AGT-013, DATA-001)", () => {
	const report = (
		workspaceId: string,
		statement: { claimId: string | null; claimType: string | null; status: string | null },
	) =>
		command(workspaceId, 2, {
			operation: "component.create",
			componentId: "my_report",
			componentType: "research-report",
			schemaVersion: 1,
			props: {
				title: "Report",
				generatedAt: "2026-10-11T00:00:00.000Z",
				dataCutoffAt: "2026-10-11T00:00:00.000Z",
				sections: [
					{
						heading: "Findings",
						statements: [{ text: "Orders will triple.", sourceIds: [], ...statement }],
					},
				],
				disclaimer: "Not investment advice.",
			},
		});

	it("accepts a statement that presents a stored claim exactly as verified", async () => {
		const { harness, workspaceId, runId } = await seeded();
		const response = await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			report(workspaceId, {
				claimId: `${runId}_cl1`,
				claimType: "observation",
				status: "supported",
			}),
		);
		expect(response.status).toBe(200);
	});

	it.each([
		[
			"a 'supported' badge with no claim behind it",
			{ claimId: null, claimType: "observation", status: "supported" },
			422,
			"UI_COMMAND_REJECTED",
			"INVALID_PROPS",
		],
		[
			"a claim id that does not exist",
			{ claimId: "invented_claim", claimType: "observation", status: "supported" },
			422,
			"UI_COMMAND_REJECTED",
			"UNKNOWN_CLAIM",
		],
		[
			"a stored claim relabelled with another type",
			{ claimId: "RUN_cl1", claimType: "forecast", status: "supported" },
			422,
			"UI_COMMAND_REJECTED",
			"CLAIM_MISMATCH",
		],
		[
			"a stored claim shown with another status",
			{ claimId: "RUN_cl1", claimType: "observation", status: "conflicting" },
			422,
			"UI_COMMAND_REJECTED",
			"CLAIM_MISMATCH",
		],
	])("rejects %s", async (_name, statement, status, code, detail) => {
		const { harness, workspaceId, runId } = await seeded();
		const response = await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			report(workspaceId, {
				...statement,
				claimId: statement.claimId === "RUN_cl1" ? `${runId}_cl1` : statement.claimId,
			}),
		);
		expect(response.status).toBe(status);
		const error = await apiError(response);
		expect(error.code).toBe(code);
		expect(error.detail).toBe(detail);
		expect((await view(harness, workspaceId)).state.version).toBe(2);
	});

	it("allows a free-form note, which carries no badge", async () => {
		const { harness, workspaceId } = await seeded();
		const response = await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			report(workspaceId, { claimId: null, claimType: null, status: null }),
		);
		expect(response.status).toBe(200);
	});

	it("refuses to import a file whose report contradicts its own claim records", async () => {
		const { harness, workspaceId, runId } = await seeded();
		await harness.call(
			"POST",
			`/workspaces/${workspaceId}/commands`,
			report(workspaceId, {
				claimId: `${runId}_cl1`,
				claimType: "observation",
				status: "supported",
			}),
		);
		const exported = await body(
			await harness.call("GET", `/workspaces/${workspaceId}/export`),
			researchExportSchema,
		);
		// A faithful export imports fine.
		expect((await harness.call("POST", "/workspaces/import", exported)).status).toBe(201);

		// Tamper: the claim record says "unsupported" while the report still shows "supported".
		const tampered = {
			...exported,
			records: {
				...exported.records,
				claims: exported.records.claims.map((claim) => ({
					...claim,
					status: "unsupported",
					links: [],
				})),
			},
		};
		const response = await harness.call("POST", "/workspaces/import", tampered);
		expect(response.status).toBe(422);
		expect(await errorCode(response)).toBe("UI_COMMAND_REJECTED");
	});
});
