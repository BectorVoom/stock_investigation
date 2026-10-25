import {
	type JsonObject,
	type JsonValue,
	UPSTREAM_STATUS_MAX,
	UPSTREAM_STATUS_MIN,
} from "@research/domain";
import { z } from "zod";

/** Opaque identifier: URL- and SQL-safe, bounded. */
export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/, "invalid id");

export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const isoDateSchema = z.iso.date();

/** A public https URL as text. Policy checks (SSRF etc.) happen in the domain, not here. */
export const httpsUrlSchema = z
	.string()
	.max(2048)
	.refine((value) => URL.canParse(value) && new URL(value).protocol === "https:", {
		message: "must be an https URL",
	});

/**
 * The HTTP status an external service answered with, exactly as received
 * (docs/rule/error_handling.md §4a). Never remapped: our own codes classify
 * the failure beside it. A number, so it carries no provider text (SEC-010).
 */
export const upstreamStatusSchema = z
	.number()
	.int()
	.min(UPSTREAM_STATUS_MIN)
	.max(UPSTREAM_STATUS_MAX);

/**
 * The latest terminal refresh run that did not succeed (failed/cancelled):
 * its state, stable failure code, the external service's answer status
 * behind it (unchanged, §4a; null when none) and when it ended. One shape
 * for Home, the Watchlist and the stock directory. `state` is a plain string
 * (not jobStateSchema: jobs.ts imports the modules that use this).
 */
export const lastRefreshFailureSchema = z.strictObject({
	state: z.string(),
	code: z.string().min(1).max(80),
	upstreamStatus: upstreamStatusSchema.nullable(),
	at: isoDateTimeSchema,
});

export const shortTextSchema = z.string().trim().min(1).max(300);
export const longTextSchema = z.string().trim().min(1).max(4000);

export const MAX_JSON_DEPTH = 12;
export const MAX_JSON_NODES = 20_000;

function isPlainObject(value: object): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Whether `value` is JSON of bounded depth and size. Iterative on purpose: a
 * recursive check (or a recursive schema) overflows the stack on a few thousand
 * nested arrays, which fits easily inside the request body limit and would
 * surface as a 500 instead of a validation error.
 */
export function isBoundedJson(value: unknown): value is JsonValue {
	const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
	let nodes = 0;
	for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
		nodes += 1;
		if (nodes > MAX_JSON_NODES || entry.depth > MAX_JSON_DEPTH) return false;
		const current = entry.value;
		if (current === null || typeof current === "string" || typeof current === "boolean") continue;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) return false;
			continue;
		}
		if (typeof current !== "object") return false;
		const children: readonly unknown[] = Array.isArray(current)
			? current
			: isPlainObject(current)
				? Object.values(current)
				: [undefined];
		for (const child of children) pending.push({ value: child, depth: entry.depth + 1 });
	}
	return true;
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(isBoundedJson, {
	message: `must be JSON no deeper than ${MAX_JSON_DEPTH} levels and no larger than ${MAX_JSON_NODES} values`,
});

export const jsonObjectSchema: z.ZodType<JsonObject> = z.custom<JsonObject>(
	(value): value is JsonObject =>
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		isPlainObject(value) &&
		isBoundedJson(value),
	{ message: "must be a bounded JSON object" },
);

export const marketSchema = z.enum(["JP", "US"]);
/** A research market: Japanese or US listings. */
export type ResearchMarket = z.infer<typeof marketSchema>;
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code expected");
