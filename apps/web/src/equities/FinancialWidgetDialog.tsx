import type {
	EquityCompanyView,
	EquityStatementKind,
	StockDirectoryHit,
	StockProfileResponse,
	WidgetCore,
} from "@research/contracts";
import { EQUITY_METRICS, EQUITY_STATEMENTS, type EquityMetricCode } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import {
	createSignal,
	createUniqueId,
	For,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, BUTTON_PRIMARY, ErrorNotice, LABEL, Loading, Select } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { StockPickerBox } from "../stocks/StockPickerBox.tsx";
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
 * What the dialog knows about the picked stock's company: being read, the
 * read failed, or the profile's answer (its company, or none yet).
 */
type PickedCompany =
	| { readonly kind: "reading"; readonly hit: StockDirectoryHit }
	| { readonly kind: "failed"; readonly hit: StockDirectoryHit; readonly failure: ApiFailure }
	| {
			readonly kind: "read";
			readonly hit: StockDirectoryHit;
			readonly profile: StockProfileResponse;
	  };

/**
 * The company a widget can be placed for: the profile's stored company,
 * tracked or not (a tracked one without values yet fills in once synced;
 * an untracked one keeps its stored values, ADR-0055). Named by the stock
 * list when the company has no stored name yet.
 */
export function pickableCompany(
	profile: StockProfileResponse,
	hitName: string,
): EquityCompanyView | null {
	const company = profile.company;
	if (company === null) return null;
	return company.name === null ? { ...company, name: hitName } : company;
}

/**
 * The add menu's dialog for the two financial widgets (ADR-0048 §8,
 * ADR-0024): pick a stock with the stock-list search (ADR-0034) — the
 * server stores the statements of every listed stock, thousands of
 * companies, so there is no list to scroll (ADR-0058 §6) — then the
 * statement (a Financial statement) or the metric (a Financial history),
 * and how many fiscal years. A pick reads the stock's profile once, whose
 * company the widget names; a stock with no stored company yet says why
 * and cannot be added. A native modal dialog like the other widget
 * dialogs: focus moves to the search box on open, Escape or Cancel closes,
 * and focus returns to the opener. The dialog stays open until the page
 * saved the widget, so a refused save (the page full) keeps the owner's
 * choice.
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
	const searchId = createUniqueId();
	const pickId = createUniqueId();
	const yearsId = createUniqueId();
	const [picked, setPicked] = createSignal<PickedCompany | null>(null);
	const [statement, setStatement] = createSignal<EquityStatementKind>("income-statement");
	const [metric, setMetric] = createSignal<EquityMetricCode>("revenue");
	const [years, setYears] = createSignal<number>(props.type === "financial-statement" ? 5 : 10);
	const [saving, setSaving] = createSignal(false);
	let dialog: HTMLDialogElement | undefined;
	let disposed = false;
	/** Only the newest pick's answer counts (an earlier one may answer later). */
	let generation = 0;

	const resolve = async (hit: StockDirectoryHit): Promise<void> => {
		generation += 1;
		const mine = generation;
		setPicked({ kind: "reading", hit });
		// No ETag: the answer always carries the profile.
		const answer = await props.api.getStockProfile(hit.stockId);
		if (disposed || mine !== generation) return;
		if (!answer.ok) {
			setPicked({ kind: "failed", hit, failure: answer.error });
			return;
		}
		if (answer.value.changed) setPicked({ kind: "read", hit, profile: answer.value.value });
	};

	const close = (): void => {
		props.onClose();
		props.opener?.focus();
	};

	const company = (): EquityCompanyView | null => {
		const current = picked();
		return current?.kind === "read" ? pickableCompany(current.profile, current.hit.name) : null;
	};

	const submit = async (): Promise<void> => {
		const chosen = company();
		if (chosen === null || saving()) return;
		setSaving(true);
		const title = companyWidgetTitle(chosen);
		const core =
			props.type === "financial-statement"
				? financialStatementWidget(chosen.companyId, statement(), years(), title)
				: financialHistoryWidget(chosen.companyId, metric(), years(), title);
		const saved = await props.onChoose(core);
		if (disposed) return;
		setSaving(false);
		if (saved) close();
	};

	onMount(() => {
		dialog?.showModal();
		document.getElementById(searchId)?.focus();
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
					<div data-field="financial-stock-search">
						<StockPickerBox
							api={props.api}
							id={searchId}
							canSubmit={company() !== null}
							onPick={(hit) => void resolve(hit)}
						/>
					</div>
					<Show when={picked()}>
						{(current) => <PickedLine picked={current()} onRetry={(hit) => void resolve(hit)} />}
					</Show>
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
														<option value={definition.code} selected={definition.code === metric()}>
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
						<Select id={yearsId} onChange={(event) => setYears(Number(event.currentTarget.value))}>
							<For each={yearChoices()}>
								{(choice) => (
									<option value={choice} selected={choice === years()}>
										{m().yearsOption(choice)}
									</option>
								)}
							</For>
						</Select>
					</div>
				</div>
				<div class="mt-3 flex gap-2">
					<button type="button" class={BUTTON} onClick={() => close()}>
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

/**
 * The picked stock under the search box: "Company: Apple Inc. (AAPL)", or
 * while it is read a loading line, after a failed read the failure with
 * Try again, and for a stock with no stored company why there is none.
 */
function PickedLine(props: {
	readonly picked: PickedCompany;
	readonly onRetry: (hit: StockDirectoryHit) => void;
}): JSX.Element {
	const m = useMessages(financialsMessages);
	const read = () => (props.picked.kind === "read" ? props.picked : null);
	const chosen = () => {
		const current = read();
		return current === null ? null : pickableCompany(current.profile, current.hit.name);
	};
	return (
		<div data-field="financial-picked" data-stock-id={props.picked.hit.stockId}>
			<Switch>
				<Match when={props.picked.kind === "reading"}>
					<Loading label={m().pickedThing} />
				</Match>
				<Match when={props.picked.kind === "failed" ? props.picked : null}>
					{(failed) => (
						<ErrorNotice
							failure={failed().failure}
							title={m().pickedFailed}
							onRetry={() => props.onRetry(failed().hit)}
						/>
					)}
				</Match>
				<Match when={chosen()}>
					{(company) => (
						<p class="text-sm text-slate-900">
							<span class="font-medium text-slate-700">{m().companyLabel}</span>{" "}
							{companyWidgetTitle(company())}
						</p>
					)}
				</Match>
				<Match when={read()}>
					{(current) => (
						<p class="text-sm text-slate-800" data-field="financial-picked-none">
							{current().profile.directory === null ? m().pickedNotListed : m().pickedNotTrackedYet}
						</p>
					)}
				</Match>
			</Switch>
		</div>
	);
}
