import {
	type CompanyProfileSource,
	type EquitySyncSource,
	jquantsMasterToProfiles,
} from "@research/adapters/finance";
import {
	equityBusinessDescriptionSchema,
	equityFilingResultSchema,
	fiscalYearEndSchema,
	jquantsIssueCodeSchema,
	secCikSchema,
} from "@research/contracts";
import { type EquityProvider, err, ok } from "@research/domain";
import { z } from "zod";
import jquantsCompletion from "../../examples/fixtures/equity-sync/e2e-jquants.json" with {
	type: "json",
};
import secCompletion from "../../examples/fixtures/equity-sync/e2e-sec.json" with { type: "json" };
import jquantsMaster from "./fixtures/jquants-equities-master.json" with { type: "json" };

/**
 * Canned financial statements and company profiles for the browser E2E run
 * (ADR-0048, ADR-0059): the `financial-sync` sources and the JP directory
 * refresh's profile source answer these instead of SEC and J-Quants — no
 * keys, no network. The Rust E2E runner (`research-runner-testkit`) serves
 * the same files the same way:
 *
 * - SEC: `examples/fixtures/equity-sync/e2e-sec.json`, what the real
 *   extraction makes of the synthetic SEC inputs beside it
 *   (`scripts/vectors/finance/equitySyncFixtures.ts`). Every US company gets
 *   its filings, `more: false`; its business description (ADR-0053) comes
 *   with a sync whose claim's `describedDocumentId` is not the description's
 *   10-K (as the real source reads a 10-K only once). The identity keeps the
 *   file's name and fiscal year end, but its CIK is derived from the claim's
 *   symbol (`fixtureSecCik`), so two tracked companies never claim the same
 *   CIK.
 * - J-Quants: `examples/fixtures/equity-sync/e2e-jquants.json`, what the
 *   real mapping (`jquantsSummariesToSync`, ADR-0059 §2) makes of J-Quants'
 *   live earnings summaries of Nintendo (79740, captured 2026-11-02: two
 *   full-year summaries, no description). Every Japanese company gets its
 *   filings, `more: false`; the identity's code is the claim's own, so two
 *   tracked companies never claim the same code.
 * - Profiles: `tests/e2e/fixtures/jquants-equities-master.json`, live rows
 *   of J-Quants' Listed Issue Master (`GET /v2/equities/master`, as of
 *   2026-08-10), through the real `jquantsMasterToProfiles` (ADR-0059 §3).
 *   Hino (7205) has no row: its Company tab says no profile is stored.
 */

const secFileSchema = z.object({
	identity: z.strictObject({
		sourceCompanyId: secCikSchema,
		name: z.string().min(1).nullable(),
		fiscalYearEnd: fiscalYearEndSchema.nullable(),
	}),
	filings: z.array(equityFilingResultSchema).min(1),
	description: equityBusinessDescriptionSchema,
});

const SEC_FIXTURE = secFileSchema.parse(secCompletion);

const jquantsFileSchema = z.object({
	identity: z.strictObject({
		sourceCompanyId: jquantsIssueCodeSchema,
		name: z.null(),
		fiscalYearEnd: fiscalYearEndSchema.nullable(),
	}),
	filings: z.array(equityFilingResultSchema).min(1),
	description: z.null(),
});

const JQUANTS_FIXTURE = jquantsFileSchema.parse(jquantsCompletion);

/** The master's rows as J-Quants answers them. */
const JQUANTS_MASTER: readonly unknown[] = z.array(z.unknown()).parse(jquantsMaster);

/** The Japanese company the specs open, whose filings the J-Quants fixture holds (Nintendo, a fixture directory row). */
export const E2E_JQUANTS_SYMBOL = "7974";

/**
 * The fixture CIK of a symbol: "99" + a base-31 hash of its UTF-16 code
 * units modulo 10^8 (a 10-digit CIK in a range no real filer uses).
 */
export function fixtureSecCik(symbol: string): string {
	let hash = 0;
	for (let index = 0; index < symbol.length; index += 1) {
		hash = (hash * 31 + symbol.charCodeAt(index)) % 100_000_000;
	}
	return `99${String(hash).padStart(8, "0")}`;
}

function fixtureSecSource(): EquitySyncSource {
	return {
		provider: "sec",
		sync: async ({ target }) =>
			ok({
				identity: { ...SEC_FIXTURE.identity, sourceCompanyId: fixtureSecCik(target.symbol) },
				filings: SEC_FIXTURE.filings,
				more: false,
				requests: 0,
				description:
					target.source.provider === "sec" &&
					target.source.describedDocumentId === SEC_FIXTURE.description.source.sourceDocumentId
						? null
						: SEC_FIXTURE.description,
				descriptionUnread: null,
			}),
	};
}

function fixtureJquantsSource(): EquitySyncSource {
	return {
		provider: "jquants",
		sync: async ({ target }) => {
			const request = target.source;
			if (request.provider !== "jquants") {
				return err({ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null, requests: 0 });
			}
			return ok({
				identity: { ...JQUANTS_FIXTURE.identity, sourceCompanyId: request.code },
				filings: JQUANTS_FIXTURE.filings,
				more: false,
				requests: 0,
				description: null,
				descriptionUnread: null,
			});
		},
	};
}

/** Both providers' canned sources, keyed like the runner's registry. */
export function fixtureEquitySyncSources(): ReadonlyMap<EquityProvider, EquitySyncSource> {
	return new Map([
		["sec", fixtureSecSource()],
		["jquants", fixtureJquantsSource()],
	]);
}

/** The canned Listed Issue Master: the fixture rows' profiles, one request. */
export function fixtureCompanyProfileSource(): CompanyProfileSource {
	return {
		fetchProfiles: async () =>
			ok({ profiles: jquantsMasterToProfiles(JQUANTS_MASTER), requests: 1 }),
	};
}
