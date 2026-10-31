/** Inputs are validated timestamps converted to integer epochs at the boundary. */
export function equityFactVisible(input: {
	readonly availableAt: number | null;
	readonly committedAt: number;
	readonly informationCutoff: number | null;
	readonly ingestionCutoff: number | null;
}): boolean {
	return (
		(input.informationCutoff === null ||
			(input.availableAt !== null && input.availableAt <= input.informationCutoff)) &&
		(input.ingestionCutoff === null || input.committedAt <= input.ingestionCutoff)
	);
}

/** A persisted snapshot excludes every later atomic import, regardless of clock changes. */
export function equityVersionVisible(committedVersion: number, ingestionVersion: number): boolean {
	return committedVersion <= ingestionVersion;
}

/** Canonical decimals have bounded length/scale before reaching this function. */
export function compareEquityDecimals(left: string, right: string): -1 | 0 | 1 {
	const leftScale = left.includes(".") ? left.length - left.indexOf(".") - 1 : 0;
	const rightScale = right.includes(".") ? right.length - right.indexOf(".") - 1 : 0;
	const leftAligned = BigInt(left.replace(".", "")) * 10n ** BigInt(rightScale);
	const rightAligned = BigInt(right.replace(".", "")) * 10n ** BigInt(leftScale);
	return leftAligned < rightAligned ? -1 : leftAligned > rightAligned ? 1 : 0;
}
