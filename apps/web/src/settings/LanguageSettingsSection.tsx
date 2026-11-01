import { LOCALE_NAMES, LOCALES, negotiateLocale } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import { createUniqueId, For, type JSX } from "solid-js";
import { Select } from "../components/ui.tsx";
import { isLocalePreference, type LocaleState } from "../i18n/localeState.ts";
import { settingsLanguageMessages } from "./languageSettings.messages.ts";
import { SettingRow, SettingsPane } from "./SettingsLayout.tsx";

/**
 * Settings → Language (ADR-0032): the UI language for this browser. The
 * change applies at once, with no reload; "Browser default" follows the
 * browser's preferred languages. Each language is named in itself.
 */
export function LanguageSettingsSection(props: { readonly localeState: LocaleState }): JSX.Element {
	const m = useMessages(settingsLanguageMessages);
	const selectId = createUniqueId();
	const hintId = createUniqueId();
	return (
		<SettingsPane title={m().title}>
			<SettingRow
				label={m().label}
				labelFor={selectId}
				description={<p id={hintId}>{m().hint}</p>}
				control={
					<Select
						id={selectId}
						describedBy={hintId}
						onChange={(event) => {
							const value = event.currentTarget.value;
							if (isLocalePreference(value)) props.localeState.setPreference(value);
						}}
					>
						<option value="system" selected={props.localeState.preference() === "system"}>
							{m().browserDefault(
								LOCALE_NAMES[negotiateLocale(props.localeState.browserLanguages())],
							)}
						</option>
						<For each={LOCALES}>
							{(locale) => (
								<option
									value={locale}
									lang={locale}
									selected={props.localeState.preference() === locale}
								>
									{LOCALE_NAMES[locale]}
								</option>
							)}
						</For>
					</Select>
				}
			/>
		</SettingsPane>
	);
}
