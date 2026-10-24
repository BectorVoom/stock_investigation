import { BUDGET_LIMITS } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { type JSX, Show } from "solid-js";
import type { SpendDraft } from "../settings/agentSettingsModel.ts";
import { spendFieldMessages } from "./ui.messages.ts";
import { Field, INPUT } from "./ui.tsx";

/**
 * The maximum spend of one question (FR-016) — the only per-question ceiling
 * the owner sets; the others are fixed (RUN_LIMITS, ADR-0029). Shared by the
 * settings form and the approval form so both state the same consent rule.
 * Storing a maximum spend is not consent (AGT-012), so the settings form
 * hides the consent checkbox and consent is asked again on each question.
 * Rendered only for a backend that can bill: a plan-limited backend never
 * receives a metered allowance.
 */
export function SpendField(props: {
	readonly draft: SpendDraft;
	readonly onChange: (draft: SpendDraft) => void;
	readonly spendConsentRequired: boolean;
	/** False in Settings → AI agent, where no consent is given. Defaults to true. */
	readonly showConsent?: boolean;
}): JSX.Element {
	const m = useMessages(spendFieldMessages);
	const patch = (change: Partial<SpendDraft>) => props.onChange({ ...props.draft, ...change });
	return (
		<div>
			<Field label={m().label} hint={m().hint(BUDGET_LIMITS.maxSpendUsd.max)}>
				{(id) => (
					<input
						id={id}
						type="number"
						inputMode="decimal"
						class={INPUT}
						min={BUDGET_LIMITS.maxSpendUsd.min}
						max={BUDGET_LIMITS.maxSpendUsd.max}
						step="0.01"
						value={props.draft.maxSpendUsd}
						aria-describedby={`${id}-hint`}
						onInput={(event) => patch({ maxSpendUsd: event.currentTarget.value })}
					/>
				)}
			</Field>
			<Show when={(props.showConsent ?? true) && props.spendConsentRequired}>
				<label class="mt-2 flex items-start gap-2 text-xs text-slate-900">
					<input
						type="checkbox"
						class="mt-0.5"
						checked={props.draft.spendConsent}
						onChange={(event) => patch({ spendConsent: event.currentTarget.checked })}
					/>
					<span>{m().consent}</span>
				</label>
			</Show>
		</div>
	);
}
