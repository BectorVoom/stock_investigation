import type { EdinetIndexSource, EquitySyncSource } from "@research/adapters/finance";
import {
	type EdinetIndexDocument,
	edinetCodeSchema,
	equityBusinessDescriptionSchema,
	equityFilingResultSchema,
	fiscalYearEndSchema,
	secCikSchema,
} from "@research/contracts";
import { type EquityProvider, ok } from "@research/domain";
import { z } from "zod";
import edinetCompletion from "../../examples/fixtures/equity-sync/e2e-edinet.json" with {
	type: "json",
};
import secCompletion from "../../examples/fixtures/equity-sync/e2e-sec.json" with { type: "json" };

/**
 * Canned financial statements for the browser E2E run (ADR-0048): the
 * `financial-sync` sources answer these completions instead of SEC and
 * EDINET — no keys, no network. The files
 * (`examples/fixtures/equity-sync/e2e-sec.json`, `e2e-edinet.json`) are what
 * the real extraction makes of the synthetic SEC and EDINET inputs beside
 * them (`scripts/vectors/finance/equitySyncFixtures.ts`), and the Rust E2E
 * runner (`research-runner-testkit`) serves the same files the same way:
 *
 * - every company of a provider gets that provider's filings, `more: false`;
 * - the file's business description (ADR-0053) comes with every EDINET
 *   sync, and with an SEC sync whose claim's `describedDocumentId` is not
 *   the description's 10-K (as the real source reads a 10-K only once);
 * - the identity keeps the file's name and fiscal year end, but its
 *   `sourceCompanyId` is derived from the claim's symbol
 *   (`fixtureSourceCompanyId`), so two tracked companies of one provider
 *   never claim the same CIK or EDINET code;
 * - the `edinet-index` job (ADR-0058 §4) lists every EDINET filing of the
 *   file on the claim's newest date, under the securities code of the
 *   specs' Japanese company (`E2E_EDINET_SYMBOL` + "0") and its fixture
 *   EDINET code, so that company's `financial-sync` becomes due; the other
 *   dates list nothing. An amendment's row states no period, as EDINET's does.
 */

const fileSchema = (sourceCompanyId: z.ZodType<string>) =>
	z.object({
		identity: z.strictObject({
			sourceCompanyId,
			name: z.string().min(1).nullable(),
			fiscalYearEnd: fiscalYearEndSchema.nullable(),
		}),
		filings: z.array(equityFilingResultSchema).min(1),
		description: equityBusinessDescriptionSchema,
	});

const FIXTURES = {
	sec: fileSchema(secCikSchema).parse(secCompletion),
	edinet: fileSchema(edinetCodeSchema).parse(edinetCompletion),
} as const;

/**
 * The fixture CIK / EDINET code of a symbol: a base-31 hash of its UTF-16
 * code units modulo 10^8, as "99" + 8 digits (a 10-digit CIK) or "E9" + the
 * last 4 digits (an EDINET code). Synthetic ranges no real filer uses.
 */
export function fixtureSourceCompanyId(provider: EquityProvider, symbol: string): string {
	let hash = 0;
	for (let index = 0; index < symbol.length; index += 1) {
		hash = (hash * 31 + symbol.charCodeAt(index)) % 100_000_000;
	}
	return provider === "sec"
		? `99${String(hash).padStart(8, "0")}`
		: `E9${String(hash % 10_000).padStart(4, "0")}`;
}

function fixtureSource(provider: EquityProvider): EquitySyncSource {
	const fixture = FIXTURES[provider];
	return {
		provider,
		sync: async ({ target }) =>
			ok({
				identity: {
					...fixture.identity,
					sourceCompanyId: fixtureSourceCompanyId(provider, target.symbol),
				},
				filings: fixture.filings,
				more: false,
				requests: 0,
				unreadableDocuments: [],
				description:
					target.source.provider === "sec" &&
					target.source.describedDocumentId === fixture.description.source.sourceDocumentId
						? null
						: fixture.description,
				descriptionUnread: null,
			}),
	};
}

/** Both providers' canned sources, keyed like the runner's registry. */
export function fixtureEquitySyncSources(): ReadonlyMap<EquityProvider, EquitySyncSource> {
	return new Map([
		["sec", fixtureSource("sec")],
		["edinet", fixtureSource("edinet")],
	]);
}

/** The Japanese company the E2E specs open (Nintendo's code in the fixture directory). */
export const E2E_EDINET_SYMBOL = "7974";

/** The canned EDINET index: the file's filings on the claim's newest date, for `E2E_EDINET_SYMBOL`. */
export function fixtureEdinetIndexSource(): EdinetIndexSource {
	const fixture = FIXTURES.edinet;
	const documents: EdinetIndexDocument[] = fixture.filings.map((filing) => {
		const original = filing.form === "securities-report";
		return {
			docId: filing.sourceDocumentId,
			secCode: `${E2E_EDINET_SYMBOL}0`,
			edinetCode: fixtureSourceCompanyId("edinet", E2E_EDINET_SYMBOL),
			filerName: fixture.identity.name ?? "Fixture filer",
			docTypeCode: original ? "120" : "130",
			periodStart: original ? filing.periodStart : null,
			periodEnd: original ? filing.periodEnd : null,
			submittedAt: filing.submittedAt ?? `${filing.filedOn}T15:00:00+09:00`,
			parentDocId: filing.amendsSourceDocumentId,
		};
	});
	return {
		list: async ({ days }) =>
			ok({
				days: days.map((date, index) => ({ date, documents: index === 0 ? documents : [] })),
				failedDays: [],
				skippedDays: 0,
				droppedRows: 0,
				requests: 0,
			}),
	};
}
