import type { MessagesOf } from "@research/i18n";
import { cellReasonMessages } from "./cellReasons.messages.ts";

export type CellReasonText = MessagesOf<typeof cellReasonMessages>;
type CellReasonKey = keyof CellReasonText;

function isCellReasonKey(key: string): key is CellReasonKey {
	return key in cellReasonMessages.en;
}

/** The registry's own reasons by their stored (English) text, for `cellReasonText`. */
const CELL_REASON_KEY_BY_TEXT: ReadonlyMap<string, CellReasonKey> = new Map(
	Object.keys(cellReasonMessages.en)
		.filter(isCellReasonKey)
		.map((key) => [cellReasonMessages.en[key], key] as const),
);

/**
 * The words for a reason a value is not shown. A reason the registry itself
 * gave (stored in English, like a dataset's own reason) is worded in the
 * language of `text`; a reason from the data is research content and is
 * returned as written.
 */
export function cellReasonText(reason: string, text: CellReasonText): string {
	const key = CELL_REASON_KEY_BY_TEXT.get(reason);
	return key === undefined ? reason : text[key];
}
