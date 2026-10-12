import type { ResearchRun } from "@research/contracts";

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usdFormat = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});

export function formatInteger(value: number): string {
	return integerFormat.format(value);
}

export function formatUsd(value: number): string {
	return usdFormat.format(value);
}

export function formatMinutes(milliseconds: number): string {
	const minutes = milliseconds / 60_000;
	return `${Number(minutes.toFixed(1))} min`;
}

/** UTC timestamp to the minute, e.g. "2026-10-11 09:30 UTC"; the raw text when unparseable. */
export function formatInstant(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return iso;
	return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * FR-016 / AGT-008: an unknown cost is never shown as $0. Plan-limited usage is
 * reported as unknown, with any separately metered portion stated.
 */
export function describeCost(cost: ResearchRun["cost"]): string {
	if (cost.status === "unknown-plan-limited") {
		return cost.meteredPortionUsd > 0
			? `unknown / plan-limited (plus ${formatUsd(cost.meteredPortionUsd)} metered)`
			: "unknown / plan-limited";
	}
	if (cost.status === "none") return "no usage recorded yet";
	return cost.totalCostUsd === null ? "unknown" : `${formatUsd(cost.totalCostUsd)} metered`;
}
