import { useMessages } from "@research/i18n/solid";
import { createMemo, ErrorBoundary, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { CannotRender } from "./parts/states.tsx";
import type { RenderContext, UiRegistry, WorkspaceComponent } from "./registry.tsx";
import { rendererMessages } from "./renderers/renderers.messages.tsx";

/**
 * Renders one workspace component through the registry. This view knows no
 * component types: a new type is a new registry entry (UI-010 / FR-013).
 * Unknown types, unsupported schema versions and invalid props render an
 * explicit fallback; nothing from the stored props reaches the DOM unvalidated.
 */
export function WorkspaceComponentView(props: {
	readonly component: WorkspaceComponent;
	readonly context: RenderContext;
	readonly registry: UiRegistry;
}): JSX.Element {
	const m = useMessages(rendererMessages);
	const resolved = createMemo(() => props.registry.resolve(props.component));
	const renderable = createMemo(() => {
		const current = resolved();
		return current.ok ? current : null;
	});
	const rejection = createMemo(() => {
		const current = resolved();
		return current.ok ? "INVALID_PROPS" : current.reason;
	});

	return (
		<article
			aria-label={m().componentLabel(props.component.componentId)}
			data-component-id={props.component.componentId}
			data-component-type={props.component.componentType}
			class="min-w-0"
		>
			<ErrorBoundary
				fallback={
					<CannotRender reason="RENDERER_FAILED" componentType={props.component.componentType} />
				}
			>
				<Show
					when={renderable()}
					fallback={
						<CannotRender
							reason={rejection()}
							componentType={props.component.componentType}
							schemaVersion={props.component.schemaVersion}
						/>
					}
				>
					{(current) => (
						<Dynamic
							component={current().renderer}
							componentId={props.component.componentId}
							props={current().props}
							context={props.context}
						/>
					)}
				</Show>
			</ErrorBoundary>
		</article>
	);
}
