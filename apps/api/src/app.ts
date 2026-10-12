import { MESSAGE_LIMIT, renderExportMarkdown } from "@research/application";
import {
	type ApiErrorBody,
	agentSettingsResponseSchema,
	agentSettingsSchema,
	approveAssetRequestSchema,
	approveRunRequestSchema,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	claimJobRequestSchema,
	completeJobRequestSchema,
	createResearchRunRequestSchema,
	createWorkspaceRequestSchema,
	heartbeatRequestSchema,
	idSchema,
	issueRunnerCredentialRequestSchema,
	MAX_REQUEST_BODY_BYTES,
	previewSourceRequestSchema,
	type RunnerCredentialCheck,
	registerSourceRequestSchema,
	runnerEventsRequestSchema,
	uiCommandSchema,
	updateSourceRequestSchema,
} from "@research/contracts";
import { attempt, createEventLogger, type EventLogger } from "@research/effects";
import { Effect } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type CompositionOverrides, createServices, createSharedParts } from "./composition.ts";
import type { Env } from "./env.ts";
import {
	type AppContext,
	type AppEnv,
	conditionalJson,
	fingerprint,
	HttpFailure,
	idempotencyKey,
	pathId,
	readJson,
	reject,
	respond,
	STATUS,
	useCase,
} from "./http.ts";

const RUNNER_ONLINE_WINDOW_MS = 60_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Local development (wrangler dev, tests) is the only place plain HTTP is acceptable. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HSTS = "max-age=31536000; includeSubDomains";

/**
 * Which local environment the API reports (ADR-0011). Only an explicit
 * "development" yields development; anything missing or unknown fails towards
 * the quiet, safe presentation (no badge).
 */
export function appEnvironment(env: Env): "development" | "production" {
	return env.APP_ENV === "development" ? "development" : "production";
}

/**
 * The defect boundary: a throw that escaped the Effect error channel reaches
 * `app.onError`, which delegates here. Logs the error class and route only
 * and answers the stable `INTERNAL` body — and answers it even when the log
 * writer itself is down (the logger counts that failure itself; logging never
 * throws into its caller).
 */
export function defectResponse(logger: EventLogger, error: Error, c: AppContext): Response {
	try {
		// Log the error class and route only: messages may carry stored content or identifiers.
		logger.error("unhandled_error", {
			name: error.name,
			method: c.req.method,
			route: c.req.routePath,
		});
	} catch {
		// Logging never throws into its caller; fall through to the answer.
	}
	return reject(c, "INTERNAL", "Internal error.");
}

export interface AppOptions {
	readonly overrides?: CompositionOverrides;
}

/**
 * The HTTP surface. Handlers are deliberately thin (API-001): validate,
 * authenticate/authorize, call one use case, map its typed result to a
 * response. No business rule lives here. Every handler is one Effect program
 * whose typed failures reach the single error boundary in `respond`.
 */
export function createApp(options: AppOptions = {}) {
	const app = new Hono<AppEnv>();
	const shared = createSharedParts(options.overrides);
	const logger = createEventLogger((line) => console.error(line.trimEnd()));

	// The platform also serves the Worker's hostname over plain HTTP. Credentials (the Access
	// token, a runner bearer token) must never travel that way, so the API refuses it: a safe
	// read is redirected to HTTPS, anything else is rejected outright rather than replayed.
	app.use("*", async (c, next) => {
		const url = new URL(c.req.url);
		if (url.protocol !== "http:" || LOOPBACK_HOSTNAMES.has(url.hostname)) return next();
		if (SAFE_METHODS.has(c.req.method)) {
			url.protocol = "https:";
			return c.redirect(url.href, 308);
		}
		return c.json(
			{ error: { code: "FORBIDDEN", message: "HTTPS is required." } } satisfies ApiErrorBody,
			STATUS.FORBIDDEN,
		);
	});

	app.use("*", async (c, next) => {
		c.set("services", createServices(c.env, options.overrides, shared));
		await next();
		// Tells browsers to use HTTPS for this host from now on (ignored by them over HTTP).
		c.header("Strict-Transport-Security", HSTS);
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "no-referrer");
		// API responses are data, never documents: forbid any active content outright.
		c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
		if (c.res.headers.get("Cache-Control") === null) c.header("Cache-Control", "no-store");
	});

	app.use(
		"/api/*",
		bodyLimit({
			maxSize: MAX_REQUEST_BODY_BYTES,
			onError: (c) =>
				c.json(
					{ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } },
					STATUS.PAYLOAD_TOO_LARGE,
				),
		}),
	);

	app.notFound((c) => reject(c, "NOT_FOUND", "Resource not found."));
	app.onError((error, c) => defectResponse(logger, error, c));

	/* ---------- Runner API: bearer credentials only, never reachable from a browser ---------- */

	const requireRunner: MiddlewareHandler<AppEnv> = async (c, next) => {
		// Browsers attach Origin to cross-site and same-site writes; a runner process never does.
		if (c.req.header("Origin") !== undefined || c.req.header("Cookie") !== undefined) {
			return reject(c, "FORBIDDEN", "Runner endpoints are not available to browsers.");
		}
		const match = /^Bearer ([A-Za-z0-9_]{20,200})$/.exec(c.req.header("Authorization") ?? "");
		const token = match?.[1];
		if (token === undefined) return reject(c, "UNAUTHENTICATED", "Runner credential required.");
		const runner = await c.var.services.credentials.authenticate(token);
		if (runner === null) return reject(c, "UNAUTHENTICATED", "Runner credential is not valid.");
		c.set("runner", runner);
		await next();
	};

	const runner = new Hono<AppEnv>();
	runner.use("*", requireRunner);

	runner.post("/jobs/claim", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, claimJobRequestSchema);
				const claimed = yield* useCase("runner.jobs.claim", () =>
					c.var.services.runnerJobs.claim(c.var.runner, body),
				);
				return c.json(claimed);
			}),
		),
	);

	runner.post("/jobs/:id/heartbeat", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const body = yield* readJson(c, heartbeatRequestSchema);
				const heartbeat = yield* useCase("runner.jobs.heartbeat", () =>
					c.var.services.runnerJobs.heartbeat(c.var.runner, runId, body.leaseGeneration),
				);
				return c.json(heartbeat);
			}),
		),
	);

	runner.post("/jobs/:id/events", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const body = yield* readJson(c, runnerEventsRequestSchema);
				const appended = yield* useCase("runner.jobs.append_events", () =>
					c.var.services.runnerJobs.appendEvents(c.var.runner, runId, body),
				);
				return c.json(appended);
			}),
		),
	);

	runner.post("/jobs/:id/complete", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const body = yield* readJson(c, completeJobRequestSchema);
				const completed = yield* useCase("runner.jobs.complete", () =>
					c.var.services.runnerJobs.complete(c.var.runner, runId, body),
				);
				return c.json(completed);
			}),
		),
	);

	/** Lets a runner, or the local launcher, confirm its token is still accepted. Changes nothing. */
	runner.get("/credential", (c) =>
		respond(
			c,
			logger,
			Effect.succeed(
				c.json({ credentialId: c.var.runner.credentialId } satisfies RunnerCredentialCheck),
			),
		),
	);

	runner.post("/credentials/renew", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(
					c,
					z.strictObject({ expiresInDays: z.number().int().min(1).max(90) }),
				);
				const renewed = yield* useCase("runner.credentials.renew", () =>
					c.var.services.credentials.renew(c.var.runner, body.expiresInDays),
				);
				return c.json(renewed);
			}),
		),
	);

	app.route("/api/v1/runner", runner);

	/* ---------- Owner API: authenticated session + CSRF defence on every write ---------- */

	const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
		const identity = await c.var.services.authenticateOwner(c.req.raw);
		if (!identity.ok) {
			return identity.error === "FORBIDDEN"
				? reject(c, "FORBIDDEN", "This account is not the workspace owner.")
				: reject(c, "UNAUTHENTICATED", "Sign-in required.");
		}
		c.set("owner", identity.value);
		await next();
	};

	const requireCsrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
		if (SAFE_METHODS.has(c.req.method)) return next();
		const origin = c.req.header("Origin");
		const sameOrigin = origin === new URL(c.req.url).origin;
		// A second origin is accepted only in local development (the Vite dev server).
		const devOrigin =
			c.var.owner.authMode === "local-dev" &&
			origin !== undefined &&
			origin === c.env.DEV_ALLOWED_ORIGIN;
		if ((!sameOrigin && !devOrigin) || c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
			return reject(c, "CSRF_REJECTED", "Cross-site or unprotected write rejected.");
		}
		await next();
	};

	const api = new Hono<AppEnv>();
	api.use("*", requireOwner, requireCsrfProtection);
	const owner = (c: AppContext) => c.var.owner.ownerId;

	api.get("/session", (c) =>
		respond(
			c,
			logger,
			Effect.succeed(
				c.json({
					ownerId: c.var.owner.ownerId,
					authMode: c.var.owner.authMode,
					environment: appEnvironment(c.env),
				}),
			),
		),
	);

	/**
	 * Which built release this instance serves (ADR-0011, release
	 * generations). Read-only and unauthenticated-content-free: generation id
	 * and build time only, so the launcher specs can assert that a running
	 * instance keeps serving the generation it started with while a newer one
	 * is built. Outside a release (development, tests) both are null.
	 */
	api.get("/version", (c) =>
		respond(
			c,
			logger,
			Effect.succeed(
				c.json({
					generation:
						typeof c.env.RELEASE_GENERATION === "string" && c.env.RELEASE_GENERATION !== ""
							? c.env.RELEASE_GENERATION
							: null,
					builtAt:
						typeof c.env.RELEASE_BUILT_AT === "string" && c.env.RELEASE_BUILT_AT !== ""
							? c.env.RELEASE_BUILT_AT
							: null,
					environment: appEnvironment(c.env),
				}),
			),
		),
	);

	/* Sources */
	api.post("/sources/preview", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, previewSourceRequestSchema);
				const preview = yield* useCase("sources.preview", () =>
					c.var.services.sources.preview(owner(c), body.url),
				);
				return c.json(preview);
			}),
		),
	);
	api.get("/sources/recommended", (c) =>
		respond(
			c,
			logger,
			Effect.succeed(c.json({ entries: c.var.services.sources.listRecommended() })),
		),
	);
	api.post("/sources/refresh", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const key = yield* idempotencyKey(c);
				const created = yield* useCase("runs.create_ingest", () =>
					c.var.services.runs.createIngest(owner(c), key),
				);
				return c.json({ run: created.run }, 202);
			}),
		),
	);
	api.get("/sources", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const sources = yield* attempt("sources.list", () => c.var.services.sources.list(owner(c)));
				return c.json({ sources });
			}),
		),
	);
	api.post("/sources", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, registerSourceRequestSchema);
				const source = yield* useCase("sources.register", () =>
					c.var.services.sources.register(owner(c), body),
				);
				return c.json(source, 201);
			}),
		),
	);
	api.patch("/sources/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const sourceId = yield* pathId(c, "id");
				const body = yield* readJson(c, updateSourceRequestSchema);
				const source = yield* useCase("sources.update", () =>
					c.var.services.sources.update(owner(c), sourceId, body),
				);
				return c.json(source);
			}),
		),
	);
	api.delete("/sources/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const sourceId = yield* pathId(c, "id");
				yield* useCase("sources.remove", () => c.var.services.sources.remove(owner(c), sourceId));
				return c.body(null, 204);
			}),
		),
	);
	api.get("/articles", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const sourceId = idSchema.safeParse(c.req.query("sourceId"));
				const cursor = c.req.query("cursor");
				const page = yield* attempt("sources.list_articles", () =>
					c.var.services.sources.listArticles(owner(c), {
						sourceId: sourceId.success ? sourceId.data : null,
						cursor: cursor === undefined || cursor === "" ? null : cursor.slice(0, 400),
					}),
				);
				return c.json(page);
			}),
		),
	);

	/* Agents */
	api.get("/agents", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const status = yield* attempt("agents.status", () =>
					c.var.services.runnerStatus.get(owner(c)),
				);
				const lastSeenMs = status === null ? null : Date.parse(status.lastSeenAt);
				const body = {
					agents: status?.agents ?? [],
					runnerLastSeenAt: status?.lastSeenAt ?? null,
					runnerOnline:
						lastSeenMs !== null &&
						c.var.services.clock.nowMs() - lastSeenMs < RUNNER_ONLINE_WINDOW_MS,
				};
				// Conditional like the other polled reads: an unchanged answer
				// is a cheap 304, so the settings form can re-read it while open.
				// Finding 12: the validator includes `runnerOnline`, which is
				// derived from the clock — otherwise a 304 would keep reporting
				// "online" forever after the runner stops.
				return conditionalJson(
					c,
					`agents.${body.runnerLastSeenAt ?? "never"}.${body.runnerOnline ? "online" : "offline"}.${fingerprint(JSON.stringify(body.agents))}`,
					body,
				);
			}),
		),
	);

	/* Research runs */
	api.post("/research-runs", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const key = yield* idempotencyKey(c);
				const body = yield* readJson(c, createResearchRunRequestSchema);
				const created = yield* useCase("runs.create", () =>
					c.var.services.runs.create(owner(c), body, key),
				);
				return c.json({ run: created.run }, 202);
			}),
		),
	);
	api.get("/research-runs", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = idSchema.safeParse(c.req.query("workspaceId"));
				const runs = yield* attempt("runs.list", () =>
					c.var.services.runs.list(owner(c), workspaceId.success ? workspaceId.data : null),
				);
				// Polled by the SPA: a validator lets an unchanged list cost a 304 instead of a body.
				const versions = runs.map((run) => `${run.runId}:${run.state}:${run.updatedAt}`).join(",");
				return conditionalJson(c, `runs.${runs.length}.${fingerprint(versions)}`, { runs });
			}),
		),
	);
	api.get("/research-runs/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const run = yield* useCase("runs.get", () => c.var.services.runs.get(owner(c), runId));
				return conditionalJson(c, `${run.runId}.${run.updatedAt}.${run.progress.length}`, {
					run,
				});
			}),
		),
	);
	api.get("/research-runs/:id/records", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const records = yield* useCase("runs.records", () =>
					c.var.services.runs.records(owner(c), runId),
				);
				return c.json(records);
			}),
		),
	);
	api.post("/research-runs/:id/cancel", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const cancelled = yield* useCase("runs.cancel", () =>
					c.var.services.runs.cancel(owner(c), runId),
				);
				return c.json({ run: cancelled });
			}),
		),
	);
	api.post("/research-runs/:id/retry", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const key = yield* idempotencyKey(c);
				const retried = yield* useCase("runs.retry", () =>
					c.var.services.runs.retry(owner(c), runId, key),
				);
				return c.json({ run: retried.run }, 202);
			}),
		),
	);
	api.post("/research-runs/:id/approve", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const runId = yield* pathId(c, "id");
				const body = yield* readJson(c, approveRunRequestSchema);
				const approved = yield* useCase("runs.approve", () =>
					c.var.services.runs.approve(owner(c), runId, body.budget),
				);
				return c.json({ run: approved });
			}),
		),
	);

	/* Workspaces */
	api.get("/workspaces", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaces = yield* attempt("workspaces.list", () =>
					c.var.services.workspaces.list(owner(c)),
				);
				return c.json({ workspaces });
			}),
		),
	);
	api.post("/workspaces/import", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, z.unknown());
				const imported = yield* useCase("export.import", () =>
					c.var.services.exportImport.import(owner(c), body),
				);
				return c.json(imported, 201);
			}),
		),
	);
	api.post("/workspaces", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, createWorkspaceRequestSchema);
				const workspace = yield* useCase("workspaces.create", () =>
					c.var.services.workspaces.create(owner(c), body.title),
				);
				return c.json(workspace, 201);
			}),
		),
	);
	api.get("/workspaces/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const workspace = yield* useCase("workspaces.view", () =>
					c.var.services.workspaces.view(owner(c), workspaceId),
				);
				return conditionalJson(
					c,
					`${workspaceId}.${workspace.state.version}.${workspace.assets.length}`,
					workspace,
				);
			}),
		),
	);
	api.get("/workspaces/:id/events", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const after = z.coerce
					.number()
					.int()
					.nonnegative()
					.safeParse(c.req.query("after") ?? "0");
				if (!after.success) {
					return yield* Effect.fail(
						new HttpFailure({
							error: { code: "VALIDATION_FAILED", message: "`after` must be a version number." },
						}),
					);
				}
				const events = yield* useCase("workspaces.events", () =>
					c.var.services.workspaces.events(owner(c), workspaceId, after.data),
				);
				return c.json(events);
			}),
		),
	);
	api.post("/workspaces/:id/commands", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const body = yield* readJson(c, uiCommandSchema);
				const submitted = yield* useCase("workspaces.submit_command", () =>
					c.var.services.workspaces.submitCommand(owner(c), workspaceId, body),
				);
				return c.json(submitted);
			}),
		),
	);
	api.get("/workspaces/:id/messages", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const beforeRaw = c.req.query("before");
				let beforeSeq: number | null = null;
				if (beforeRaw !== undefined) {
					const parsed = z.coerce.number().int().nonnegative().safeParse(beforeRaw);
					if (!parsed.success) {
						return yield* Effect.fail(
							new HttpFailure({
								error: { code: "VALIDATION_FAILED", message: "`before` must be a message seq." },
							}),
						);
					}
					beforeSeq = parsed.data;
				}
				let pageLimit = MESSAGE_LIMIT;
				const limitRaw = c.req.query("limit");
				if (limitRaw !== undefined) {
					const parsed = z.coerce.number().int().min(1).max(MESSAGE_LIMIT).safeParse(limitRaw);
					if (!parsed.success) {
						return yield* Effect.fail(
							new HttpFailure({
								error: {
									code: "VALIDATION_FAILED",
									message: "`limit` must be an integer from 1 to 200.",
								},
							}),
						);
					}
					pageLimit = parsed.data;
				}
				const conversation = yield* useCase("workspaces.conversation", () =>
					c.var.services.workspaces.conversation(owner(c), workspaceId, {
						beforeSeq,
						limit: pageLimit,
					}),
				);
				const first = conversation.messages.at(0);
				const last = conversation.messages.at(-1);
				return conditionalJson(
					c,
					`${workspaceId}.${beforeSeq ?? "all"}.${pageLimit}.${conversation.messages.length}.${first?.seq ?? "none"}.${last?.messageId ?? "none"}.${conversation.hasEarlier}`,
					conversation,
				);
			}),
		),
	);
	api.get("/conversations", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const conversations = yield* attempt("conversations.list", () =>
					c.var.services.workspaces.listConversations(owner(c)),
				);
				// Polled by clients: the validator changes whenever any summary changes.
				const print = conversations
					.map((entry) => `${entry.workspaceId}:${entry.messageCount}:${entry.lastActivityAt}`)
					.join(",");
				return conditionalJson(c, `conversations.${conversations.length}.${fingerprint(print)}`, {
					conversations,
				});
			}),
		),
	);
	api.get("/workspaces/:id/export", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const document = yield* useCase("export.export", () =>
					c.var.services.exportImport.export(owner(c), workspaceId),
				);
				if (c.req.query("format") === "markdown") {
					return c.body(renderExportMarkdown(document), 200, {
						"Content-Type": "text/markdown; charset=utf-8",
						"Content-Disposition": 'attachment; filename="research-export.md"',
					});
				}
				return c.json(document);
			}),
		),
	);

	/* Assets */
	api.get("/assets", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const assets = yield* attempt("assets.list", () => c.var.services.assets.list(owner(c)));
				return c.json({ assets });
			}),
		),
	);
	api.post("/assets", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, approveAssetRequestSchema);
				const asset = yield* useCase("assets.approve", () =>
					c.var.services.assets.approve(owner(c), body),
				);
				return c.json(asset, 201);
			}),
		),
	);
	api.delete("/assets/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const assetId = yield* pathId(c, "id");
				yield* useCase("assets.remove", () => c.var.services.assets.remove(owner(c), assetId));
				return c.body(null, 204);
			}),
		),
	);

	/* Runner credentials (managed by the owner; used by the runner API above) */
	api.get("/runner-credentials", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const credentials = yield* attempt("credentials.list", () =>
					c.var.services.credentials.list(owner(c)),
				);
				return c.json({ credentials });
			}),
		),
	);
	api.post("/runner-credentials", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, issueRunnerCredentialRequestSchema);
				const issued = yield* useCase("credentials.issue", () =>
					c.var.services.credentials.issue(owner(c), body.label, body.expiresInDays),
				);
				return c.json(issued, 201);
			}),
		),
	);
	api.delete("/runner-credentials/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const credentialId = yield* pathId(c, "id");
				yield* useCase("credentials.revoke", () =>
					c.var.services.credentials.revoke(owner(c), credentialId),
				);
				return c.body(null, 204);
			}),
		),
	);

	/* AI agent settings: one stored record per owner (section 10) */
	api.get("/settings/agent", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const settings = yield* attempt("settings.get", () =>
					c.var.services.agentSettings.get(owner(c)),
				);
				return c.json(agentSettingsResponseSchema.parse(settings));
			}),
		),
	);
	api.put("/settings/agent", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, agentSettingsSchema);
				const updated = yield* useCase("settings.update", () =>
					c.var.services.agentSettings.update(owner(c), body),
				);
				return c.json(agentSettingsResponseSchema.parse(updated));
			}),
		),
	);

	app.route("/api/v1", api);
	return app;
}
