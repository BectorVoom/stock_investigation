import type {
	EquityFilingView,
	EquityMetricCell,
	EquityRevisionsResponse,
} from "@research/contracts";
import type { EquityMetricCode } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, ErrorNotice, Loading } from "../components/ui.tsx";
import { formatExactAmount, formatPeriodEnd } from "./financialFormat.ts";
import { financialsMessages } from "./financials.messages.ts";
import { isRevised } from "./statementModel.ts";

/** The value a dialog shows: one metric of one company in one fiscal year. */
export interface ValueDetails {
	readonly companyId: string;
	readonly metric: EquityMetricCode;
	readonly cell: EquityMetricCell;
	/** The filing the value comes from, when the answer cited it. */
	readonly filing: EquityFilingView | null;
}

const DT = "text-xs font-medium text-slate-700";
const DD = "text-sm text-slate-900";

/**
 * One value's details (ADR-0048 §5, §8): the exact amount in base units, its
 * period end, source concept and scope, the filing it comes from (a link to
 * SEC or EDINET), and — for a value filings reported differently — every
 * as-filed value with its filing, read once from the revisions API. A native
 * modal dialog: focus moves to Close on open, Escape or Close closes, and
 * focus returns to the value that opened it.
 */
export function ValueDetailsDialog(props: {
	readonly api: ApiClient;
	readonly details: ValueDetails;
	readonly opener: HTMLElement | null;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(financialsMessages);
	const locale = useLocale();
	const headingId = createUniqueId();
	const [revisions, setRevisions] = createSignal<EquityRevisionsResponse | null>(null);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [loading, setLoading] = createSignal(false);
	let dialog: HTMLDialogElement | undefined;
	let closeButton: HTMLButtonElement | undefined;
	let disposed = false;

	const cell = () => props.details.cell;
	const year = () => m().fiscalYear(cell().fiscalYear);
	const close = (): void => {
		props.onClose();
		props.opener?.focus();
	};

	const loadRevisions = async (): Promise<void> => {
		setLoading(true);
		setFailure(null);
		const answer = await props.api.getEquityRevisions(
			props.details.companyId,
			props.details.metric,
			cell().fiscalYear,
		);
		if (disposed) return;
		setLoading(false);
		if (answer.ok) setRevisions(answer.value);
		else setFailure(answer.error);
	};

	onMount(() => {
		dialog?.showModal();
		closeButton?.focus();
		if (isRevised(cell())) void loadRevisions();
	});
	onCleanup(() => {
		disposed = true;
		if (dialog?.open === true) dialog.close();
	});

	const filingOf = (filingId: string): EquityFilingView | null =>
		revisions()?.filings.find((filing) => filing.filingId === filingId) ?? null;

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			class="m-auto w-full max-w-xl rounded bg-slate-100 p-4"
			data-value-details=""
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<h3 id={headingId} class="text-base font-semibold text-slate-900">
				{m().detailsHeading(m().metric(props.details.metric), year())}
			</h3>
			<dl class="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
				<Show
					when={cell().valueDecimal}
					fallback={
						<>
							<dt class={DT}>{m().exactValue}</dt>
							<dd class={DD}>
								<span data-unavailable="true" class="italic text-slate-600">
									{m().reason(cell().unavailableReason ?? "not-reported")}
								</span>
							</dd>
						</>
					}
				>
					{(value) => (
						<>
							<dt class={DT}>{m().exactValue}</dt>
							<dd class={`${DD} tabular-nums`} data-field="exact-value">
								{formatExactAmount(value()) ?? value()} {cell().currency ?? ""}
							</dd>
						</>
					)}
				</Show>
				<Show when={cell().periodEnd}>
					{(periodEnd) => (
						<>
							<dt class={DT}>{m().periodEnd}</dt>
							<dd class={DD}>{formatPeriodEnd(periodEnd(), locale())}</dd>
						</>
					)}
				</Show>
				<Show when={cell().concept}>
					{(concept) => (
						<>
							<dt class={DT}>{m().concept}</dt>
							<dd class={`${DD} break-all font-mono text-xs`}>{concept()}</dd>
						</>
					)}
				</Show>
				<Show when={cell().scope}>
					{(scope) => (
						<>
							<dt class={DT}>{m().scopeLabel}</dt>
							<dd class={DD}>{m().scope(scope())}</dd>
						</>
					)}
				</Show>
				<Show when={props.details.filing}>
					{(filing) => (
						<>
							<dt class={DT}>{m().filing}</dt>
							<dd class={DD} data-field="value-filing">
								<SafeLink
									url={filing().sourceUrl}
									label={m().openFiling(m().form(filing().form), filing().filedOn)}
								>
									{m().filingLine(m().form(filing().form), filing().filedOn)}
								</SafeLink>
							</dd>
						</>
					)}
				</Show>
			</dl>
			<Show when={cell().derived && cell().valueDecimal !== null}>
				<p class="mt-2 text-xs text-slate-800">{m().derivedDetail}</p>
			</Show>
			<Show when={isRevised(cell())}>
				<section class="mt-3" aria-labelledby={`${headingId}-revisions`}>
					<h4 id={`${headingId}-revisions`} class="text-sm font-semibold text-slate-900">
						{m().revisionsHeading}
					</h4>
					<p class="text-xs text-slate-700">{m().revisionsIntro}</p>
					<Show when={failure()}>
						{(error) => (
							<div class="mt-1">
								<ErrorNotice
									failure={error()}
									title={m().revisionsFailed}
									onRetry={() => void loadRevisions()}
								/>
							</div>
						)}
					</Show>
					<Show when={loading()}>
						<Loading label={m().revisionsThing} />
					</Show>
					<Show when={revisions()}>
						{(answer) => (
							<div class="mt-1 overflow-x-auto">
								<table class="w-full border-collapse text-left text-sm" data-field="revisions">
									<caption class="sr-only">{m().revisionsHeading}</caption>
									<thead>
										<tr class="border-b border-slate-200 text-xs text-slate-700">
											<th scope="col" class="py-1 pr-2 font-medium">
												{m().filing}
											</th>
											<th scope="col" class="py-1 pr-2 font-medium">
												{m().revisionFiled}
											</th>
											<th scope="col" class="py-1 pr-2 text-right font-medium">
												{m().revisionValue}
											</th>
											<th scope="col" class="py-1 font-medium">
												{m().concept}
											</th>
										</tr>
									</thead>
									<tbody>
										<For each={answer().reported}>
											{(reported) => {
												const filing = () => filingOf(reported.filingId);
												const current = () =>
													reported.filingId === answer().current.filingId &&
													reported.concept === answer().current.concept;
												return (
													<tr
														class="border-b border-slate-200 align-top"
														data-current={current() ? "true" : undefined}
													>
														<td class="py-1 pr-2">
															<Show
																when={filing()}
																fallback={
																	<span class="font-mono text-xs">{reported.filingId}</span>
																}
															>
																{(found) => (
																	<SafeLink url={found().sourceUrl}>
																		{m().form(found().form)}
																	</SafeLink>
																)}
															</Show>
															<Show when={current()}>
																<span class="ml-1 rounded border border-slate-500 px-1 text-2xs font-medium text-slate-800">
																	{m().currentValue}
																</span>
															</Show>
														</td>
														<td class="py-1 pr-2 whitespace-nowrap">{filing()?.filedOn ?? "—"}</td>
														<td class="py-1 pr-2 text-right whitespace-nowrap tabular-nums">
															{formatExactAmount(reported.valueDecimal) ?? reported.valueDecimal}{" "}
															{reported.unit}
														</td>
														<td class="py-1 break-all font-mono text-xs">
															{reported.concept} · {m().scope(reported.scope)}
														</td>
													</tr>
												);
											}}
										</For>
									</tbody>
								</table>
							</div>
						)}
					</Show>
				</section>
			</Show>
			<div class="mt-3 flex gap-2">
				<button
					ref={(element) => {
						closeButton = element;
					}}
					type="button"
					class={BUTTON}
					onClick={() => close()}
				>
					{m().close}
				</button>
			</div>
		</dialog>
	);
}
