import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { defineMessages, type Locale } from "../src/index.ts";
import { LocaleProvider, useLocale, useMessages } from "../src/solid.tsx";

const catalog = defineMessages({
	en: { greeting: "Hello", items: (n: number) => `${n} items` },
	ja: { greeting: "こんにちは", items: (n) => `${n} 件` },
});

function Greeting() {
	const m = useMessages(catalog);
	const locale = useLocale();
	return (
		<p data-locale={locale()}>
			{m().greeting} · {m().items(3)}
		</p>
	);
}

describe("useMessages", () => {
	it("uses the default language without a provider", () => {
		const { container } = render(() => <Greeting />);
		expect(container.textContent).toBe("Hello · 3 items");
	});

	it("follows a language change without remounting", () => {
		const [locale, setLocale] = createSignal<Locale>("en");
		const { container } = render(() => (
			<LocaleProvider locale={locale}>
				<Greeting />
			</LocaleProvider>
		));
		const paragraph = container.querySelector("p");
		expect(paragraph?.textContent).toBe("Hello · 3 items");
		setLocale("ja");
		expect(container.querySelector("p")).toBe(paragraph);
		expect(paragraph?.textContent).toBe("こんにちは · 3 件");
		expect(paragraph?.dataset.locale).toBe("ja");
	});
});
