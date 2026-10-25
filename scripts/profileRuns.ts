/**
 * Where research runs spend their wall-clock time, from the job events the
 * runner already records (no extra logging, nothing written).
 *
 *     bun run profile:runs                 # development data (data-dev/)
 *     bun run profile:runs -- --prod       # production data (data/)
 *     bun run profile:runs -- --limit 50
 *
 * Phases come from the stored state events of each run's final lease
 * generation. "lost" is time spent in earlier generations (a runner stopped
 * mid-run and the run started again). Inside collection, a tool event that
 * follows a usage event (a gap in the event sequence: a planning turn ended)
 * is counted as planning time, because a tool's own start is not recorded;
 * every other tool event is counted as that tool's time.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

interface Options {
	readonly dataDir: string;
	readonly limit: number;
}

function parseOptions(argv: readonly string[]): Options {
	let dataDir = "data-dev";
	let limit = 20;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--prod") dataDir = "data";
		else if (arg === "--limit") {
			const value = Number(argv[i + 1]);
			if (!Number.isInteger(value) || value < 1)
				throw new Error("--limit needs a positive integer");
			limit = value;
			i += 1;
		} else throw new Error(`unknown option ${arg}`);
	}
	return { dataDir, limit };
}

/** The local D1 database: the largest SQLite file of the D1 object store. */
function findDatabase(dataDir: string): string {
	const dir = join(dataDir, "d1", "v3", "d1", "miniflare-D1DatabaseObject");
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".sqlite"))
		.map((name) => join(dir, name))
		.sort((a, b) => statSync(b).size - statSync(a).size);
	const [largest] = files;
	if (largest === undefined) throw new Error(`no D1 database under ${dir}`);
	return largest;
}

// Rows are parsed, not cast: an unexpected schema fails loudly.
const jobRow = z.object({
	run_id: z.string(),
	state: z.string(),
	created_at: z.string(),
	provider_model: z.string().nullable(),
	lease_generation: z.number(),
});
const transitionRow = z.object({ at: z.string(), to_state: z.string() });
const eventRow = z.object({ seq: z.number(), at: z.string(), kind: z.string(), text: z.string() });
type JobRow = z.infer<typeof jobRow>;
type TransitionRow = z.infer<typeof transitionRow>;
type EventRow = z.infer<typeof eventRow>;

const ms = (iso: string): number => Date.parse(iso);
const seconds = (value: number): string => (value / 1000).toFixed(1);

interface Profile {
	readonly total: number;
	readonly queued: number;
	readonly lost: number;
	readonly planning: number;
	readonly tools: number;
	readonly analyzing: number;
	readonly verifying: number;
	readonly publishing: number;
	readonly rounds: number;
	readonly byTool: ReadonlyMap<string, number>;
}

function profile(
	job: JobRow,
	transitions: readonly TransitionRow[],
	events: readonly EventRow[],
): Profile | null {
	const claims = transitions.filter((t) => t.to_state === "claimed").map((t) => ms(t.at));
	const [firstClaim] = claims;
	const lastClaim = claims.at(-1);
	const end = transitions.at(-1);
	if (firstClaim === undefined || lastClaim === undefined || end === undefined) return null;
	const endMs = ms(end.at);
	const stateAt = new Map<string, number>();
	for (const event of events) {
		if (event.kind === "state" && !stateAt.has(event.text)) stateAt.set(event.text, ms(event.at));
	}
	const analyzingAt = stateAt.get("analyzing");
	const verifyingAt = stateAt.get("verifying");
	const publishingAt = stateAt.get("publishing");
	const collectEnd = analyzingAt ?? endMs;

	let planning = 0;
	let tools = 0;
	let rounds = 0;
	const byTool = new Map<string, number>();
	let previous = stateAt.get("planning") ?? lastClaim;
	let previousSeq: number | null = null;
	let afterPlan = true;
	for (const event of events) {
		const at = ms(event.at);
		if (at >= collectEnd) break;
		const gap = at - previous;
		const skipped = previousSeq !== null && event.seq - previousSeq > 1;
		if (event.kind === "tool") {
			if (skipped || afterPlan) {
				planning += gap;
				rounds += 1;
			} else {
				tools += gap;
				const toolId = event.text.split(":", 1)[0] ?? "unknown";
				byTool.set(toolId, (byTool.get(toolId) ?? 0) + gap);
			}
			afterPlan = false;
		} else if (event.kind === "state" && event.text === "collecting") {
			planning += gap;
			afterPlan = true;
		}
		previous = at;
		previousSeq = event.seq;
	}
	if (analyzingAt !== undefined) planning += Math.max(0, collectEnd - previous);
	const analyzing =
		analyzingAt === undefined ? 0 : (verifyingAt ?? publishingAt ?? endMs) - analyzingAt;
	const verifying = verifyingAt === undefined ? 0 : (publishingAt ?? endMs) - verifyingAt;
	return {
		total: endMs - ms(job.created_at),
		queued: Math.max(0, firstClaim - ms(job.created_at)),
		lost: lastClaim - firstClaim,
		planning,
		tools,
		analyzing,
		verifying,
		publishing: publishingAt === undefined ? 0 : endMs - publishingAt,
		rounds,
		byTool,
	};
}

function main(): void {
	const options = parseOptions(process.argv.slice(2));
	const db = new DatabaseSync(findDatabase(options.dataDir), { readOnly: true });
	const jobs = z.array(jobRow).parse(
		db
			.prepare(
				`SELECT run_id, state, created_at, provider_model, lease_generation FROM research_jobs
					 WHERE kind = 'research' AND state IN ('completed', 'failed', 'partial')
					 ORDER BY created_at DESC LIMIT ?`,
			)
			.all(options.limit),
	);
	const transitionsQuery = db.prepare(
		"SELECT at, to_state FROM job_transitions WHERE run_id = ? ORDER BY transition_id",
	);
	const eventsQuery = db.prepare(
		"SELECT seq, at, kind, text FROM job_events WHERE run_id = ? AND lease_generation = ? ORDER BY seq",
	);
	const transitionsOf = (runId: string) =>
		z.array(transitionRow).parse(transitionsQuery.all(runId));
	const eventsOf = (runId: string, generation: number) =>
		z.array(eventRow).parse(eventsQuery.all(runId, generation));
	const columns = [
		"total",
		"queued",
		"lost",
		"planning",
		"tools",
		"analyzing",
		"verifying",
		"publishing",
	] as const;
	const sums = new Map<string, number>(columns.map((c) => [c, 0]));
	const toolSums = new Map<string, number>();
	const rows: string[][] = [["run", "state", "model", ...columns, "rounds"]];
	for (const job of jobs) {
		const result = profile(
			job,
			transitionsOf(job.run_id),
			eventsOf(job.run_id, job.lease_generation),
		);
		if (result === null) continue;
		for (const c of columns) sums.set(c, (sums.get(c) ?? 0) + result[c]);
		for (const [tool, value] of result.byTool)
			toolSums.set(tool, (toolSums.get(tool) ?? 0) + value);
		rows.push([
			job.run_id.slice(-8),
			job.state,
			(job.provider_model ?? "-").slice(0, 18),
			...columns.map((c) => seconds(result[c])),
			String(result.rounds),
		]);
	}
	const total = sums.get("total") ?? 0;
	rows.push([
		"SUM",
		"",
		"",
		...columns.map((c) => {
			const value = sums.get(c) ?? 0;
			return c === "total" || total === 0
				? seconds(value)
				: `${seconds(value)} (${Math.round((value / total) * 100)}%)`;
		}),
		"",
	]);
	const widths = (rows[0] ?? []).map((_, i) =>
		Math.max(...rows.map((row) => (row[i] ?? "").length)),
	);
	for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  "));
	console.log("\nTool time (s), largest first:");
	for (const [tool, value] of [...toolSums].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${tool.padEnd(36)} ${seconds(value)}`);
	}
	db.close();
}

main();
