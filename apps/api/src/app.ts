import {
	homeDataDigestEtag,
	MESSAGE_LIMIT,
	renderExportMarkdown,
	watchlistDigestEtag,
} from "@research/application";
import type { ApiErrorBody } from "@research/contracts";
import {
	addWatchlistStockRequestSchema,
	agentSettingsResponseSchema,
	agentSettingsSchema,
	approveRunRequestSchema,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	calendarFeedIssuedSchema,
	claimJobRequestSchema,
	completeJobRequestSchema,
	createResearchRunRequestSchema,
	createWorkspaceRequestSchema,
	DEFAULT_CONVERSATION_TITLE,
	heartbeatRequestSchema,
	homeDashboardResponseSchema,
	homeDataResponseSchema,
	idSchema,
	issueRunnerCredentialRequestSchema,
	MAX_REQUEST_BODY_BYTES,
	marketCatalogResponseSchema,
	notebookAssistRequestSchema,
	notebookAssistResponseSchema,
	notebookResponseSchema,
	previewSourceRequestSchema,
	putHomeDashboardRequestSchema,
	putNotebookRequestSchema,
	type RunnerCredentialCheck,
	registerSourceRequestSchema,
	renameWorkspaceRequestSchema,
	runnerEventsRequestSchema,
	uiCommandSchema,
	undoNotebookRequestSchema,
	updateSourceRequestSchema,
	watchlistResponseSchema,
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
					c.var.services.workspaces.create(owner(c), body.title ?? DEFAULT_CONVERSATION_TITLE),
				);
				return c.json(workspace, 201);
			}),
		),
	);
	api.patch("/workspaces/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const body = yield* readJson(c, renameWorkspaceRequestSchema);
				const renamed = yield* useCase("workspaces.rename", () =>
					c.var.services.workspaces.rename(owner(c), workspaceId, body.title),
				);
				return c.json(renamed);
			}),
		),
	);
	api.delete("/workspaces/:id", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				yield* useCase("workspaces.remove", () =>
					c.var.services.workspaces.remove(owner(c), workspaceId),
				);
				return c.body(null, 204);
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
				// The title is part of the validator (otherwise a rename answers
				// 304 with the old title), fingerprinted so any owner text stays
				// a valid ASCII header value.
				return conditionalJson(
					c,
					`${workspaceId}.${fingerprint(workspace.workspace.title)}.${workspace.workspace.updatedAt}.${workspace.state.version}`,
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

	/* Notebook of one conversation (ADR-0020): compare-and-set saves, undo,
	 * and the assistant turn. Same auth, CSRF, body-size limits, error
	 * mapping and logging as the dashboard routes; every response body is
	 * parsed with its contract schema before sending.
	 */
	api.get("/workspaces/:id/notebook", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const notebook = yield* useCase("notebook.get", () =>
					c.var.services.notebook.getNotebook(owner(c), workspaceId),
				);
				return c.json(notebookResponseSchema.parse(notebook));
			}),
		),
	);
	api.put("/workspaces/:id/notebook", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const body = yield* readJson(c, putNotebookRequestSchema);
				const updated = yield* useCase("notebook.put", () =>
					c.var.services.notebook.putNotebook(
						owner(c),
						workspaceId,
						body.notebook,
						body.expectedVersion,
					),
				);
				return c.json(notebookResponseSchema.parse(updated));
			}),
		),
	);
	api.post("/workspaces/:id/notebook/undo", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const body = yield* readJson(c, undoNotebookRequestSchema);
				const undone = yield* useCase("notebook.undo", () =>
					c.var.services.notebook.undoNotebook(owner(c), workspaceId, body.expectedVersion),
				);
				return c.json(notebookResponseSchema.parse(undone));
			}),
		),
	);
	api.post("/workspaces/:id/notebook/assist", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const workspaceId = yield* pathId(c, "id");
				const key = yield* idempotencyKey(c);
				const body = yield* readJson(c, notebookAssistRequestSchema);
				const assisted = yield* useCase("notebook.assist", () =>
					c.var.services.notebook.assistNotebook(owner(c), workspaceId, body, key),
				);
				return c.json(notebookAssistResponseSchema.parse(assisted), 202);
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
				// The title is part of it: without it a rename would keep
				// answering 304 and the list would show the old title.
				const print = conversations
					.map(
						(entry) =>
							`${entry.workspaceId}:${entry.title}:${entry.messageCount}:${entry.lastActivityAt}`,
					)
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

	/* Home dashboard (FR-017) */
	api.get("/home/dashboard", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				// V2: a stored dashboard that no longer parses answers with the
				// stable STORED_DASHBOARD_UNREADABLE code (fail closed), not a
				// silent default — the app shows the error state with a reset.
				const dashboard = yield* useCase("home.get_dashboard", () =>
					c.var.services.home.getDashboard(owner(c)),
				);
				return c.json(homeDashboardResponseSchema.parse(dashboard));
			}),
		),
	);
	api.put("/home/dashboard", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, putHomeDashboardRequestSchema);
				const updated = yield* useCase("home.put_dashboard", () =>
					c.var.services.home.putDashboard(owner(c), body.dashboard, body.expectedVersion),
				);
				return c.json(homeDashboardResponseSchema.parse(updated));
			}),
		),
	);
	// V2: dedicated reset — replaces the stored document with the defaults
	// without an expectedVersion, so it stays usable when the stored document
	// no longer parses (the owner explicitly discards whatever is stored).
	api.post("/home/dashboard/reset", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const reset = yield* useCase("home.reset_dashboard", () =>
					c.var.services.home.resetDashboard(owner(c)),
				);
				return c.json(homeDashboardResponseSchema.parse(reset));
			}),
		),
	);
	api.get("/home/data", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				// S3: the ETag covers a cheap digest (dashboard version, active
				// run id + state, last success/failure, per-series stamps), so
				// a 304 is answered BEFORE any observation row is loaded.
				const digest = yield* useCase("home.get_data_digest", () =>
					c.var.services.home.getDataDigest(owner(c)),
				);
				const etag = homeDataDigestEtag(digest);
				c.header("ETag", `"${etag}"`);
				if (c.req.header("If-None-Match") === `"${etag}"`) return c.body(null, 304);
				const data = yield* useCase("home.get_data", () =>
					c.var.services.home.getData(owner(c), digest),
				);
				const parsed = homeDataResponseSchema.parse(data);
				return c.json(parsed);
			}),
		),
	);
	api.get("/home/catalog", (c) =>
		respond(
			c,
			logger,
			Effect.succeed(
				c.json(marketCatalogResponseSchema.parse({ entries: c.var.services.marketCatalog })),
			),
		),
	);
	api.post("/home/refresh", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const key = yield* idempotencyKey(c);
				const created = yield* useCase("runs.create_market_refresh", () =>
					c.var.services.runs.createMarketRefresh(owner(c), key),
				);
				return c.json({ run: created.run }, 202);
			}),
		),
	);

	/* Watchlist and earnings-date calendar (FR-018) */
	api.get("/watchlist", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				// Like /home/data: the ETag covers a cheap digest (stock
				// stamps, refresh state, feed stamp), so a 304 is answered
				// BEFORE any event row is loaded.
				const digest = yield* useCase("watchlist.get_digest", () =>
					c.var.services.watchlist.getDigest(owner(c)),
				);
				const etag = watchlistDigestEtag(digest);
				c.header("ETag", `"${etag}"`);
				if (c.req.header("If-None-Match") === `"${etag}"`) return c.body(null, 304);
				const watchlist = yield* useCase("watchlist.get", () =>
					c.var.services.watchlist.getWatchlist(owner(c)),
				);
				return c.json(watchlistResponseSchema.parse(watchlist));
			}),
		),
	);
	api.post("/watchlist/stocks", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const body = yield* readJson(c, addWatchlistStockRequestSchema);
				const watchlist = yield* useCase("watchlist.add_stock", () =>
					c.var.services.watchlist.addStock(owner(c), body),
				);
				return c.json(watchlistResponseSchema.parse(watchlist));
			}),
		),
	);
	api.delete("/watchlist/stocks/:stockId", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				// The id carries its own shape (`us:AAPL`); an unknown shape
				// is NOT_FOUND, answered by the use case, never a 500.
				const stockId = c.req.param("stockId");
				const watchlist = yield* useCase("watchlist.remove_stock", () =>
					c.var.services.watchlist.removeStock(owner(c), stockId),
				);
				return c.json(watchlistResponseSchema.parse(watchlist));
			}),
		),
	);
	api.post("/watchlist/refresh", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const key = yield* idempotencyKey(c);
				const created = yield* useCase("runs.create_earnings_refresh", () =>
					c.var.services.watchlist.queueRefresh(owner(c), key),
				);
				return c.json({ run: created.run }, 202);
			}),
		),
	);
	api.get("/watchlist/calendar.ics", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const ics = yield* useCase("watchlist.get_calendar", () =>
					c.var.services.watchlist.getCalendar(owner(c)),
				);
				return c.body(ics, 200, {
					"Content-Type": "text/calendar; charset=utf-8",
					"Content-Disposition": 'attachment; filename="earnings-calendar.ics"',
				});
			}),
		),
	);
	api.post("/watchlist/feed", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				// Issues (or rotates) the subscription token: it is returned
				// exactly once here and never stored, logged or shown again.
				const issued = yield* useCase("watchlist.issue_feed", () =>
					c.var.services.watchlist.issueFeed(owner(c)),
				);
				return c.json(calendarFeedIssuedSchema.parse(issued), 201);
			}),
		),
	);
	api.delete("/watchlist/feed", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				yield* useCase("watchlist.revoke_feed", () =>
					c.var.services.watchlist.revokeFeed(owner(c)),
				);
				return c.body(null, 204);
			}),
		),
	);

	/* Google Calendar sync (FR-019 section 2.5): each queues one
	 * `google-calendar` step (at most one active per owner; a request while
	 * one runs answers with that run). Like `/watchlist/refresh`: CSRF
	 * through the middleware, idempotency through the key, no request body.
	 * State is read through `GET /watchlist` (`googleCalendar` field).
	 */
	for (const action of ["connect", "sync", "disconnect"] as const) {
		api.post(`/google-calendar/${action}`, (c) =>
			respond(
				c,
				logger,
				Effect.gen(function* () {
					const key = yield* idempotencyKey(c);
					const created = yield* useCase(`runs.create_google_calendar_${action}`, () =>
						c.var.services.googleCalendar.queue(owner(c), action, key),
					);
					return c.json({ run: created.run }, 202);
				}),
			),
		);
	}

	/* Token-authenticated calendar subscription feed (FR-018).
	 *
	 * OUTSIDE the owner session on purpose: calendar apps cannot send the
	 * session cookie or the CSRF header. Authentication is the token path
	 * segment alone; the owner session is never consulted, and nothing but
	 * the calendar document of the token's owner is ever served. Any failure
	 * (bad shape, unknown or revoked token) answers the SAME 404 body.
	 *
	 * The token is a secret in a URL: it must never reach a log line, an
	 * audit row or an error body (SEC-005, SEC-010). The application logs the
	 * route pattern (`:token` unexpanded), never the path — but wrangler's
	 * own per-request lines print the expanded path, so both launch plans
	 * run it with `--log-level warn`, which drops those lines while the
	 * Worker's own console.error event lines still reach the server log.
	 */
	const feed = new Hono<AppEnv>();
	feed.get("/calendar-feed/:token/earnings.ics", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const token = c.req.param("token");
				const found = yield* useCase("watchlist.feed_calendar", () =>
					c.var.services.watchlist.getFeedCalendar(token),
				);
				const etag = `"${fingerprint(found.ics)}"`;
				c.header("ETag", etag);
				c.header("Cache-Control", "private, max-age=900");
				if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
				return c.body(found.ics, 200, {
					"Content-Type": "text/calendar; charset=utf-8",
				});
			}),
		),
	);
	// Anything else under the feed prefix — another method, an empty token,
	// a trailing slash, a wrong suffix — answers the same uniform 404 instead
	// of falling through to the owner API (which would answer 401/403).
	feed.all("/calendar-feed/*", (c) => reject(c, "NOT_FOUND", "Resource not found."));
	app.route("/api/v1", feed);

	app.route("/api/v1", api);
	return app;
}
