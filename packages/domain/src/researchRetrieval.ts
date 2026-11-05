/** Round-robin passages from each corpus, preserving each corpus's order. */
export function interleaveSearchResults<T>(
	groups: readonly (readonly T[])[],
	limit: number,
): readonly T[] {
	const rounds = Math.max(0, ...groups.map((group) => group.length));
	const output: T[] = [];
	for (let index = 0; index < rounds; index += 1) {
		for (const group of groups) {
			const value = group[index];
			if (value !== undefined) output.push(value);
		}
	}
	return output.slice(0, Math.max(0, Math.trunc(limit)));
}
