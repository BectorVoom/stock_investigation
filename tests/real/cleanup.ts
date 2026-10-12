import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Finished generations are read-only: make a throwaway tree writable first
 * so the suite can delete it. Best effort throughout; the `rm` that follows
 * reports the real failure.
 */
export function makeWritableTree(dir: string): void {
	let entries: { name: string; isDir: boolean }[] = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
			name: entry.name,
			isDir: entry.isDirectory(),
		}));
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDir) makeWritableTree(full);
		try {
			chmodSync(full, entry.isDir ? 0o755 : 0o644);
		} catch {
			// Best effort.
		}
	}
	try {
		chmodSync(dir, 0o755);
	} catch {
		// Best effort.
	}
}
