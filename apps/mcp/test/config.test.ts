import { describe, expect, it } from "vitest";
import { DEFAULT_API_ORIGIN, parseHomeMcpConfig } from "../src/config.ts";

describe("parseHomeMcpConfig", () => {
	it("defaults to the production loopback origin", () => {
		const parsed = parseHomeMcpConfig([], {});
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.value).toEqual({ apiOrigin: DEFAULT_API_ORIGIN, help: false });
		expect(DEFAULT_API_ORIGIN).toBe("http://127.0.0.1:8787");
	});

	it("takes the origin from --api, preferring the flag over the environment", () => {
		const fromFlag = parseHomeMcpConfig(["--api", "http://127.0.0.1:8788"], {
			RESEARCH_API_URL: "http://localhost:3000",
		});
		if (!fromFlag.ok) throw new Error(fromFlag.error);
		expect(fromFlag.value.apiOrigin).toBe("http://127.0.0.1:8788");

		const equalsForm = parseHomeMcpConfig(["--api=http://localhost:8788"], {});
		if (!equalsForm.ok) throw new Error(equalsForm.error);
		expect(equalsForm.value.apiOrigin).toBe("http://localhost:8788");

		const fromEnv = parseHomeMcpConfig([], { RESEARCH_API_URL: "http://localhost:3000" });
		if (!fromEnv.ok) throw new Error(fromEnv.error);
		expect(fromEnv.value.apiOrigin).toBe("http://localhost:3000");
	});

	it("accepts every loopback host and normalizes the origin", () => {
		for (const raw of [
			"http://localhost:8787",
			"http://127.0.0.1:8787",
			"http://[::1]:8787",
			"http://127.0.0.1:8788/",
			"http://127.0.0.1:8788/api",
		]) {
			const parsed = parseHomeMcpConfig(["--api", raw], {});
			if (!parsed.ok) throw new Error(`${raw}: ${parsed.error}`);
			expect(parsed.value.help).toBe(false);
		}
		const slashed = parseHomeMcpConfig(["--api", "http://127.0.0.1:8788/"], {});
		if (!slashed.ok) throw new Error(slashed.error);
		expect(slashed.value.apiOrigin).toBe("http://127.0.0.1:8788");
		const withPath = parseHomeMcpConfig(["--api", "http://127.0.0.1:8788/api"], {});
		if (!withPath.ok) throw new Error(withPath.error);
		expect(withPath.value.apiOrigin).toBe("http://127.0.0.1:8788");
	});

	it("refuses anything that is not a loopback http: origin", () => {
		for (const raw of [
			"https://127.0.0.1:8787",
			"https://localhost:8787",
			"http://example.com",
			"http://example.com:8787",
			"http://192.168.1.2:8787",
			"http://10.0.0.1:8787",
			"http://[::2]:8787",
			"http://127.0.0.1.evil.com:8787",
			"http://localhost.evil.com",
			"not-a-url",
			"127.0.0.1:8787",
			"",
		]) {
			const parsed =
				raw === "" ? parseHomeMcpConfig(["--api", ""], {}) : parseHomeMcpConfig(["--api", raw], {});
			if (parsed.ok) throw new Error(`${raw} was accepted`);
			expect(parsed.error).toMatch(/refusing API origin|not a URL|needs an origin/);
		}
		const fromEnv = parseHomeMcpConfig([], { RESEARCH_API_URL: "https://example.com" });
		if (fromEnv.ok) throw new Error("a hostile environment origin was accepted");
	});

	it("fails closed on missing values, unknown options and positionals", () => {
		const missing = parseHomeMcpConfig(["--api"], {});
		if (missing.ok) throw new Error("missing --api value was accepted");
		const unknown = parseHomeMcpConfig(["--bogus"], {});
		if (unknown.ok) throw new Error("unknown option was accepted");
		const positional = parseHomeMcpConfig(["http://127.0.0.1:8787"], {});
		if (positional.ok) throw new Error("positional argument was accepted");
	});

	it("answers --help without an origin", () => {
		for (const flag of ["--help", "-h"]) {
			const parsed = parseHomeMcpConfig([flag], {});
			if (!parsed.ok) throw new Error(parsed.error);
			expect(parsed.value.help).toBe(true);
		}
	});
});
