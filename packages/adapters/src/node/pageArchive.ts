/**
 * File-system `PageArchive` for the Node runner.
 *
 * The archive is write-only storage for already-retrieved pages: the file
 * name is built only from the retrieval date, the final URL's host and a
 * hash of the final URL, so no page content can steer where a file is
 * written (SEC-001). Front matter values are `JSON.stringify` scalars, so a
 * hostile title cannot break out of the front matter block.
 *
 * Error handling follows ADR-0007: `save` is one Effect program. Each
 * file-system step (`mkdir`, `writeFile`, `chmod`, `rename`) is lifted with
 * `attempt` from `@research/effects`, cleanup of the temporary file when a
 * later step fails is expressed with `Effect.onError` (a failed `unlink` is
 * swallowed with `Effect.ignore`), and every failure is mapped ONCE with
 * `Effect.mapError` to the typed `ARCHIVE_WRITE_FAILED` — detail is the OS
 * error code (`UnexpectedError.errorCode`, e.g. `EACCES`) or the error class,
 * never a path outside the archive directory and never page content. The
 * port's `Result` is produced with `toResult` at the edge.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchivedPage, Hasher, PageArchive } from "@research/application";
import { attempt, Effect, toResult } from "@research/effects";

export interface FilePageArchiveOptions {
	readonly directory: string;
	readonly hasher: Hasher;
}

type ArchiveWriteError = { readonly code: "ARCHIVE_WRITE_FAILED"; readonly detail: string };

function datePart(retrievedAt: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(retrievedAt);
	return match?.[1] ?? "0000-00-00";
}

/** Hostname reduced to `[a-z0-9.-]` and cut to 80 characters; never empty. */
function safeHost(finalUrl: string): string {
	let host = "unknown-host";
	try {
		host = new URL(finalUrl).hostname.toLowerCase();
	} catch {
		// A malformed URL names no host; the hash below still keeps the file unique.
	}
	const cleaned = host.replace(/[^a-z0-9.-]/g, "").slice(0, 80);
	return cleaned === "" ? "unknown-host" : cleaned;
}

function renderFile(page: ArchivedPage, bodyHash: string): string {
	const omitted = page.omitted ?? { boilerplateBlocks: 0, menuLists: 0, leadingBlocks: 0 };
	const lines = [
		"---",
		`source_url: ${JSON.stringify(page.sourceUrl)}`,
		`final_url: ${JSON.stringify(page.finalUrl)}`,
		`title: ${JSON.stringify(page.title)}`,
		`retrieved_at: ${JSON.stringify(page.retrievedAt)}`,
		`sha256: ${JSON.stringify(bodyHash)}`,
		`generator: ${JSON.stringify("research-workspace")}`,
		`omitted_boilerplate_blocks: ${JSON.stringify(omitted.boilerplateBlocks)}`,
		`omitted_menu_lists: ${JSON.stringify(omitted.menuLists)}`,
		`omitted_leading_blocks: ${JSON.stringify(omitted.leadingBlocks)}`,
		"---",
		"",
		page.markdown,
		"",
	];
	return lines.join("\n");
}

export function createFilePageArchive(options: FilePageArchiveOptions): PageArchive {
	const directory = options.directory;
	const hasher = options.hasher;
	return {
		save: (page) =>
			toResult(
				Effect.gen(function* () {
					const prepared = yield* attempt("page-archive.save", async () => {
						const urlHash = await hasher.sha256Hex(page.finalUrl);
						const bodyHash = await hasher.sha256Hex(page.markdown);
						const fileName = `${datePart(page.retrievedAt)}-${safeHost(page.finalUrl)}-${urlHash.slice(0, 16)}.md`;
						return { fileName, content: renderFile(page, bodyHash) };
					});
					yield* attempt("page-archive.save", () =>
						mkdir(directory, { recursive: true, mode: 0o700 }),
					);
					const tmpPath = yield* attempt("page-archive.save", async () =>
						join(directory, `${prepared.fileName}.tmp-${randomBytes(8).toString("hex")}`),
					);
					const finalPath = join(directory, prepared.fileName);
					yield* Effect.gen(function* () {
						yield* attempt("page-archive.save", () =>
							writeFile(tmpPath, prepared.content, { mode: 0o600 }),
						);
						yield* attempt("page-archive.save", () => chmod(tmpPath, 0o600));
						yield* attempt("page-archive.save", () => rename(tmpPath, finalPath));
					}).pipe(
						// Never leave a half-written page behind; a failed rename keeps the old file.
						Effect.onError(() =>
							Effect.ignore(attempt("page-archive.save", () => unlink(tmpPath))),
						),
					);
					return { fileName: prepared.fileName };
				}).pipe(
					Effect.mapError(
						(failure): ArchiveWriteError => ({
							code: "ARCHIVE_WRITE_FAILED",
							detail: failure.errorCode ?? failure.errorName,
						}),
					),
				),
			),
	};
}
