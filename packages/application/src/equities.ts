import {
	EQUITY_LIMITS,
	type EquityCatalogRecord,
	type EquityFactQuery,
	type EquityImport,
	type EquityImportResult,
	idSchema,
} from "@research/contracts";
import { compareEquityDecimals, ok } from "@research/domain";
import type { EquityCursorQuery, EquityPageQuery, EquityRepository } from "./equityPorts.ts";
import { fail, type UseCaseResult } from "./errors.ts";
import type { Clock, Hasher, IdGenerator } from "./ports.ts";

/** Parsed records are serialized in schema field order; array order remains part of import identity. */
export function equityImportRecords(b: EquityImport): EquityCatalogRecord[] {
	return [
		...b.issuers.map((body) => ({ recordType: "issuer" as const, recordId: body.issuerId, body })),
		...b.sources.map((body) => ({ recordType: "source" as const, recordId: body.sourceId, body })),
		...b.documents.map((body) => ({
			recordType: "document" as const,
			recordId: body.sourceDocumentId,
			body,
		})),
		...b.identifiers.map((body) => ({
			recordType: "identifier" as const,
			recordId: body.identifierId,
			body,
		})),
		...b.securities.map((body) => ({
			recordType: "security" as const,
			recordId: body.securityId,
			body,
		})),
		...b.listings.map((body) => ({
			recordType: "listing" as const,
			recordId: body.listingId,
			body,
		})),
		...b.filings.map((body) => ({ recordType: "filing" as const, recordId: body.filingId, body })),
		...b.statements.map((body) => ({
			recordType: "statement" as const,
			recordId: body.statementId,
			body,
		})),
		...b.metrics.map((body) => ({
			recordType: "metric" as const,
			recordId: body.metricDefinitionId,
			body,
		})),
		...b.facts.map((body) => ({ recordType: "fact" as const, recordId: body.factId, body })),
		...b.prices.map((body) => ({ recordType: "price" as const, recordId: body.priceBarId, body })),
		...b.actions.map((body) => ({ recordType: "action" as const, recordId: body.actionId, body })),
		...b.fx.map((body) => ({ recordType: "fx" as const, recordId: body.fxId, body })),
		...b.guidance.map((body) => ({
			recordType: "guidance" as const,
			recordId: body.guidanceId,
			body,
		})),
	];
}

type RecordKind = EquityCatalogRecord["recordType"];
interface Reference {
	readonly id: string;
	readonly kind: RecordKind;
}
function references(r: EquityCatalogRecord): readonly Reference[] {
	const ref = (id: string, kind: RecordKind): Reference => ({ id, kind });
	switch (r.recordType) {
		case "issuer":
		case "source":
		case "metric":
			return [];
		case "identifier":
			return [ref(r.body.issuerId, "issuer"), ref(r.body.sourceDocumentId, "document")];
		case "security":
			return [ref(r.body.issuerId, "issuer")];
		case "listing":
			return [ref(r.body.securityId, "security"), ref(r.body.sourceDocumentId, "document")];
		case "document":
			return [ref(r.body.sourceId, "source")];
		case "filing":
			return [
				ref(r.body.issuerId, "issuer"),
				ref(r.body.sourceDocumentId, "document"),
				...(r.body.amendmentOfFilingId === null ? [] : [ref(r.body.amendmentOfFilingId, "filing")]),
			];
		case "statement":
			return [ref(r.body.filingId, "filing")];
		case "fact":
			return [ref(r.body.statementId, "statement"), ref(r.body.metricDefinitionId, "metric")];
		case "price":
			return [
				ref(r.body.listingId, "listing"),
				ref(r.body.sourceDocumentId, "document"),
				...(r.body.supersedesPriceBarId === null
					? []
					: [ref(r.body.supersedesPriceBarId, "price")]),
			];
		case "action":
			return [
				ref(r.body.securityId, "security"),
				ref(r.body.sourceDocumentId, "document"),
				...(r.body.supersedesActionId === null ? [] : [ref(r.body.supersedesActionId, "action")]),
			];
		case "fx":
			return [ref(r.body.sourceDocumentId, "document")];
		case "guidance":
			return [
				ref(r.body.issuerId, "issuer"),
				ref(r.body.sourceDocumentId, "document"),
				ref(r.body.metricDefinitionId, "metric"),
				...(r.body.supersedesGuidanceId === null
					? []
					: [ref(r.body.supersedesGuidanceId, "guidance")]),
			];
	}
}

/** Checks reference kinds, immutable identities, bases and ordered revision links before SQL. */
function importProblem(
	records: readonly EquityCatalogRecord[],
	stored: readonly EquityCatalogRecord[],
): "INTEGRITY_VIOLATION" | "CONFLICT" | null {
	const available = new Map(stored.map((r) => [r.recordId, r]));
	const seen = new Set<string>();
	const identifiers = new Map<string, string>();
	const metrics = new Set<string>();
	const listings = new Map<
		string,
		Extract<EquityCatalogRecord, { recordType: "listing" }>["body"][]
	>();
	for (const record of records) {
		if (record.recordType === "metric") {
			const key = JSON.stringify([record.body.metricCode, record.body.version]);
			if (metrics.has(key)) return "INTEGRITY_VIOLATION";
			metrics.add(key);
		}
		if (record.recordType === "identifier") {
			const key = JSON.stringify([record.body.scheme, record.body.value]);
			const issuer = identifiers.get(key);
			if (issuer !== undefined && issuer !== record.body.issuerId) return "INTEGRITY_VIOLATION";
			identifiers.set(key, record.body.issuerId);
		}
		if (record.recordType === "listing") {
			const key = JSON.stringify([record.body.venueMic, record.body.symbol]);
			const prior = listings.get(key) ?? [];
			if (
				prior.some(
					(other) =>
						(other.listedOn ?? "0001-01-01") <= (record.body.delistedOn ?? "9999-12-31") &&
						(record.body.listedOn ?? "0001-01-01") <= (other.delistedOn ?? "9999-12-31"),
				)
			)
				return "INTEGRITY_VIOLATION";
			listings.set(key, [...prior, record.body]);
		}
	}

	for (const r of records) {
		if (seen.has(r.recordId)) return "INTEGRITY_VIOLATION";
		seen.add(r.recordId);
		const previous = available.get(r.recordId);
		if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(r)) return "CONFLICT";
		available.set(r.recordId, r);
	}
	const predecessors = new Set(stored.map((r) => r.recordId));
	for (const r of records) {
		if (
			references(r).some((reference) => available.get(reference.id)?.recordType !== reference.kind)
		)
			return "INTEGRITY_VIOLATION";
		const positive = (v: string | null): boolean => v !== null && compareEquityDecimals(v, "0") > 0;
		switch (r.recordType) {
			case "identifier": {
				if (r.body.scheme === "cik" && !/^\d{10}$/.test(r.body.value)) return "INTEGRITY_VIOLATION";
				if (r.body.scheme === "edinet" && !/^E\d{5}$/.test(r.body.value))
					return "INTEGRITY_VIOLATION";
				break;
			}
			case "filing": {
				const priorId = r.body.amendmentOfFilingId;
				const prior = priorId === null ? undefined : available.get(priorId);
				if (
					priorId !== null &&
					(priorId === r.recordId ||
						!predecessors.has(priorId) ||
						prior?.recordType !== "filing" ||
						prior.body.issuerId !== r.body.issuerId)
				)
					return "INTEGRITY_VIOLATION";
				break;
			}
			case "fact": {
				const metric = available.get(r.body.metricDefinitionId);
				if (metric?.recordType !== "metric") return "INTEGRITY_VIOLATION";
				if (
					r.body.valueDecimal !== null &&
					(metric.body.unit === "currency-per-share" || metric.body.unit === "shares") &&
					r.body.shareBasis === null
				)
					return "INTEGRITY_VIOLATION";
				break;
			}
			case "price": {
				const p = r.body;
				const listing = available.get(p.listingId);
				if (
					listing?.recordType !== "listing" ||
					p.currency !== listing.body.tradingCurrency ||
					(listing.body.listedOn !== null && p.tradingOn < listing.body.listedOn) ||
					(listing.body.delistedOn !== null && p.tradingOn > listing.body.delistedOn)
				)
					return "INTEGRITY_VIOLATION";
				if (
					compareEquityDecimals(p.lowDecimal, "0") < 0 ||
					compareEquityDecimals(p.lowDecimal, p.openDecimal) > 0 ||
					compareEquityDecimals(p.lowDecimal, p.closeDecimal) > 0 ||
					compareEquityDecimals(p.highDecimal, p.openDecimal) < 0 ||
					compareEquityDecimals(p.highDecimal, p.closeDecimal) < 0 ||
					(p.volumeDecimal !== null && compareEquityDecimals(p.volumeDecimal, "0") < 0)
				)
					return "INTEGRITY_VIOLATION";
				if (p.supersedesPriceBarId !== null) {
					const prior = available.get(p.supersedesPriceBarId);
					if (
						p.supersedesPriceBarId === r.recordId ||
						!predecessors.has(p.supersedesPriceBarId) ||
						prior?.recordType !== "price" ||
						prior.body.listingId !== p.listingId ||
						prior.body.tradingOn !== p.tradingOn
					)
						return "INTEGRITY_VIOLATION";
				}
				break;
			}
			case "action": {
				const a = r.body;
				if (
					(a.actionType === "split" ||
						a.actionType === "reverse-split" ||
						a.actionType === "stock-dividend") &&
					(!positive(a.ratioNumerator) || !positive(a.ratioDenominator))
				)
					return "INTEGRITY_VIOLATION";
				if (
					a.actionType === "cash-dividend" &&
					(a.cashDecimal === null ||
						a.currency === null ||
						compareEquityDecimals(a.cashDecimal, "0") < 0)
				)
					return "INTEGRITY_VIOLATION";
				if (a.supersedesActionId !== null) {
					const prior = available.get(a.supersedesActionId);
					if (
						a.supersedesActionId === r.recordId ||
						!predecessors.has(a.supersedesActionId) ||
						prior?.recordType !== "action" ||
						prior.body.securityId !== a.securityId
					)
						return "INTEGRITY_VIOLATION";
				}
				break;
			}
			case "fx":
				if (!positive(r.body.rateDecimal) || r.body.baseCurrency === r.body.quoteCurrency)
					return "INTEGRITY_VIOLATION";
				break;
			case "guidance": {
				const g = r.body;
				const metric = available.get(g.metricDefinitionId);
				if (
					metric?.recordType !== "metric" ||
					((metric.body.unit === "currency" || metric.body.unit === "currency-per-share") &&
						g.currency === null)
				)
					return "INTEGRITY_VIOLATION";
				const bounds = [g.lowDecimal, g.baseDecimal, g.highDecimal].filter((v) => v !== null);
				if (
					bounds.some((v, i) => {
						const next = bounds[i + 1];
						return next !== undefined && compareEquityDecimals(v, next) > 0;
					})
				)
					return "INTEGRITY_VIOLATION";
				if (g.supersedesGuidanceId !== null) {
					const prior = available.get(g.supersedesGuidanceId);
					if (
						g.supersedesGuidanceId === r.recordId ||
						!predecessors.has(g.supersedesGuidanceId) ||
						prior?.recordType !== "guidance" ||
						prior.body.issuerId !== g.issuerId ||
						prior.body.metricDefinitionId !== g.metricDefinitionId
					)
						return "INTEGRITY_VIOLATION";
				}
				break;
			}
		}
		predecessors.add(r.recordId);
	}
	return null;
}

export function createEquityService(deps: {
	readonly equities: EquityRepository;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly hasher: Hasher;
}) {
	async function requireIssuer(ownerId: string, issuerId: string) {
		if (!idSchema.safeParse(issuerId).success) return false;
		const records = await deps.equities.getRecords(ownerId, [issuerId]);
		return records.some((r) => r.recordType === "issuer");
	}
	return {
		listRecords: (ownerId: string, query: import("@research/contracts").EquityRecordQuery) =>
			deps.equities.listRecords(ownerId, query),
		listIssuers: (ownerId: string, query: EquityPageQuery) =>
			deps.equities.listIssuers(ownerId, query),
		listImports: (ownerId: string, query: EquityCursorQuery) =>
			deps.equities.listImports(ownerId, query),
		async getImport(ownerId: string, importId: string) {
			const payload = await deps.equities.getImportPayload(ownerId, importId);
			return payload === null ? fail("NOT_FOUND", "Import not found.") : ok(payload);
		},
		async facts(ownerId: string, issuerId: string, query: EquityFactQuery) {
			if (!(await requireIssuer(ownerId, issuerId))) return fail("NOT_FOUND", "Issuer not found.");
			const version = await deps.equities.getVersion(ownerId);
			if (query.ingestionVersion !== undefined && query.ingestionVersion > version)
				return fail("VALIDATION_FAILED", "Catalog version does not exist.");
			return ok(
				await deps.equities.listFacts(ownerId, issuerId, {
					...query,
					ingestionVersion: query.ingestionVersion ?? version,
				}),
			);
		},
		async records(ownerId: string, issuerId: string, query: EquityCursorQuery) {
			if (!(await requireIssuer(ownerId, issuerId))) return fail("NOT_FOUND", "Issuer not found.");
			return ok(await deps.equities.listIssuerRecords(ownerId, issuerId, query));
		},
		/** INTEGRITY_VIOLATION for bad references/bases; key reuse and immutable identity conflicts are distinct; no network effects. */
		async import(
			ownerId: string,
			payload: EquityImport,
			idempotencyKey: string,
		): Promise<UseCaseResult<EquityImportResult>> {
			const text = JSON.stringify(payload);
			if (new TextEncoder().encode(text).byteLength > EQUITY_LIMITS.maxImportBytes)
				return fail("PAYLOAD_TOO_LARGE", "Equity import exceeds the byte limit.");
			const contentSha256 = await deps.hasher.sha256Hex(text);
			const existing = await deps.equities.findImport(ownerId, idempotencyKey);
			if (existing !== null)
				return existing.contentSha256 === contentSha256
					? ok({ ...existing.result, replayed: true })
					: fail("IDEMPOTENCY_KEY_REUSED", "Import key was used for different data.");
			const receivedAt = deps.clock.nowIso();
			if (payload.documents.some((d) => d.retrievedAt > receivedAt))
				return fail("INTEGRITY_VIOLATION", "Document retrieval time cannot be in the future.");
			const records = equityImportRecords(payload);
			const wanted = new Set(records.map((r) => r.recordId));
			for (const r of records) for (const ref of references(r)) wanted.add(ref.id);
			const stored = await deps.equities.getRecords(ownerId, [...wanted]);
			const problem = importProblem(records, stored);
			if (problem !== null)
				return fail(
					problem,
					problem === "CONFLICT"
						? "An immutable catalog identity was reused for different data."
						: "Equity references, revision order or financial bases are invalid.",
				);
			const importId = deps.ids.newId("eqimp");

			const committed = await deps.equities.commit(ownerId, {
				importId,
				idempotencyKey,
				contentSha256,
				receivedAt,
				payload,
				records,
			});
			if (!committed) {
				const replay = await deps.equities.findImport(ownerId, idempotencyKey);
				if (replay !== null)
					return replay.contentSha256 === contentSha256
						? ok({ ...replay.result, replayed: true })
						: fail("IDEMPOTENCY_KEY_REUSED", "Import key was used for different data.");
				return fail(
					"CONFLICT",
					"An identity assignment or listing interval conflicts with the catalog.",
				);
			}
			const saved = await deps.equities.findImport(ownerId, idempotencyKey);
			return saved === null
				? fail("INTERNAL", "Committed import could not be read.")
				: ok({ ...saved.result, replayed: false });
		},
	};
}
