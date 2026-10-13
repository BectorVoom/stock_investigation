import { isValidIsoDate } from "./civilDate.ts";

export interface UpcomingEarningRow {
	readonly stockId: string;
	readonly announcementDate: string | null;
}

/**
 * Keeps rows whose `announcementDate` lies in `[today, today + daysAhead]`
 * (inclusive, ISO string comparison on validated dates), sorted ascending by
 * date then by `stockId`, at most `maxItems`. Rows with an undecided (`null`)
 * or malformed date never enter a dated window — they are dropped, not
 * guessed. Invalid arguments fail closed to an empty selection.
 */
export function selectUpcomingEarnings<Row extends UpcomingEarningRow>(
	rows: readonly Row[],
	today: string,
	daysAhead: number,
	maxItems: number,
): readonly Row[] {
	if (!isValidIsoDate(today)) return [];
	if (!Number.isInteger(daysAhead) || daysAhead < 0) return [];
	if (!Number.isInteger(maxItems) || maxItems < 0) return [];
	const end = endOfWindow(today, daysAhead);
	const kept: Row[] = [];
	for (const row of rows) {
		const date = row.announcementDate;
		if (date === null || !isValidIsoDate(date)) continue;
		if (date < today || date > end) continue;
		kept.push(row);
	}
	kept.sort((a, b) => {
		const dateA = a.announcementDate ?? "";
		const dateB = b.announcementDate ?? "";
		if (dateA !== dateB) return dateA < dateB ? -1 : 1;
		return a.stockId < b.stockId ? -1 : a.stockId > b.stockId ? 1 : 0;
	});
	return kept.slice(0, maxItems);
}

function endOfWindow(today: string, daysAhead: number): string {
	const at = Date.parse(`${today}T00:00:00.000Z`);
	return new Date(at + daysAhead * 86_400_000).toISOString().slice(0, 10);
}
