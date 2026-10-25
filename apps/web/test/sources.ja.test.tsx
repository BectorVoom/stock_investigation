import { type NewsSource, newsSourceSchema } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { SourcesView } from "../src/sources/SourcesView.tsx";
import { createFakeBackend, type FakeBackend, jsonResponse } from "./fakeBackend.ts";

const SOURCE: NewsSource = newsSourceSchema.parse({
	sourceId: "src_1",
	canonicalUrl: "https://news.example.com/feed.xml",
	sourceType: "rss",
	title: "Example Energy News",
	publisher: "Example Media",
	licensePolicy: "headline-and-link-only",
	trustClassification: "trade-press",
	feedStatus: "failing",
	lastFetchedAt: "2026-10-05T03:00:00Z",
	lastErrorCode: "FETCH_TIMEOUT",
	lastErrorUpstreamStatus: null,
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-05T03:00:00Z",
});

const RECOMMENDED = {
	catalogId: "cat_1",
	title: "Official Statistics Feed",
	publisher: "Statistics Bureau",
	feedUrl: "https://stats.example.go.jp/feed.xml",
	homepageUrl: "https://stats.example.go.jp/",
	region: "JP",
	language: "ja",
	trustClassification: "official",
	licensePolicy: "headline-and-link-only",
	rationale: "Primary source for monthly production statistics.",
	feedCheckedOn: "2026-10-01",
};

const PREVIEW = {
	canonicalUrl: "https://feeds.example.org/energy.xml",
	sourceType: "atom",
	title: "Energy Wire",
	siteLink: null,
	suggestedPublisher: "",
	itemCount: 12,
	rejectedItemCount: 2,
	sampleItems: [],
	alreadySubscribed: false,
};

let backend: FakeBackend;

beforeEach(() => {
	backend = createFakeBackend();
	backend.on("GET", /^\/api\/v1\/sources$/, () => jsonResponse({ sources: [SOURCE] }));
	backend.on("GET", /^\/api\/v1\/sources\/recommended$/, () =>
		jsonResponse({ entries: [RECOMMENDED] }),
	);
	backend.on("GET", /^\/api\/v1\/articles$/, () =>
		jsonResponse({ articles: [], nextCursor: null }),
	);
	backend.on("POST", /^\/api\/v1\/sources\/preview$/, () => jsonResponse(PREVIEW));
});

afterEach(cleanup);

function mountJapanese() {
	render(() => (
		<LocaleProvider locale={() => "ja"}>
			<SourcesView api={createApiClient({ fetch: backend.fetch })} />
		</LocaleProvider>
	));
}

describe("Sources view in Japanese", () => {
	it("words the page, the enum values and the actions in Japanese, keeping content as it is", async () => {
		mountJapanese();
		const table = await screen.findByRole("table", { name: "購読中の情報源と最終取得の状況" });
		const row = within(table).getByRole("row", { name: /Example Energy News/ });
		// Stored values are worded, never translated in place: trade-press → 業界紙, failing → 取得失敗.
		expect(row.textContent).toContain("見出しとリンクのみ（抜粋は保存しません）; 業界紙");
		expect(row.querySelector('[data-field="feed-status"]')?.textContent).toContain("取得失敗");
		expect(row.textContent).toContain("最終取得: 2026-10-05 03:00 UTC");
		expect(row.textContent).toContain("最後のエラー: FETCH_TIMEOUT");
		expect(
			within(row).getByRole("button", { name: "「Example Energy News」を一時停止" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "今すぐニュースを更新" })).toBeTruthy();
		expect(screen.getByText("まだ取り込んだ記事はありません。", { exact: false })).toBeTruthy();

		// The recommended catalog's own title, publisher and rationale stay as the server sent them.
		const entry = await screen.findByText("Primary source for monthly production statistics.");
		expect(entry).toBeTruthy();
		expect(screen.getByRole("button", { name: "「Official Statistics Feed」を購読" })).toBeTruthy();
		expect(document.body.textContent).toContain("JP · ja · 公式 · 既定のライセンス:");
	});

	it("states the feed host's answer status beside the last error in Japanese", async () => {
		backend.on("GET", /^\/api\/v1\/sources$/, () =>
			jsonResponse({
				sources: [{ ...SOURCE, lastErrorCode: "HTTP_ERROR", lastErrorUpstreamStatus: 403 }],
			}),
		);
		mountJapanese();
		const table = await screen.findByRole("table", { name: "購読中の情報源と最終取得の状況" });
		const row = within(table).getByRole("row", { name: /Example Energy News/ });
		expect(row.textContent).toContain("最後のエラー: HTTP_ERROR（サービスの応答: HTTP 403）");
	});

	it("previews a source with Japanese labels and counts", async () => {
		mountJapanese();
		await screen.findByRole("table");
		fireEvent.input(screen.getByLabelText("フィードまたはサイトの URL"), {
			target: { value: "https://feeds.example.org/energy.xml" },
		});
		fireEvent.click(screen.getByRole("button", { name: "プレビュー" }));
		const preview = await screen.findByRole("region", { name: "情報源のプレビュー" });
		expect(preview.textContent).toContain("プレビュー: Energy Wire");
		expect(preview.querySelector('[data-field="rejected-count"]')?.textContent).toBe(
			"2（安全でないリンクや不正なリンクは保存しません）",
		);
		expect(preview.textContent).toContain("フィードに記載なし");
		expect(within(preview).getByRole("button", { name: "この情報源を購読" })).toBeTruthy();
	});
});
