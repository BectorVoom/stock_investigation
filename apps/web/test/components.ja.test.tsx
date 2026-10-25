import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createRoot, type JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { clientFailureMessages } from "../src/api/errors.messages.ts";
import { translatedFailureMessage } from "../src/api/errorText.ts";
import { type ApiFailure, CLIENT_ERROR_CODES } from "../src/api/http.ts";
import { SpendField } from "../src/components/SpendField.tsx";
import { ErrorNotice, RemoteView } from "../src/components/ui.tsx";
import { sessionMessages } from "../src/lib/session.messages.ts";
import { createWorkspaceSession, type WorkspaceSession } from "../src/lib/session.ts";
import { defaultSpendDraft } from "../src/settings/agentSettingsModel.ts";
import { initialServerState, installWorkspaceRoutes } from "./appHarness.tsx";
import { createFakeBackend, deferred, errorResponse, jsonResponse } from "./fakeBackend.ts";
import { makeRun, WORKSPACE_ID } from "./fixtures.ts";

afterEach(cleanup);

function inJapanese(content: () => JSX.Element) {
	return render(() => <LocaleProvider locale={() => "ja"}>{content()}</LocaleProvider>);
}

function failure(overrides: Partial<ApiFailure>): ApiFailure {
	return {
		kind: "api",
		code: "INTERNAL",
		status: 500,
		message: "Internal error.",
		detail: null,
		issues: [],
		...overrides,
	};
}

function alertParts() {
	const alert = screen.getByRole("alert");
	const code = alert.querySelector("[data-error-code]");
	if (!(code instanceof HTMLElement)) throw new Error("no code element");
	return { alert, code };
}

describe("ErrorNotice in Japanese (ADR-0032 decision 8)", () => {
	it("words a server code by its description and keeps the server's message as the code's tooltip", () => {
		inJapanese(() => (
			<ErrorNotice
				failure={failure({
					code: "VERSION_CONFLICT",
					status: 409,
					message: "The workspace changed; reload and try again.",
				})}
				onRetry={() => {}}
			/>
		));
		const { alert, code } = alertParts();
		expect(alert.textContent).toContain(
			"VERSION_CONFLICT: 読み込んだ後に内容が変わりました。再読み込みしてから再試行してください。",
		);
		expect(alert.textContent).not.toContain("reload and try again");
		expect(code.title).toBe("The workspace changed; reload and try again.");
		expect(screen.getByRole("button", { name: "再試行" })).toBeTruthy();
	});

	it("words the client's own failure with its values", async () => {
		const api = createApiClient({
			fetch: () => Promise.reject(new Error("Failed to fetch")),
		});
		const result = await api.listWorkspaces();
		if (result.ok) throw new Error("expected a failure");
		inJapanese(() => <ErrorNotice failure={result.error} />);
		const { alert, code } = alertParts();
		expect(alert.textContent).toContain(
			"NETWORK_ERROR: リクエストを完了できませんでした（Failed to fetch）。",
		);
		expect(code.title).toBe("The request could not be completed (Failed to fetch).");
	});

	it("falls back to the message for an unknown code, and for a client code the caller worded", () => {
		inJapanese(() => (
			<>
				<ErrorNotice
					failure={{
						code: "GOOGLE_TOKEN_REVOKED",
						message: "Google の許可が取り消されました。",
						detail: null,
						issues: [],
					}}
				/>
				<ErrorNotice
					failure={failure({
						kind: "invalid-request",
						code: "INVALID_REQUEST",
						status: null,
						message: "ファイルが有効な JSON ではありません。",
					})}
				/>
			</>
		));
		const [unknown, worded] = screen.getAllByRole("alert");
		expect(unknown?.textContent).toBe("GOOGLE_TOKEN_REVOKED: Google の許可が取り消されました。");
		expect(unknown?.querySelector("[data-error-code]")?.hasAttribute("title")).toBe(false);
		expect(worded?.textContent).toBe("INVALID_REQUEST: ファイルが有効な JSON ではありません。");
	});

	it("names the validation issues list in Japanese", () => {
		inJapanese(() => (
			<ErrorNotice
				failure={failure({
					kind: "invalid-response",
					code: "INVALID_RESPONSE",
					message: clientFailureMessages.en.responseInvalid,
					issues: ["title: Required"],
				})}
			/>
		));
		expect(screen.getByRole("list", { name: "検証エラー" }).textContent).toBe("title: Required");
		expect(screen.getByRole("alert").textContent).toContain(
			"サーバーの応答が API の契約に合いません。",
		);
	});

	it("renders English exactly as before, with no tooltip", () => {
		render(() => (
			<ErrorNotice failure={failure({ code: "NOT_FOUND", message: "Workspace not found." })} />
		));
		const { alert, code } = alertParts();
		expect(alert.textContent).toBe("NOT_FOUND: Workspace not found.");
		expect(code.hasAttribute("title")).toBe(false);
	});
});

describe("translatedFailureMessage", () => {
	it("reads every client sentence back with its values", () => {
		const en = clientFailureMessages.en;
		const ja = clientFailureMessages.ja;
		const cases: readonly (readonly [string, string])[] = [
			[en.requestInvalid, ja.requestInvalid],
			[en.responseInvalid, ja.responseInvalid],
			[en.responseNotJson, ja.responseNotJson],
			[en.unexpectedStatus(502), ja.unexpectedStatus(502)],
			[en.timeout(20), ja.timeout(20)],
			[en.requestFailed("network error"), ja.requestFailed("network error")],
			[en.responseIncomplete("aborted"), ja.responseIncomplete("aborted")],
			[en.markdownContentType("text/html"), ja.markdownContentType("text/html")],
			[en.markdownContentType(""), ja.markdownContentType("")],
			[en.calendarContentType("text/plain"), ja.calendarContentType("text/plain")],
		];
		for (const [message, expected] of cases) {
			const translated = CLIENT_ERROR_CODES.map((code) =>
				translatedFailureMessage({ code, message }, "ja"),
			);
			expect(translated.every((text) => text === expected)).toBe(true);
		}
		expect(translatedFailureMessage({ code: "TIMEOUT", message: en.timeout(5) }, "en")).toBeNull();
	});
});

describe("RemoteView and SpendField in Japanese", () => {
	it("composes the caller's label into the loading and failure sentences", () => {
		inJapanese(() => (
			<>
				<RemoteView remote={{ status: "loading" }} label="セッション" onRetry={() => {}}>
					{() => <p>ready</p>}
				</RemoteView>
				<RemoteView
					remote={{ status: "error", error: failure({}) }}
					label="ワークスペース"
					onRetry={() => {}}
				>
					{() => <p>ready</p>}
				</RemoteView>
			</>
		));
		expect(screen.getByText("セッションを読み込み中…")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain(
			"ワークスペースを読み込めませんでした。 INTERNAL: サーバー内部でエラーが発生しました。",
		);
	});

	it("states the spend ceiling and the consent in Japanese", () => {
		inJapanese(() => (
			<SpendField draft={defaultSpendDraft()} onChange={() => {}} spendConsentRequired={true} />
		));
		expect(screen.getByLabelText("最大支出額（USD）")).toBeTruthy();
		expect(
			screen.getByText(/空欄の場合、支出額の上限はありません。設定できる上限は \d+ です/),
		).toBeTruthy();
		expect(
			screen.getByText("この実行で、上記の最大額までの従量課金の支出に同意します"),
		).toBeTruthy();
	});
});

describe("workspace session notices in Japanese", () => {
	let dispose: () => void = () => {};
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		dispose();
		vi.useRealTimers();
	});

	it("words its notices with the table it is given, and a new retry clears the retry's failure", async () => {
		const backend = createFakeBackend();
		const server = initialServerState();
		server.runs = [makeRun({ runId: "run_9", state: "failed" })];
		installWorkspaceRoutes(backend, server);
		const session: WorkspaceSession = createRoot((disposeRoot) => {
			dispose = disposeRoot;
			return createWorkspaceSession(
				createApiClient({ fetch: backend.fetch }),
				WORKSPACE_ID,
				{ isVisible: () => true, subscribe: () => () => {} },
				() => sessionMessages.ja,
			);
		});
		await vi.advanceTimersByTimeAsync(0);

		backend.on("POST", /\/run_9\/retry$/, () => errorResponse(409, "ILLEGAL_TRANSITION", "No."));
		await session.retryRun("run_9");
		expect(session.notice()?.text).toBe("実行を再試行できませんでした。");

		const slowRetry = deferred<Response>();
		backend.on("POST", /\/run_9\/retry$/, () => slowRetry.promise);
		const retrying = session.retryRun("run_9");
		expect(session.notice()).toBeNull();
		slowRetry.resolve(jsonResponse({ run: makeRun({ runId: "run_9", state: "pending" }) }));
		await retrying;

		await session.cancelRun("run_missing");
		expect(session.notice()?.text).toBe("実行をキャンセルできませんでした。");
	});
});
