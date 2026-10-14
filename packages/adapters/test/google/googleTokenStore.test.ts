/**
 * Token store (FR-019 section 2.2, security check 4): the file is created
 * with mode 0600 and written atomically (temp file + rename); a corrupt or
 * unreadable file reads as "not connected" and is left alone.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GOOGLE_CALENDAR_SCOPE } from "../../src/google/googleOAuth.ts";
import {
	type GoogleTokenRecord,
	readGoogleTokenFile,
	writeGoogleTokenFile,
} from "../../src/google/googleTokenStore.ts";

const RECORD: GoogleTokenRecord = {
	version: 1,
	refreshToken: "refresh-token-value",
	calendarId: "calendar-id-value",
	scope: GOOGLE_CALENDAR_SCOPE,
	savedAt: "2026-10-13T00:00:00.000Z",
};

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "google-token-test-"));
}

describe("token store file (security check 4)", () => {
	it("writes mode 0600 atomically and reads the record back", async () => {
		const dir = await tempDir();
		try {
			const path = join(dir, "google-token.json");
			await writeGoogleTokenFile(path, RECORD);
			const mode = (await stat(path)).mode & 0o777;
			expect(mode).toBe(0o600);
			// Atomic: no temp file survives the write.
			expect(await readdir(dir)).toEqual(["google-token.json"]);
			expect(await readGoogleTokenFile(path)).toEqual(RECORD);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("overwrites an existing file without changing its mode", async () => {
		const dir = await tempDir();
		try {
			const path = join(dir, "google-token.json");
			await writeGoogleTokenFile(path, RECORD);
			await writeGoogleTokenFile(path, { ...RECORD, calendarId: "new-calendar" });
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(await readGoogleTokenFile(path)).toMatchObject({ calendarId: "new-calendar" });
			expect(await readdir(dir)).toEqual(["google-token.json"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads a missing file as not connected", async () => {
		const dir = await tempDir();
		try {
			expect(await readGoogleTokenFile(join(dir, "missing.json"))).toBe(null);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads a corrupt file as not connected and leaves it alone", async () => {
		const dir = await tempDir();
		try {
			const path = join(dir, "google-token.json");
			for (const corrupt of [
				"not json at all",
				'{"version":2,"refreshToken":"x","calendarId":"y","scope":"z","savedAt":"t"}',
				'{"version":1,"calendarId":"y","scope":"z","savedAt":"t"}',
				"[]",
			]) {
				await writeFile(path, corrupt);
				expect(await readGoogleTokenFile(path)).toBe(null);
				// Left alone: the corrupt bytes are untouched.
				expect(await readFile(path, "utf8")).toBe(corrupt);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
