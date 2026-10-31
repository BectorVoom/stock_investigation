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

/** What a non-zero amount under half a million shows: never "0", which means a reported zero. */
export const UNDER_ONE_MILLION = "<1";

/**
 * The amount as shown in a statement cell: whole millions, grouped, with
 * the typographic minus for a negative ("−1,234"). A non-zero amount that
 * rounds to 0 millions shows "<1" ("−<1"), so a reported zero ("0"), a tiny
 * amount and a missing value stay distinguishable. Null for text that is not
 * canonical decimal (the caller shows the value as unavailable, never 0).
 */
export function formatMillions(valueDecimal: string): string | null {
	const millions = roundedMillions(valueDecimal);
	if (millions === null) return null;
	// Canonical decimal text writes zero only as "0".
	if (millions === "0" && valueDecimal !== "0") {
		return valueDecimal.startsWith("-") ? `${MINUS_SIGN}${UNDER_ONE_MILLION}` : UNDER_ONE_MILLION;
	}
	return millions.startsWith("-")
		? `${MINUS_SIGN}${groupThousands(millions.slice(1))}`
		: groupThousands(millions);
}

/**
 * The powers of ten a history chart's axis may count in, per language: the
 * units each language's financial press writes large amounts in (USD
 * millions / billions / trillions; 百万円 / 億円 / 兆円).
 */
const CHART_SCALE_EXPONENTS: { readonly [L in Locale]: readonly number[] } = {
	en: [6, 9, 12],
	ja: [6, 8, 12],
};

/**
 * The largest count of the unit an axis shows: under 100,000, so the widest
 * tick ("100,000") fits the axis gutter as plain grouped digits.
 */
const CHART_MAX_INTEGER_DIGITS = 5;

/** Digits before the point of canonical decimal text, sign ignored ("-1234.5" → 4; "0.3" → 1). */
function integerDigits(valueDecimal: string): number {
	const unsigned = valueDecimal.startsWith("-") ? valueDecimal.slice(1) : valueDecimal;
	const point = unsigned.indexOf(".");
	return point === -1 ? unsigned.length : point;
}

/**
 * The one scale (power of ten) a history chart counts its values in: the
 * smallest of the language's units in which the largest value stays under
 * 100,000 — Apple's revenue in USD billions (391), Nintendo's in 億円
 * (11,649) or JPY billions (1,165), a small company's in millions. The axis
 * title names the unit and the ticks are plain grouped digits, so a tick
 * never adds a second scale (K, M) to the title's. Values that are not
 * canonical decimal are ignored (they are not drawn).
 */
export function chartScaleExponent(values: Iterable<string>, locale: Locale): number {
	let digits = 0;
	for (const value of values) {
		if (isCanonicalDecimal(value)) digits = Math.max(digits, integerDigits(value));
	}
	const exponents = CHART_SCALE_EXPONENTS[locale];
	for (const exponent of exponents) {
		if (digits - exponent <= CHART_MAX_INTEGER_DIGITS) return exponent;
	}
	return exponents.at(-1) ?? MILLION_DIGITS;
}

/**
 * The amount in units of 10^exponent as a number for drawing a bar
 * ("391035000000", 9 → 391.035). The point is moved on the digits and the
 * shifted text parsed once, so the number is the closest double to the
 * exact quotient (a division of a large Number could round twice). Null for
 * text that is not canonical decimal.
 */
export function scaledForChart(valueDecimal: string, exponent: number): number | null {
	if (!isCanonicalDecimal(valueDecimal)) return null;
	const negative = valueDecimal.startsWith("-");
	const unsigned = negative ? valueDecimal.slice(1) : valueDecimal;
	const point = unsigned.indexOf(".");
	const integer = (point === -1 ? unsigned : unsigned.slice(0, point)).padStart(exponent + 1, "0");
	const fraction = point === -1 ? "" : unsigned.slice(point + 1);
	const head = integer.slice(0, integer.length - exponent);
	const tail = `${integer.slice(integer.length - exponent)}${fraction}`;
	const value = Number(`${negative ? "-" : ""}${head}.${tail === "" ? "0" : tail}`);
	return Object.is(value, -0) ? 0 : value;
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
