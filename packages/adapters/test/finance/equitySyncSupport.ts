/** Shared doubles and fixture access for the financial statement sync tests (ADR-0048). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BinaryDocument,
	Clock,
	FetchedDocument,
	SafeBinaryFetcher,
	SafeFetchError,
	SafeFetcher,
} from "@research/application";
import type { ClaimedJob, EdinetKnownFiling } from "@research/contracts";
import { equityConceptsOfProvider, err, ok } from "@research/domain";
import type { EquitySyncQuery, EquitySyncTarget } from "../../src/finance/equitySync.ts";

const FIXTURE_DIR = fileURLToPath(
	new URL("../../../../examples/fixtures/equity-sync/", import.meta.url),
);

export function equityFixtureText(name: string): string {
	return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

export function equityFixtureJson(name: string): unknown {
	return JSON.parse(equityFixtureText(name));
}

export function equityFixtureBytes(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

export const SEC_CONCEPTS = equityConceptsOfProvider("sec");
export const EDINET_CONCEPTS = equityConceptsOfProvider("edinet");

/** One answer: text, bytes, or a fetch error. */
export type FakeAnswer =
	| { readonly text: string; readonly contentType?: string }
	| { readonly bytes: Uint8Array; readonly contentType?: string }
	| { readonly error: SafeFetchError };

export interface RecordedRequest {
	readonly url: string;
	readonly kind: "text" | "bytes";
	readonly maxBytes: number;
	readonly accept: string;
	readonly allowedHosts: readonly string[] | null;
	readonly userAgent: string | null;
}

/**
 * A text + binary fetcher answering by exact URL (an unknown URL answers
 * HTTP 404) and recording every request with the options that matter.
 */
export function fakeFetcher(answers: ReadonlyMap<string, FakeAnswer>) {
	const requests: RecordedRequest[] = [];
	const fetcher: SafeFetcher & SafeBinaryFetcher = {
		async fetchText(url, options) {
			requests.push({
				url,
				kind: "text",
				maxBytes: options.maxBytes,
				accept: options.accept,
				allowedHosts: options.allowedHosts === undefined ? null : [...options.allowedHosts],
				userAgent: options.userAgent ?? null,
			});
			const answer = answers.get(url);
			if (answer === undefined) return err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 });
			if ("error" in answer) return err(answer.error);
			if ("bytes" in answer) return err({ code: "NETWORK_ERROR", detail: "bytes for text" });
			const document: FetchedDocument = {
				finalUrl: url,
				contentType: answer.contentType ?? "application/json",
				text: answer.text,
			};
			return ok(document);
		},
		async fetchBytes(url, options) {
			requests.push({
				url,
				kind: "bytes",
				maxBytes: options.maxBytes,
				accept: options.accept,
				allowedHosts: options.allowedHosts === undefined ? null : [...options.allowedHosts],
				userAgent: options.userAgent ?? null,
			});
			const answer = answers.get(url);
			if (answer === undefined) return err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 });
			if ("error" in answer) return err(answer.error);
			const document: BinaryDocument = {
				finalUrl: url,
				contentType: answer.contentType ?? "application/octet-stream",
				bytes: "bytes" in answer ? answer.bytes : new TextEncoder().encode(answer.text),
			};
			return ok(document);
		},
	};
	return { fetcher, requests };
}

export function httpError(status: number): FakeAnswer {
	return { error: { code: "HTTP_ERROR", detail: `HTTP ${status}`, status } };
}

/** A clock a test moves by hand. */
export function movableClock(startIso = "2026-10-31T03:00:00.000Z") {
	let now = Date.parse(startIso);
	const clock: Clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };
	return {
		clock,
		advance(ms: number) {
			now += ms;
		},
	};
}

type FinancialSyncJob = Extract<ClaimedJob, { kind: "financial-sync" }>;

export function secTarget(
	source: Partial<Extract<FinancialSyncJob["source"], { provider: "sec" }>> = {},
	symbol = "SYND",
): EquitySyncTarget {
	return {
		companyId: "eqc_us",
		market: "US",
		symbol,
		concepts: [...SEC_CONCEPTS],
		source: {
			provider: "sec",
			cik: "0009999981",
			knownAccessions: [],
			pendingFilings: [],
			filedSince: "2020-10-31",
			fullCheck: false,
			...source,
		},
	};
}

export function edinetTarget(
	source: Partial<Extract<FinancialSyncJob["source"], { provider: "edinet" }>> = {},
): EquitySyncTarget {
	return {
		companyId: "eqc_jp",
		market: "JP",
		symbol: "9999",
		concepts: [...EDINET_CONCEPTS],
		source: {
			provider: "edinet",
			secCode: "99990",
			edinetCode: null,
			knownFilings: [],
			pendingFilings: [],
			scanDays: [],
			...source,
		},
	};
}

/**
 * A stored filing of the synthetic EDINET filer, with its period: the last
 * digit of its document id is the fiscal year ending March 202X
 * (S100SY24 and its amendment S100SYA4 → April 2023 – March 2024).
 */
export function knownFiling(docId: string): EdinetKnownFiling {
	const year = 2020 + Number(docId.slice(-1));
	return { docId, periodStart: `${year - 1}-04-01`, periodEnd: `${year}-03-31` };
}

/** A query whose pacing gate counts its grants and answers from `answers` (true once used up). */
export function queryFor(target: EquitySyncTarget, answers: readonly boolean[] = []) {
	let grants = 0;
	const query: EquitySyncQuery = {
		target,
		signal: new AbortController().signal,
		beforeRequest: async () => {
			const answer = answers[grants] ?? true;
			grants += 1;
			return answer;
		},
	};
	return { query, grants: () => grants };
}
