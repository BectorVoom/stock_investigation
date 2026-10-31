import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventLogger, LOG_EVENT_PATTERN } from "@research/effects";
import { describe, expect, it } from "vitest";

/**
 * WHY a source scan: the content rule rejects any event name outside
 * `LOG_EVENT_PATTERN`, so every event name in the tree must already match —
 * otherwise enforcement would silence a real event. The scan fails if a
 * future call site introduces a non-matching name, and each found name is run
 * through the real logger to prove it still logs unchanged.
 */
function collectProductionEventNames(): string[] {
	const roots = [
		fileURLToPath(new URL("../../../apps/api/src", import.meta.url)),
		fileURLToPath(new URL("../src", import.meta.url)),
	];
	const names = new Set<string>();
	const pattern =
		/logger\.(?:info|warn|error)\(\s*"([^"\\]+)"|logEvent\(\s*"[a-z]+",\s*"([^"\\]+)"/g;
	const visit = (path: string): void => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const text = readFileSync(full, "utf8");
			for (const match of text.matchAll(pattern)) {
				const name = match[1] ?? match[2];
				if (name !== undefined) names.add(name);
			}
		}
	};
	for (const root of roots) visit(root);
	return [...names].sort();
}

describe("the stock-directory events (ADR-0034, docs/OPERATIONS.md)", () => {
	it("are logged by the TypeScript runner under the documented names", () => {
		const names = collectProductionEventNames();
		for (const event of [
			"stock_directory_fetched",
			"stock_directory_rejected",
			"stock_directory_source_failed",
			"stock_directory_rows_dropped",
		]) {
			expect(names, event).toContain(event);
		}
	});
});

describe("the financial statement sync events (ADR-0048, docs/OPERATIONS.md)", () => {
	it("are logged by the TypeScript runner under the documented names", () => {
		const names = collectProductionEventNames();
		for (const event of [
			"financial_sync_completed",
			"financial_sync_failed",
			"financial_sync_source_failed",
			"edinet_disabled",
		]) {
			expect(names, event).toContain(event);
		}
	});
});

describe("existing production events still log unchanged (A1-1)", () => {
	it("every event name in apps/api and apps/runner matches the pattern and logs as-is", () => {
		const names = collectProductionEventNames();
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(name).toMatch(LOG_EVENT_PATTERN);
			const lines: string[] = [];
			const logger = createEventLogger(
				(line) => {
					lines.push(line);
				},
				() => new Date("2026-10-12T00:00:00.000Z"),
			);
			logger.info(name);
			expect(lines).toEqual([
				`{"at":"2026-10-12T00:00:00.000Z","level":"info","event":"${name}"}\n`,
			]);
		}
	});
});
