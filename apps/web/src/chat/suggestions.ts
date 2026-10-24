import type { MessagesOf } from "@research/i18n";
import type { suggestionsMessages } from "./suggestions.messages.ts";

/**
 * Starter suggestions for an empty conversation, in the UI language. They
 * fill the question input without sending, so choosing one never spends the
 * owner's quota. Written for this product (demand growth, suppliers, pricing
 * power); no investment-advice wording.
 */
export function suggestions(text: MessagesOf<typeof suggestionsMessages>): readonly string[] {
	return [text.demandGrowth, text.japaneseGridStorage, text.usPricingPower, text.batteryMaterials];
}
