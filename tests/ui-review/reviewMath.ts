/**
 * Pure helpers for the scripted UI review (`chatReview.spec.ts`).
 *
 * WHY a separate module: the geometry audit itself runs inside the page
 * (`page.evaluate`), where imports cannot cross the serialization boundary —
 * so the in-page code keeps its own copy of these formulas (see the header
 * comment of the spec). What lives here is the part that CAN be shared and
 * tested in Node: the WCAG contrast math, the 24 px target-size rule
 * (guideline section 9) and the findings summary the review prints.
 */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
	const channel = (value: number): number => {
		const s = value / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const red = rgb[0] ?? 0;
	const green = rgb[1] ?? 0;
	const blue = rgb[2] ?? 0;
	return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

/** WCAG contrast ratio of two relative luminances (1–21, higher is better). */
export function contrastRatio(first: number, second: number): number {
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Convenience over sRGB triples (e.g. the guideline pairs in section 2). */
export function contrastRatioOf(
	foreground: readonly [number, number, number],
	background: readonly [number, number, number],
): number {
	return contrastRatio(relativeLuminance(foreground), relativeLuminance(background));
}

/**
 * Guideline section 9: every button, `summary` and stand-alone link is at
 * least 24 px tall (and wide, unless it is an inline link or a checkbox).
 */
export function isSmallTarget(width: number, height: number): boolean {
	return width < 24 || height < 24;
}

export interface ReviewFinding {
	readonly state: string;
	readonly rule: string;
	readonly detail: string;
}

/** Counts findings per rule for the summary table the review prints. */
export function countByRule(findings: readonly ReviewFinding[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const finding of findings) {
		counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
	}
	return counts;
}

/** Renders the `rule -> count` summary table lines. */
export function formatSummaryTable(counts: Readonly<Record<string, number>>): readonly string[] {
	const rules = Object.keys(counts).sort();
	if (rules.length === 0) return ["ui-review: no findings"];
	const width = Math.max(...rules.map((rule) => rule.length));
	return [
		"ui-review findings (rule -> count):",
		...rules.map((rule) => `  ${(rule ?? "").padEnd(width)}  ${counts[rule] ?? 0}`),
		`  ${"total".padEnd(width)}  ${rules.reduce((sum, rule) => sum + (counts[rule] ?? 0), 0)}`,
	];
}
