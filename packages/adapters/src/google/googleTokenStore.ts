/**
 * Runner-side refresh-token file (FR-019 section 2.2). Lives beside
 * `runner-credential.json` (the launch plan gives the path); holds the
 * refresh token and the calendar id, nothing else. Access tokens stay in
 * memory and never reach this file.
 *
 * A corrupt or unreadable file means "not connected" (the caller logs a
 * stable code): the file is left alone, never deleted or rewritten here.
 * Writes are atomic (temp file + rename) with mode 0600, so a crash can
 * never leave a half-written or world-readable token file behind.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseJson } from "@research/domain";
import { z } from "zod";

const tokenFileSchema = z.strictObject({
	version: z.literal(1),
	refreshToken: z.string().min(1).max(2000),
	calendarId: z.string().min(1).max(256),
	scope: z.string().min(1).max(200),
	savedAt: z.string().min(1).max(64),
});

export type GoogleTokenRecord = z.infer<typeof tokenFileSchema>;

/** Reads the token file; null when missing, unreadable or corrupt ("not connected"). */
export async function readGoogleTokenFile(path: string): Promise<GoogleTokenRecord | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	const value = parseJson(text);
	if (!value.ok) return null;
	const parsed = tokenFileSchema.safeParse(value.value);
	return parsed.success ? parsed.data : null;
}

/**
 * Writes the token file atomically with mode 0600: the parent directory is
 * created 0700, the record goes to a temp file beside the target (chmodded
 * 0600 explicitly, so no umask can leave it readable), then renamed over
 * the target. No temp file survives a successful write.
 */
export async function writeGoogleTokenFile(path: string, record: GoogleTokenRecord): Promise<void> {
	const parsed = tokenFileSchema.parse(record);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
		await chmod(temp, 0o600);
		await rename(temp, path);
	} catch (error) {
		// A failed write must not leave a token-bearing temp file behind.
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** Deletes the token file; missing files are already "disconnected". */
export async function deleteGoogleTokenFile(path: string): Promise<void> {
	await rm(path, { force: true });
}
