import { isCanonicalDecimal } from "@research/domain";
import type { Locale } from "@research/i18n";

/**
 * Presentation of exact financial amounts (ADR-0048 §8). Values arrive as
 * canonical decimal text in base units (`"391035000000"`, `"-1234.5"`) and
 * are shown in whole millions. The scaling is done on the digits, never
 * through `Number`: a value above 2^53 would otherwise lose digits, and a
 * binary fraction can round a half the wrong way.
 */

/** The minus sign a negative amount is shown with (U+2212, the typographic minus). */
export const MINUS_SIGN = "−";

const MILLION_DIGITS = 6;
const HALF_MILLION = "500000";

/** Adds one to a string of decimal digits ("999" → "1000"). */
function incrementDigits(digits: string): string {
	const out = digits.split("");
	for (let index = out.length - 1; index >= 0; index -= 1) {
		if (out[index] !== "9") {
			out[index] = String(Number(out[index]) + 1);
			return out.join("");
		}
		out[index] = "0";
	}
	return `1${out.join("")}`;
}

/**
 * The amount in whole millions, rounded half away from zero, as signed
 * decimal digits ("-391035", "0"), or null when `valueDecimal` is not
 * canonical decimal text. Zero is never signed.
 */
export function roundedMillions(valueDecimal: string): string | null {
	if (!isCanonicalDecimal(valueDecimal)) return null;
	const negative = valueDecimal.startsWith("-");
	const unsigned = negative ? valueDecimal.slice(1) : valueDecimal;
	const point = unsigned.indexOf(".");
	const integer = point === -1 ? unsigned : unsigned.slice(0, point);
	const padded = integer.padStart(MILLION_DIGITS + 1, "0");
	const head = padded.slice(0, padded.length - MILLION_DIGITS);
	// The six digits below a million decide the rounding; any fraction only
	// matters below the half, which these digits already decide (499999.9 < 500000).
	const below = padded.slice(padded.length - MILLION_DIGITS);
	const magnitude = (below >= HALF_MILLION ? incrementDigits(head) : head).replace(/^0+(?=\d)/, "");
	return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

/** Groups decimal digits by thousands with ","; both UI languages write amounts this way. */
function groupThousands(digits: string): string {
	let out = "";
	for (let index = 0; index < digits.length; index += 1) {
		if (index > 0 && (digits.length - index) % 3 === 0) out += ",";
		out += digits[index];
	}
	return out;
}

/**
 * The amount as shown in a statement cell: whole millions, grouped, with
 * the typographic minus for a negative ("−1,234"). Null for text that is not
 * canonical decimal (the caller shows the value as unavailable, never 0).
 */
export function formatMillions(valueDecimal: string): string | null {
	const millions = roundedMillions(valueDecimal);
	if (millions === null) return null;
	return millions.startsWith("-")
		? `${MINUS_SIGN}${groupThousands(millions.slice(1))}`
		: groupThousands(millions);
}

/**
 * The amount in millions as a number for drawing a bar. Exact: a rounded
 * millions count is an integer far below 2^53 for any reported amount.
 */
export function millionsForChart(valueDecimal: string): number | null {
	const millions = roundedMillions(valueDecimal);
	return millions === null ? null : Number(millions);
}

/** The exact amount in base units, grouped ("391,035,000,000"; "−1,234.5"). */
export function formatExactAmount(valueDecimal: string): string | null {
	if (!isCanonicalDecimal(valueDecimal)) return null;
	const negative = valueDecimal.startsWith("-");
	const unsigned = negative ? valueDecimal.slice(1) : valueDecimal;
	const point = unsigned.indexOf(".");
	const integer = point === -1 ? unsigned : unsigned.slice(0, point);
	const fraction = point === -1 ? "" : unsigned.slice(point);
	return `${negative ? MINUS_SIGN : ""}${groupThousands(integer)}${fraction}`;
}

const MONTHS_EN = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/**
 * A calendar date ("2025-03-31") as a column header shows it: "Mar 31, 2025"
 * in English, "2025年3月31日" in Japanese. Read from the text itself (no time
 * zone can move it); the text as it came when it is not a date.
 */
export function formatPeriodEnd(isoDate: string, locale: Locale): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
	if (match === null) return isoDate;
	const [, year, month, day] = match;
	const monthIndex = Number(month) - 1;
	const monthName = MONTHS_EN[monthIndex];
	if (monthName === undefined) return isoDate;
	return locale === "ja"
		? `${year}年${monthIndex + 1}月${Number(day)}日`
		: `${monthName} ${Number(day)}, ${year}`;
}
