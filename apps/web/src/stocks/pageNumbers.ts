/**
 * The page numbers a pager shows (ADR-0070 §3): every page when there are
 * at most `ALL_PAGES_UP_TO`; else the first and last page, the current page
 * and its neighbours, and the first or last four near either end — "1 2 3
 * 4 … 10", "1 … 4 5 6 … 10", "1 … 7 8 9 10". A gap of one page shows that
 * page instead of "…", so "…" always stands for two or more pages.
 */

/** A page number, or "gap" for the pages "…" stands for. */
export type PageItem = number | "gap";

/** Up to this many pages, every page is shown. */
const ALL_PAGES_UP_TO = 7;

export function pageNumbers(current: number, pageCount: number): readonly PageItem[] {
	const count = Math.max(1, Math.trunc(pageCount));
	const page = Math.min(Math.max(1, Math.trunc(current)), count);
	if (count <= ALL_PAGES_UP_TO) return Array.from({ length: count }, (_, index) => index + 1);
	const shown = new Set<number>([1, count, page - 1, page, page + 1]);
	if (page <= 3) for (let n = 2; n <= 4; n += 1) shown.add(n);
	if (page >= count - 2) for (let n = count - 3; n < count; n += 1) shown.add(n);
	const sorted = [...shown].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
	const items: PageItem[] = [];
	let previous = 0;
	for (const n of sorted) {
		if (n - previous === 2) items.push(n - 1);
		else if (n - previous > 2) items.push("gap");
		items.push(n);
		previous = n;
	}
	return items;
}
