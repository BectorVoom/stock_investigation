import {
	EQUITY_LIMITS,
	equityCursorQuerySchema,
	equityFactQuerySchema,
	equityFactsResponseSchema,
	equityImportHistorySchema,
	equityImportPageQuerySchema,
	equityImportResultSchema,
	equityImportSchema,
	equityIssuerListSchema,
	equityPageQuerySchema,
	equityRecordQuerySchema,
	equityRecordsResponseSchema,
} from "@research/contracts";
import { attempt, type EventLogger } from "@research/effects";
import { Effect } from "effect";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	type AppEnv,
	idempotencyKey,
	pathId,
	readJson,
	readQuery,
	respond,
	useCase,
} from "./http.ts";

/** Mounted only on the owner-authenticated, CSRF-protected API router. */
export function registerEquityRoutes(api: Hono<AppEnv>, logger: EventLogger): void {
	api.get("/equities/records", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const query = yield* readQuery(c, equityRecordQuerySchema);
				const result = yield* attempt("equities.list_records", () =>
					c.var.services.equities.listRecords(c.var.owner.ownerId, query),
				);
				return c.json(equityRecordsResponseSchema.parse(result));
			}),
		),
	);
	api.get("/equities/issuers", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const query = yield* readQuery(c, equityPageQuerySchema);
				const result = yield* attempt("equities.list_issuers", () =>
					c.var.services.equities.listIssuers(c.var.owner.ownerId, query),
				);
				return c.json(equityIssuerListSchema.parse(result));
			}),
		),
	);
	api.get("/equities/issuers/:issuerId/facts", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const id = yield* pathId(c, "issuerId");
				const query = yield* readQuery(c, equityFactQuerySchema);
				const result = yield* useCase("equities.facts", () =>
					c.var.services.equities.facts(c.var.owner.ownerId, id, query),
				);
				return c.json(equityFactsResponseSchema.parse(result));
			}),
		),
	);
	api.get("/equities/issuers/:issuerId/records", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const id = yield* pathId(c, "issuerId");
				const query = yield* readQuery(c, equityCursorQuerySchema);
				const result = yield* useCase("equities.records", () =>
					c.var.services.equities.records(c.var.owner.ownerId, id, query),
				);
				return c.json(equityRecordsResponseSchema.parse(result));
			}),
		),
	);
	api.post(
		"/equities/imports",
		bodyLimit({
			maxSize: EQUITY_LIMITS.maxImportBytes,
			onError: (c) =>
				c.json(
					{
						error: { code: "PAYLOAD_TOO_LARGE", message: "Equity import exceeds the byte limit." },
					},
					413,
				),
		}),
		(c) =>
			respond(
				c,
				logger,
				Effect.gen(function* () {
					const key = yield* idempotencyKey(c);
					const payload = yield* readJson(c, equityImportSchema);
					const result = yield* useCase("equities.import", () =>
						c.var.services.equities.import(c.var.owner.ownerId, payload, key),
					);
					return c.json(equityImportResultSchema.parse(result), result.replayed ? 200 : 201);
				}),
			),
	);
	api.get("/equities/imports", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const query = yield* readQuery(c, equityImportPageQuerySchema);
				const result = yield* attempt("equities.list_imports", () =>
					c.var.services.equities.listImports(c.var.owner.ownerId, query),
				);
				return c.json(equityImportHistorySchema.parse(result));
			}),
		),
	);
	api.get("/equities/imports/:importId", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const id = yield* pathId(c, "importId");
				const result = yield* useCase("equities.get_import", () =>
					c.var.services.equities.getImport(c.var.owner.ownerId, id),
				);
				return c.json(equityImportSchema.parse(result));
			}),
		),
	);
}
