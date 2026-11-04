import { isLocale, type Locale, negotiateLocale } from "@research/i18n";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { type KeyValueStorage, readStoredText, writeStoredText } from "../lib/browserStorage.ts";

/** The owner's choice: a fixed language, or whatever the browser prefers. */
export type LocalePreference = Locale | "system";

/** Browser-storage key of the choice; a per-visitor convenience (ADR-0032). */
export const LOCALE_STORAGE_KEY = "research.locale";

export function isLocalePreference(value: unknown): value is LocalePreference {
	return value === "system" || isLocale(value);
}

/** The language a preference stands for, given the browser's preferred languages. */
export function resolveLocale(
	preference: LocalePreference,
	browserLanguages: readonly string[],
): Locale {
	return preference === "system" ? negotiateLocale(browserLanguages) : preference;
}

/** The choice stored in this browser, "system" when none (or an unknown value) is stored. */
export function storedLocalePreference(storage: KeyValueStorage | null): LocalePreference {
	const stored = readStoredText(storage, LOCALE_STORAGE_KEY);
	return isLocalePreference(stored) ? stored : "system";
}

/**
 * Sets `<html lang>` to the UI language before the app renders. The served
 * index.html says `lang="en"`, so a Japanese page was announced as English
 * until the app started, and Chrome's page translation offered to
 * translate it: run over Japanese text it turned 【事業内容】 into
 * 【コンテンツ事業】 and 「手がける」 into 「評価」 (2026-11-04). The
 * Content-Security-Policy rules out an inline script in index.html, so
 * main.tsx calls this first; `createLocaleState` keeps it in step later.
 */
export function applyInitialLocale(window: Window, storage: KeyValueStorage | null): Locale {
	const locale = resolveLocale(storedLocalePreference(storage), languagesOf(window));
	window.document.documentElement.lang = locale;
	return locale;
}

export interface LocaleState {
	/** The language the UI is shown in now. */
	readonly locale: Accessor<Locale>;
	readonly preference: Accessor<LocalePreference>;
	/** The browser's preferred languages, followed live (what "system" resolves against). */
	readonly browserLanguages: Accessor<readonly string[]>;
	/** Shows the UI in `preference` at once and remembers it in this browser. */
	readonly setPreference: (preference: LocalePreference) => void;
}

/**
 * The UI language for this visit: the stored choice, else the browser's
 * languages (followed live while the choice is "system"). Keeps
 * `<html lang>` equal to it, which also switches the Shoelace controls'
 * own words and lets assistive technology pronounce the page correctly.
 * Call inside a reactive owner (the App component).
 */
export function createLocaleState(env: {
	readonly window: Window;
	readonly storage: KeyValueStorage | null;
}): LocaleState {
	const [preference, setPreferenceSignal] = createSignal<LocalePreference>(
		storedLocalePreference(env.storage),
	);
	const [browserLanguages, setBrowserLanguages] = createSignal(languagesOf(env.window));
	const onLanguageChange = () => setBrowserLanguages(languagesOf(env.window));
	env.window.addEventListener("languagechange", onLanguageChange);
	onCleanup(() => env.window.removeEventListener("languagechange", onLanguageChange));

	const locale = () => resolveLocale(preference(), browserLanguages());
	createEffect(() => {
		env.window.document.documentElement.lang = locale();
	});

	return {
		locale,
		preference,
		browserLanguages,
		setPreference: (next) => {
			setPreferenceSignal(next);
			// Refused storage only means the choice lasts for this visit.
			writeStoredText(env.storage, LOCALE_STORAGE_KEY, next === "system" ? null : next);
		},
	};
}

function languagesOf(window: Window): readonly string[] {
	const { languages, language } = window.navigator;
	return languages.length > 0 ? languages : [language];
}
