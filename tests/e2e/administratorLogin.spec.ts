import { expect, test } from "@playwright/test";

/** Browser gate behavior; authorization itself remains covered by API security tests. */
test("localhost opens the workspace with the real automatic session", async ({ page }) => {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/#/settings");
	await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
	// In particular, schema construction must not probe eval under strict CSP.
	expect(errors).toEqual([]);
	await expect(page.locator('[data-field="session-summary"]')).toContainText("Signed in as");
	await expect(page.getByRole("heading", { name: "Administrator login" })).toHaveCount(0);
});

for (const code of ["UNAUTHENTICATED", "FORBIDDEN"] as const) {
	test(`${code} hides the workspace and its data requests`, async ({ page }) => {
		const requests: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
		});
		await page.route("**/api/v1/session", (route) =>
			route.fulfill({
				status: code === "UNAUTHENTICATED" ? 401 : 403,
				contentType: "application/json",
				body: JSON.stringify({ error: { code, message: "Administrator sign-in required." } }),
			}),
		);
		await page.goto("/#/settings");
		await expect(page.getByRole("heading", { name: "Administrator login" })).toBeVisible();
		await expect(page.getByRole("navigation")).toHaveCount(0);
		if (code === "UNAUTHENTICATED") {
			await expect(
				page.getByRole("button", { name: "Sign in with Cloudflare Access" }),
			).toBeVisible();
		} else {
			await expect(page.getByRole("alert")).toContainText("not the administrator");
			await expect(
				page.getByRole("link", { name: "Sign out of Cloudflare Access" }),
			).toHaveAttribute("href", "/cdn-cgi/access/logout");
		}
		expect(requests.map((url) => new URL(url).pathname)).toEqual(["/api/v1/session"]);
		if (code === "UNAUTHENTICATED") {
			const destination = page.url();
			const navigation = page.waitForRequest(
				(request) => request.isNavigationRequest() && request.url() === destination.split("#")[0],
			);
			await page.getByRole("button", { name: "Sign in with Cloudflare Access" }).click();
			await navigation;
			await expect(page).toHaveURL(destination);
		}
	});
}

test("a failed verification can retry and open the original page with a real session", async ({
	page,
}) => {
	await page.route("**/api/v1/session", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				error: { code: "AUTH_KEYS_UNAVAILABLE", message: "Keys unavailable." },
			}),
		}),
	);
	await page.goto("/#/settings");
	await expect(page.getByRole("alert")).toContainText("session could not be verified");
	await expect(page.getByRole("navigation")).toHaveCount(0);
	await page.unroute("**/api/v1/session");
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Administrator login" })).toHaveCount(0);
});
