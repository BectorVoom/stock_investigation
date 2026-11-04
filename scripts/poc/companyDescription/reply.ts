import { extractJsonObject } from "@research/agent-core";
import {
	overviewOverseasDraftSchema,
	overviewProfileFactSchema,
	overviewSegmentSchema,
	overviewStatementSchema,
	overviewThemeSchema,
} from "@research/contracts";
import { z } from "zod";
import {
	type CompanyDescription,
	companyDescriptionSchema,
	type DescriptionToCheck,
	TEMPLATE_LIMITS,
} from "./template.ts";

/** Reading a model reply as a company description (run.ts). */
export type ReplyCheck =
	| { readonly ok: true; readonly description: CompanyDescription }
	| { readonly ok: false; readonly message: string; readonly json: unknown };

export function parseReply(text: string): ReplyCheck {
	const json = extractJsonObject(text);
	if (!json.ok) {
		return { ok: false, message: "The reply contained no parseable JSON object.", json: null };
	}
	const parsed = companyDescriptionSchema.safeParse(json.value);
	if (!parsed.success) {
		const fields = parsed.error.issues
			.slice(0, 8)
			.map((issue) => `${issue.path.join(".")} (${issue.message})`)
			.join(", ");
		return { ok: false, message: `Invalid fields: ${fields}.`, json: json.value };
	}
	return { ok: true, description: parsed.data };
}

const replyObjectSchema = z.record(z.string(), z.unknown());

/** The items of `value` that `schema` accepts, at most `max`; the rest are dropped. */
function validItems<T>(schema: z.ZodType<T>, value: unknown, max: number): T[] {
	if (!Array.isArray(value)) return [];
	return value
		.flatMap((item) => {
			const parsed = schema.safeParse(item);
			return parsed.success ? [parsed.data] : [];
		})
		.slice(0, max);
}

/**
 * The repair turn's reply with each invalid field dropped (a theme label one
 * character too long once cost Microsoft its whole entry). An invalid or
 * null 【特色】 is dropped too: Haiku leaves it empty when no quote supports
 * one, and the reply's valid 【事業内容】 was then lost with it (10 stocks in
 * the run of 2026-11-04). Null when the reply is not an object.
 */
export function salvageReply(json: unknown): DescriptionToCheck | null {
	const reply = replyObjectSchema.safeParse(json);
	if (!reply.success) return null;
	const limits = TEMPLATE_LIMITS;
	const feature = companyDescriptionSchema.shape.feature.safeParse(reply.data.feature);
	const overseas = overviewOverseasDraftSchema.safeParse(reply.data.overseasSales);
	return {
		feature: feature.success ? feature.data : null,
		businesses: validItems(overviewStatementSchema, reply.data.businesses, limits.maxBusinesses),
		segments: validItems(overviewSegmentSchema, reply.data.segments, limits.maxSegments),
		overseasSales: overseas.success ? overseas.data : null,
		profile: validItems(overviewProfileFactSchema, reply.data.profile, limits.maxProfileFacts),
		themes: validItems(overviewThemeSchema, reply.data.themes, limits.maxThemes),
	};
}
