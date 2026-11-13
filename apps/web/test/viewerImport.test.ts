import { expect, it, vi } from "vitest";
import { importViewerModule } from "../src/chartViewer/viewerImport.ts";

vi.mock("virtual:chart-viewer-url", () => ({
	default: "https://unexpected.example.invalid/ChartViewer.js",
}));

it("refuses a retry asset on a different origin before importing it", async () => {
	await expect(importViewerModule(1)).rejects.toThrow(
		"The chart viewer asset must have the same origin.",
	);
});
