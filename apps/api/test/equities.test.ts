import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import { equityImportRecords } from "@research/application";
import {
	equityFactsResponseSchema,
	equityImportHistorySchema,
	equityImportResultSchema,
	equityImportSchema,
	equityIssuerListSchema,
	equityRecordsResponseSchema,
} from "@research/contracts";
import { equityFactVisible } from "@research/domain";
import { describe, expect, it } from "vitest";
import { equityFixture } from "../../../examples/equities/fixture.ts";
import { body, createHarness, idempotencyKey } from "./helpers.ts";

describe("equities library on the real database", () => {
	it("imports both markets, retains exact decimals and source/basis, and reads related records", async () => {
		const h = createHarness();
		const response = await h.call("POST", "/equities/imports", equityFixture, idempotencyKey());
		expect(response.status).toBe(201);
		const committed = await body(response, equityImportResultSchema);
		const issuers = await body(await h.call("GET", "/equities/issuers"), equityIssuerListSchema);
		expect(issuers.issuers).toHaveLength(2);
		expect(issuers.issuers.map((i) => i.symbols)).toContainEqual(["JP:999A"]);
		const facts = await body(
			await h.call("GET", "/equities/issuers/issuer_example_us/facts"),
			equityFactsResponseSchema,
		);
		expect(facts.facts[0]).toMatchObject({
			valueDecimal: "9007199254740993.25",
			statement: { accountingStandard: "US-GAAP", reportingCurrency: "USD" },
			document: { url: "https://example.com/us" },
			committedAt: committed.committedAt,
		});
		const related = await body(
			await h.call("GET", "/equities/issuers/issuer_example_us/records"),
			equityRecordsResponseSchema,
		);
		expect(related.records.map((r) => r.recordType)).toEqual(
			expect.arrayContaining(["issuer", "security", "listing", "filing", "price", "action"]),
		);
		const audit = await env.DB.prepare(
			"SELECT action FROM audit_log WHERE owner_id = ? AND resource = ?",
		)
			.bind(h.ownerId, committed.importId)
			.all();
		expect(audit.results).toHaveLength(1);
	});

	it("pins an ingestion snapshot across later imports and stamps commit order inside the batch", async () => {
		const h = createHarness();
		const first = await body(
			await h.call("POST", "/equities/imports", equityFixture, idempotencyKey()),
			equityImportResultSchema,
		);
		const snapshot = await body(
			await h.call("GET", "/equities/issuers/issuer_example_us/facts"),
			equityFactsResponseSchema,
		);
		const fact = equityFixture.facts[0];
		if (fact === undefined) throw new Error("missing fixture");
		const second = await body(
			await h.call(
				"POST",
				"/equities/imports",
				{
					schemaVersion: 1,
					coverageNote: "A later observation",
					facts: [{ ...fact, factId: "fact_later", valueDecimal: "43" }],
				},
				idempotencyKey(),
			),
			equityImportResultSchema,
		);
		expect(second.commitSequence).toBe(first.commitSequence + 1);
		expect(second.committedAt > first.committedAt).toBe(true);
		const replay = await body(
			await h.call(
				"GET",
				`/equities/issuers/issuer_example_us/facts?ingestionVersion=${snapshot.ingestionVersion}`,
			),
			equityFactsResponseSchema,
		);
		expect(replay).toEqual(snapshot);
		expect(
			(
				await body(
					await h.call("GET", "/equities/issuers/issuer_example_us/facts"),
					equityFactsResponseSchema,
				)
			).facts,
		).toHaveLength(2);
	});

	it("canonicalizes dimension keys and rejects duplicate metric versions", async () => {
		const h = createHarness();
		const key = idempotencyKey();
		const payload = {
			...equityFixture,
			facts: equityFixture.facts.map((f) => ({
				...f,
				dimensions: { geography: "JP", segment: "industrial" },
			})),
		};
		expect((await h.call("POST", "/equities/imports", payload, key)).status).toBe(201);
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{
						...payload,
						facts: payload.facts.map((f) => ({
							...f,
							dimensions: { segment: "industrial", geography: "JP" },
						})),
					},
					key,
				)
			).status,
		).toBe(200);
		const metric = equityFixture.metrics[0];
		if (metric === undefined) throw new Error("missing fixture");
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{
						schemaVersion: 1,
						coverageNote: "Duplicate metric",
						metrics: [
							{
								...metric,
								metricDefinitionId: "metric_wrong",
								definition: "A different definition",
							},
						],
					},
					idempotencyKey(),
				)
			).status,
		).toBe(409);
	});

	it("rejects oversized bodies before parsing and future retrieval timestamps", async () => {
		const h = createHarness();
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{ padding: "x".repeat(760_000) },
					idempotencyKey(),
				)
			).status,
		).toBe(413);
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{
						...equityFixture,
						documents: equityFixture.documents.map((d) => ({
							...d,
							retrievedAt: "2099-01-01T00:00:00.000Z",
						})),
					},
					idempotencyKey(),
				)
			).status,
		).toBe(422);
	});

	it("serializes concurrent retries and protects identities in the SQL commit guard", async () => {
		const h = createHarness();
		const key = idempotencyKey();
		const responses = await Promise.all([
			h.call("POST", "/equities/imports", equityFixture, key),
			h.call("POST", "/equities/imports", equityFixture, key),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
		const changed = equityImportSchema.parse({
			...equityFixture,
			facts: equityFixture.facts.map((f) => ({ ...f, valueDecimal: "1" })),
		});
		const repo = createD1Adapters(env.DB).equities;
		expect(
			await repo.commit(h.ownerId, {
				importId: "eqimp_guard",
				idempotencyKey: "guard",
				contentSha256: "a".repeat(64),
				receivedAt: h.time.clock.nowIso(),
				payload: changed,
				records: equityImportRecords(changed),
			}),
		).toBe(false);
		expect((await repo.listImports(h.ownerId, { limit: 100 })).imports).toHaveLength(1);
	});

	it("rolls back the entire database batch when a foreign key fails", async () => {
		const h = createHarness();
		const bad = equityImportSchema.parse({ ...equityFixture, securities: [] });
		const repo = createD1Adapters(env.DB).equities;
		await expect(
			repo.commit(h.ownerId, {
				importId: "eqimp_rollback",
				idempotencyKey: "rollback",
				contentSha256: "b".repeat(64),
				receivedAt: h.time.clock.nowIso(),
				payload: bad,
				records: equityImportRecords(bad),
			}),
		).rejects.toThrow();
		expect((await repo.listImports(h.ownerId, { limit: 100 })).imports).toEqual([]);
		expect((await repo.listIssuers(h.ownerId, { q: "", limit: 100 })).issuers).toEqual([]);
		expect(
			(
				await env.DB.prepare("SELECT count(*) AS total FROM equity_record WHERE owner_id = ?")
					.bind(h.ownerId)
					.first()
			)?.total,
		).toBe(0);
	});

	it("rejects ambiguous issuer identifiers and overlapping listing episodes", async () => {
		const h = createHarness();
		const identifier = {
			identifierId: "identifier_us",
			issuerId: "issuer_example_us",
			sourceDocumentId: "doc_example_us",
			scheme: "cik",
			value: "0000000001",
		};
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{
						...equityFixture,
						identifiers: [
							identifier,
							{ ...identifier, identifierId: "identifier_jp", issuerId: "issuer_example_jp" },
						],
					},
					idempotencyKey(),
				)
			).status,
		).toBe(422);
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{ ...equityFixture, identifiers: [identifier] },
					idempotencyKey(),
				)
			).status,
		).toBe(201);
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{
						schemaVersion: 1,
						coverageNote: "conflicting identifier",
						identifiers: [
							{ ...identifier, identifierId: "identifier_wrong", issuerId: "issuer_example_jp" },
						],
					},
					idempotencyKey(),
				)
			).status,
		).toBe(409);
		expect(
			(
				await h.call(
					"POST",
					"/equities/imports",
					{
						schemaVersion: 1,
						coverageNote: "conflicting listing",
						listings: [{ ...equityFixture.listings[0], listingId: "listing_overlap" }],
					},
					idempotencyKey(),
				)
			).status,
		).toBe(409);
	});

	it("reads FX and other catalog record kinds and paginates history by time", async () => {
		const h = createHarness();
		await h.call("POST", "/equities/imports", equityFixture, idempotencyKey());
		h.time.advance(1000);
		const later = await body(
			await h.call(
				"POST",
				"/equities/imports",
				{ ...equityFixture, coverageNote: "later import" },
				idempotencyKey(),
			),
			equityImportResultSchema,
		);
		const first = await body(
			await h.call("GET", "/equities/imports?limit=1"),
			equityImportHistorySchema,
		);
		expect(first.imports[0]?.importId).toBe(later.importId);
		const second = await body(
			await h.call(
				"GET",
				`/equities/imports?limit=1&after=${encodeURIComponent(first.nextCursor ?? "")}`,
			),
			equityImportHistorySchema,
		);
		expect(second.imports).toHaveLength(1);
		expect(second.imports[0]?.importId).not.toBe(later.importId);
		const fx = await body(
			await h.call("GET", "/equities/records?recordType=fx"),
			equityRecordsResponseSchema,
		);
		expect(fx.records[0]).toMatchObject({ recordType: "fx", body: { rateDecimal: "150.25" } });
	});

	it("imports and reads a bounded large statement using indexed joins", async ({ annotate }) => {
		const h = createHarness();
		const fact = equityFixture.facts[0];
		if (fact === undefined) throw new Error("missing fixture");
		const payload = {
			...equityFixture,
			facts: Array.from({ length: 1000 }, (_, n) => ({
				...fact,
				factId: `fact_load_${String(n).padStart(4, "0")}`,
				sourceLocator: `row/${n}`,
			})),
		};
		const start = performance.now();
		expect((await h.call("POST", "/equities/imports", payload, idempotencyKey())).status).toBe(201);
		const imported = performance.now();
		const facts = await body(
			await h.call("GET", "/equities/issuers/issuer_example_us/facts?limit=200"),
			equityFactsResponseSchema,
		);
		expect(facts.facts).toHaveLength(200);
		expect(facts.nextCursor).toBe("fact_load_0199");
		await annotate(
			`equities_1000_facts import_ms=${(imported - start).toFixed(2)} page_200_ms=${(performance.now() - imported).toFixed(2)}`,
		);
	});

	it("replays exact imports, rejects key/identity changes, and never overwrites an earlier fact", async () => {
		const h = createHarness();
		const key = idempotencyKey();
		const first = await body(
			await h.call("POST", "/equities/imports", equityFixture, key),
			equityImportResultSchema,
		);
		const replay = await h.call("POST", "/equities/imports", equityFixture, key);
		expect(replay.status).toBe(200);
		expect(await body(replay, equityImportResultSchema)).toMatchObject({
			...first,
			replayed: true,
		});
		const changed = { ...equityFixture, coverageNote: "different payload" };
		expect((await h.call("POST", "/equities/imports", changed, key)).status).toBe(409);
		const changedFact = {
			...equityFixture,
			facts: equityFixture.facts.map((f) => ({ ...f, valueDecimal: "1" })),
		};
		expect((await h.call("POST", "/equities/imports", changedFact, idempotencyKey())).status).toBe(
			409,
		);
		const history = await body(await h.call("GET", "/equities/imports"), equityImportHistorySchema);
		expect(history.imports).toHaveLength(1);
		const downloaded = await h.call("GET", `/equities/imports/${first.importId}`);
		expect(await downloaded.json()).toEqual(equityFixture);
	});

	it("rolls back invalid references and financial bases without even an import manifest", async () => {
		const h = createHarness();
		for (const payload of [
			{ ...equityFixture, securities: [] },
			{
				...equityFixture,
				facts: equityFixture.facts.map((f) => ({ ...f, statementId: "missing" })),
			},
			{ ...equityFixture, prices: equityFixture.prices.map((p) => ({ ...p, lowDecimal: "9999" })) },
			{ ...equityFixture, prices: equityFixture.prices.map((p) => ({ ...p, currency: "JPY" })) },
			{
				...equityFixture,
				actions: equityFixture.actions.map((a) => ({ ...a, ratioDenominator: "0" })),
			},
		])
			expect((await h.call("POST", "/equities/imports", payload, idempotencyKey())).status).toBe(
				422,
			);
		expect(
			(await body(await h.call("GET", "/equities/imports"), equityImportHistorySchema)).imports,
		).toEqual([]);
		expect(
			(await body(await h.call("GET", "/equities/issuers"), equityIssuerListSchema)).issuers,
		).toEqual([]);
	});

	it("isolates owners, authenticates reads and requires CSRF for writes", async () => {
		const a = createHarness();
		const b = createHarness();
		await a.call("POST", "/equities/imports", equityFixture, idempotencyKey());
		expect((await b.call("GET", "/equities/issuers/issuer_example_us/facts")).status).toBe(404);
		expect(
			(await b.raw("GET", "/equities/issuers", { headers: { "X-Test-Anonymous": "1" } })).status,
		).toBe(401);
		expect(
			(await b.raw("POST", "/equities/imports", { body: equityFixture, headers: idempotencyKey() }))
				.status,
		).toBe(403);
	});

	it("applies public and system cutoffs independently, including equality boundaries", async () => {
		const h = createHarness();
		h.time.advance(30 * 86_400_000);
		const committed = await body(
			await h.call("POST", "/equities/imports", equityFixture, idempotencyKey()),
			equityImportResultSchema,
		);
		for (const informationCutoff of [
			undefined,
			"2026-04-30T23:59:59.999Z",
			"2026-05-01T00:00:00.000Z",
		]) {
			for (const ingestionCutoff of [
				undefined,
				"2026-10-11T00:00:00.000Z",
				committed.committedAt,
			]) {
				const params = new URLSearchParams();
				if (informationCutoff !== undefined) params.set("informationCutoff", informationCutoff);
				if (ingestionCutoff !== undefined) params.set("ingestionCutoff", ingestionCutoff);
				const result = await body(
					await h.call("GET", `/equities/issuers/issuer_example_us/facts?${params}`),
					equityFactsResponseSchema,
				);
				const visible = equityFactVisible({
					availableAt: Date.parse("2026-05-01T00:00:00.000Z"),
					committedAt: Date.parse(committed.committedAt),
					informationCutoff: informationCutoff === undefined ? null : Date.parse(informationCutoff),
					ingestionCutoff: ingestionCutoff === undefined ? null : Date.parse(ingestionCutoff),
				});
				expect(result.facts.length).toBe(visible ? 1 : 0);
			}
		}
	});

	it("keeps amendments separate and rejects cross-issuer / cyclic amendments", async () => {
		const h = createHarness();
		await h.call("POST", "/equities/imports", equityFixture, idempotencyKey());
		const filing = equityFixture.filings.find((f) => f.issuerId === "issuer_example_us");
		const statement = equityFixture.statements.find(
			(s) => s.statementId === "statement_example_us",
		);
		const fact = equityFixture.facts.find((f) => f.factId === "fact_example_us");
		if (filing === undefined || statement === undefined || fact === undefined)
			throw new Error("missing fixture");
		const amendment = {
			schemaVersion: 1,
			coverageNote: "Amendment",
			filings: [
				{
					...filing,
					filingId: "filing_amendment",
					externalFilingId: "amendment",
					publicAvailableAt: "2026-06-01T00:00:00.000Z",
					amendmentOfFilingId: filing.filingId,
				},
			],
			statements: [
				{ ...statement, statementId: "statement_amendment", filingId: "filing_amendment" },
			],
			facts: [
				{
					...fact,
					factId: "fact_amendment",
					statementId: "statement_amendment",
					valueDecimal: "42",
				},
			],
		};
		expect((await h.call("POST", "/equities/imports", amendment, idempotencyKey())).status).toBe(
			201,
		);
		const historical = await body(
			await h.call(
				"GET",
				"/equities/issuers/issuer_example_us/facts?informationCutoff=2026-05-15T00:00:00.000Z",
			),
			equityFactsResponseSchema,
		);
		expect(historical.facts.map((f) => f.factId)).toEqual(["fact_example_us"]);
		const latest = await body(
			await h.call("GET", "/equities/issuers/issuer_example_us/facts"),
			equityFactsResponseSchema,
		);
		expect(latest.facts).toHaveLength(2);
		const bad = {
			...amendment,
			filings: [
				{ ...amendment.filings[0], filingId: "filing_wrong", issuerId: "issuer_example_jp" },
			],
			statements: [],
			facts: [],
		};
		expect((await h.call("POST", "/equities/imports", bad, idempotencyKey())).status).toBe(422);
	});

	it("paginates deterministically and searches local names and symbols", async () => {
		const h = createHarness();
		await h.call("POST", "/equities/imports", equityFixture, idempotencyKey());
		const first = await body(
			await h.call("GET", "/equities/issuers?limit=1"),
			equityIssuerListSchema,
		);
		const second = await body(
			await h.call("GET", `/equities/issuers?limit=1&after=${first.nextCursor}`),
			equityIssuerListSchema,
		);
		expect([...first.issuers, ...second.issuers].map((i) => i.issuerId)).toEqual([
			"issuer_example_jp",
			"issuer_example_us",
		]);
		for (const q of ["999A", "サンプル"])
			expect(
				(
					await body(
						await h.call("GET", `/equities/issuers?q=${encodeURIComponent(q)}`),
						equityIssuerListSchema,
					)
				).issuers.map((i) => i.issuerId),
			).toEqual(["issuer_example_jp"]);
	});
});
