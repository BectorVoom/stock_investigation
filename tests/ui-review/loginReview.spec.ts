import { expect, test } from "@playwright/test";

for (const width of [390, 1440]) {
	test(`administrator login at ${width}px`, async ({ page }, testInfo) => {
		let forbidden = false;
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/api/v1/session", (route) =>
			route.fulfill({
				status: forbidden ? 403 : 401,
				contentType: "application/json",
				body: JSON.stringify({
					error: {
						code: forbidden ? "FORBIDDEN" : "UNAUTHENTICATED",
						message: "Sign in required.",
					},
				}),
			}),
		);
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "Administrator login" })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Sign in with Cloudflare Access" }),
		).toBeVisible();
		await expect(page.getByRole("navigation")).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: testInfo.outputPath("login.png"), fullPage: true });
		forbidden = true;
		await page.reload();
		await expect(page.getByRole("alert")).toContainText("not the administrator");
		await expect(page.getByRole("link", { name: "Sign out of Cloudflare Access" })).toHaveAttribute(
			"href",
			"/cdn-cgi/access/logout",
		);
		await page.screenshot({ path: testInfo.outputPath("forbidden.png"), fullPage: true });
		expect(errors).toEqual([]);
	});
}
