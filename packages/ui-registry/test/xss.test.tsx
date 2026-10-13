import type { Dataset, Evidence } from "@research/contracts";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderContext, WorkspaceComponent } from "../src/index.ts";
import { safeHttpsUrl } from "../src/index.ts";
import { BASELINE_TYPES, type BaselineType, component } from "./fixtures.ts";
import { renderComponent } from "./helpers.tsx";

afterEach(cleanup);

const SCRIPT = "<script>globalThis.__xss = 'script'</script>";
const IMG = "<img src=x onerror=\"globalThis.__xss = 'img'\">";
const JS_URL = "javascript:globalThis.__xss='url'";
const HOSTILE = `${SCRIPT}${IMG}`;

/**
 * These records deliberately violate the contract schemas (the server would
 * reject them). The renderers must stay inert even if such data reached them.
 */
const hostileEvidence: Evidence = {
	evidenceId: "ev_x",
	sourceUrl: JS_URL,
	title: HOSTILE,
	publisher: IMG,
	publishedAt: SCRIPT,
	retrievedAt: "2026-10-01T00:00:00Z",
	effectiveAt: null,
	excerpt: HOSTILE,
	checksum: "c".repeat(64),
	sourceClass: "other",
};

const dataUrlEvidence: Evidence = {
	...hostileEvidence,
	evidenceId: "ev_data",
	sourceUrl: "data:text/html,<script>globalThis.__xss='data'</script>",
};

const httpEvidence: Evidence = {
	...hostileEvidence,
	evidenceId: "ev_http",
	sourceUrl: "http://insecure.example.com/",
};

const hostileDataset: Dataset = {
	datasetId: "ds_x",
	title: HOSTILE,
	createdAt: "2026-10-01T00:00:00Z",
	columns: [
		{ key: "label", label: SCRIPT, kind: "text" },
		{ key: "value", label: IMG, kind: "number", unit: SCRIPT },
		{ key: "o", label: "Open", kind: "number", unit: IMG },
		{ key: "h", label: "High", kind: "number", unit: IMG },
		{ key: "l", label: "Low", kind: "number", unit: IMG },
		{ key: "c", label: "Close", kind: "number", unit: IMG },
	],
	rows: [
		{
			label: { v: HOSTILE, sourceId: "ev_x", asOf: SCRIPT },
			value: { v: 10, sourceId: "ev_x", asOf: "2026-09-30" },
			o: { v: 1 },
			h: { v: 3 },
			l: { v: 1 },
			c: { v: 2 },
		},
		{
			label: { v: JS_URL },
			value: { v: null, reason: HOSTILE },
			o: { v: 2 },
			h: { v: 4 },
			l: { v: 1 },
			c: { v: 1 },
		},
	],
};

const hostileContext: Partial<RenderContext> = {
	datasets: new Map([[hostileDataset.datasetId, hostileDataset]]),
	sources: new Map(
		[hostileEvidence, dataUrlEvidence, httpEvidence].map((e) => [e.evidenceId, e] as const),
	),
};

const SOURCE_IDS = ["ev_x", "ev_data", "ev_http"];

/** Props that pass each schema (they are just strings) but carry markup payloads. */
const HOSTILE_PROPS: { readonly [T in BaselineType]: WorkspaceComponent["props"] } = {
	"data-table": { title: HOSTILE, datasetRef: "ds_x", sourceIds: SOURCE_IDS, caption: HOSTILE },
	"financial-table": {
		title: HOSTILE,
		datasetRef: "ds_x",
		sourceIds: SOURCE_IDS,
		methodologyNote: HOSTILE,
	},
	"line-chart": {
		title: HOSTILE,
		datasetRef: "ds_x",
		xKey: "label",
		series: [
			{ key: "value", label: SCRIPT },
			{ key: "o", label: IMG },
		],
		xLabel: SCRIPT,
		yLabel: IMG,
		yUnit: "<b>unit</b>",
		sourceIds: SOURCE_IDS,
	},
	"bar-chart": {
		title: HOSTILE,
		datasetRef: "ds_x",
		categoryKey: "label",
		series: [
			{ key: "value", label: SCRIPT },
			{ key: "o", label: IMG },
		],
		xLabel: SCRIPT,
		yLabel: IMG,
		yUnit: "<b>unit</b>",
		sourceIds: SOURCE_IDS,
	},
	"candlestick-chart": {
		title: HOSTILE,
		datasetRef: "ds_x",
		dateKey: "label",
		openKey: "o",
		highKey: "h",
		lowKey: "l",
		closeKey: "c",
		priceUnit: "<b>unit</b>",
		sourceIds: SOURCE_IDS,
	},
	"news-card": { headline: HOSTILE, sourceId: "ev_x", summary: HOSTILE },
	"source-list": { title: HOSTILE, sourceIds: SOURCE_IDS },
	"company-profile": {
		companyName: HOSTILE,
		ticker: "X",
		exchange: SCRIPT.slice(0, 20),
		country: "US",
		productsOrServices: [SCRIPT, IMG],
		businessExposure: HOSTILE,
		datasetRef: "ds_x",
		sourceIds: SOURCE_IDS,
	},
	"research-report": {
		title: HOSTILE,
		generatedAt: "2026-10-05T12:00:00Z",
		dataCutoffAt: "2026-10-04T00:00:00Z",
		sections: [
			{
				heading: HOSTILE,
				statements: [
					{
						text: HOSTILE,
						claimId: "claim_x",
						claimType: "observation",
						status: "supported",
						sourceIds: SOURCE_IDS,
					},
					{ text: JS_URL, claimId: null, claimType: null, status: null, sourceIds: [] },
				],
			},
		],
		disclaimer: HOSTILE,
	},
};

function readXssFlag(): unknown {
	return Reflect.get(globalThis, "__xss");
}

describe.each(
	BASELINE_TYPES,
)("XSS: %s treats agent and source strings as inert text", (componentType) => {
	it("creates no script, image, event-handler or non-https link from data", () => {
		const container = renderComponent(
			component(componentType, HOSTILE_PROPS[componentType]),
			hostileContext,
		);

		// The fixture really rendered (not a fallback), so the assertions below are meaningful.
		expect(container.querySelector("[data-fallback]")).toBeNull();
		expect(container.textContent).toContain("<script>");

		expect(container.querySelectorAll("script")).toHaveLength(0);
		expect(container.querySelectorAll("img")).toHaveLength(0);
		expect(container.querySelectorAll("iframe, object, embed, b")).toHaveLength(0);
		for (const element of container.querySelectorAll("*")) {
			for (const attribute of element.getAttributeNames()) {
				expect(attribute.startsWith("on")).toBe(false);
			}
		}
		for (const anchor of container.querySelectorAll("a")) {
			expect(anchor.getAttribute("href")).toMatch(/^https:\/\//);
		}
		expect(container.querySelectorAll("[href^='javascript:'], [src^='javascript:']")).toHaveLength(
			0,
		);
		expect(container.querySelectorAll("[href^='data:'], [src^='data:']")).toHaveLength(0);
		expect(container.querySelectorAll("[href^='http:'], [src^='http:']")).toHaveLength(0);
		expect(readXssFlag()).toBeUndefined();
	});
});

describe("XSS: links", () => {
	it("shows a javascript:, data: or http: source as text marked link unavailable", () => {
		const container = renderComponent(
			component("source-list", HOSTILE_PROPS["source-list"]),
			hostileContext,
		);
		expect(container.querySelectorAll("a")).toHaveLength(0);
		expect(container.querySelectorAll("[data-link-unavailable]")).toHaveLength(3);
		expect(container.textContent).toContain("(link unavailable)");
		// The hostile title is visible as literal text.
		expect(container.textContent).toContain(SCRIPT);
	});

	it("unknown component types never echo props into the DOM as markup", () => {
		const container = renderComponent(
			component("made-up-type", { html: HOSTILE, url: JS_URL }),
			hostileContext,
		);
		expect(container.querySelector('[data-fallback="UNKNOWN_COMPONENT_TYPE"]')).not.toBeNull();
		expect(container.querySelectorAll("script, img, a")).toHaveLength(0);
		expect(container.textContent).not.toContain("globalThis.__xss");
	});
});

describe("safeHttpsUrl", () => {
	it.each([
		["https://example.com/a?b=1#c", "https://example.com/a?b=1#c"],
		["HTTPS://EXAMPLE.com", "https://example.com/"],
	])("accepts %s", (input, expected) => {
		expect(safeHttpsUrl(input)).toBe(expected);
	});

	it.each([
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		" javascript:alert(1)",
		"data:text/html,<script>1</script>",
		"http://example.com/",
		"//example.com/x",
		"/relative/path",
		"vbscript:msgbox(1)",
		"blob:https://example.com/uuid",
		"https://user:secret@example.com/",
		"not a url",
		"",
	])("rejects %s", (input) => {
		expect(safeHttpsUrl(input)).toBeNull();
	});
});
