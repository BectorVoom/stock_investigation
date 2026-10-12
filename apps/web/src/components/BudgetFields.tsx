import { BUDGET_LIMITS } from "@research/contracts";
import { type JSX, Show } from "solid-js";
import { type BudgetDraft, WALL_CLOCK_MINUTES } from "../settings/agentSettingsModel.ts";
import { Field, INPUT } from "./ui.tsx";

function NumberField(props: {
	readonly label: string;
	readonly value: string;
	readonly min: number;
	readonly max: number;
	readonly step: string;
	readonly disabled?: boolean;
	readonly hint?: string;
	readonly onInput: (value: string) => void;
}): JSX.Element {
	const hint = props.hint ?? `${props.min}–${props.max}`;
	return (
		<Field label={props.label} hint={hint}>
			{(id) => (
				<input
					id={id}
					type="number"
					inputMode="decimal"
					class={INPUT}
					min={props.min}
					max={props.max}
					step={props.step}
					value={props.value}
					disabled={props.disabled}
					aria-describedby={`${id}-hint`}
					onInput={(event) => props.onInput(event.currentTarget.value)}
				/>
			)}
		</Field>
	);
}

/**
 * The resource ceilings of one run (FR-016). Shared by the settings form and
 * the approval form so both state the same limits and the same consent rule.
 * Storing a maximum spend is not consent (AGT-012), so the settings form
 * hides the consent checkbox and consent is asked again on each question.
 */
export function BudgetFields(props: {
	readonly draft: BudgetDraft;
	readonly onChange: (draft: BudgetDraft) => void;
	/** False for plan-limited backends, which never receive a metered allowance. */
	readonly spendEditable: boolean;
	readonly spendConsentRequired: boolean;
	readonly legend: string;
	/** False in Settings → AI agent, where no consent is given. Defaults to true. */
	readonly showConsent?: boolean;
}): JSX.Element {
	const patch = (change: Partial<BudgetDraft>) => props.onChange({ ...props.draft, ...change });
	return (
		<fieldset class="rounded border border-slate-300 p-2">
			<legend class="px-1 text-xs font-semibold text-slate-800">{props.legend}</legend>
			<div class="grid grid-cols-2 gap-2">
				<NumberField
					label="Max agent steps"
					value={props.draft.maxAgentSteps}
					min={BUDGET_LIMITS.maxAgentSteps.min}
					max={BUDGET_LIMITS.maxAgentSteps.max}
					step="1"
					onInput={(maxAgentSteps) => patch({ maxAgentSteps })}
				/>
				<NumberField
					label="Max tool calls"
					value={props.draft.maxToolCalls}
					min={BUDGET_LIMITS.maxToolCalls.min}
					max={BUDGET_LIMITS.maxToolCalls.max}
					step="1"
					onInput={(maxToolCalls) => patch({ maxToolCalls })}
				/>
				<NumberField
					label="Max wall-clock minutes"
					value={props.draft.maxWallClockMinutes}
					min={WALL_CLOCK_MINUTES.min}
					max={WALL_CLOCK_MINUTES.max}
					step="0.5"
					onInput={(maxWallClockMinutes) => patch({ maxWallClockMinutes })}
				/>
				<NumberField
					label="Max input bytes"
					value={props.draft.maxInputBytes}
					min={BUDGET_LIMITS.maxInputBytes.min}
					max={BUDGET_LIMITS.maxInputBytes.max}
					step="1000"
					onInput={(maxInputBytes) => patch({ maxInputBytes })}
				/>
				<NumberField
					label="Max spend (USD)"
					value={props.spendEditable ? props.draft.maxSpendUsd : ""}
					min={BUDGET_LIMITS.maxSpendUsd.min}
					max={BUDGET_LIMITS.maxSpendUsd.max}
					step="0.01"
					disabled={!props.spendEditable}
					hint={
						props.spendEditable
							? `Leave empty to authorize no metered spend; at most ${BUDGET_LIMITS.maxSpendUsd.max}`
							: "Not applicable — plan-limited backend; no metered spend is authorized"
					}
					onInput={(maxSpendUsd) => patch({ maxSpendUsd })}
				/>
			</div>
			<Show when={(props.showConsent ?? true) && props.spendConsentRequired}>
				<label class="mt-2 flex items-start gap-2 text-xs text-slate-900">
					<input
						type="checkbox"
						class="mt-0.5"
						checked={props.draft.spendConsent}
						onChange={(event) => patch({ spendConsent: event.currentTarget.checked })}
					/>
					<span>I consent to metered spend up to the maximum above for this run</span>
				</label>
			</Show>
		</fieldset>
	);
}
