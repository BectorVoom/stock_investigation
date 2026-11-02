import { z } from "zod";
import { isoDateSchema, isoDateTimeSchema } from "./primitives.ts";
import { STOCK_DIRECTORY_LIMITS } from "./stockDirectory.ts";

/**
 * A Japanese stock's company profile from J-Quants' Listed Issue Master
 * (`GET /v2/equities/master`, ADR-0059 §3): carried by the JP
 * `stock-directory-refresh` completion, stored in `stock_company_profile`
 * and shown on the Stocks page's Company tab in place of a business
 * description. Codes and names are J-Quants' own (Japanese names).
 */
export const STOCK_COMPANY_PROFILE_LIMITS = {
	/** Profiles one completion carries: the directory's bound (4,444 issues measured 2026-11-02). */
	maxProfiles: STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket,
	maxNameChars: 200,
	maxCodeChars: 8,
} as const;

const codeSchema = z.string().min(1).max(STOCK_COMPANY_PROFILE_LIMITS.maxCodeChars);
const nameSchema = z.string().trim().min(1).max(STOCK_COMPANY_PROFILE_LIMITS.maxNameChars);

/** A JPX local code (four characters: digits, or digits and an uppercase letter such as `130A`). */
export const jpxLocalCodeSchema = z.string().regex(/^[0-9][0-9A-Z]{3}$/);

export const stockCompanyProfileSchema = z.strictObject({
	/** The directory symbol: J-Quants' 5-character `Code` without its trailing `0`. */
	symbol: jpxLocalCodeSchema,
	/** `CoNameEn`; null when J-Quants states none. */
	nameEn: nameSchema.nullable(),
	/** `S17` / `S17Nm`: the TSE 17-sector classification. */
	sector17Code: codeSchema,
	sector17Name: nameSchema,
	/** `S33` / `S33Nm`: the TSE 33-sector classification. */
	sector33Code: codeSchema,
	sector33Name: nameSchema,
	/** `ScaleCat` (e.g. "TOPIX Core30"); null for J-Quants' "-". */
	scaleCategory: nameSchema.nullable(),
	/** `Mkt` / `MktNm` (e.g. "0111" / "プライム"). */
	marketSegmentCode: codeSchema,
	marketSegmentName: nameSchema,
	/** `Date`: the day the master states the issue's information for (about 12 weeks ago on Free). */
	asOf: isoDateSchema,
});
export type StockCompanyProfile = z.infer<typeof stockCompanyProfileSchema>;

/** The first problem of a completion's profiles (a symbol twice), or null. */
export function stockCompanyProfilesProblem(
	profiles: readonly StockCompanyProfile[],
): string | null {
	const symbols = new Set<string>();
	for (const profile of profiles) {
		if (symbols.has(profile.symbol)) return `profile ${profile.symbol} appears twice`;
		symbols.add(profile.symbol);
	}
	return null;
}

/** A stored profile as the Stocks API returns it (`companyProfile`), with when it was stored. */
export const stockCompanyProfileViewSchema = stockCompanyProfileSchema.extend({
	retrievedAt: isoDateTimeSchema,
});
export type StockCompanyProfileView = z.infer<typeof stockCompanyProfileViewSchema>;
