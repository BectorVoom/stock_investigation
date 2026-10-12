/**
 * Offers text as a file download through a short-lived Blob URL. The content
 * never touches localStorage and the object URL is revoked right after the click.
 */
export function downloadTextFile(
	doc: Document,
	fileName: string,
	mimeType: string,
	text: string,
): void {
	const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
	const anchor = doc.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.rel = "noopener";
	doc.body.append(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/** A file-system-safe slug for export file names. */
export function fileSlug(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug === "" ? "workspace" : slug;
}
