import { err, ok } from "@research/domain";
import { createApp } from "../../apps/api/src/app.ts";
import type { Env } from "../../apps/api/src/env.ts";
import { fixtureFetcher } from "./fixtures.ts";

/**
 * E2E Worker entry: the production app with one seam replaced — outbound
 * fetches are served from fixtures so the browser test needs no network.
 *
 * Local-dev auth fixes a single owner, but the upgrade test needs an owner
 * that never saved settings while the first test saves them. `X-E2E-Owner`
 * selects the owner for that request (test-only; the header never exists in
 * production). Requests without it reach the production local-dev path
 * untouched.
 */
const E2E_OWNER_HEADER = "X-E2E-Owner";

const defaultApp = createApp({ overrides: { fetcher: fixtureFetcher } });

const secondOwnerApp = createApp({
	overrides: {
		fetcher: fixtureFetcher,
		ownerAuthenticator: (request) => {
			const e2eOwner = request.headers.get(E2E_OWNER_HEADER)?.trim().toLowerCase();
			if (e2eOwner === null || e2eOwner === undefined || e2eOwner === "" || e2eOwner.length > 254) {
				return Promise.resolve(err("UNAUTHENTICATED"));
			}
			return Promise.resolve(ok({ ownerId: e2eOwner, authMode: "local-dev" as const }));
		},
	},
});

export default {
	fetch(request: Request, env: Env): Response | Promise<Response> {
		const routed = request.headers.get(E2E_OWNER_HEADER) === null ? defaultApp : secondOwnerApp;
		return routed.fetch(request, env);
	},
};
