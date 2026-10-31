import { MATERIAL_LIMITS, materialImportSchema } from "@research/contracts";
import { attempt, type EventLogger } from "@research/effects";
import { Effect } from "effect";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, readJson, respond } from "./http.ts";

/** Owner authentication and CSRF are inherited from the API router. */
export function registerMaterialRoutes(api: Hono<AppEnv>, logger: EventLogger): void {
	api.post(
		"/materials/imports",
		bodyLimit({
			maxSize: MATERIAL_LIMITS.maxImportBytes,
			onError: (c) =>
				c.json(
					{
						error: {
							code: "PAYLOAD_TOO_LARGE",
							message: "Material import exceeds the byte limit.",
						},
					},
					413,
				),
		}),
		(c) =>
			respond(
				c,
				logger,
				Effect.gen(function* () {
					const payload = yield* readJson(c, materialImportSchema);
					const now = c.var.services.clock.nowIso();
					if (payload.series.some((series) => series.retrievedAt > now))
						return c.json(
							{ error: { code: "VALIDATION_FAILED", message: "Retrieval time is in the future." } },
							400,
						);
					const imported = yield* attempt("materials.import", () =>
						c.var.services.materials.import(c.var.owner.ownerId, payload, now),
					);
					if (!imported)
						return c.json(
							{
								error: {
									code: "CONFLICT",
									message: "Material series conflicts or the stored series limit is exceeded.",
								},
							},
							409,
						);
					return c.json({ importedSeries: payload.series.map((series) => series.seriesId) }, 201);
				}),
			),
	);
	api.get("/materials/series/:seriesId", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const series = yield* attempt("materials.get", () =>
					c.var.services.materials.get(c.var.owner.ownerId, c.req.param("seriesId")),
				);
				if (series === null)
					return c.json(
						{ error: { code: "NOT_FOUND", message: "Material series was not found." } },
						404,
					);
				return c.json(series);
			}),
		),
	);
}
