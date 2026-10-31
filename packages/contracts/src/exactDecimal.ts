import { z } from "zod";

/**
 * Canonical base-unit decimals: 100 significant digits, at most 30
 * fractional digits (docs/NAMING_CONVENTIONS.md). Used by the materials
 * series (ADR-0042); kept from the retired equities import (ADR-0041,
 * superseded by ADR-0048).
 */
export const equityDecimalSchema = z
	.string()
	.max(132)
	.regex(/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
	.refine(
		(value) =>
			value !== "-0" &&
			(value.split(".")[1]?.length ?? 0) <= 30 &&
			value.replace(/[-.]/g, "").replace(/^0+/, "").length <= 100,
	);

/** Source-supplied update instant, canonical UTC milliseconds (ADR-0042). */
export const materialsSourceUpdatedAtSchema = z
	.string()
	.length(24)
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	.pipe(z.iso.datetime());
