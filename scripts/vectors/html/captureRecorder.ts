/**
 * Recording stand-in for `htmlToMarkdown`, used only by
 * `capture.vitest.config.ts`: every call the converter's own test suites make
 * is appended to `$HTML_CAPTURE_FILE`, so the vector corpus in
 * `testInputs.ts` can be checked for completeness against the real tests.
 */
import { appendFileSync } from "node:fs";
import {
	type HtmlToMarkdownOptions,
	type MarkdownPage,
	htmlToMarkdown as realHtmlToMarkdown,
} from "../../../packages/adapters/src/tools/htmlToMarkdown.ts";

export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions): MarkdownPage {
	const target = process.env.HTML_CAPTURE_FILE;
	if (target !== undefined) appendFileSync(target, `${JSON.stringify({ html, options })}\n`);
	return realHtmlToMarkdown(html, options);
}
