/**
 * Google Calendar sync application service (FR-019 section 2.5).
 *
 * Queueing mirrors `queueRefresh` (at most one non-terminal
 * `google-calendar` job per owner — the INSERT itself refuses the second
 * one, reported as `kind-active`; same `job-create` rate-limiter bucket;
 * idempotency keys with a per-action fingerprint). `sync` and `disconnect`
 * require status `connected` or `needs-reconnect`, else `VALIDATION_FAILED`
 * with the stable `GOOGLE_NOT_CONNECTED` code. Queuing `connect` sets
 * status `connecting` (remembering the previous status for the restore).
 *
 * The desired-set assembly (`assembleDesiredEvents`) is shared by the
 * claim-time sync payload and the `inSync` computation: dated events of
 * stocks with a retrieved stamp — the same assembly as the `.ics` — so a
 * removed stock or a refresh that changes dates flips `inSync` without any
 * extra write. The domain stays hash-free: the SHA-256 comes through the
 * application's `Hasher` port and only the first 20 digest bytes cross into
 * the domain.
 */
import {
	DISCONNECTED_GOOGLE_CALENDAR_STATE,
	EARNINGS_LIMITS,
	GOOGLE_SYNC_MAX_EVENTS,
	type GoogleCalendarAction,
	type GoogleCalendarState,
	googleCalendarFailure,
	googleCalendarFailureCodeSchema,
} from "@research/contracts";
import {
	canonicalGoogleSyncDigestInput,
	EMPTY_USAGE,
	err,
	googleEventBody,
	type JobState,
	ok,
	type Result,
} from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AuditLog,
	Clock,
	EarningsRepository,
	GoogleCalendarLink,
	GoogleCalendarLinkPatch,
	GoogleCalendarRepository,
	Hasher,
	IdGenerator,
	JobRecord,
	JobRepository,
	RateLimiter,
	StoredEarningsEvent,
	WatchlistRepository,
} from "./ports.ts";
import { type CreatedRun, MAX_JOB_ATTEMPTS } from "./researchRuns.ts";
import { toRunView } from "./runView.ts";

export interface GoogleCalendarServiceDeps {
	readonly jobs: JobRepository;
	readonly googleCalendar: GoogleCalendarRepository;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly rateLimiter: RateLimiter;
	readonly audit: AuditLog;
}

/** Admission control shared with run creation: one hourly job allowance per owner. */
const JOBS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const MAX_UNFINISHED_JOBS = 5;

export function googleFingerprint(action: GoogleCalendarAction): string {
	return `google-calendar:${action}`;
}

/** First 20 SHA-256 bytes of `stockId + "\n" + periodKey`, for the domain's event id. */
function digest20(hex: string): readonly number[] | null {
	if (!/^[0-9a-f]{64}$/.test(hex)) return null;
	const bytes: number[] = [];
	for (let index = 0; index < 40; index += 2) {
		bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
	}
	return bytes;
}

export interface DesiredGoogleEvents {
	readonly bodies: readonly {
		readonly id: string;
		readonly summary: string;
		readonly description: string;
		readonly startDate: string;
		readonly endDate: string;
		readonly privateProperties: {
			readonly researchWorkspace: "earnings";
			readonly stockId: string;
			readonly periodKey: string;
		};
		readonly sourceTitle: string;
		readonly sourceUrl: string;
	}[];
	/** SHA-256 hex of the canonical digest input (stored as `synced_digest`). */
	readonly digest: string;
}

export interface DesiredEventsDeps {
	readonly watchlist: WatchlistRepository;
	readonly earnings: EarningsRepository;
	readonly hasher: Hasher;
}

/**
 * Assembles the current desired Google events: dated events of stocks with
 * a retrieved stamp (the same assembly as the `.ics` document), with
 * deterministic ids from the `Hasher` port. Fail-closed: an undecidable
 * row fails the assembly instead of syncing a guess.
 */
export async function assembleDesiredEvents(
	deps: DesiredEventsDeps,
	ownerId: string,
): Promise<Result<DesiredGoogleEvents, "ASSEMBLY_FAILED">> {
	const stocks = await deps.watchlist.listStocks(ownerId);
	const stored = await deps.earnings.getEvents(
		ownerId,
		stocks.map((stock) => stock.stockId),
	);
	const sources = new Map(
		(await deps.earnings.getSources()).map((source) => [source.market, source]),
	);
	const byStock = new Map<string, StoredEarningsEvent[]>();
	for (const event of stored) {
		const list = byStock.get(event.stockId);
		if (list === undefined) byStock.set(event.stockId, [event]);
		else list.push(event);
	}
	const bodies: {
		readonly id: string;
		readonly summary: string;
		readonly description: string;
		readonly startDate: string;
		readonly endDate: string;
		readonly privateProperties: {
			readonly researchWorkspace: "earnings";
			readonly stockId: string;
			readonly periodKey: string;
		};
		readonly sourceTitle: string;
		readonly sourceUrl: string;
	}[] = [];
	for (const stock of stocks) {
		if (stock.retrievedAt === null) continue;
		const info = sources.get(stock.market);
		if (info === undefined) return err("ASSEMBLY_FAILED");
		for (const event of (byStock.get(stock.stockId) ?? []).slice(
			0,
			EARNINGS_LIMITS.maxEventsPerStock,
		)) {
			if (event.announcementDate === null) continue;
			const extra = await deps.hasher.sha256Hex(`${stock.stockId}\n${event.periodKey}`);
			const bytes = digest20(extra);
			if (bytes === null) return err("ASSEMBLY_FAILED");
			const body = googleEventBody(
				{
					stockId: stock.stockId,
					symbol: stock.symbol,
					name: stock.name,
					periodKey: event.periodKey,
					announcementDate: event.announcementDate,
					fiscalPeriodLabel: event.fiscalPeriodLabel,
					fiscalPeriodEnd: event.fiscalPeriodEnd,
					timing: event.timing,
					publisher: info.publisher,
					sourceUrl: info.sourceUrl,
					retrievedAt: stock.retrievedAt,
				},
				bytes,
			);
			if (!body.ok) return err("ASSEMBLY_FAILED");
			bodies.push(body.value);
		}
	}
	if (bodies.length > GOOGLE_SYNC_MAX_EVENTS) return err("ASSEMBLY_FAILED");
	const digest = await deps.hasher.sha256Hex(canonicalGoogleSyncDigestInput(bodies));
	if (!/^[0-9a-f]{64}$/.test(digest)) return err("ASSEMBLY_FAILED");
	return ok({ bodies, digest });
}

export interface GoogleActiveRun {
	readonly runId: string;
	readonly state: JobState;
	/** Null only for a storage fault (a google job without its action); shown as no action. */
	readonly action: GoogleCalendarAction | null;
}

/**
 * Projects the link row plus the active run onto the API state. `inSync`
 * is null unless connected: connected with a stored digest equal to the
 * CURRENT desired digest. `currentDigest` may be null (assembly failed or
 * skipped) — then a connected calendar reports `inSync: false`, never null.
 */
export function toGoogleCalendarState(
	link: GoogleCalendarLink | null,
	active: GoogleActiveRun | null,
	currentDigest: string | null,
): GoogleCalendarState {
	const lastFailure =
		link !== null && link.lastFailureCode !== null && link.lastFailureAt !== null
			? toFailure(link.lastFailureCode, link.lastFailureAt, link.lastFailureUpstreamStatus)
			: null;
	if (link === null) {
		return {
			...DISCONNECTED_GOOGLE_CALENDAR_STATE,
			activeRunId: active?.runId ?? null,
			activeRunState: active?.state ?? null,
			activeAction: active?.action ?? null,
		};
	}
	// `connecting` is only real while a run exists. A row left behind by a
	// run that ended without its bookkeeping shows the status it would be
	// restored to, so the owner is never stranded on a dead sign-in link.
	const status =
		link.status === "connecting" && active === null
			? (link.connectFrom ?? "disconnected")
			: link.status;
	return {
		status,
		authUrl: status === "connecting" ? link.pendingAuthUrl : null,
		calendarId: link.calendarId,
		connectedAt: link.connectedAt,
		lastSyncedAt: link.lastSyncedAt,
		lastSync: link.lastSync,
		inSync:
			status === "connected"
				? link.syncedDigest !== null &&
					currentDigest !== null &&
					link.syncedDigest === currentDigest
				: null,
		activeRunId: active?.runId ?? null,
		activeRunState: active?.state ?? null,
		activeAction: active?.action ?? null,
		lastFailure,
	};
}

function toFailure(
	code: string,
	at: string,
	upstreamStatus: number | null,
): GoogleCalendarState["lastFailure"] {
	const parsed = googleCalendarFailureCodeSchema.safeParse(code);
	// Display-time defensive mapping: unknown stored codes (a runner that
	// sent a non-GOOGLE code) show the generic reason — provider text never
	// reaches the UI. The audit row keeps the stored code.
	if (!parsed.success) {
		return googleCalendarFailure("GOOGLE_REQUEST_FAILED", at, upstreamStatus);
	}
	return googleCalendarFailure(parsed.data, at, upstreamStatus);
}

export function createGoogleCalendarService(deps: GoogleCalendarServiceDeps) {
	return {
		/**
		 * Queues a Google Calendar step. AT MOST ONE non-terminal
		 * `google-calendar` job per owner: a request while one is active
		 * returns that active run (no second job).
		 */
		async queue(
			ownerId: string,
			action: GoogleCalendarAction,
			idempotencyKey: string,
		): Promise<UseCaseResult<CreatedRun>> {
			const active = await deps.jobs.findActiveByKind(ownerId, "google-calendar");
			if (active !== null) {
				const running =
					active.request !== null && "action" in active.request ? active.request.action : null;
				// The same step asked twice answers with the run already
				// there. A different step is refused: answering 202 with the
				// other run would look as if (say) Disconnect had been queued.
				if (running === action) return ok({ run: toRunView(active, []), replayed: true });
				return fail(
					"CONFLICT",
					"Another Google Calendar step is still running; wait for it to finish, then try again.",
				);
			}
			const fingerprint = googleFingerprint(action);
			const existing = await deps.jobs.findByIdempotencyKey(ownerId, idempotencyKey);
			if (existing !== null) {
				return existing.requestFingerprint === fingerprint
					? ok({ run: toRunView(existing.job, []), replayed: true })
					: fail(
							"IDEMPOTENCY_KEY_REUSED",
							"This idempotency key was already used for a different request.",
						);
			}
			const link = await deps.googleCalendar.get(ownerId);
			if (action !== "connect") {
				if (link === null || (link.status !== "connected" && link.status !== "needs-reconnect")) {
					return fail(
						"VALIDATION_FAILED",
						"Google Calendar is not connected; connect it before syncing.",
						"GOOGLE_NOT_CONNECTED",
					);
				}
			}
			const allowed = await deps.rateLimiter.consume({
				ownerId,
				bucket: "job-create",
				limit: JOBS_PER_HOUR,
				windowMs: HOUR_MS,
				nowMs: deps.clock.nowMs(),
			});
			if (!allowed) return fail("RATE_LIMITED", "Too many runs were started; try again later.");
			const now = deps.clock.nowIso();
			// A stale `connecting` row with no active run means the previous
			// attempt died abnormally: recover by remembering a sane restore
			// point instead of `connecting` itself.
			const before = link?.status ?? "disconnected";
			const hadCalendar = link?.calendarId !== null && link?.calendarId !== undefined;
			const restoreTo =
				before === "connecting" ? (hadCalendar ? "needs-reconnect" : "disconnected") : before;
			if (action === "connect") {
				// Set BEFORE the insert, so the row is `connecting` by the
				// time a runner can claim the job and send its sign-in link.
				await deps.googleCalendar.setConnecting(ownerId, { connectFrom: restoreTo, at: now });
			}
			/**
			 * Undoes `setConnecting` when this request stored no connect job
			 * — unless another connect is in fact running, whose `connecting`
			 * status (and sign-in link) must stand.
			 */
			const undoConnecting = async (): Promise<void> => {
				if (action !== "connect") return;
				const winner = await deps.jobs.findActiveByKind(ownerId, "google-calendar");
				const winnerAction =
					winner !== null && winner.request !== null && "action" in winner.request
						? winner.request.action
						: null;
				if (winnerAction === "connect") return;
				await deps.googleCalendar.apply(
					ownerId,
					{ status: restoreTo, connectFrom: null, pendingAuthUrl: null },
					deps.clock.nowIso(),
				);
			};
			const job: JobRecord = {
				kind: "google-calendar",
				request: { action },
				workspaceId: null,
				retryOfRunId: null,
				contextAnchorSeq: null,
				runId: deps.ids.newId("run"),
				ownerId,
				state: "pending",
				usage: { ...EMPTY_USAGE },
				attempt: 0,
				maxAttempts: MAX_JOB_ATTEMPTS,
				leaseGeneration: 0,
				leaseOwnerId: null,
				leaseExpiresAt: null,
				lastEventSeq: -1,
				cancelRequested: false,
				failureCode: null,
				failureDetail: null,
				failureUpstreamStatus: null,
				approvalRequest: null,
				verificationStatus: null,
				providerModel: null,
				providerSessionRef: null,
				completedGeneration: null,
				provenance: null,
				version: 0,
				createdAt: now,
				updatedAt: now,
			};
			const outcome = await deps.jobs.insert(job, idempotencyKey, fingerprint, MAX_UNFINISHED_JOBS);
			if (outcome.kind === "at-capacity") {
				await undoConnecting();
				return fail("RATE_LIMITED", "At most 5 unfinished runs are allowed.");
			}
			if (outcome.kind === "no-workspace") {
				await undoConnecting();
				return fail("INTERNAL", "Internal error.");
			}
			if (outcome.kind === "kind-active") {
				// A concurrent request won the race after our check.
				await undoConnecting();
				const running =
					outcome.job.request !== null && "action" in outcome.job.request
						? outcome.job.request.action
						: null;
				if (running === action) return ok({ run: toRunView(outcome.job, []), replayed: true });
				return fail(
					"CONFLICT",
					"Another Google Calendar step is still running; wait for it to finish, then try again.",
				);
			}
			if (outcome.kind === "existing") {
				await undoConnecting();
				return outcome.sameRequest
					? ok({ run: toRunView(outcome.job, []), replayed: true })
					: fail(
							"IDEMPOTENCY_KEY_REUSED",
							"This idempotency key was already used for a different request.",
						);
			}
			if (action === "connect") {
				await deps.audit.record({
					ownerId,
					actor: "owner",
					action: "google_calendar.connect_requested",
					resource: job.runId,
					detail: "action=connect",
					at: now,
				});
			}
			return ok({ run: toRunView(job, []), replayed: false });
		},
	};
}

export type GoogleCalendarService = ReturnType<typeof createGoogleCalendarService>;

export {
	applyGoogleTerminalOutcome,
	googleSuccessPatch,
	googleTerminalPatch,
} from "./googleCalendarLink.ts";

/**
 * In-memory test double for the link repository (unit tests). Mirrors the
 * SQL adapter's semantics: `setConnecting` remembers the previous status,
 * `setPendingAuthUrl` only stores while connecting.
 */
export function createInMemoryGoogleCalendarRepository(): GoogleCalendarRepository & {
	readonly rows: ReadonlyMap<string, GoogleCalendarLink>;
} {
	const rows = new Map<string, GoogleCalendarLink>();
	const blank = (at: string): GoogleCalendarLink => ({
		status: "disconnected",
		connectFrom: null,
		pendingAuthUrl: null,
		calendarId: null,
		connectedAt: null,
		lastSyncedAt: null,
		syncedDigest: null,
		lastSync: null,
		lastFailureCode: null,
		lastFailureUpstreamStatus: null,
		lastFailureAt: null,
		updatedAt: at,
	});
	const applyPatch = (
		link: GoogleCalendarLink,
		patch: GoogleCalendarLinkPatch,
	): GoogleCalendarLink => ({
		status: patch.status ?? link.status,
		connectFrom: "connectFrom" in patch ? (patch.connectFrom ?? null) : link.connectFrom,
		pendingAuthUrl:
			"pendingAuthUrl" in patch ? (patch.pendingAuthUrl ?? null) : link.pendingAuthUrl,
		calendarId: "calendarId" in patch ? (patch.calendarId ?? null) : link.calendarId,
		connectedAt: "connectedAt" in patch ? (patch.connectedAt ?? null) : link.connectedAt,
		lastSyncedAt: "lastSyncedAt" in patch ? (patch.lastSyncedAt ?? null) : link.lastSyncedAt,
		syncedDigest: "syncedDigest" in patch ? (patch.syncedDigest ?? null) : link.syncedDigest,
		lastSync: "lastSync" in patch ? (patch.lastSync ?? null) : link.lastSync,
		lastFailureCode:
			"lastFailureCode" in patch ? (patch.lastFailureCode ?? null) : link.lastFailureCode,
		lastFailureUpstreamStatus:
			"lastFailureUpstreamStatus" in patch
				? (patch.lastFailureUpstreamStatus ?? null)
				: link.lastFailureUpstreamStatus,
		lastFailureAt: "lastFailureAt" in patch ? (patch.lastFailureAt ?? null) : link.lastFailureAt,
		updatedAt: link.updatedAt,
	});
	return {
		rows,
		async get(ownerId) {
			return rows.get(ownerId) ?? null;
		},
		async setConnecting(ownerId, input) {
			const previous = rows.get(ownerId) ?? blank(input.at);
			rows.set(ownerId, {
				...previous,
				status: "connecting",
				connectFrom: input.connectFrom,
				pendingAuthUrl: null,
				updatedAt: input.at,
			});
		},
		async setPendingAuthUrl(ownerId, url, at) {
			const link = rows.get(ownerId);
			if (link === undefined || link.status !== "connecting") return;
			rows.set(ownerId, { ...link, pendingAuthUrl: url, updatedAt: at });
		},
		async apply(ownerId, patch, at) {
			const previous = rows.get(ownerId) ?? blank(at);
			rows.set(ownerId, { ...applyPatch(previous, patch), updatedAt: at });
		},
	};
}
