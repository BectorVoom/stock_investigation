import { EQUITY_FINANCIAL_LIMITS, type EquityCompanyView } from "@research/contracts";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { companiesPollSignal } from "../equities/equitiesModel.ts";
import { refreshCompanyReads } from "../equities/financialStore.ts";
import { createPoller, type PollSchedule, type VisibilitySource } from "../lib/polling.ts";

/**
 * The companies list poll (ADR-0048 §8), moved from the Equities page:
 * every 2.5 s while a sync runs, every 15 s while one waits for a runner,
 * and otherwise every five minutes while the page is visible (with a
 * catch-up read on return) — an unchanged list is a 304.
 */
export const COMPANIES_POLL: PollSchedule = {
	activeMs: 2_500,
	idleBaseMs: 300_000,
	idleMaxMs: 300_000,
	queuedMaxMs: 15_000,
	backoffFactor: 2,
};

export interface CompaniesState {
	/** The tracked companies in tracking order; null before the first answer. */
	readonly companies: Accessor<readonly EquityCompanyView[] | null>;
	/** The last list read's failure; cleared by the next success. */
	readonly failure: Accessor<ApiFailure | null>;
	/** Companies (by id) with a write of this page on its way. */
	readonly busy: Accessor<ReadonlySet<string>>;
	/** Stock ids being set to sync. */
	readonly tracking: Accessor<ReadonlySet<string>>;
	/** True at `EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies` tracked companies. */
	readonly atLimit: Accessor<boolean>;
	readonly start: () => void;
	/** Reads the list now (Try again; a read said a company is gone). */
	readonly pollNow: () => void;
	readonly syncNow: (company: EquityCompanyView) => Promise<ApiResult<EquityCompanyView>>;
	readonly track: (stockId: string) => Promise<ApiResult<EquityCompanyView>>;
	readonly untrack: (company: EquityCompanyView) => Promise<ApiResult<null>>;
}

function toggled(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
	const next = new Set(set);
	if (on) next.add(key);
	else next.delete(key);
	return next;
}

/**
 * The Stocks page's companies half (ADR-0049 §2): `listEquityCompanies`
 * with its ETag and poll schedule, and the three writes (Sync now, track,
 * stop tracking). A finished sync re-reads the shown statement reads of its
 * company (`refreshCompanyReads`). Must be created under the page's owner.
 */
export function createCompaniesState(options: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): CompaniesState {
	const api = options.api;
	const [companies, setCompanies] = createSignal<readonly EquityCompanyView[] | null>(null);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
	const [tracking, setTracking] = createSignal<ReadonlySet<string>>(new Set());
	let etag: string | null = null;
	let disposed = false;

	/** Re-reads a company's statements when its last successful sync moved (values may have changed). */
	const noteFinishedSyncs = (
		before: readonly EquityCompanyView[] | null,
		after: readonly EquityCompanyView[],
	): void => {
		if (before === null) return;
		const previous = new Map(before.map((company) => [company.companyId, company] as const));
		for (const company of after) {
			const old = previous.get(company.companyId);
			if (old !== undefined && old.sync.lastSucceededAt !== company.sync.lastSucceededAt) {
				refreshCompanyReads(api, company.companyId);
			}
		}
	};

	const poller = createPoller({
		poll: async () => {
			const answer = await api.listEquityCompanies(etag);
			if (disposed) return "unchanged";
			if (!answer.ok) {
				setFailure(answer.error);
				return "failed";
			}
			setFailure(null);
			if (answer.value.changed) {
				etag = answer.value.etag;
				const next = answer.value.value.companies.filter((company) => company.tracked);
				noteFinishedSyncs(companies(), next);
				setCompanies(next);
			}
			return (
				companiesPollSignal(companies() ?? []) ?? (answer.value.changed ? "changed" : "unchanged")
			);
		},
		visibility: options.visibility,
		schedule: COMPANIES_POLL,
	});
	onCleanup(() => {
		disposed = true;
		poller.stop();
	});

	/** Puts a company the API answered for into the list in place (its new sync status). */
	const replaceCompany = (company: EquityCompanyView): void => {
		setCompanies((current) =>
			current === null
				? current
				: current.map((entry) => (entry.companyId === company.companyId ? company : entry)),
		);
	};

	return {
		companies,
		failure,
		busy,
		tracking,
		atLimit: () => (companies()?.length ?? 0) >= EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies,
		start: () => poller.start(),
		pollNow: () => poller.pollNow(),
		syncNow: async (company) => {
			setBusy((current) => toggled(current, company.companyId, true));
			const answer = await api.syncEquityCompany(company.companyId);
			setBusy((current) => toggled(current, company.companyId, false));
			if (disposed || !answer.ok) return answer;
			replaceCompany(answer.value);
			poller.pollNow();
			return answer;
		},
		track: async (stockId) => {
			setTracking((current) => toggled(current, stockId, true));
			const answer = await api.trackEquityCompany(stockId);
			setTracking((current) => toggled(current, stockId, false));
			if (disposed || !answer.ok) return answer;
			const company = answer.value;
			setCompanies((current) => [
				...(current ?? []).filter((entry) => entry.companyId !== company.companyId),
				company,
			]);
			poller.pollNow();
			return answer;
		},
		untrack: async (company) => {
			setBusy((current) => toggled(current, company.companyId, true));
			const answer = await api.untrackEquityCompany(company.companyId);
			setBusy((current) => toggled(current, company.companyId, false));
			if (disposed || !answer.ok) return answer;
			setCompanies((current) =>
				current === null
					? current
					: current.filter((entry) => entry.companyId !== company.companyId),
			);
			poller.pollNow();
			return answer;
		},
	};
}
