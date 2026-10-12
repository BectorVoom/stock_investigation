import { describe, expect, it } from "vitest";
import { createReadGate } from "../src/lib/readGate.ts";

describe("read gate", () => {
	it("admits reads in the order they were sent", () => {
		const gate = createReadGate();
		const first = gate.begin();
		const second = gate.begin();
		expect(gate.admit(first)).toBe(true);
		expect(gate.admit(second)).toBe(true);
	});

	it("rejects a read that was sent before an accepted mutation", () => {
		const gate = createReadGate();
		const before = gate.begin();
		gate.invalidate();
		const after = gate.begin();
		expect(gate.admit(before)).toBe(false);
		expect(gate.admit(after)).toBe(true);
	});

	it("rejects an earlier read once a later one has been applied", () => {
		const gate = createReadGate();
		const earlier = gate.begin();
		const later = gate.begin();
		expect(gate.admit(later)).toBe(true);
		expect(gate.admit(earlier)).toBe(false);
	});

	it("keeps rejecting stale reads across several mutations", () => {
		const gate = createReadGate();
		const stale = gate.begin();
		gate.invalidate();
		const alsoStale = gate.begin();
		gate.invalidate();
		const fresh = gate.begin();
		expect(gate.admit(alsoStale)).toBe(false);
		expect(gate.admit(stale)).toBe(false);
		expect(gate.admit(fresh)).toBe(true);
	});

	it("admits a read that was sent while a mutation was still unanswered", () => {
		// The mutation only counts once the server has accepted it; a read that started
		// during the request and finishes first is still the newest knowledge at that time.
		const gate = createReadGate();
		const duringMutation = gate.begin();
		expect(gate.admit(duringMutation)).toBe(true);
		gate.invalidate();
		expect(gate.admit(gate.begin())).toBe(true);
	});
});
