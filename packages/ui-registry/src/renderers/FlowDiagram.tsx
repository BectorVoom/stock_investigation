import type { FlowDiagramProps } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { For, type JSX, Show } from "solid-js";
import type { RendererProps } from "../registry.tsx";
import { rendererMessages } from "./renderers.messages.tsx";

/**
 * An ordered flow of stages (ADR-0079): numbered cards joined by downward
 * arrows, top to bottom so it reads the same in the Chat column, a Notebook
 * widget and a phone. It is an ordered list, so assistive technology hears the
 * stages and their order; the arrows are decoration. Every diagram is the
 * model's own general knowledge, and the caption under it always says so.
 */
export function FlowDiagram(props: RendererProps<FlowDiagramProps>): JSX.Element {
	const m = useMessages(rendererMessages);
	const total = () => props.props.steps.length;
	return (
		<figure class="m-0 min-w-0" data-flow-diagram="true">
			<h3 class="text-sm font-semibold text-slate-900">{props.props.title}</h3>
			<ol class="mt-2 flex list-none flex-col items-stretch p-0">
				<For each={props.props.steps}>
					{(step, index) => (
						<li
							class="flex flex-col items-center"
							aria-label={m().flowDiagramStage(index() + 1, total())}
						>
							<Show when={index() > 0}>
								<svg
									aria-hidden="true"
									class="my-0.5 text-slate-600"
									width="12"
									height="16"
									viewBox="0 0 12 16"
									fill="none"
								>
									<path
										d="M6 1v12M2 9.5 6 13.5l4-4"
										stroke="currentColor"
										stroke-width="1.6"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</Show>
							<div class="flex w-full min-w-0 items-start gap-2.5 rounded border border-slate-200 bg-slate-50 px-3 py-2">
								<span
									aria-hidden="true"
									class="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-700 text-2xs font-semibold text-white tabular-nums"
								>
									{index() + 1}
								</span>
								<div class="min-w-0">
									<p class="text-sm font-semibold text-slate-900 wrap-anywhere">{step.label}</p>
									<Show when={step.detail}>
										{(detail) => (
											<p class="mt-0.5 text-xs text-slate-700 wrap-anywhere">{detail()}</p>
										)}
									</Show>
								</div>
							</div>
						</li>
					)}
				</For>
			</ol>
			<figcaption
				data-flow-diagram-basis="true"
				class="mt-2 inline-block rounded border border-dashed border-slate-500 px-1.5 py-px text-2xs font-medium leading-4 text-slate-800"
			>
				{m().flowDiagramBasis}
			</figcaption>
		</figure>
	);
}
