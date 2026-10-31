import { parseJsonOrNull } from "@research/domain";
import { z } from "zod";
import type { ArticleKey } from "./ports.ts";

/**
 * The one opaque article cursor (the Sources list and the Stocks page's
 * News tab, ADR-0049 §7): base64 of the JSON `[retrievedAt, articleId]` of
 * the last article a page covered. Article ids and ISO times are ASCII, so
 * `btoa` never meets a character outside Latin-1.
 */
const cursorSchema = z.tuple([z.string().min(1), z.string().min(1)]);

export function encodeArticleCursor(key: ArticleKey): string {
	return btoa(JSON.stringify([key.retrievedAt, key.articleId]));
}

/** The key a cursor names; null when it is not one this module encoded. */
export function decodeArticleCursor(cursor: string): ArticleKey | null {
	let decoded: string;
	try {
		decoded = atob(cursor);
	} catch {
		// atob throws only InvalidCharacterError: the cursor is not base64.
		return null;
	}
	const parsed = cursorSchema.safeParse(parseJsonOrNull(decoded));
	return parsed.success ? { retrievedAt: parsed.data[0], articleId: parsed.data[1] } : null;
}
