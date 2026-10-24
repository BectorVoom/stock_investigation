import { LOCALE_NAMES, LOCALES, negotiateLocale } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import { createUniqueId, For, type JSX } from "solid-js";
import { Section, Select } from "../components/ui.tsx";
import { isLocalePreference, type LocaleState } from "../i18n/localeState.ts";
import { settingsLanguageMessages } from "./languageSettings.messages.ts";

/**
 * Settings → Language (ADR-0031): the UI language for this browser. The
 * change applies at once, with no reload; "Browser default" follows the
 * browser's preferred languages. Each language is named in itself.
 */
export function LanguageSettingsSection(props: { readonly localeState: LocaleState }): JSX.Element {
	const m = useMessages(settingsLanguageMessages);
	const selectId = createUniqueId();
	const hintId = createUniqueId();
	return (
		<Section title={m().title}>
			<div class="mt-1 max-w-xs">
				<label for={selectId} class="block text-xs font-medium text-slate-700">
					{m().label}
				</label>
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
				<p id={hintId} class="mt-1 text-xs text-slate-600">
					{m().hint}
				</p>
			</div>
		</Section>
	);
}
