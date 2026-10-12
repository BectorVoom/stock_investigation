/**
 * SSRF adversarial cases for `web.fetch_page` (SEC-002, hard gate 3). The
 * tool is the first whose destination is chosen by the model, so these tests
 * show that a hostile or careless URL is refused by the string policy before
 * any fetch — and that a refusal from the pinned fetcher (a name that
 * resolves to a private address) surfaces as a typed tool failure rather
 * than retrieved content.
 */
import { describe, expect, it } from "vitest";
import { webCryptoHasher } from "../../packages/adapters/src/runtime/index.ts";
import { createWebTools } from "../../packages/adapters/src/tools/webTools.ts";
import {
	createScriptedFetcher,
	createToolContext,
	fixedClock,
} from "../../packages/adapters/test/tools/support.ts";

function setup() {
	const fetcher = createScriptedFetcher({});
	const saved: unknown[] = [];
	const [tool] = createWebTools({
		fetcher,
		hasher: webCryptoHasher,
		clock: fixedClock(),
		pageArchive: {
			async save(page) {
				saved.push(page);
				return { ok: true as const, value: { fileName: "archived.md" } };
			},
		},
		sleep: async () => {},
	});
	if (tool === undefined) throw new Error("web.fetch_page was not created");
	return { fetcher, tool, saved };
}

describe("web.fetch_page SSRF policy", () => {
	it.each([
		["plain http", "http://news.synthetic-wire.org/page"],
		["a URL with credentials", "https://admin:hunter2@news.synthetic-wire.org/"],
		["an IPv4 literal", "https://127.0.0.1/"],
		["a metadata IPv4 literal", "https://169.254.169.254/latest/meta-data/"],
		["an IPv6 literal", "https://[::1]/"],
		["a decimal IP literal", "https://2130706433/"],
		["localhost", "https://localhost/"],
		["a single-label name", "https://nas/"],
		["a non-default port", "https://news.synthetic-wire.org:8443/page"],
	])("refuses %s before any fetch", async (_label, url) => {
		const { fetcher, tool, saved } = setup();
		await expect(tool.execute({ url }, createToolContext())).resolves.toMatchObject({
			ok: false,
			error: { code: "UNSAFE_URL", retryable: false },
		});
		expect(fetcher.calls).toHaveLength(0);
		expect(saved).toHaveLength(0);
	});

	it("surfaces a fetcher refusal for a private address as a tool failure", async () => {
		const fetcher = createScriptedFetcher({
			"https://news.synthetic-wire.org/robots.txt": { text: "User-agent: *\nAllow: /" },
			"https://news.synthetic-wire.org/internal": {
				error: { code: "UNSAFE_URL", detail: "host resolves to a non-public address" },
			},
		});
		const saved: unknown[] = [];
		const [tool] = createWebTools({
			fetcher,
			hasher: webCryptoHasher,
			clock: fixedClock(),
			pageArchive: {
				async save(page) {
					saved.push(page);
					return { ok: true as const, value: { fileName: "archived.md" } };
				},
			},
			sleep: async () => {},
		});
		if (tool === undefined) throw new Error("web.fetch_page was not created");
		await expect(
			tool.execute({ url: "https://news.synthetic-wire.org/internal" }, createToolContext()),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "UNSAFE_URL", detail: "host resolves to a non-public address" },
		});
		expect(saved).toHaveLength(0);
	});
});
