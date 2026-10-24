import { defineMessages } from "@research/i18n";

/**
 * The reasons the registry itself gives when a value is not shown (DATA-011,
 * FR-007). The English text is also what a guarded dataset stores in the
 * cell (`{ v: null, reason }`), as a dataset's own reason would be; the view
 * words a registry reason in the current language and shows any other reason
 * as it was written (`cellReasonText`).
 */
export const cellReasonMessages = defineMessages({
	en: {
		valueNotProvided: "value not provided",
		reasonNotStated: "reason not stated",
		valueNotFinite: "value is not a finite number",
		valueNotNumeric: "value is not numeric",
		noValueForLabel: "no value for this label",
		usMarginBuyWithheld: "not shown: no security-level US margin-buy balance exists",
	},
	ja: {
		valueNotProvided: "値がありません",
		reasonNotStated: "理由の記載なし",
		valueNotFinite: "値が有限の数値ではありません",
		valueNotNumeric: "値が数値ではありません",
		noValueForLabel: "このラベルの値はありません",
		usMarginBuyWithheld: "表示しません：米国には銘柄別の信用買い残がありません",
	},
});
