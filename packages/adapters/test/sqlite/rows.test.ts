import { describe, expect, it } from "vitest";
import { toJobRecord } from "../../src/sql/rows.ts";

/**
 * Finding 10 (task 23b): `failure_detail` is a stable code, never free text.
 * Old rows predate the rule and must still decode, so an unstable or
 * mis-tied value decodes to null instead of throwing.
 */
function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		owner_id: "owner_1",
		run_id: "run_1",
		kind: "research",
		state: "failed",
		request_json: null,
		workspace_id: null,
		usage_json: JSON.stringify({
			agentSteps: 0,
			toolCalls: 0,
			inputBytes: 0,
			knownCostUsd: 0,
			hasUnmeteredUsage: false,
		}),
		attempt: 1,
		max_attempts: 3,
		lease_generation: 1,
		lease_owner_id: null,
		lease_expires_at: null,
		last_event_seq: -1,
		cancel_requested: 0,
		failure_code: "ALL_TOOL_CALLS_FAILED",
		failure_detail: "TIMEOUT",
		approval_request_json: null,
		retry_of_run_id: null,
		context_anchor_seq: null,
		verification_status: null,
		provider_model: null,
		provider_session_ref: null,
		completed_generation: null,
		provenance_json: null,
		version: 1,
		created_at: "2026-10-12T00:00:00.000Z",
		updated_at: "2026-10-12T00:00:00.000Z",
		request_fingerprint: "fp",
		...overrides,
	};
}

describe("toJobRecord failureDetail decoding (finding 10, task 23b, ADR-0025)", () => {
	it("keeps a stable detail tied to ALL_TOOL_CALLS_FAILED", () => {
		expect(toJobRecord(baseRow()).failureDetail).toBe("TIMEOUT");
	});

	it("keeps an ADR-0025 detail tied to NO_EVIDENCE_COLLECTED", () => {
		for (const detail of ["NO_TOOL_REQUESTED", "PLAN_NOT_JSON", "TOOLS_RETURNED_NOTHING"]) {
			expect(
				toJobRecord(baseRow({ failure_code: "NO_EVIDENCE_COLLECTED", failure_detail: detail }))
					.failureDetail,
			).toBe(detail);
		}
	});

	it("decodes page-derived text to null instead of throwing", () => {
		for (const detail of ["Click here to read more", "timeout", "TIME OUT", "a", "1X"]) {
			expect(toJobRecord(baseRow({ failure_detail: detail })).failureDetail).toBeNull();
			expect(
				toJobRecord(baseRow({ failure_code: "NO_EVIDENCE_COLLECTED", failure_detail: detail }))
					.failureDetail,
			).toBeNull();
		}
	});

	it("decodes a stable detail with the wrong failure code to null", () => {
		const record = toJobRecord(
			baseRow({ failure_code: "PROVIDER_RATE_LIMITED", failure_detail: "TIMEOUT" }),
		);
		expect(record.failureCode).toBe("PROVIDER_RATE_LIMITED");
		expect(record.failureDetail).toBeNull();
	});

	it("keeps decoding grandfathered mixed-case failure codes", () => {
		const record = toJobRecord(
			baseRow({ failure_code: "AGENT_THREW_TypeError", failure_detail: null }),
		);
		expect(record.failureCode).toBe("AGENT_THREW_TypeError");
		expect(record.failureDetail).toBeNull();
	});
});

/**
 * Migration 0012 (§4a): the stored upstream status is a number read back as
 * written; a value that cannot be an HTTP status decodes to null so one bad
 * row never makes a list unreadable, and a status never shows without a code.
 */
describe("toJobRecord failure_upstream_status decoding (ADR-0037)", () => {
	it("reads a stored status unchanged, including one Hono has no name for", () => {
		for (const status of [404, 418, 503, 529]) {
			expect(toJobRecord(baseRow({ failure_upstream_status: status })).failureUpstreamStatus).toBe(
				status,
			);
		}
	});

	it("reads a row written before the column existed, or a NULL, as null", () => {
		expect(toJobRecord(baseRow()).failureUpstreamStatus).toBeNull();
		expect(
			toJobRecord(baseRow({ failure_upstream_status: null })).failureUpstreamStatus,
		).toBeNull();
	});

	it("decodes an out-of-range or non-integer stored value to null instead of throwing", () => {
		for (const stored of [0, 99, 600, 404.5, -1, "404", Number.NaN]) {
			expect(toJobRecord(baseRow({ failure_upstream_status: stored })).failureUpstreamStatus).toBe(
				null,
			);
		}
	});

	it("shows no status without a failure code", () => {
		const record = toJobRecord(
			baseRow({ failure_code: null, failure_detail: null, failure_upstream_status: 503 }),
		);
		expect(record.failureCode).toBeNull();
		expect(record.failureUpstreamStatus).toBeNull();
	});
});
