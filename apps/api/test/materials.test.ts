import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import {
	homeDataResponseSchema,
	marketCatalogResponseSchema,
	materialSeriesSchema,
} from "@research/contracts";
import { expect, it } from "vitest";
import { materialFixture } from "../../../examples/materials/fixture.ts";
import {
	body,
	claim,
	createHarness,
	createWorkspace,
	idempotencyKey,
	issueRunnerToken,
} from "./helpers.ts";

it("serves imported material prices from the database to Home and Notebook widgets", async () => {
	const h = createHarness();
	const response = await h.call("POST", "/materials/imports", materialFixture);
	expect(response.status).toBe(201);
	const catalog = await body(await h.call("GET", "/home/catalog"), marketCatalogResponseSchema);
	expect(catalog.entries).toContainEqual(
		expect.objectContaining({ seriesId: "materials:NDTESTV1", category: "commodity" }),
	);
	expect(
		(
			await h.call("PUT", "/home/dashboard", {
				dashboard: {
					schemaVersion: 2,
					widgets: [
						{
							widgetId: "material-chart",
							type: "line-chart",
							title: "Material chart",
							size: "medium",
							seriesIds: ["materials:NDTESTV1"],
							range: "max",
						},
						{
							widgetId: "material-table",
							type: "indicator-table",
							title: "Material indicators",
							size: "large",
							seriesIds: ["materials:NDTESTV1"],
						},
					],
				},
				expectedVersion: 0,
			})
		).status,
	).toBe(200);
	const home = await body(await h.call("GET", "/home/data"), homeDataResponseSchema);
	expect(home.series).toHaveLength(1);
	expect(home.series[0]).toMatchObject({
		provider: "materials",
		materialDetails: {
			product: "Neodymium oxide",
			grade: "Synthetic 99.5%",
			basis: "Synthetic ex-works China, VAT-exclusive",
			sourceId: "synthetic-a",
		},
		unit: "USD/kg product",
		publisher: "Synthetic material source A",
		observations: [
			["2026-01-01", 70.25],
			["2026-01-02", 72.5],
		],
	});
	const source = await body(
		await h.call("GET", "/materials/series/materials:NDTESTV1"),
		materialSeriesSchema,
	);
	expect(source.observations[1]?.materialsSourceUpdatedAt).toBe("2026-01-02T10:45:30.000Z");
	const rows = await env.DB.prepare(
		"SELECT materials_source_updated_at FROM metal_observation WHERE owner_id = ? ORDER BY observed_on",
	)
		.bind(h.ownerId)
		.all();
	expect(rows.results).toHaveLength(2);
	const audit = await env.DB.prepare(
		"SELECT detail FROM audit_log WHERE owner_id = ? AND action = 'materials.import'",
	)
		.bind(h.ownerId)
		.all();
	expect(audit.results).toEqual([{ detail: "series:1" }]);
	const workspace = await createWorkspace(h);
	const now = h.time.clock.nowIso();
	expect(
		(
			await h.call("PUT", `/workspaces/${workspace}/notebook`, {
				notebook: {
					widgets: [
						{
							widgetId: "nb-material",
							type: "line-chart",
							title: "Notebook material",
							size: "medium",
							seriesIds: ["materials:NDTESTV1"],
							range: "max",
							createdAt: now,
							updatedAt: now,
							revision: 1,
							origin: { kind: "owner", messageId: null, runId: null, componentId: null },
						},
					],
				},
				expectedVersion: 0,
			})
		).status,
	).toBe(200);
	const notebook = await body(
		await h.call("GET", `/workspaces/${workspace}/notebook/market-data`),
		homeDataResponseSchema,
	);
	expect(notebook.series).toEqual(home.series);
	// Removing widgets must not delete the authoritative material snapshots.
	await h.call("PUT", "/home/dashboard", {
		dashboard: { schemaVersion: 2, widgets: [] },
		expectedVersion: 1,
	});
	expect((await h.call("GET", "/materials/series/materials:NDTESTV1")).status).toBe(200);
});

it("isolates owners, preserves independent sources and atomically rejects changed snapshots", async () => {
	const h = createHarness();
	const first = materialFixture.series[0];
	if (first === undefined) throw new Error("fixture needs series");
	expect((await h.call("POST", "/materials/imports", materialFixture)).status).toBe(201);
	expect((await h.call("POST", "/materials/imports", materialFixture)).status).toBe(201);
	const other = createHarness();
	expect((await other.call("GET", "/materials/series/materials:NDTESTV1")).status).toBe(404);
	const otherCatalog = await body(
		await other.call("GET", "/home/catalog"),
		marketCatalogResponseSchema,
	);
	expect(otherCatalog.entries.some((entry) => entry.seriesId.startsWith("materials:"))).toBe(false);
	const second = {
		...first,
		seriesId: "materials:NDTESTV2",
		sourceId: "synthetic-b",
		title: "Synthetic source B",
	};
	expect(
		(
			await h.call("POST", "/materials/imports", {
				schemaVersion: 1,
				series: [second, { ...first, grade: "Changed" }],
			})
		).status,
	).toBe(409);
	expect((await h.call("GET", "/materials/series/materials:NDTESTV2")).status).toBe(404);
	expect(
		(await h.call("POST", "/materials/imports", { schemaVersion: 1, series: [second] })).status,
	).toBe(201);
	expect(
		(
			await h.call("POST", "/materials/imports", {
				schemaVersion: 1,
				series: [
					{
						...first,
						seriesId: "materials:BAD",
						observations: [
							{
								observedOn: "2026-01-02",
								valueDecimal: "1",
								materialsSourceUpdatedAt: "2026-02-30T00:00:00.000Z",
							},
						],
					},
				],
			})
		).status,
	).toBe(400);
});

it("imports through the SQL port with exact source timestamps", async () => {
	const h = createHarness();
	await expect(
		createD1Adapters(env.DB).materials.import(h.ownerId, materialFixture, h.time.clock.nowIso()),
	).resolves.toBe(true);
});

it("rejects overlong titles and future assessments without breaking the catalog", async () => {
	const h = createHarness();
	const series = materialFixture.series[0];
	if (series === undefined) throw new Error("fixture needs a series");
	expect(
		(
			await h.call("POST", "/materials/imports", {
				schemaVersion: 1,
				series: [{ ...series, title: "x".repeat(121) }],
			})
		).status,
	).toBe(400);
	expect(
		(
			await h.call("POST", "/materials/imports", {
				schemaVersion: 1,
				series: [
					{
						...series,
						observations: [
							{ observedOn: "2099-01-01", valueDecimal: "1", materialsSourceUpdatedAt: null },
						],
					},
				],
			})
		).status,
	).toBe(400);
	expect((await h.call("POST", "/materials/imports", materialFixture)).status).toBe(201);
	expect(
		(
			await h.call("POST", "/materials/imports", {
				schemaVersion: 1,
				series: [{ ...series, observations: [...series.observations].reverse() }],
			})
		).status,
	).toBe(201);
	expect((await h.call("GET", "/home/catalog")).status).toBe(200);
});

it("does not send database material series to external refresh providers", async () => {
	const h = createHarness();
	await h.call("POST", "/materials/imports", materialFixture);
	const saved = await h.call("PUT", "/home/dashboard", {
		expectedVersion: 0,
		dashboard: {
			schemaVersion: 2,
			widgets: [
				{
					widgetId: "material-metric",
					type: "market-metric",
					title: "Material",
					size: "small",
					seriesId: "materials:NDTESTV1",
				},
			],
		},
	});
	expect(saved.status).toBe(200);
	const token = await issueRunnerToken(h);
	expect((await h.call("POST", "/home/refresh", undefined, idempotencyKey())).status).toBe(202);
	const job = await claim(h, token);
	if (job?.kind !== "market-refresh") throw new Error("expected market refresh");
	expect(job.series).toEqual([]);
});

it("enforces the stored-series bound without truncating the catalog", async () => {
	const h = createHarness();
	const series = materialFixture.series[0];
	if (series === undefined) throw new Error("fixture needs a series");
	for (let batch = 0; batch < 10; batch += 1) {
		const entries = Array.from({ length: 20 }, (_, index) => ({
			...series,
			seriesId: `materials:N${batch * 20 + index}`,
		}));
		expect(
			(await h.call("POST", "/materials/imports", { schemaVersion: 1, series: entries })).status,
		).toBe(201);
	}
	expect((await h.call("POST", "/materials/imports", materialFixture)).status).toBe(409);
	const catalog = await body(await h.call("GET", "/home/catalog"), marketCatalogResponseSchema);
	expect(catalog.entries.filter((entry) => entry.seriesId.startsWith("materials:"))).toHaveLength(
		200,
	);
});

it("returns no material data or fabricated source before import and invalidates the data ETag after import", async () => {
	const h = createHarness();
	expect(
		(
			await h.call("PUT", "/home/dashboard", {
				expectedVersion: 0,
				dashboard: {
					schemaVersion: 2,
					widgets: [
						{
							widgetId: "missing",
							type: "market-metric",
							title: "Material",
							size: "small",
							seriesId: "materials:NDTESTV1",
						},
					],
				},
			})
		).status,
	).toBe(200);
	const before = await h.call("GET", "/home/data");
	const empty = await body(before, homeDataResponseSchema);
	expect(empty.series[0]).toMatchObject({
		sourceUrl: "",
		observations: [],
		unavailable: { code: "NO_DATA" },
	});
	const previousEtag = before.headers.get("ETag");
	expect(previousEtag).not.toBeNull();
	expect((await h.call("POST", "/materials/imports", materialFixture)).status).toBe(201);
	const after = await h.call(
		"GET",
		"/home/data",
		undefined,
		previousEtag === null ? {} : { "If-None-Match": previousEtag },
	);
	expect(after.status).toBe(200);
	expect(after.headers.get("ETag")).not.toBe(previousEtag);
});

it("keeps the catalog readable for valid astral Unicode product descriptions", async () => {
	const h = createHarness();
	const series = materialFixture.series[0];
	if (series === undefined) throw new Error("fixture needs series");
	expect(
		(
			await h.call("POST", "/materials/imports", {
				schemaVersion: 1,
				series: [
					{
						...series,
						product: "𠮷".repeat(100),
						grade: "😀".repeat(100),
						basis: "𠮷".repeat(100),
					},
				],
			})
		).status,
	).toBe(201);
	const catalog = await body(await h.call("GET", "/home/catalog"), marketCatalogResponseSchema);
	const description = catalog.entries.find(
		(entry) => entry.seriesId === series.seriesId,
	)?.description;
	expect(description?.length).toBeLessThanOrEqual(300);
	expect(description).not.toContain("\uFFFD");
});
