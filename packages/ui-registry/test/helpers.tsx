import { render } from "@solidjs/testing-library";
import {
	createBaselineUiRegistry,
	type RenderContext,
	type UiRegistry,
	type WorkspaceComponent,
	WorkspaceComponentView,
} from "../src/index.ts";
import { makeContext } from "./fixtures.ts";

const BASELINE_REGISTRY = createBaselineUiRegistry();

export function renderComponent(
	workspaceComponent: WorkspaceComponent,
	contextOverrides: Partial<RenderContext> = {},
	registry: UiRegistry = BASELINE_REGISTRY,
): HTMLElement {
	const context = makeContext(contextOverrides);
	return render(() => (
		<WorkspaceComponentView component={workspaceComponent} context={context} registry={registry} />
	)).container;
}

export function texts(root: ParentNode, selector: string): string[] {
	return [...root.querySelectorAll(selector)].map((element) => element.textContent ?? "");
}

/** Every anchor must be an https link that opens safely in a new tab. */
export function expectOnlySafeLinks(root: ParentNode): HTMLAnchorElement[] {
	const anchors = [...root.querySelectorAll("a")];
	for (const anchor of anchors) {
		const href = anchor.getAttribute("href");
		if (href === null || !href.startsWith("https://")) {
			throw new Error(`unsafe or missing href: ${String(href)}`);
		}
		if (anchor.getAttribute("target") !== "_blank") throw new Error("link must open in a new tab");
		if (anchor.getAttribute("rel") !== "noopener noreferrer") {
			throw new Error("link must carry rel=noopener noreferrer");
		}
	}
	return anchors;
}
