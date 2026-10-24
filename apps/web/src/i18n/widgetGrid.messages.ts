import { defineMessages } from "@research/i18n";
import { ENGLISH_WIDGET_GRID_STRINGS, type WidgetSize } from "@research/widget-grid";

const JAPANESE_SIZES: { readonly [S in WidgetSize]: string } = {
	small: "小（1 × 1）",
	medium: "中（2 × 2）",
	large: "大（全幅 × 2）",
};

/**
 * The widget grid's own words (`WidgetGridStrings`), per UI language. English
 * is the package's default set, so the two cannot drift.
 */
export const widgetGridMessages = defineMessages({
	en: { ...ENGLISH_WIDGET_GRID_STRINGS },
	ja: {
		moveAnnouncement: (title, position, total) =>
			`「${title}」を ${total} 件中 ${position} 番目に移動しました。`,
		selectWidget: (title) => `「${title}」を選択`,
		sizeOptionName: (size) => JAPANESE_SIZES[size],
		sizeOptionShort: ENGLISH_WIDGET_GRID_STRINGS.sizeOptionShort,
	},
});
