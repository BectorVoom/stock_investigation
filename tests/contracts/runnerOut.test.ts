/**
 * The Rust runner's outgoing payloads against the real zod schemas (ADR-0030,
 * shell-wire spec section 6, point 4). `cargo test -p research-runner` writes
 * every payload the runner's producers build (claim requests, heartbeat
 * requests, event batches, every completion outcome) to
 * `vectors/runner/out/`; each file must parse with the schema the Worker uses
 * on the same bytes. A Rust change that departs from zod therefore fails here,
 * and the Rust test fails when the files are stale.
 *
 * Also scans the Rust sources for log event names (the Rust half of
 * `apps/runner/test/logEvents.test.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	claimJobRequestSchema,
	completeJobRequestSchema,
	heartbeatRequestSchema,
	runnerEventsRequestSchema,
} from "@research/contracts";
import { LOG_EVENT_PATTERN } from "@research/effects";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const outDirectory = join(repoRoot, "vectors/runner/out");

const SCHEMAS: Readonly<Record<string, ZodType>> = {
	claimJobRequest: claimJobRequestSchema,
	heartbeatRequest: heartbeatRequestSchema,
	runnerEventsRequest: runnerEventsRequestSchema,
	completeJobRequest: completeJobRequestSchema,
};

interface GoldenFile {
	readonly name: string;
	readonly schema: string;
	readonly body: string;
}

function readGoldens(): GoldenFile[] {
	return readdirSync(outDirectory)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const parsed: unknown = JSON.parse(readFileSync(join(outDirectory, name), "utf8"));
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("schema" in parsed) ||
				!("body" in parsed) ||
				typeof parsed.schema !== "string" ||
				typeof parsed.body !== "string"
			) {
				throw new Error(`${name} is not a golden file`);
			}
			return { name, schema: parsed.schema, body: parsed.body };
		});
}

const goldens = readGoldens();

describe("payloads the Rust runner sends to the Worker", () => {
	it("has golden files for every schema the runner writes", () => {
		const schemas = new Set(goldens.map((golden) => golden.schema));
		expect([...schemas].sort()).toEqual(Object.keys(SCHEMAS).sort());
	});

	it.each(goldens.map((golden) => [golden.name, golden] as const))("%s parses", (_name, golden) => {
		const schema = SCHEMAS[golden.schema];
		if (schema === undefined) throw new Error(`unknown schema ${golden.schema}`);
		// The exact bytes the Worker would receive.
		const result = schema.safeParse(JSON.parse(golden.body));
		expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
	});

	it("covers all 12 completion outcomes and every event type the runner sends", () => {
		const outcomes = new Set<string>();
		const eventTypes = new Set<string>();
		for (const golden of goldens) {
			const body: unknown = JSON.parse(golden.body);
			if (typeof body !== "object" || body === null) continue;
			if (golden.schema === "completeJobRequest" && "outcome" in body) {
				outcomes.add(String(body.outcome));
			}
			if (
				golden.schema === "runnerEventsRequest" &&
				"events" in body &&
				Array.isArray(body.events)
			) {
				for (const entry of body.events) {
					if (typeof entry === "object" && entry !== null && "event" in entry) {
						const event: unknown = entry.event;
						if (typeof event === "object" && event !== null && "type" in event) {
							eventTypes.add(String(event.type));
						}
					}
				}
			}
		}
		expect([...outcomes].sort()).toEqual([
			"cancelled",
			"completed",
			"earnings-refreshed",
			"failed",
			"google-calendar-connected",
			"google-calendar-disconnected",
			"google-calendar-synced",
			"ingested",
			"market-refreshed",
			"notebook-assisted",
			"partial",
			"waiting_approval",
		]);
		// `provider-session` is part of the schema but the runner never sends it.
		expect([...eventTypes].sort()).toEqual(["google-auth-url", "note", "state", "tool", "usage"]);
	});
});

describe("log event names in the Rust crates", () => {
	function rustSources(directory: string, found: string[]): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "tests" && entry.name !== "target") rustSources(full, found);
			} else if (entry.name.endsWith(".rs")) {
				found.push(full);
			}
		}
	}

	it("every event literal passed to a logger matches LOG_EVENT_PATTERN", () => {
		const files: string[] = [];
		const crates = join(repoRoot, "crates");
		for (const crate of readdirSync(crates)) rustSources(join(crates, crate, "src"), files);
		// Receivers named `logger` only: other types have an `error` method too.
		const pattern = /logger\s*\.\s*(?:info|warn|error)\(\s*"([^"\\]+)"/g;
		const names = new Set<string>();
		for (const file of files) {
			// Test modules sit after the first `#[cfg(test)]` of a file.
			const production = readFileSync(file, "utf8").split("#[cfg(test)]")[0] ?? "";
			for (const match of production.matchAll(pattern)) {
				if (match[1] !== undefined) names.add(match[1]);
			}
		}
		expect(names.size).toBeGreaterThan(20);
		for (const name of names) expect(name, name).toMatch(LOG_EVENT_PATTERN);
		// The names the launcher greps for stay reserved to the runner shell.
		for (const reserved of ["invalid_configuration", "unsupported_runtime", "runner_crashed"]) {
			expect(names.has(reserved), reserved).toBe(true);
		}
	});
});
