import type { Claim } from "@research/contracts";
import type { JSX } from "solid-js";

export type ClaimType = Claim["claimType"];
export type ClaimStatus = Claim["status"];

const CLAIM_TYPE_TEXT: { readonly [T in ClaimType]: string } = {
	observation: "Observation",
	inference: "Inference",
	hypothesis: "Hypothesis",
	forecast: "Forecast",
};

/** Status is never colour-alone: each badge carries a symbol and a word. */
const STATUS_PRESENTATION: {
	readonly [S in ClaimStatus]: {
		readonly text: string;
		readonly symbol: string;
		readonly classes: string;
	};
} = {
	supported: {
		text: "Supported",
		symbol: "✓",
		classes: "border-emerald-700 bg-emerald-50 text-emerald-900",
	},
	unsupported: {
		text: "Unsupported",
		symbol: "✕",
		classes: "border-red-700 bg-red-50 text-red-900",
	},
	conflicting: {
		text: "Conflicting evidence",
		symbol: "≠",
		classes: "border-amber-700 bg-amber-50 text-amber-900",
	},
};

const BADGE_BASE =
	"inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs font-medium leading-4";

/**
 * Observation / inference / hypothesis / forecast kept distinct in display
 * (DATA-003). Both badges take a real value only: there is deliberately no
 * "unknown" variant, so text that is not a verified claim cannot wear a badge.
 */
export function ClaimTypeBadge(props: { readonly claimType: ClaimType }): JSX.Element {
	return (
		<span
			data-claim-type={props.claimType}
			class={`${BADGE_BASE} border-slate-400 bg-slate-50 text-slate-800`}
		>
			{CLAIM_TYPE_TEXT[props.claimType]}
		</span>
	);
}

/** Unsupported and conflicting claims are shown, visibly distinct, never hidden (section 9.8). */
export function ClaimStatusBadge(props: { readonly status: ClaimStatus }): JSX.Element {
	return (
		<span
			data-claim-status={props.status}
			class={`${BADGE_BASE} ${STATUS_PRESENTATION[props.status].classes}`}
		>
			<span aria-hidden="true">{STATUS_PRESENTATION[props.status].symbol}</span>
			{STATUS_PRESENTATION[props.status].text}
		</span>
	);
}
