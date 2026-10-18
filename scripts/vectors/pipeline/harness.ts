/** Registers the existing test inputs without importing Vitest's runner.
 * Assertions are deliberately not evaluated here: the real TS functions are
 * the oracle. The unchanged Vitest suite remains the assertion gate. */
interface Case {
	readonly name: string;
	readonly run: () => unknown;
}
export const cases: Case[] = [];
export let currentCase = "";
/** Names the scenario about to run (generated scenarios do not come from `it`). */
export function setCurrentCase(name: string): void {
	currentCase = name;
}
let suite = "";
export function describe(name: string, callback: () => void): void {
	const before = suite;
	suite = `${before}/${name}`;
	callback();
	suite = before;
}
function register(name: string, callback: () => unknown): void {
	cases.push({ name: `${suite}/${name}`, run: callback });
}
export const it = Object.assign(register, {
	each:
		(rows: readonly unknown[]) => (name: string, callback: (...values: unknown[]) => unknown) => {
			for (const [index, row] of rows.entries())
				register(`${name} [${index}]`, () => callback(...(Array.isArray(row) ? row : [row])));
		},
});
export const test = it;
const matcher: object = new Proxy(() => undefined, {
	get: () => matcher,
	apply: () => undefined,
});
export function expect(_value: unknown): object {
	return matcher;
}
export async function runCases(): Promise<void> {
	for (const entry of cases) {
		currentCase = entry.name;
		await entry.run();
	}
}
