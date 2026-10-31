/**
 * The Cloudflare Access key set documented in
 * docs/external-apis/apis/cloudflare-access.md is accepted by the same `jose`
 * function the Worker's remote key set uses to parse a fetched set.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLocalJWKSet } from "../../apps/api/test/joseForDocExamples.ts";
import { docExampleJson } from "../../packages/adapters/test/docExamples.ts";

describe("Cloudflare Access documented examples", () => {
	it("parses the documented key set and resolves its RS256 key by kid", async () => {
		const body = docExampleJson("cloudflare-access", "cloudflare-access-certs");
		const keySet = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) }).parse(body);
		const keys = createLocalJWKSet(keySet);
		const key = await keys({
			alg: "RS256",
			kid: "3927eca979364ff16db41a2031f635466b5d5f392a25f88f328f86f37db66f08",
		});
		expect(key).toBeDefined();
	});
});
