import { LocaleProvider, useMessages } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commonMessages } from "../src/i18n/common.messages.ts";
import { createLocaleState, LOCALE_STORAGE_KEY, resolveLocale } from "../src/i18n/localeState.ts";
import type { KeyValueStorage } from "../src/lib/browserStorage.ts";
import { LanguageSettingsSection } from "../src/settings/LanguageSettingsSection.tsx";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
	readonly entries: Map<string, string>;
} {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
		removeItem: (key) => void entries.delete(key),
	};
}

/** A window whose browser languages the test sets. */
function windowWithLanguages(languages: readonly string[]): Window {
	Object.defineProperty(window.navigator, "languages", {
		configurable: true,
		get: () => languages,
	});
	return window;
}

afterEach(() => {
	cleanup();
	document.documentElement.lang = "en";
	Object.defineProperty(window.navigator, "languages", {
		configurable: true,
		get: () => ["en-US"],
	});
});

describe("resolveLocale", () => {
	it("uses a fixed choice as it is and resolves 'system' against the browser", () => {
		expect(resolveLocale("ja", ["en-US"])).toBe("ja");
		expect(resolveLocale("system", ["ja-JP", "en"])).toBe("ja");
		expect(resolveLocale("system", ["fr-FR"])).toBe("en");
	});
});

/** Effects run once the root's setup returns, so assertions come after it. */
function mountState(languages: readonly string[], storage: KeyValueStorage | null) {
	return createRoot((dispose) => ({
		state: createLocaleState({ window: windowWithLanguages(languages), storage }),
		dispose,
	}));
}

describe("createLocaleState", () => {
	it("follows the browser by default and keeps <html lang> in step", () => {
		const { state, dispose } = mountState(["ja-JP", "en-US"], memoryStorage());
		expect(state.preference()).toBe("system");
		expect(state.locale()).toBe("ja");
		expect(document.documentElement.lang).toBe("ja");
		dispose();
	});

	it("restores a stored choice, and ignores a stored value it does not know", () => {
		const stored = mountState(["en-US"], memoryStorage({ [LOCALE_STORAGE_KEY]: "ja" }));
		expect(stored.state.locale()).toBe("ja");
		stored.dispose();
		const unknown = mountState(["en-US"], memoryStorage({ [LOCALE_STORAGE_KEY]: "klingon" }));
		expect(unknown.state.preference()).toBe("system");
		expect(unknown.state.locale()).toBe("en");
		unknown.dispose();
	});

	it("stores a fixed choice and forgets it again for 'system'", () => {
		const storage = memoryStorage();
		const { state, dispose } = mountState(["en-US"], storage);
		state.setPreference("ja");
		expect(storage.entries.get(LOCALE_STORAGE_KEY)).toBe("ja");
		expect(document.documentElement.lang).toBe("ja");
		state.setPreference("system");
		expect(storage.entries.has(LOCALE_STORAGE_KEY)).toBe(false);
		expect(state.locale()).toBe("en");
		expect(document.documentElement.lang).toBe("en");
		dispose();
	});

	it("still switches for this visit when storage is unavailable", () => {
		const { state, dispose } = mountState(["en-US"], null);
		state.setPreference("ja");
		expect(state.locale()).toBe("ja");
		dispose();
	});

	it("follows a browser language change while the choice is 'system'", () => {
		const { state, dispose } = mountState(["en-US"], memoryStorage());
		windowWithLanguages(["ja"]);
		window.dispatchEvent(new Event("languagechange"));
		expect(state.locale()).toBe("ja");
		dispose();
	});
});

function Probe() {
	const common = useMessages(commonMessages);
	return <p data-testid="probe">{common().save}</p>;
}

describe("Settings → Language", () => {
	it("switches the whole UI at once, with no reload", () => {
		const storage = memoryStorage();
		render(() => {
			const state = createLocaleState({ window: windowWithLanguages(["en-US"]), storage });
			return (
				<LocaleProvider locale={state.locale}>
					<LanguageSettingsSection localeState={state} />
					<Probe />
				</LocaleProvider>
			);
		});
		const select = screen.getByLabelText("Display language");
		expect(screen.getByRole("option", { name: "Browser default (English)" })).toBeTruthy();
		expect(screen.getByTestId("probe").textContent).toBe("Save");
		fireEvent.change(select, { target: { value: "ja" } });
		expect(screen.getByTestId("probe").textContent).toBe("保存");
		expect(screen.getByRole("region", { name: "言語" })).toBeTruthy();
		expect(screen.getByLabelText("表示言語")).toBe(select);
		expect(storage.entries.get(LOCALE_STORAGE_KEY)).toBe("ja");
	});
});
