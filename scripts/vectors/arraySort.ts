/**
 * `Array.prototype.sort` with a comparator (crate `research-js`,
 * `array_sort`): V8's TimSort, element for element, for consistent
 * comparators and for inconsistent ones (random answers keyed by the pair,
 * `NaN` differences from infinite values). Each case carries the keys, the
 * comparator kind and seed, and the order V8 produced (as element ids).
 */
import { seededRandom, type VectorExporter, type VectorFile } from "./shared.ts";

interface Element {
	readonly id: number;
	readonly key: number;
	readonly other: number;
}

const TABLE: readonly number[] = [Number.NaN, -1, 1, 0, -7, 3, 0.5, -0.25];

function tableAnswer(seed: number, a: Element, b: Element): number {
	const hash =
		(Math.imul(a.id, 73856093) ^ Math.imul(b.id, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
	return TABLE[hash % TABLE.length] ?? 0;
}

type Kind = "consistent" | "table" | "infdelta";

function comparator(kind: Kind, seed: number): (a: Element, b: Element) => number {
	if (kind === "consistent") return (a, b) => a.key - b.key;
	if (kind === "table") return (a, b) => tableAnswer(seed, a, b);
	const delta = (x: Element): number => Math.abs(x.key - x.other);
	return (a, b) => delta(b) - delta(a) || a.id - b.id;
}

export const arraySortExporter: VectorExporter = {
	name: "array-sort",
	async build(): Promise<readonly VectorFile[]> {
		const random = seededRandom(0xa11a7);
		const int = (max: number): number => Math.floor(random() * max);
		const cases: unknown[] = [];
		const sizes = [0, 1, 2, 3, 5, 8, 31, 32, 33, 63, 64, 65, 66, 100, 127, 128, 129, 200, 255, 300];
		for (let index = 0; index < 1100; index += 1) {
			const size = random() < 0.5 ? (sizes[int(sizes.length)] ?? 0) : int(301);
			const kind: Kind = (["consistent", "table", "infdelta"] as const)[int(3)] ?? "consistent";
			const distinct = [1, 2, 3, 5, 20, 1000][int(6)] ?? 3;
			const pool = [0, 1, 2, 5, Number.POSITIVE_INFINITY, 3];
			const items: Element[] = Array.from({ length: size }, (_, id) => ({
				id,
				key:
					kind === "infdelta"
						? (pool[int(pool.length)] ?? 0)
						: int(distinct) * (random() < 0.5 ? 1 : -1),
				other: pool[int(pool.length)] ?? 0,
			}));
			// Pre-sorted and reversed runs exercise run detection.
			const shape = int(5);
			if (kind === "consistent" && shape === 1) {
				items.sort((a, b) => a.key - b.key);
				for (const [id, item] of items.entries()) Object.assign(item, { id });
			}
			if (kind === "consistent" && shape === 2) {
				items.sort((a, b) => b.key - a.key);
				for (const [id, item] of items.entries()) Object.assign(item, { id });
			}
			const seed = int(1_000_000);
			const sorted = [...items].sort(comparator(kind, seed));
			cases.push({
				kind,
				seed,
				keys: items.map((item) => (Number.isFinite(item.key) ? item.key : "inf")),
				others:
					kind === "infdelta"
						? items.map((item) => (Number.isFinite(item.other) ? item.other : "inf"))
						: [],
				order: sorted.map((item) => item.id),
			});
		}
		return [{ path: "js/array-sort.json", content: cases }];
	},
};
