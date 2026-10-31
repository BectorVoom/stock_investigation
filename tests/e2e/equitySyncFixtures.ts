import type { EquitySyncSource } from "@research/adapters/finance";
import {
	edinetCodeSchema,
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
 * Canned financial statements for the browser E2E run (ADR-0045): the
 * `financial-sync` sources answer these completions instead of SEC and
 * EDINET — no keys, no network. The files
 * (`examples/fixtures/equity-sync/e2e-sec.json`, `e2e-edinet.json`) are what
 * the real extraction makes of the synthetic SEC and EDINET inputs beside
 * them (`scripts/vectors/finance/equitySyncFixtures.ts`), and the Rust E2E
 * runner (`research-runner-testkit`) serves the same files the same way:
 *
 * - every company of a provider gets that provider's filings, `more: false`,
 *   and `scannedDays` = the claim's `scanDays` (EDINET) or [] (SEC);
 * - the identity keeps the file's name and fiscal year end, but its
 *   `sourceCompanyId` is derived from the claim's symbol
 *   (`fixtureSourceCompanyId`), so two tracked companies of one provider
 *   never claim the same CIK or EDINET code.
 */

const fileSchema = (sourceCompanyId: z.ZodType<string>) =>
	z.object({
		identity: z.strictObject({
			sourceCompanyId,
			name: z.string().min(1).nullable(),
			fiscalYearEnd: fiscalYearEndSchema.nullable(),
		}),
		filings: z.array(equityFilingResultSchema).min(1),
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
				scannedDays: target.source.provider === "edinet" ? [...target.source.scanDays] : [],
				filings: fixture.filings,
				more: false,
				requests: 0,
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
