import type { EquityCompanyView, EquityStatementKind, WidgetCore } from "@research/contracts";
import { EQUITY_METRICS, EQUITY_STATEMENTS, type EquityMetricCode } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, BUTTON_PRIMARY, ErrorNotice, LABEL, Loading, Select } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { EQUITIES_HASH } from "../router.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import { financialHistoryWidget, financialStatementWidget } from "../widgets/widgetModel.ts";
import { financialsMessages } from "./financials.messages.ts";

/** The fiscal-year choices of the add dialog and the Equities page (ADR-0048 §8). */
export const STATEMENT_YEAR_CHOICES = [5, 10] as const;
export const HISTORY_YEAR_CHOICES = [5, 10, 15] as const;

export type FinancialWidgetType = "financial-statement" | "financial-history";

function isMetricCode(value: string): value is EquityMetricCode {
	return EQUITY_METRICS.some((definition) => definition.code === value);
}

function isStatement(value: string): value is EquityStatementKind {
	return EQUITY_STATEMENTS.some((statement) => statement === value);
}

/**
 * A company as a list names it and as a widget stores its title (hidden;
 * the frame's accessible name, cut to the title bound by the widget model).
 */
export function companyWidgetTitle(company: EquityCompanyView): string {
	const name = company.name ?? company.symbol;
	return name === company.symbol ? name : `${name} (${company.symbol})`;
}

/**
 * The add menu's dialog for the two financial widgets (ADR-0048 §8): pick
 * one of the companies tracked on the Equities page, then the statement (a
 * Financial statement) or the metric (a Financial history), and how many
 * fiscal years. A native modal dialog like the other widget dialogs: focus
 * moves to the company list on open, Escape or Cancel closes, and focus
 * returns to the opener. With no tracked company it says so and links to
 * the Equities page. The dialog stays open until the page saved the widget,
 * so a refused save (the page full) keeps the owner's choice.
 */
export function FinancialWidgetDialog(props: {
	readonly api: ApiClient;
	readonly type: FinancialWidgetType;
	readonly opener: HTMLElement | null;
	/** Places the widget; resolves true once saved (the dialog then closes). */
	readonly onChoose: (core: WidgetCore) => Promise<boolean>;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(financialsMessages);
	const common = useMessages(commonMessages);
	const headingId = createUniqueId();
	const introId = createUniqueId();
	const companyId = createUniqueId();
	const pickId = createUniqueId();
	const yearsId = createUniqueId();
	const [companies, setCompanies] = createSignal<readonly EquityCompanyView[] | null>(null);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [chosen, setChosen] = createSignal<string | null>(null);
	const [statement, setStatement] = createSignal<EquityStatementKind>("income-statement");
	const [metric, setMetric] = createSignal<EquityMetricCode>("revenue");
	const [years, setYears] = createSignal<number>(props.type === "financial-statement" ? 5 : 10);
	const [saving, setSaving] = createSignal(false);
	let dialog: HTMLDialogElement | undefined;
	let cancelButton: HTMLButtonElement | undefined;
	let disposed = false;

	const load = async (): Promise<void> => {
		setFailure(null);
		const answer = await props.api.listEquityCompanies();
		if (disposed) return;
		if (!answer.ok) {
			setFailure(answer.error);
			return;
		}
		// No ETag was sent, so the answer always carries the list.
		if (answer.value.changed) {
			const list = answer.value.value.companies.filter((company) => company.tracked);
			setCompanies(list);
			setChosen((current) => current ?? list[0]?.companyId ?? null);
			queueMicrotask(() => {
				const select = document.getElementById(companyId);
				if (select instanceof HTMLSelectElement && document.activeElement === cancelButton) {
					select.focus();
				}
			});
		}
	};

	const close = (): void => {
		props.onClose();
		props.opener?.focus();
	};

	const company = (): EquityCompanyView | null =>
		companies()?.find((entry) => entry.companyId === chosen()) ?? null;

	const submit = async (): Promise<void> => {
		const picked = company();
		if (picked === null || saving()) return;
		setSaving(true);
		const title = companyWidgetTitle(picked);
		const core =
			props.type === "financial-statement"
				? financialStatementWidget(picked.companyId, statement(), years(), title)
				: financialHistoryWidget(picked.companyId, metric(), years(), title);
		const saved = await props.onChoose(core);
		if (disposed) return;
		setSaving(false);
		if (saved) close();
	};

	onMount(() => {
		dialog?.showModal();
		cancelButton?.focus();
		void load();
	});
	onCleanup(() => {
		disposed = true;
		if (dialog?.open === true) dialog.close();
	});

	const yearChoices = (): readonly number[] =>
		props.type === "financial-statement" ? STATEMENT_YEAR_CHOICES : HISTORY_YEAR_CHOICES;

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			aria-describedby={introId}
			class="m-auto w-full max-w-md rounded bg-slate-100 p-4"
			data-financial-widget-dialog={props.type}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<h3 id={headingId} class="text-base font-semibold text-slate-900">
					{props.type === "financial-statement" ? m().addStatementHeading : m().addHistoryHeading}
				</h3>
				<p id={introId} class="mt-1 text-xs text-slate-700">
					{m().addIntro}
				</p>
				<div class="mt-2 space-y-2">
					<Show when={failure()}>
						{(error) => (
							<ErrorNotice
								failure={error()}
								title={m().companiesFailed}
								onRetry={() => void load()}
							/>
						)}
					</Show>
					<Show
						when={companies()}
						fallback={
							<Show when={failure() === null}>
								<Loading label={m().companiesThing} />
							</Show>
						}
					>
						{(list) => (
							<Show
								when={list().length > 0}
								fallback={
									<div class="space-y-1 rounded border border-dashed border-slate-300 px-3 py-2">
										<p class="text-sm text-slate-800">{m().noCompanies}</p>
										<a
											href={EQUITIES_HASH}
											class={`${TASK_LINK} text-sm`}
											onClick={() => props.onClose()}
										>
											{m().trackOnEquities}
										</a>
									</div>
								}
							>
								<div>
									<label for={companyId} class={LABEL}>
										{m().companyLabel}
									</label>
									<Select id={companyId} onChange={(event) => setChosen(event.currentTarget.value)}>
										<For each={list()}>
											{(entry) => (
												<option value={entry.companyId} selected={entry.companyId === chosen()}>
													{companyWidgetTitle(entry)}
												</option>
											)}
										</For>
									</Select>
								</div>
								<Show
									when={props.type === "financial-statement"}
									fallback={
										<div>
											<label for={pickId} class={LABEL}>
												{m().metricPicker}
											</label>
											<Select
												id={pickId}
												onChange={(event) => {
													const value = event.currentTarget.value;
													if (isMetricCode(value)) setMetric(value);
												}}
											>
												<For each={EQUITY_STATEMENTS}>
													{(group) => (
														<optgroup label={m().statement(group)}>
															<For
																each={EQUITY_METRICS.filter(
																	(definition) => definition.statement === group,
																)}
															>
																{(definition) => (
																	<option
																		value={definition.code}
																		selected={definition.code === metric()}
																	>
																		{m().metric(definition.code)}
																	</option>
																)}
															</For>
														</optgroup>
													)}
												</For>
											</Select>
										</div>
									}
								>
									<div>
										<label for={pickId} class={LABEL}>
											{m().statementSwitch}
										</label>
										<Select
											id={pickId}
											onChange={(event) => {
												const value = event.currentTarget.value;
												if (isStatement(value)) setStatement(value);
											}}
										>
											<For each={EQUITY_STATEMENTS}>
												{(option) => (
													<option value={option} selected={option === statement()}>
														{m().statement(option)}
													</option>
												)}
											</For>
										</Select>
									</div>
								</Show>
								<div>
									<label for={yearsId} class={LABEL}>
										{m().yearsLabel}
									</label>
									<Select
										id={yearsId}
										onChange={(event) => setYears(Number(event.currentTarget.value))}
									>
										<For each={yearChoices()}>
											{(choice) => (
												<option value={choice} selected={choice === years()}>
													{m().yearsOption(choice)}
												</option>
											)}
										</For>
									</Select>
								</div>
							</Show>
						)}
					</Show>
				</div>
				<div class="mt-3 flex gap-2">
					<button
						ref={(element) => {
							cancelButton = element;
						}}
						type="button"
						class={BUTTON}
						onClick={() => close()}
					>
						{common().cancel}
					</button>
					<button type="submit" class={BUTTON_PRIMARY} disabled={saving() || company() === null}>
						{m().addWidget}
					</button>
				</div>
			</form>
		</dialog>
	);
}
