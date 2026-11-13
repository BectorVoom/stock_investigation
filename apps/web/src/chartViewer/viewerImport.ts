import viewerModuleUrl from "virtual:chart-viewer-url";
import type * as ViewerModule from "./ChartViewer.tsx";

export type ViewerExports = Pick<typeof ViewerModule, "ChartViewer" | "InlineChartViewer">;

/** The retry URL is our own compiled module; check its public export shape. */
function isViewerModule(value: unknown): value is ViewerExports {
	return (
		typeof value === "object" &&
		value !== null &&
		"ChartViewer" in value &&
		typeof value.ChartViewer === "function" &&
		"InlineChartViewer" in value &&
		typeof value.InlineChartViewer === "function"
	);
}

export async function importViewerModule(failedAttempts: number): Promise<ViewerExports> {
	if (failedAttempts === 0) return import("./ChartViewer.tsx");
	const url = new URL(viewerModuleUrl, import.meta.url);
	if (url.origin !== new URL(import.meta.url).origin) {
		throw new Error("The chart viewer asset must have the same origin.");
	}
	url.searchParams.set("chart-retry", String(failedAttempts));
	const loaded: unknown = await import(/* @vite-ignore */ url.href);
	if (!isViewerModule(loaded)) throw new Error("The chart viewer module has invalid exports.");
	return loaded;
}
