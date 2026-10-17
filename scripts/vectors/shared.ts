/** Helpers shared by the vector exporters (ADR-0030). */

export interface VectorFile {
	/** Path under `vectors/`, e.g. `js/number.json`. */
	readonly path: string;
	readonly content: unknown;
}

export interface VectorExporter {
	readonly name: string;
	build(): Promise<readonly VectorFile[]>;
}

/**
 * Deterministic pseudo-random numbers (mulberry32), so a regenerated vector
 * file is byte-identical to the committed one.
 */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * A double as its IEEE-754 bit pattern (16 hex digits): JSON cannot carry
 * NaN, ±Infinity or -0, and no JSON float parser is trusted with the rest.
 */
export function doubleBits(value: number): string {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value);
	return view.getBigUint64(0).toString(16).padStart(16, "0");
}

/** A double made from a random bit pattern (any finite or special value). */
export function randomDouble(random: () => number): number {
	const view = new DataView(new ArrayBuffer(8));
	view.setUint32(0, Math.floor(random() * 4_294_967_296));
	view.setUint32(4, Math.floor(random() * 4_294_967_296));
	return view.getFloat64(0);
}

/**
 * `String.prototype.toWellFormed` (ES2024, not in this project's lib): lone
 * surrogates become U+FFFD, as a Rust `String` would hold them (ADR-0030).
 */
export function wellFormed(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"�",
	);
}
