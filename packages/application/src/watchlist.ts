import {
	type AddWatchlistListStockRequest,
	type AddWatchlistStockRequest,
	addWatchlistListStockRequestSchema,
	addWatchlistStockRequestSchema,
	type CalendarFeedIssued,
	type CreateWatchlistListRequest,
	createWatchlistListRequestSchema,
	DEFAULT_HOME_DASHBOARD,
	EARNINGS_LIMITS,
	earningsUnavailable,
	formatStockId,
	type GoogleCalendarState,
	idSchema,
	parseStockId,
	type RefreshScope,
	type RenameWatchlistListRequest,
	renameWatchlistListRequestSchema,
	WATCHLIST_LISTS_LIMITS,
	type WatchlistResponse,
	type WatchMarket,
} from "@research/contracts";
import {
	buildEarningsCalendar,
	EARNINGS_SOURCE_BY_MARKET,
	EARNINGS_SOURCE_INFO,
	EMPTY_USAGE,
	err,
	ok,
} from "@research/domain";
import { fail, type UseCaseError, type UseCaseResult } from "./errors.ts";
import {
	assembleDesiredEvents,
	type GoogleActiveRun,
	toGoogleCalendarState,
} from "./googleCalendar.ts";
import { ownerSeries } from "./pageSeries.ts";
import type {
	AuditLog,
	CalendarFeedRepository,
	Clock,
	EarningsRepository,
	GoogleCalendarRepository,
	Hasher,
	HomeDashboardRepository,
	IdGenerator,
	JobRecord,
	JobRepository,
	MarketRepository,
	NotebookRepository,
	RateLimiter,
	SecretGenerator,
	StockDirectoryRepository,
	StoredEarningsEvent,
	StoredWatchlistList,
	StoredWatchlistStock,
	WatchlistListRepository,
	WatchlistRepository,
} from "./ports.ts";
import { activeRefreshJob, refreshFingerprint, refreshScopeRequest } from "./refreshScope.ts";
import { type CreatedRun, JOB_ADMISSION, MAX_JOB_ATTEMPTS } from "./researchRuns.ts";
import { toRunView } from "./runView.ts";

export interface WatchlistServiceDeps {
	readonly watchlist: WatchlistRepository;
	/** Titled lists of watchlist stocks (ADR-0040). */
	readonly watchlistLists: WatchlistListRepository;
	/**
	 * What a series clean-up after a list change must keep (ADR-0040 §2):
	 * Home's and every notebook's named and listed series.
	 */
	readonly homeDashboard: Pick<HomeDashboardRepository, "get">;
	readonly notebooks: Pick<NotebookRepository, "listMarketSeriesIds" | "listWatchlistListIds">;
	readonly market: Pick<MarketRepository, "deleteSeriesNotIn">;
	readonly earnings: EarningsRepository;
	readonly calendarFeed: CalendarFeedRepository;
	readonly googleCalendar: GoogleCalendarRepository;
	/** Names a stock added from the stock directory (ADR-0034). */
	readonly stockDirectory: Pick<StockDirectoryRepository, "getEntry">;
	readonly jobs: JobRepository;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly secrets: SecretGenerator;
	readonly hasher: Hasher;
	readonly rateLimiter: RateLimiter;
	readonly audit: AuditLog;
}

/**
 * The cheap, owner-scoped facts a `/watchlist` ETag covers: one stamp per
 * stock (attempt/success times, failure code), the refresh state and the feed
 * stamp. Event rows are NOT part of the digest — they always move together
 * with the stamps a completion writes — so a 304 is answered before any
 * event row is loaded.
 */
export interface WatchlistDigest {
	readonly stockStamps: readonly {
		readonly stockId: string;
		readonly lastRefreshedAt: string | null;
		readonly retrievedAt: string | null;
		readonly unavailableCode: string | null;
		readonly unavailableUpstreamStatus: number | null;
	}[];
	readonly activeRunId: string | null;
	readonly activeRunState: string | null;
	readonly lastSucceededAt: string | null;
	readonly lastFailure: WatchlistResponse["refresh"]["lastFailure"];
	readonly feedCreatedAt: string | null;
	/**
	 * One stamp per list in creation order (ADR-0040): every change to a list
	 * — a rename, a stock added or removed, one of its stocks leaving the
	 * watchlist — bumps its version, so the ETag covers lists without
	 * comparing titles or members. A created or deleted list changes the set.
	 */
	readonly listStamps: readonly { readonly listId: string; readonly version: number }[];
	/**
	 * Repository-backed Google Calendar state (FR-019 section 2.5). It is
	 * part of the digest so the ETag covers every field of it: both views
	 * see link, run and freshness changes through the poll they already run.
	 */
	readonly googleCalendar: GoogleCalendarState;
}

/**
 * Runner-supplied text made safe inside a quoted header value: printable
 * ASCII passes through, everything else (and the quote, percent and
 * backslash characters) becomes
 * `%<hex code unit>;`. Injective, so two different values never share an
 * ETag, and total — it cannot throw on any string.
 */
export function headerSafe(value: string): string {
	let safe = "";
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		const plain = code > 0x20 && code < 0x7f && code !== 0x22 && code !== 0x25 && code !== 0x5c;
		safe += plain ? value.charAt(index) : `%${code.toString(16)};`;
	}
	return safe;
}

/**
 * Pure ETag source for `/watchlist`, over the digest only. The same string
 * is used for the digest-first 304 check and for the full response, so the
 * two can never disagree.
 */
export function watchlistDigestEtag(digest: WatchlistDigest): string {
	const stocks = digest.stockStamps
		.map(
			(entry) =>
				`${entry.stockId}:${entry.lastRefreshedAt ?? "never"}:${entry.retrievedAt ?? "never"}:${entry.unavailableCode ?? "ok"}:${entry.unavailableUpstreamStatus ?? "-"}`,
		)
		.join(",");
	const failure =
		digest.lastFailure === null
			? "no-failure"
			: `${digest.lastFailure.state}:${digest.lastFailure.code}:${digest.lastFailure.upstreamStatus ?? "-"}:${digest.lastFailure.at}`;
	const sync =
		digest.googleCalendar.lastSync === null
			? "no-sync"
			: `${digest.googleCalendar.lastSync.inserted}.${digest.googleCalendar.lastSync.updated}.${digest.googleCalendar.lastSync.deleted}.${digest.googleCalendar.lastSync.unchanged}`;
	const googleFailure =
		digest.googleCalendar.lastFailure === null
			? "no-gfailure"
			: `${digest.googleCalendar.lastFailure.code}:${digest.googleCalendar.lastFailure.upstreamStatus ?? "-"}:${digest.googleCalendar.lastFailure.at}`;
	// The sign-in link and the calendar id come from the runner: they are
	// percent-encoded so nothing in them (a quote, a non-ASCII character)
	// can make this string unusable as a header value.
	const authUrl = digest.googleCalendar.authUrl;
	const calendarId = digest.googleCalendar.calendarId;
	const google =
		`gcal.${digest.googleCalendar.status}.${authUrl === null ? "no-url" : headerSafe(authUrl)}.` +
		`${calendarId === null ? "no-cal" : headerSafe(calendarId)}.${digest.googleCalendar.connectedAt ?? "never"}.` +
		`${digest.googleCalendar.lastSyncedAt ?? "never"}.${sync}.` +
		`${digest.googleCalendar.inSync ?? "na"}.${digest.googleCalendar.activeRunId ?? "idle"}.` +
		`${digest.googleCalendar.activeRunState ?? "idle"}.${digest.googleCalendar.activeAction ?? "none"}.${googleFailure}`;
	const lists = digest.listStamps.map((entry) => `${entry.listId}:${entry.version}`).join(",");
	return `watchlist.${digest.stockStamps.length}.${digest.activeRunId ?? "idle"}.${digest.activeRunState ?? "idle"}.${digest.lastSucceededAt ?? "never"}.${failure}.${digest.feedCreatedAt ?? "no-feed"}.${stocks}.lists.${digest.listStamps.length}.${lists}.${google}`;
}

/** Feed path relative to the origin; the token is the path segment. */
export function calendarFeedPath(token: string): string {
	return `/api/v1/calendar-feed/${token}/earnings.ics`;
}

const FEED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,200}$/;

const LIST_NOT_FOUND = "List not found.";
const NOT_IN_LIST = "The stock is not in this list.";

function listFull(): UseCaseResult<never> {
	return fail(
		"VALIDATION_FAILED",
		`A list holds at most ${WATCHLIST_LISTS_LIMITS.maxStocksPerList} stocks.`,
		"WATCHLIST_LIST_FULL",
	);
}

/** A stored list as the API answers it (ADR-0040), naming only stocks the response holds. */
function toWatchlistList(
	list: StoredWatchlistList,
	watched: ReadonlySet<string>,
): WatchlistResponse["lists"][number] {
	return {
		listId: list.listId,
		title: list.title,
		stockIds: list.stockIds.filter((stockId) => watched.has(stockId)),
		version: list.version,
		createdAt: list.createdAt,
		updatedAt: list.updatedAt,
	};
}

const JOBS_PER_HOUR = JOB_ADMISSION.jobsPerHour;
const HOUR_MS = JOB_ADMISSION.windowMs;
const MAX_UNFINISHED_JOBS = JOB_ADMISSION.maxUnfinishedJobs;
export function createWatchlistService(deps: WatchlistServiceDeps) {
	async function refreshState(
		ownerId: string,
	): Promise<
		Pick<WatchlistDigest, "activeRunId" | "activeRunState" | "lastSucceededAt" | "lastFailure">
	> {
		const [active, lastSucceededAt, lastFailureRow] = await Promise.all([
			deps.jobs.findActiveByKind(ownerId, "earnings-refresh"),
			deps.jobs.findLatestSuccessAtByKind(ownerId, "earnings-refresh"),
			deps.jobs.findLatestFailureByKind(ownerId, "earnings-refresh"),
		]);
		return {
			activeRunId: active?.runId ?? null,
			activeRunState: active?.state ?? null,
			lastSucceededAt,
			lastFailure:
				lastFailureRow === null || lastFailureRow.failureCode === null
					? null
					: {
							state: lastFailureRow.state,
							code: lastFailureRow.failureCode,
							upstreamStatus: lastFailureRow.failureUpstreamStatus,
							at: lastFailureRow.at,
						},
		};
	}

	function toWatchlistStock(
		stock: StoredWatchlistStock,
		events: readonly StoredEarningsEvent[],
	): WatchlistResponse["stocks"][number] {
		const source = EARNINGS_SOURCE_BY_MARKET[stock.market];
		const info = EARNINGS_SOURCE_INFO[source];
		return {
			stockId: stock.stockId,
			market: stock.market,
			symbol: stock.symbol,
			name: stock.name,
			addedAt: stock.addedAt,
			source,
			publisher: info.publisher,
			sourceUrl: info.sourceUrl,
			lastRefreshedAt: stock.lastRefreshedAt,
			retrievedAt: stock.retrievedAt,
			unavailable:
				stock.unavailableCode !== null
					? earningsUnavailable(stock.unavailableCode, source, stock.unavailableUpstreamStatus)
					: stock.retrievedAt === null
						? earningsUnavailable("NEVER_REFRESHED")
						: null,
			events: events.slice(0, EARNINGS_LIMITS.maxEventsPerStock).map((event) => ({
				periodKey: event.periodKey,
				announcementDate: event.announcementDate,
				fiscalPeriodLabel: event.fiscalPeriodLabel,
				fiscalPeriodEnd: event.fiscalPeriodEnd,
				timing: event.timing,
			})),
		};
	}

	async function assemble(
		ownerId: string,
		stocks: readonly StoredWatchlistStock[],
	): Promise<WatchlistResponse> {
		const [events, lists] = await Promise.all([
			deps.earnings.getEvents(
				ownerId,
				stocks.map((stock) => stock.stockId),
			),
			deps.watchlistLists.listLists(ownerId),
		]);
		const byStock = new Map<string, StoredEarningsEvent[]>();
		for (const event of events) {
			const list = byStock.get(event.stockId) ?? [];
			list.push(event);
			byStock.set(event.stockId, list);
		}
		// The stocks and the lists are two reads: a stock added to the
		// watchlist and a list between them would make the list name a stock
		// this response does not hold. Such a member is left out until the
		// next read rather than failing the whole response.
		const watched = new Set(stocks.map((stock) => stock.stockId));
		const header = await refreshState(ownerId);
		const feed = await deps.calendarFeed.get(ownerId);
		return {
			stocks: stocks.map((stock) => toWatchlistStock(stock, byStock.get(stock.stockId) ?? [])),
			lists: lists.map((list) => toWatchlistList(list, watched)),
			refresh: {
				activeRunId: header.activeRunId,
				activeRunState: header.activeRunState,
				lastSucceededAt: header.lastSucceededAt,
				lastFailure: header.lastFailure,
			},
			feed: { enabled: feed !== null, createdAt: feed?.createdAt ?? null },
			googleCalendar: await googleState(ownerId),
		};
	}

	/** The current watchlist response (after a change, or for an idempotent no-op). */
	async function current(ownerId: string): Promise<WatchlistResponse> {
		return assemble(ownerId, await deps.watchlist.listStocks(ownerId));
	}

	/**
	 * Adds a stock to the watchlist (ADR-0034 naming, the 50-stock cap, the
	 * audit row): the ONE implementation behind `POST /watchlist/stocks` and
	 * adding a stock to a list that is not watched yet (ADR-0040 §2).
	 */
	async function addToWatchlist(
		ownerId: string,
		market: WatchMarket,
		symbol: string,
	): Promise<UseCaseResult<{ readonly stockId: string }>> {
		const stockId = formatStockId(market, symbol);
		const now = deps.clock.nowIso();
		// ADR-0034: a stock the directory lists is stored with the
		// directory's (English / SEC / JPX) name, so the table names the
		// company at once. The Japanese local name never goes here, and a
		// stock outside the directory starts with a null name. Either way
		// the earnings refresh may replace the name later: a refresh that
		// returns a company name stores it (`COALESCE(new, stored)` in the
		// completion commit), and one that returns none keeps the stored
		// name.
		const listed = await deps.stockDirectory.getEntry(ownerId, market, symbol);
		// The cap is enforced by the INSERT itself (see the port): the
		// outcome tells an idempotent re-add apart from a full list, and
		// only a written row is audited — a lost race writes no second
		// audit row.
		const outcome = await deps.watchlist.insertStock(
			ownerId,
			{ stockId, market, symbol, name: listed?.name ?? null, addedAt: now },
			EARNINGS_LIMITS.maxStocks,
		);
		if (outcome === "full") {
			return fail(
				"VALIDATION_FAILED",
				`At most ${EARNINGS_LIMITS.maxStocks} stocks can be watched.`,
				"WATCHLIST_FULL",
			);
		}
		if (outcome === "added") {
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "watchlist.stock.add",
				resource: stockId,
				detail: `market=${market}`,
				at: now,
			});
		}
		return ok({ stockId });
	}

	/**
	 * After a list change or a watchlist removal, deletes the price series no
	 * page tracks any more (ADR-0040 §2), like a Home save does (S4b). An
	 * unreadable stored dashboard keeps everything: what it names cannot be
	 * known, and its reset way out runs the same clean-up.
	 */
	async function deleteUntrackedSeries(ownerId: string): Promise<void> {
		const stored = await deps.homeDashboard.get(ownerId);
		if (stored === "unreadable") return;
		const dashboard = stored === null ? DEFAULT_HOME_DASHBOARD : stored.dashboard;
		const { keep } = await ownerSeries(deps, ownerId, dashboard.widgets);
		await deps.market.deleteSeriesNotIn(ownerId, keep);
	}

	async function auditList(
		ownerId: string,
		action: string,
		listId: string,
		detail: string,
		at: string,
	): Promise<void> {
		// The list title is owner text and never goes into an audit row.
		await deps.audit.record({ ownerId, actor: "owner", action, resource: listId, detail, at });
	}

	/**
	 * Repository-backed Google Calendar state. The current desired digest
	 * is computed only for a connected calendar with a stored digest —
	 * otherwise `inSync` is decided without loading any event row, so the
	 * cheap digest path stays cheap for everyone else.
	 */
	async function googleState(ownerId: string): Promise<GoogleCalendarState> {
		const [link, activeJob] = await Promise.all([
			deps.googleCalendar.get(ownerId),
			deps.jobs.findActiveByKind(ownerId, "google-calendar"),
		]);
		const active: GoogleActiveRun | null =
			activeJob === null
				? null
				: {
						runId: activeJob.runId,
						state: activeJob.state,
						action:
							activeJob.request !== null && "action" in activeJob.request
								? activeJob.request.action
								: null,
					};
		let currentDigest: string | null = null;
		if (link !== null && link.status === "connected" && link.syncedDigest !== null) {
			const desired = await assembleDesiredEvents(
				{ watchlist: deps.watchlist, earnings: deps.earnings, hasher: deps.hasher },
				ownerId,
			);
			// An undecidable set reports out-of-sync rather than failing
			// the whole read; the claim fails closed when it matters.
			currentDigest = desired.ok ? desired.value.digest : null;
		}
		return toGoogleCalendarState(link, active, currentDigest);
	}

	/** The owner's calendar document: every dated event, deterministic bytes. */
	async function calendarDocument(ownerId: string): Promise<UseCaseResult<string>> {
		const stocks = await deps.watchlist.listStocks(ownerId);
		const byId = new Map(stocks.map((stock) => [stock.stockId, stock]));
		const events = await deps.earnings.getEvents(
			ownerId,
			stocks.map((stock) => stock.stockId),
		);
		const calendar = buildEarningsCalendar({
			calendarName: "Earnings calendar",
			events: events.flatMap((event) => {
				const stock = byId.get(event.stockId);
				// The stock was removed concurrently: its events are gone with
				// it (same unit of work), so there is nothing to stamp.
				if (stock === undefined || stock.retrievedAt === null) return [];
				const source = EARNINGS_SOURCE_BY_MARKET[stock.market];
				const info = EARNINGS_SOURCE_INFO[source];
				return [
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
				];
			}),
		});
		return ok(calendar);
	}

	return {
		async getDigest(ownerId: string): Promise<UseCaseResult<WatchlistDigest>> {
			const [stocks, header, feed, lists] = await Promise.all([
				deps.watchlist.listStocks(ownerId),
				refreshState(ownerId),
				deps.calendarFeed.get(ownerId),
				deps.watchlistLists.listLists(ownerId),
			]);
			return ok({
				stockStamps: stocks.map((stock) => ({
					stockId: stock.stockId,
					lastRefreshedAt: stock.lastRefreshedAt,
					retrievedAt: stock.retrievedAt,
					unavailableCode: stock.unavailableCode,
					unavailableUpstreamStatus: stock.unavailableUpstreamStatus,
				})),
				...header,
				feedCreatedAt: feed?.createdAt ?? null,
				listStamps: lists.map((list) => ({ listId: list.listId, version: list.version })),
				googleCalendar: await googleState(ownerId),
			});
		},

		async getWatchlist(ownerId: string): Promise<UseCaseResult<WatchlistResponse>> {
			const stocks = await deps.watchlist.listStocks(ownerId);
			return ok(await assemble(ownerId, stocks));
		},

		async addStock(
			ownerId: string,
			request: AddWatchlistStockRequest,
		): Promise<UseCaseResult<WatchlistResponse>> {
			const parsed = addWatchlistStockRequestSchema.safeParse(request);
			if (!parsed.success) return fail("VALIDATION_FAILED", "The stock could not be added.");
			const added = await addToWatchlist(ownerId, parsed.data.market, parsed.data.symbol);
			if (!added.ok) return added;
			return ok(await current(ownerId));
		},

		async removeStock(ownerId: string, stockId: string): Promise<UseCaseResult<WatchlistResponse>> {
			if (parseStockId(stockId) === null) return fail("NOT_FOUND", "Stock not found.");
			const now = deps.clock.nowIso();
			const removed = await deps.watchlist.removeStock(ownerId, stockId, now);
			if (!removed) return fail("NOT_FOUND", "Stock not found.");
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "watchlist.stock.remove",
				resource: stockId,
				detail: "",
				at: now,
			});
			// Its price series may have been shown only through a list.
			await deleteUntrackedSeries(ownerId);
			return ok(await current(ownerId));
		},

		/** `POST /watchlist/lists` (ADR-0040): a new, empty list. */
		async createList(
			ownerId: string,
			request: CreateWatchlistListRequest,
		): Promise<UseCaseResult<WatchlistResponse>> {
			const parsed = createWatchlistListRequestSchema.safeParse(request);
			if (!parsed.success) return fail("VALIDATION_FAILED", "The list could not be created.");
			const listId = deps.ids.newId("list");
			if (!idSchema.safeParse(listId).success) return fail("INTERNAL", "Internal error.");
			const now = deps.clock.nowIso();
			const outcome = await deps.watchlistLists.insertList(
				ownerId,
				{ listId, title: parsed.data.title, createdAt: now },
				WATCHLIST_LISTS_LIMITS.maxLists,
			);
			if (outcome === "full") {
				return fail(
					"VALIDATION_FAILED",
					`At most ${WATCHLIST_LISTS_LIMITS.maxLists} lists can be kept.`,
					"WATCHLIST_LISTS_FULL",
				);
			}
			await auditList(ownerId, "watchlist.list.create", listId, "", now);
			return ok(await current(ownerId));
		},

		/** `PATCH /watchlist/lists/:listId` (ADR-0040): a new title. */
		async renameList(
			ownerId: string,
			listId: string,
			request: RenameWatchlistListRequest,
		): Promise<UseCaseResult<WatchlistResponse>> {
			if (!idSchema.safeParse(listId).success) return fail("NOT_FOUND", LIST_NOT_FOUND);
			const parsed = renameWatchlistListRequestSchema.safeParse(request);
			if (!parsed.success) return fail("VALIDATION_FAILED", "The list could not be renamed.");
			const now = deps.clock.nowIso();
			const renamed = await deps.watchlistLists.renameList(ownerId, listId, parsed.data.title, now);
			if (!renamed) return fail("NOT_FOUND", LIST_NOT_FOUND);
			await auditList(ownerId, "watchlist.list.rename", listId, "", now);
			return ok(await current(ownerId));
		},

		/**
		 * `DELETE /watchlist/lists/:listId` (ADR-0040): the list and its
		 * memberships; its widgets stay and say the list was deleted. Series
		 * only the list kept are deleted with it.
		 */
		async deleteList(ownerId: string, listId: string): Promise<UseCaseResult<WatchlistResponse>> {
			if (!idSchema.safeParse(listId).success) return fail("NOT_FOUND", LIST_NOT_FOUND);
			const deleted = await deps.watchlistLists.deleteList(ownerId, listId);
			if (!deleted) return fail("NOT_FOUND", LIST_NOT_FOUND);
			await auditList(ownerId, "watchlist.list.delete", listId, "", deps.clock.nowIso());
			await deleteUntrackedSeries(ownerId);
			return ok(await current(ownerId));
		},

		/**
		 * `POST /watchlist/lists/:listId/stocks` (ADR-0040 §2). The list's
		 * existence and room are checked BEFORE the watchlist is touched, so
		 * the common failures add nothing; a stock not on the watchlist is
		 * then added to it exactly as `addStock` does. A lost race (the list
		 * deleted or filled in between) may leave the stock on the watchlist
		 * only, which is a valid state. Adding a member again is a no-op.
		 */
		async addListStock(
			ownerId: string,
			listId: string,
			request: AddWatchlistListStockRequest,
		): Promise<UseCaseResult<WatchlistResponse>> {
			if (!idSchema.safeParse(listId).success) return fail("NOT_FOUND", LIST_NOT_FOUND);
			const parsed = addWatchlistListStockRequestSchema.safeParse(request);
			if (!parsed.success) return fail("VALIDATION_FAILED", "The stock could not be added.");
			const stockId = formatStockId(parsed.data.market, parsed.data.symbol);
			const list = (await deps.watchlistLists.listLists(ownerId)).find(
				(entry) => entry.listId === listId,
			);
			if (list === undefined) return fail("NOT_FOUND", LIST_NOT_FOUND);
			if (list.stockIds.includes(stockId)) return ok(await current(ownerId));
			if (list.stockIds.length >= WATCHLIST_LISTS_LIMITS.maxStocksPerList) return listFull();
			const watched = await addToWatchlist(ownerId, parsed.data.market, parsed.data.symbol);
			if (!watched.ok) return watched;
			const now = deps.clock.nowIso();
			const outcome = await deps.watchlistLists.addStock(
				ownerId,
				listId,
				stockId,
				now,
				WATCHLIST_LISTS_LIMITS.maxStocksPerList,
			);
			switch (outcome) {
				case "added":
					await auditList(ownerId, "watchlist.list.stock.add", listId, `stock=${stockId}`, now);
					return ok(await current(ownerId));
				case "already-present":
					return ok(await current(ownerId));
				case "list-full":
					return listFull();
				case "list-not-found":
					return fail("NOT_FOUND", LIST_NOT_FOUND);
				case "stock-not-found":
					// Removed from the watchlist between the two writes.
					return fail("NOT_FOUND", "Stock not found.");
			}
		},

		/**
		 * `DELETE /watchlist/lists/:listId/stocks/:stockId` (ADR-0040): the
		 * stock leaves the list but stays on the watchlist. Its price series
		 * is deleted when no page tracks it any more.
		 */
		async removeListStock(
			ownerId: string,
			listId: string,
			stockId: string,
		): Promise<UseCaseResult<WatchlistResponse>> {
			if (!idSchema.safeParse(listId).success) return fail("NOT_FOUND", LIST_NOT_FOUND);
			if (parseStockId(stockId) === null) return fail("NOT_FOUND", NOT_IN_LIST);
			const now = deps.clock.nowIso();
			const outcome = await deps.watchlistLists.removeStock(ownerId, listId, stockId, now);
			if (outcome === "list-not-found") return fail("NOT_FOUND", LIST_NOT_FOUND);
			if (outcome === "not-in-list") return fail("NOT_FOUND", NOT_IN_LIST);
			await auditList(ownerId, "watchlist.list.stock.remove", listId, `stock=${stockId}`, now);
			await deleteUntrackedSeries(ownerId);
			return ok(await current(ownerId));
		},

		/**
		 * Queues an earnings-date refresh of every watchlist stock (`"all"`)
		 * or only those never refreshed (`"unrefreshed"`, ADR-0039). AT MOST
		 * ONE non-terminal earnings-refresh job per owner: a request while one
		 * is active returns that active run (no second job); a request for
		 * everything first widens a still-pending `"unrefreshed"` one. An
		 * empty watchlist queues nothing and says so with a stable code.
		 */
		async queueRefresh(
			ownerId: string,
			idempotencyKey: string,
			scope: RefreshScope,
		): Promise<UseCaseResult<CreatedRun>> {
			const active = await activeRefreshJob(deps, ownerId, "earnings-refresh", scope);
			if (active !== null) {
				return ok({ run: toRunView(active, []), replayed: true });
			}
			const fingerprint = refreshFingerprint("earnings-refresh", scope);
			const existing = await deps.jobs.findByIdempotencyKey(ownerId, idempotencyKey);
			if (existing !== null) {
				return existing.requestFingerprint === fingerprint
					? ok({ run: toRunView(existing.job, []), replayed: true })
					: fail(
							"IDEMPOTENCY_KEY_REUSED",
							"This idempotency key was already used for a different request.",
						);
			}
			const count = await deps.watchlist.countStocks(ownerId);
			if (count === 0) {
				return fail(
					"VALIDATION_FAILED",
					"The watchlist has no stocks to refresh.",
					"WATCHLIST_EMPTY",
				);
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
			const job: JobRecord = {
				kind: "earnings-refresh",
				request: refreshScopeRequest(scope),
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
				return fail("RATE_LIMITED", "At most 5 unfinished runs are allowed.");
			}
			if (outcome.kind === "no-workspace") {
				return fail("INTERNAL", "Internal error.");
			}
			if (outcome.kind === "kind-active") {
				// Another request inserted its job between our read and this
				// insert: a request for everything widens it when it is a
				// pending narrow job, like an active job found before the insert.
				const raced =
					scope === "all" ? await activeRefreshJob(deps, ownerId, "earnings-refresh", scope) : null;
				return ok({ run: toRunView(raced ?? outcome.job, []), replayed: true });
			}
			if (outcome.kind === "existing") {
				return outcome.sameRequest
					? ok({ run: toRunView(outcome.job, []), replayed: true })
					: fail(
							"IDEMPOTENCY_KEY_REUSED",
							"This idempotency key was already used for a different request.",
						);
			}
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "run.create_earnings_refresh",
				resource: job.runId,
				detail: `kind=earnings-refresh scope=${scope}`,
				at: now,
			});
			return ok({ run: toRunView(job, []), replayed: false });
		},

		async getCalendar(ownerId: string): Promise<UseCaseResult<string>> {
			return calendarDocument(ownerId);
		},

		/**
		 * Issues (or rotates) the calendar subscription token. The token is
		 * returned exactly once; only its SHA-256 is stored. The audit row
		 * never carries the token.
		 */
		async issueFeed(ownerId: string): Promise<UseCaseResult<CalendarFeedIssued>> {
			const token = deps.secrets.newSecret();
			if (!FEED_TOKEN_PATTERN.test(token)) return fail("INTERNAL", "Internal error.");
			const tokenHash = await deps.hasher.sha256Hex(token);
			const now = deps.clock.nowIso();
			await deps.calendarFeed.put(ownerId, tokenHash, now);
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "watchlist.feed.issue",
				resource: ownerId,
				detail: "feed=issued",
				at: now,
			});
			return ok({ token, path: calendarFeedPath(token), createdAt: now });
		},

		async revokeFeed(ownerId: string): Promise<UseCaseResult<void>> {
			const revoked = await deps.calendarFeed.revoke(ownerId);
			if (!revoked) return fail("NOT_FOUND", "There is no subscription link to revoke.");
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "watchlist.feed.revoke",
				resource: ownerId,
				detail: "feed=revoked",
				at: deps.clock.nowIso(),
			});
			return ok(undefined);
		},

		/**
		 * Serves one owner's calendar to a token-bearing calendar app. Any
		 * failure — bad shape, unknown or revoked token — yields the same
		 * null, so the route answers one uniform 404 (SEC-005). The owner
		 * session is never consulted here.
		 */
		async getFeedCalendar(token: string): Promise<UseCaseResult<{ ownerId: string; ics: string }>> {
			const failure: UseCaseError = { code: "NOT_FOUND", message: "Resource not found." };
			if (!FEED_TOKEN_PATTERN.test(token)) return err(failure);
			const tokenHash = await deps.hasher.sha256Hex(token);
			const ownerId = await deps.calendarFeed.findOwnerByTokenHash(tokenHash);
			if (ownerId === null) return err(failure);
			const calendar = await calendarDocument(ownerId);
			if (!calendar.ok) return calendar;
			return ok({ ownerId, ics: calendar.value });
		},
	};
}

export type WatchlistService = ReturnType<typeof createWatchlistService>;
