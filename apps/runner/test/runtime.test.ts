import { describe, expect, it } from "vitest";
import { isUnsupportedRuntime, runtimeName } from "../src/runtime.ts";

describe("runner runtime guard", () => {
	it("runs under Node and refuses Bun", () => {
		expect(runtimeName({ node: "23.6.0" })).toBe("node");
		expect(isUnsupportedRuntime({ node: "23.6.0" })).toBe(false);
		expect(runtimeName({ node: "23.6.0", bun: "1.3.14" })).toBe("bun");
		expect(isUnsupportedRuntime({ node: "23.6.0", bun: "1.3.14" })).toBe(true);
	});
});
