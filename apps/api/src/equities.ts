import {
	equityCompanyListSchema,
	equityCompanyViewSchema,
	equityMetricQuerySchema,
	equityMetricSeriesResponseSchema,
	equityRevisionsQuerySchema,
	equityRevisionsResponseSchema,
	equityStatementResponseSchema,
	equityStatementSchema,
	equityYearsQuerySchema,
	trackEquityCompanyRequestSchema,
} from "@research/contracts";
import { attempt, type EventLogger } from "@research/effects";
import { Effect } from "effect";
import type { Hono } from "hono";
import {
	type AppContext,
	type AppEnv,
	conditionalJson,
	fingerprint,
	HttpFailure,
	pathId,
	readJson,
	readQuery,
	respond,
	useCase,
} from "./http.ts";

/**
 * Annual financial statements (ADR-0048 §7): tracked companies, their sync
 * status, and the statements, metric series and revisions read from the
 * stored projection. Nothing here contacts SEC or EDINET — only the runner
 * does. Owner authentication and CSRF are inherited from the API router.
 */
export function registerEquityRoutes(api: Hono<AppEnv>, logger: EventLogger): void {
	const owner = (c: AppContext) => c.var.owner.ownerId;

	/** The company the path names (tracked or not), with its ETag basis. */
	const companyOf = (c: AppContext) =>
		Effect.gen(function* () {
			const companyId = yield* Effect.mapError(
				pathId(c, "companyId"),
				() =>
					new HttpFailure({
						error: { code: "EQUITY_COMPANY_NOT_FOUND", message: "The company is not tracked." },
					}),
			);
			return yield* useCase("equities.company", () =>
				c.var.services.equitySync.company(owner(c), companyId),
			);
		});

	/**
	 * The validator of a read: the time the company's values last changed
	 * and the company view the body embeds (its sync status moves with every
	 * check, so a revision added without a value change is covered too).
	 */
	const versionOf = (
		read: string,
		company: { readonly view: unknown; readonly dataUpdatedAt: string | null },
	) =>
		`equity.${read}.${company.dataUpdatedAt ?? "none"}.${fingerprint(JSON.stringify(company.view))}`;

	/** 304 before any statement query when the client holds this version. */
	const notModified = (c: AppContext, version: string): Response | null => {
		const etag = `"${version}"`;
		if (c.req.header("If-None-Match") !== etag) return null;
		c.header("ETag", etag);
		c.header("Cache-Control", "private, no-cache");
		return c.body(null, 304);
	};

	api.get("/equities/companies", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const list = yield* useCase("equities.list", () =>
					c.var.services.equitySync.list(owner(c)),
				);
				const parsed = equityCompanyListSchema.parse(list);
				return conditionalJson(
					c,
					`equity.companies.${fingerprint(JSON.stringify(parsed))}`,
					parsed,
				);
			}),
		),
	);

	api.post("/equities/companies", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, trackEquityCompanyRequestSchema);
				const tracked = yield* useCase("equities.track", () =>
					c.var.services.equitySync.track(owner(c), body.stockId),
				);
				return c.json(equityCompanyViewSchema.parse(tracked.company), tracked.created ? 201 : 200);
			}),
		),
	);

	api.get("/equities/companies/:companyId", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const company = yield* companyOf(c);
				const parsed = equityCompanyViewSchema.parse(company.view);
				return conditionalJson(c, versionOf("company", company), parsed);
			}),
		),
	);

	api.delete("/equities/companies/:companyId", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const company = yield* companyOf(c);
				yield* useCase("equities.untrack", () =>
					c.var.services.equitySync.untrack(owner(c), company.view.companyId),
				);
				return c.body(null, 204);
			}),
		),
	);

	api.post("/equities/companies/:companyId/sync", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const company = yield* companyOf(c);
				const view = yield* useCase("equities.sync_now", () =>
					c.var.services.equitySync.syncNow(owner(c), company.view.companyId),
				);
				return c.json(equityCompanyViewSchema.parse(view), 202);
			}),
		),
	);

	api.get("/equities/companies/:companyId/statements/:statement", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const statement = equityStatementSchema.safeParse(c.req.param("statement"));
				if (!statement.success) {
					return yield* Effect.fail(
						new HttpFailure({ error: { code: "NOT_FOUND", message: "Resource not found." } }),
					);
				}
				const query = yield* readQuery(c, equityYearsQuerySchema);
				const company = yield* companyOf(c);
				const version = versionOf(`statement.${statement.data}.${query.years}`, company);
				const unchanged = notModified(c, version);
				if (unchanged !== null) return unchanged;
				const response = yield* attempt("equities.statement", () =>
					c.var.services.equitySync.statement(owner(c), company, statement.data, query.years),
				);
				return conditionalJson(c, version, equityStatementResponseSchema.parse(response));
			}),
		),
	);

	api.get("/equities/companies/:companyId/metrics", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const query = yield* readQuery(c, equityMetricQuerySchema);
				const company = yield* companyOf(c);
				const version = versionOf(`metric.${query.metric}.${query.years}`, company);
				const unchanged = notModified(c, version);
				if (unchanged !== null) return unchanged;
				const response = yield* attempt("equities.metric", () =>
					c.var.services.equitySync.metricSeries(owner(c), company, query.metric, query.years),
				);
				return conditionalJson(c, version, equityMetricSeriesResponseSchema.parse(response));
			}),
		),
	);

	api.get("/equities/companies/:companyId/revisions", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const query = yield* readQuery(c, equityRevisionsQuerySchema);
				const company = yield* companyOf(c);
				const version = versionOf(`revisions.${query.metric}.${query.fiscalYear}`, company);
				const unchanged = notModified(c, version);
				if (unchanged !== null) return unchanged;
				const response = yield* attempt("equities.revisions", () =>
					c.var.services.equitySync.revisions(owner(c), company, query.metric, query.fiscalYear),
				);
				return conditionalJson(c, version, equityRevisionsResponseSchema.parse(response));
			}),
		),
	);
}
