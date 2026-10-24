import { type Accessor, createContext, type JSX, useContext } from "solid-js";
import { DEFAULT_LOCALE, type Locale } from "./locales.ts";
import type { MessageTable, Translations } from "./messages.ts";

/**
 * The UI language, read reactively. Without a provider (unit tests, a
 * component rendered on its own) it is `DEFAULT_LOCALE`, so a component never
 * needs a provider just to render.
 */
const LocaleContext = createContext<Accessor<Locale>>(() => DEFAULT_LOCALE);

export function LocaleProvider(props: {
	readonly locale: Accessor<Locale>;
	readonly children: JSX.Element;
}): JSX.Element {
	return <LocaleContext.Provider value={props.locale}>{props.children}</LocaleContext.Provider>;
}

export function useLocale(): Accessor<Locale> {
	return useContext(LocaleContext);
}

/**
 * The catalog's table for the current language. Call it once in a component
 * body and read `m().key` inside JSX, so text follows a language change
 * without a reload.
 */
export function useMessages<T extends MessageTable>(translations: Translations<T>): Accessor<T> {
	const locale = useLocale();
	return () => translations[locale()];
}
