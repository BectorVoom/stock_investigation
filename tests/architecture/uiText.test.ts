import { describe, expect, it } from "vitest";
import { scanUiText, scanUiTextPaths } from "./uiTextScanner.ts";

/**
 * ADR-0031: every word of the UI comes from a translation catalog, so the UI
 * reads the same in each supported language. Findings name file and line;
 * run `bun tests/architecture/uiTextScanner.ts <path>` to list them for a
 * folder.
 */
describe("UI text comes from translation catalogs", () => {
	it("has no English text written straight into UI source", () => {
		expect(scanUiTextPaths().map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
	});
});

describe("the scanner", () => {
	const scan = (code: string) => scanUiText("x.tsx", code).map((finding) => finding.text);

	it("finds JSX text, read attributes and prose literals", () => {
		expect(
			scan(`
const a = <p>Save changes</p>;
const b = <button aria-label="Close" />;
const c = { text: "Refresh queued for the runner." };
const d = \`Moved \${x} to position \${y}.\`;
`),
		).toEqual([
			"Save changes",
			"Close",
			"Refresh queued for the runner.",
			"Moved x to position x .",
		]);
	});

	it("ignores code, developer messages and marked lines", () => {
		expect(
			scan(`
const a = <div class="flex items-center" data-field="owner-id" role="status" />;
if (key === "ArrowRight") throw new Error("Unexpected state here");
console.warn("Something went wrong here");
const b = { kind: "line chart", code: "NOT_FOUND" };
// i18n-exempt: a product name
const c = <span>OpenCode Go</span>;
const d = <span>{m().save}</span>;
`),
		).toEqual([]);
	});
});
