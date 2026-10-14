import { describe, expect, it } from "vitest";
import { sanitizePastedHTML } from "../../src/notebook/richText/pasteSanitize.ts";

describe("paste sanitization", () => {
	it("keeps the subset and drops styles, scripts and hostile attributes", () => {
		const out = sanitizePastedHTML(
			'<p style="color:red" onclick="x()">Hi <strong>there</strong> <a href="https://example.com" style="x">docs</a></p><script>alert(1)</script><style>p{}</style>',
		);
		expect(out).toContain("<strong>there</strong>");
		expect(out).toContain('<a href="https://example.com">docs</a>');
		expect(out).not.toContain("style=");
		expect(out).not.toContain("onclick");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("alert(1)");
	});

	it("unwraps unsafe link targets but keeps their labels", () => {
		const out = sanitizePastedHTML('<p><a href="javascript:evil()">click</a></p>');
		expect(out).not.toContain("<a");
		expect(out).toContain("click");
	});

	it("unwraps foreign structure to text and maps deep headings to paragraphs", () => {
		const out = sanitizePastedHTML(
			"<div><section><h4>Title</h4><table><tr><td>cell</td></tr></table></section></div>",
		);
		expect(out).not.toContain("<div");
		expect(out).not.toContain("<table");
		expect(out).toContain("<p>Title</p>");
		expect(out).toContain("cell");
	});

	it("drops media and inputs with their content", () => {
		const out = sanitizePastedHTML('<p>before<img src="x"><input type="checkbox">after</p>');
		expect(out).not.toContain("<img");
		expect(out).not.toContain("<input");
		expect(out).toContain("before");
		expect(out).toContain("after");
	});

	it("is total over strings", () => {
		expect(sanitizePastedHTML("")).toBe("");
		expect(sanitizePastedHTML("plain")).toBe("plain");
		expect(sanitizePastedHTML("<p>unclosed")).toContain("unclosed");
	});
});
