import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { LoginPage } from "../src/auth/LoginPage.tsx";
import { initialServerState, installWorkspaceRoutes, mountApp } from "./appHarness.tsx";
import { createFakeBackend, errorResponse, jsonResponse } from "./fakeBackend.ts";

afterEach(() => {
	cleanup();
	window.localStorage.removeItem("research.locale");
});

it("renders Loading… while the administrator session check is in flight", async () => {
	let resolveSession: ((response: Response) => void) | undefined;
	const backend = createFakeBackend();
	backend.on(
		"GET",
		/^\/api\/v1\/session$/,
		() =>
			new Promise<Response>((resolve) => {
				resolveSession = resolve;
			}),
	);
	mountApp(backend);
	expect(screen.getByRole("heading", { level: 1, name: "Administrator login" })).toBeDefined();
	const status = screen.getByRole("status");
	expect(status.getAttribute("aria-busy")).toBe("true");
	expect(status.textContent).toBe("Loading…");
	expect(screen.queryByRole("navigation")).toBeNull();
	expect(backend.requests).toHaveLength(1);
	resolveSession?.(errorResponse(401, "UNAUTHENTICATED", "Sign in required."));
	expect(
		await screen.findByRole("button", { name: "Sign in with Cloudflare Access" }),
	).toBeDefined();
});

it("shows administrator login and makes no workspace requests when unauthenticated", async () => {
	const backend = createFakeBackend();
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		errorResponse(401, "UNAUTHENTICATED", "Sign in required."),
	);
	mountApp(backend);
	const login = await screen.findByRole("button", { name: "Sign in with Cloudflare Access" });
	expect(login).toBeDefined();
	expect(screen.queryByRole("navigation")).toBeNull();
	expect(backend.requests).toHaveLength(1);
});

it("calls signIn when the administrator clicks Sign in with Cloudflare Access", () => {
	const signIn = vi.fn();
	render(() => (
		<LocaleProvider locale={() => "en"}>
			<LoginPage
				state={{
					status: "error",
					error: {
						kind: "api",
						code: "UNAUTHENTICATED",
						status: 401,
						message: "Sign in required.",
						detail: null,
						issues: [],
						upstreamStatus: null,
					},
				}}
				retry={() => Promise.resolve()}
				signIn={signIn}
			/>
		</LocaleProvider>
	));
	fireEvent.click(screen.getByRole("button", { name: "Sign in with Cloudflare Access" }));
	expect(signIn).toHaveBeenCalledTimes(1);
});

it("refuses a non-administrator and offers sign out", async () => {
	const backend = createFakeBackend();
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		errorResponse(403, "FORBIDDEN", "Not the owner."),
	);
	mountApp(backend);
	expect(
		(await screen.findByRole("link", { name: "Sign out of Cloudflare Access" })).getAttribute(
			"href",
		),
	).toBe("/cdn-cgi/access/logout");
	expect(screen.getByRole("alert").textContent).toBe(
		"This account is not the administrator. Sign out and use the configured administrator account.",
	);
	expect(screen.queryByRole("navigation")).toBeNull();
	expect(backend.requests).toHaveLength(1);
});

it("retries a failed session check and opens the workspace after confirmation", async () => {
	const backend = createFakeBackend();
	installWorkspaceRoutes(backend, initialServerState());
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		errorResponse(503, "AUTH_KEYS_UNAVAILABLE", "Keys unavailable."),
	);
	mountApp(backend);
	const retry = await screen.findByRole("button", { name: "Retry" });
	expect(screen.getByRole("alert").textContent).toBe(
		"The session could not be verified. Retry, or ask the administrator to check the Cloudflare Access configuration.",
	);
	expect(screen.queryByRole("navigation")).toBeNull();
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		jsonResponse({
			ownerId: "admin@example.com",
			authMode: "cloudflare-access",
			environment: "production",
		}),
	);
	fireEvent.click(retry);
	expect(await screen.findByRole("navigation", { name: "Views" })).toBeDefined();
});

it("renders the administrator login states in Japanese when the locale is ja", async () => {
	window.localStorage.setItem("research.locale", "ja");
	const backend = createFakeBackend();
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		errorResponse(401, "UNAUTHENTICATED", "Sign in required."),
	);
	mountApp(backend);
	expect(screen.getByRole("heading", { level: 1, name: "管理者ログイン" })).toBeDefined();
	expect(screen.getByRole("status").textContent).toBe("読み込み中…");
	expect(await screen.findByRole("button", { name: "Cloudflare Access でログイン" })).toBeDefined();

	cleanup();
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		errorResponse(403, "FORBIDDEN", "Not the owner."),
	);
	mountApp(backend);
	expect(
		(await screen.findByRole("link", { name: "Cloudflare Access からログアウト" })).getAttribute(
			"href",
		),
	).toBe("/cdn-cgi/access/logout");
	expect(screen.getByRole("alert").textContent).toContain("このアカウントは管理者ではありません。");

	cleanup();
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		errorResponse(503, "AUTH_KEYS_UNAVAILABLE", "Keys unavailable."),
	);
	mountApp(backend);
	expect(await screen.findByRole("button", { name: "再試行" })).toBeDefined();
	expect(screen.getByRole("alert").textContent).toContain("セッションを確認できませんでした。");
});
