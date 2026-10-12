import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchivedPage } from "@research/application";
import { describe, expect, it } from "vitest";
import { createFilePageArchive } from "../../src/node/pageArchive.ts";
import { webCryptoHasher } from "../../src/runtime/index.ts";

const PAGE: ArchivedPage = {
	sourceUrl: "https://news.synthetic-wire.org/feed-item",
	finalUrl: "https://news.synthetic-wire.org/2026/10/grid-battery-orders",
	title: "Grid battery orders double",
	retrievedAt: "2026-10-11T03:00:00.000Z",
	markdown: "# Grid battery orders double\n\nOrders doubled year over year.",
};

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "page-archive-test-"));
}

function frontMatter(content: string): {
	readonly fields: Map<string, string>;
	readonly body: string;
} {
	const lines = content.split("\n");
	expect(lines[0]).toBe("---");
	const fields = new Map<string, string>();
	let index = 1;
	for (; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line === "---") break;
		const colon = line.indexOf(":");
		expect(colon).toBeGreaterThan(0);
		fields.set(line.slice(0, colon), JSON.parse(line.slice(colon + 1).trim()) as string);
	}
	expect(lines[index]).toBe("---");
	expect(lines[index + 1]).toBe("");
	return { fields, body: lines.slice(index + 2).join("\n") };
}

describe("createFilePageArchive", () => {
	it("writes a file whose name carries date, host and URL hash", async () => {
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const saved = await archive.save(PAGE);
		if (!saved.ok) throw new Error(`unexpected failure ${saved.error.detail}`);
		const urlHash = createHash("sha256").update(PAGE.finalUrl, "utf8").digest("hex").slice(0, 16);
		expect(saved.value.fileName).toBe(`2026-10-11-news.synthetic-wire.org-${urlHash}.md`);
		expect(await readdir(directory)).toEqual([saved.value.fileName]);
	});

	it("writes front matter that parses back to the page", async () => {
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const saved = await archive.save(PAGE);
		if (!saved.ok) throw new Error("unexpected failure");
		const content = await readFile(join(directory, saved.value.fileName), "utf8");
		const { fields, body } = frontMatter(content);
		expect(fields.get("source_url")).toBe(PAGE.sourceUrl);
		expect(fields.get("final_url")).toBe(PAGE.finalUrl);
		expect(fields.get("title")).toBe(PAGE.title);
		expect(fields.get("retrieved_at")).toBe(PAGE.retrievedAt);
		expect(fields.get("generator")).toBe("research-workspace");
		expect(body).toBe(`${PAGE.markdown}\n`);
		const bodyHash = createHash("sha256").update(PAGE.markdown, "utf8").digest("hex");
		expect(fields.get("sha256")).toBe(bodyHash);
	});

	it("writes a null title as null", async () => {
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const saved = await archive.save({ ...PAGE, title: null });
		if (!saved.ok) throw new Error("unexpected failure");
		const content = await readFile(join(directory, saved.value.fileName), "utf8");
		expect(frontMatter(content).fields.get("title")).toBeNull();
	});

	it("keeps a hostile title inside one scalar", async () => {
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const hostile = 'x\n---\nsource_url: evil\ntitle: "injected';
		const saved = await archive.save({ ...PAGE, title: hostile });
		if (!saved.ok) throw new Error("unexpected failure");
		const content = await readFile(join(directory, saved.value.fileName), "utf8");
		const { fields } = frontMatter(content);
		expect(fields.get("title")).toBe(hostile);
		expect(fields.get("source_url")).toBe(PAGE.sourceUrl);
	});

	it("never lets hostile hostname characters reach the file name", async () => {
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const saved = await archive.save({ ...PAGE, finalUrl: "https://[::1]:8080/x?y=1" });
		if (!saved.ok) throw new Error("unexpected failure");
		expect(saved.value.fileName).toMatch(/^[0-9-]{10}-[a-z0-9.-]{1,80}-[0-9a-f]{16}\.md$/);
		expect(saved.value.fileName).not.toContain("[");
		expect(saved.value.fileName).not.toContain(":");
	});

	it("creates the directory with mode 0700 and files with mode 0600", async () => {
		const parent = await tempDir();
		const directory = join(parent, "nested", "archive");
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const saved = await archive.save(PAGE);
		if (!saved.ok) throw new Error("unexpected failure");
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(join(directory, saved.value.fileName))).mode & 0o777).toBe(0o600);
	});

	it("replaces the file when the same URL is saved again on the same day", async () => {
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const first = await archive.save(PAGE);
		const second = await archive.save({ ...PAGE, markdown: "updated body" });
		if (!first.ok || !second.ok) throw new Error("unexpected failure");
		expect(second.value.fileName).toBe(first.value.fileName);
		expect(await readdir(directory)).toHaveLength(1);
		const content = await readFile(join(directory, second.value.fileName), "utf8");
		expect(frontMatter(content).body).toBe("updated body\n");
	});

	it("adds a file when the same URL is saved on another day", async () => {
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const first = await archive.save(PAGE);
		const second = await archive.save({ ...PAGE, retrievedAt: "2026-10-12T03:00:00.000Z" });
		if (!first.ok || !second.ok) throw new Error("unexpected failure");
		expect(second.value.fileName).not.toBe(first.value.fileName);
		expect(await readdir(directory)).toHaveLength(2);
	});

	it("leaves no temp files behind on a failed write", async () => {
		const { chmod } = await import("node:fs/promises");
		const directory = await tempDir();
		const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const saved = await archive.save(PAGE);
		if (!saved.ok) throw new Error("unexpected failure");
		await chmod(directory, 0o500);
		try {
			const failed = await archive.save({ ...PAGE, markdown: "cannot land" });
			expect(failed.ok).toBe(false);
			if (failed.ok) throw new Error("expected failure");
			expect(failed.error.code).toBe("ARCHIVE_WRITE_FAILED");
			// The detail names the failure class/code, never the page or a path.
			expect(failed.error.detail).toMatch(/^[A-Za-z0-9_]+$/);
			expect(failed.error.detail).not.toContain("cannot land");
			expect(failed.error.detail).not.toContain(directory);
			expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
		} finally {
			await chmod(directory, 0o700);
		}
	});

	it("yields ARCHIVE_WRITE_FAILED instead of throwing for an unwritable directory", async () => {
		const { chmod } = await import("node:fs/promises");
		const parent = await tempDir();
		const directory = join(parent, "locked");
		const setup = createFilePageArchive({ directory, hasher: webCryptoHasher });
		const first = await setup.save(PAGE);
		if (!first.ok) throw new Error("unexpected failure");
		await chmod(directory, 0o500);
		try {
			const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
			const failed = await archive.save(PAGE);
			expect(failed).toMatchObject({ ok: false, error: { code: "ARCHIVE_WRITE_FAILED" } });
		} finally {
			await chmod(directory, 0o700);
		}
	});
});
