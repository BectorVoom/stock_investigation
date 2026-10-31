import type { MarketSeries } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createSignal, For, Show } from "solid-js";
import { materialDetailsMessages } from "./materialDetails.messages.ts";

export function MaterialDetails(props: { readonly series: MarketSeries }) {
	const m = useMessages(materialDetailsMessages);
	const [open, setOpen] = createSignal(false);
	return (
		<Show when={props.series.materialDetails}>
			{(details) => (
				<details
					class="mt-1 max-w-full whitespace-normal text-xs"
					onToggle={(event) => setOpen(event.currentTarget.open)}
				>
					<summary>{m().details}</summary>
					<Show when={open()}>
						<p class="mb-1">
							{details().product} · {details().grade} · {details().basis} · {details().sourceId}
						</p>
						<div class="overflow-x-auto">
							<table class="border-collapse text-left">
								<thead>
									<tr>
										<th scope="col" class="py-1 pr-3 font-medium">
											{m().date}
										</th>
										<th scope="col" class="py-1 pr-3 font-medium">
											{m().exactValue}
										</th>
										<th scope="col" class="py-1 pr-3 font-medium">
											{m().sourceUpdated}
										</th>
									</tr>
								</thead>
								<tbody>
									<For each={props.series.materialObservations ?? []}>
										{(point) => (
											<tr>
												<td class="whitespace-nowrap py-0.5 pr-3">{point.observedOn}</td>
												<td class="whitespace-nowrap py-0.5 pr-3">
													{point.valueDecimal} {props.series.unit}
												</td>
												<td class="whitespace-nowrap py-0.5 pr-3">
													{point.materialsSourceUpdatedAt ?? m().unknown}
												</td>
											</tr>
										)}
									</For>
								</tbody>
							</table>
						</div>
					</Show>
				</details>
			)}
		</Show>
	);
}
