/**
 * `Math.pow` (and `**`), `Math.exp` and `Math.log` (crate `research-js`,
 * module `math`). Expected values come from V8 itself; the Rust port must
 * equal them bit for bit.
 *
 * Each case is one string of space-separated IEEE-754 bit patterns
 * (`doubleBits`) to keep the file small: `pow` cases are `"x y x**y"`,
 * `expLog` cases are `"x Math.exp(x) Math.log(x)"`.
 */
import { doubleBits, randomDouble, seededRandom, type VectorExporter } from "./shared.ts";

const SPECIAL = [
	0,
	-0,
	1,
	-1,
	0.5,
	-0.5,
	2,
	-2,
	3,
	-3,
	1 / 3,
	10,
	1024,
	-1075,
	1 + 2 ** -52,
	1 - 2 ** -53,
	2 ** 31,
	2 ** 31 + 1,
	2 ** 53,
	2 ** 64,
	1e-310,
	-1e-310,
	5e-324,
	-5e-324,
	2 ** -1022,
	1e308,
	-1e308,
	Number.MAX_VALUE,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	Math.E,
	709.79,
	-745.2,
	1e-9,
];

/** A double from raw bits: `high` (sign, exponent, top mantissa) and `low`. */
function fromWords(high: number, low: number): number {
	const view = new DataView(new ArrayBuffer(8));
	view.setUint32(0, high >>> 0);
	view.setUint32(4, low >>> 0);
	return view.getFloat64(0);
}

function powCases(): string[] {
	const random = seededRandom(0x5eed_0f00);
	const between = (low: number, high: number) => low + (high - low) * random();
	const integer = (low: number, high: number) => Math.floor(between(low, high + 1));
	const sign = () => (random() < 0.5 ? -1 : 1);
	const pairs: [number, number][] = [];
	for (const x of SPECIAL) for (const y of SPECIAL) pairs.push([x, y]);
	// Random bit patterns: every exponent, NaN payloads, infinities.
	for (let index = 0; index < 8000; index += 1)
		pairs.push([randomDouble(random), randomDouble(random)]);
	// Integers to integer powers (exact results, odd/even signs).
	for (let index = 0; index < 6000; index += 1) {
		const x = random() < 0.8 ? integer(-1000, 1000) : sign() * integer(1, 2 ** 31);
		pairs.push([x, integer(-40, 40)]);
	}
	// Halves: square roots and their odd multiples, negative bases (NaN).
	for (let index = 0; index < 4000; index += 1) {
		const x = sign() * Math.exp(between(-50, 50));
		pairs.push([x, integer(-20, 20) + 0.5]);
	}
	// Tiny exponents and huge exponents (the |y| > 2^31 branch near x = 1).
	for (let index = 0; index < 2000; index += 1) {
		pairs.push([Math.exp(between(-700, 700)), sign() * 2 ** between(-1074, -10)]);
	}
	for (let index = 0; index < 3000; index += 1) {
		const x = 1 + sign() * integer(1, 2 ** 20) * 2 ** -integer(20, 60);
		pairs.push([x, sign() * 2 ** between(31, 70)]);
	}
	// Subnormal bases, and results that underflow into the subnormals.
	for (let index = 0; index < 3000; index += 1) {
		const x = fromWords(integer(0, 0x000f_ffff), integer(0, 0xffff_ffff));
		pairs.push([random() < 0.2 ? -x : x, between(-1.5, 1.5)]);
	}
	for (let index = 0; index < 3000; index += 1) {
		const x = between(0.01, 0.99);
		// x ** y lands near 2^-1022 … 2^-1075.
		pairs.push([x, between(1020, 1076) / -Math.log2(x)]);
	}
	// Results near the overflow threshold 2^1024.
	for (let index = 0; index < 2000; index += 1) {
		const x = between(1.5, 1000);
		pairs.push([x, between(1022, 1025) / Math.log2(x)]);
	}
	// CAGR inputs: (end / start) ** (1 / years) (finance/cagr.ts).
	for (let index = 0; index < 8000; index += 1) {
		const ratio =
			random() < 0.5 ? Math.exp(between(-5, 5)) : integer(1, 10 ** 7) / integer(1, 10 ** 7);
		const years = random() < 0.7 ? integer(1, 30) : integer(1, 400) / integer(1, 40);
		pairs.push([ratio, 1 / years]);
	}
	// General positive and negative bases with modest exponents.
	for (let index = 0; index < 8000; index += 1) {
		const x = sign() * Math.exp(between(-60, 60));
		pairs.push([x, random() < 0.3 ? integer(-60, 60) : between(-8, 8)]);
	}
	// Negative bases to large odd and even integer exponents.
	for (let index = 0; index < 2000; index += 1) {
		const x = -between(0.9, 1.1);
		pairs.push([x, sign() * integer(1, 2 ** 53)]);
	}
	return pairs.map(([x, y]) => `${doubleBits(x)} ${doubleBits(y)} ${doubleBits(x ** y)}`);
}

function expLogCases(): string[] {
	const random = seededRandom(0x0e_10_9e);
	const inputs: number[] = [...SPECIAL];
	for (let index = 0; index < 5000; index += 1) inputs.push(randomDouble(random));
	for (let index = 0; index < 5000; index += 1) inputs.push((random() - 0.5) * 1500);
	for (let index = 0; index < 5000; index += 1) inputs.push(Math.exp((random() - 0.5) * 1400));
	return inputs.map(
		(x) => `${doubleBits(x)} ${doubleBits(Math.exp(x))} ${doubleBits(Math.log(x))}`,
	);
}

export const mathExporter: VectorExporter = {
	name: "math",
	async build() {
		return [{ path: "js/math.json", content: { pow: powCases(), expLog: expLogCases() } }];
	},
};
