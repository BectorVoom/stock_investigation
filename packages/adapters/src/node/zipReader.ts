import { inflateRawSync } from "node:zlib";
import { err, ok, type Result } from "@research/domain";

/**
 * Minimal ZIP reader for downloaded `.xlsx` workbooks (FR-018, JPX) and
 * EDINET's XBRL-to-CSV archives (ADR-0045). It understands exactly what
 * those downloads need: stored (method 0) and deflated (method 8) entries
 * looked up by exact name via the central directory, then the local header
 * to find the data.
 *
 * The archive is untrusted input (SEC-001), so the reader fails closed:
 * archives over the archive ceiling (4 MB unless the caller passes its own
 * `ZipLimits`) are rejected before parsing, only the requested entries are
 * ever inflated, each inflated entry is capped (16 MB by default, zlib's
 * `maxOutputLength`), and ZIP64, encrypted or multi-disk archives are
 * rejected outright. Entry names are matched exactly and never used as paths.
 */

export type ZipReaderError =
	| "ARCHIVE_TOO_LARGE"
	| "NOT_A_ZIP"
	| "UNSUPPORTED_ZIP"
	| "ENTRY_NOT_FOUND"
	| "ENTRY_TOO_LARGE"
	| "CORRUPT_ENTRY";

/** Archive ceiling: the observed JPX workbook is ~235 kB zipped. */
export const MAX_ZIP_ARCHIVE_BYTES = 4_194_304;
/** Per-entry inflation ceiling, enforced by zlib itself. */
export const MAX_ZIP_ENTRY_BYTES = 16_777_216;

/**
 * Ceilings of one read. A caller whose documents are larger than the JPX
 * workbook (EDINET: 16 MB archives, 64 MB CSV entries) raises them for its
 * own calls only; the defaults stay the JPX ones.
 */
export interface ZipLimits {
	readonly maxArchiveBytes: number;
	readonly maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
	maxArchiveBytes: MAX_ZIP_ARCHIVE_BYTES,
	maxEntryBytes: MAX_ZIP_ENTRY_BYTES,
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
/** General-purpose flag bit 0: encryption. Any encrypted entry fails closed. */
const FLAG_ENCRYPTED = 0x1;
/** Values meaning "see the ZIP64 extra field", which this reader does not parse. */
const ZIP64_COUNT_SENTINEL = 0xffff;
const ZIP64_SIZE_SENTINEL = 0xffffffff;

interface CentralEntry {
	readonly flags: number;
	readonly method: number;
	readonly compressedSize: number;
	readonly uncompressedSize: number;
	readonly localHeaderOffset: number;
}

function readU16(view: DataView, offset: number): number {
	return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
	return view.getUint32(offset, true);
}

/** The end-of-central-directory record: scanned from the tail, like every ZIP reader. */
function findCentralDirectory(
	bytes: Uint8Array,
): Result<{ readonly offset: number; readonly count: number }, ZipReaderError> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tailStart = Math.max(0, bytes.byteLength - 65_557 - 22);
	for (let offset = bytes.byteLength - 22; offset >= tailStart; offset -= 1) {
		if (readU32(view, offset) !== EOCD_SIGNATURE) continue;
		const diskNumber = readU16(view, offset + 4);
		const directoryDisk = readU16(view, offset + 6);
		const entriesOnDisk = readU16(view, offset + 8);
		const totalEntries = readU16(view, offset + 10);
		const directorySize = readU32(view, offset + 12);
		const directoryOffset = readU32(view, offset + 16);
		if (diskNumber !== 0 || directoryDisk !== 0) return err("UNSUPPORTED_ZIP");
		if (entriesOnDisk !== totalEntries) return err("UNSUPPORTED_ZIP");
		if (
			entriesOnDisk === ZIP64_COUNT_SENTINEL ||
			directorySize === ZIP64_SIZE_SENTINEL ||
			directoryOffset === ZIP64_SIZE_SENTINEL
		) {
			return err("UNSUPPORTED_ZIP");
		}
		if (directoryOffset + directorySize > bytes.byteLength) return err("CORRUPT_ENTRY");
		return ok({ offset: directoryOffset, count: entriesOnDisk });
	}
	return err("NOT_A_ZIP");
}

function readCentralEntry(
	view: DataView,
	bytes: Uint8Array,
	offset: number,
): Result<
	{ readonly name: string; readonly entry: CentralEntry; readonly next: number },
	ZipReaderError
> {
	if (offset + 46 > bytes.byteLength) return err("CORRUPT_ENTRY");
	if (readU32(view, offset) !== CENTRAL_SIGNATURE) return err("CORRUPT_ENTRY");
	const flags = readU16(view, offset + 8);
	const method = readU16(view, offset + 10);
	const compressedSize = readU32(view, offset + 20);
	const uncompressedSize = readU32(view, offset + 24);
	const nameLength = readU16(view, offset + 28);
	const extraLength = readU16(view, offset + 30);
	const commentLength = readU16(view, offset + 32);
	const localHeaderOffset = readU32(view, offset + 42);
	const nameStart = offset + 46;
	const nameEnd = nameStart + nameLength;
	if (nameEnd + extraLength + commentLength > bytes.byteLength) return err("CORRUPT_ENTRY");
	if (localHeaderOffset >= bytes.byteLength) return err("CORRUPT_ENTRY");
	const name = new TextDecoder("utf-8").decode(bytes.subarray(nameStart, nameEnd));
	return ok({
		name,
		entry: { flags, method, compressedSize, uncompressedSize, localHeaderOffset },
		next: nameEnd + extraLength + commentLength,
	});
}

function entryData(bytes: Uint8Array, entry: CentralEntry): Result<Uint8Array, ZipReaderError> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const base = entry.localHeaderOffset;
	if (base + 30 > bytes.byteLength) return err("CORRUPT_ENTRY");
	if (readU32(view, base) !== LOCAL_SIGNATURE) return err("CORRUPT_ENTRY");
	if ((readU16(view, base + 6) & FLAG_ENCRYPTED) !== 0) return err("UNSUPPORTED_ZIP");
	if (readU16(view, base + 8) !== entry.method) return err("CORRUPT_ENTRY");
	const nameLength = readU16(view, base + 26);
	const extraLength = readU16(view, base + 28);
	const dataStart = base + 30 + nameLength + extraLength;
	const dataEnd = dataStart + entry.compressedSize;
	if (dataEnd > bytes.byteLength) return err("CORRUPT_ENTRY");
	return ok(bytes.subarray(dataStart, dataEnd));
}

function inflateEntry(
	data: Uint8Array,
	entry: CentralEntry,
	maxEntryBytes: number,
): Result<Uint8Array, ZipReaderError> {
	if (entry.uncompressedSize > maxEntryBytes) return err("ENTRY_TOO_LARGE");
	if (entry.method === METHOD_STORED) {
		if (entry.compressedSize !== entry.uncompressedSize) return err("CORRUPT_ENTRY");
		return ok(Uint8Array.from(data));
	}
	if (entry.method !== METHOD_DEFLATED) return err("UNSUPPORTED_ZIP");
	try {
		const inflated = inflateRawSync(data, { maxOutputLength: maxEntryBytes });
		if (inflated.byteLength !== entry.uncompressedSize) return err("CORRUPT_ENTRY");
		return ok(new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength));
	} catch (error) {
		// Past the ceiling zlib refuses the allocation (`ERR_BUFFER_TOO_LARGE`
		// on this Node line; `ERR_ZLIB_MAX_OUTPUT_LENGTH_EXCEEDED` elsewhere);
		// anything else is a corrupt deflate stream. Either way there is no entry.
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ERR_BUFFER_TOO_LARGE" ||
				error.code === "ERR_ZLIB_MAX_OUTPUT_LENGTH_EXCEEDED")
		) {
			return err("ENTRY_TOO_LARGE");
		}
		return err("CORRUPT_ENTRY");
	}
}

/** Every central-directory entry name with its record, in directory order. */
function centralEntries(
	archive: Uint8Array,
	limits: ZipLimits,
): Result<readonly { readonly name: string; readonly entry: CentralEntry }[], ZipReaderError> {
	if (archive.byteLength > limits.maxArchiveBytes) return err("ARCHIVE_TOO_LARGE");
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	const directory = findCentralDirectory(archive);
	if (!directory.ok) return err(directory.error);
	const records: { readonly name: string; readonly entry: CentralEntry }[] = [];
	let offset = directory.value.offset;
	for (let index = 0; index < directory.value.count; index += 1) {
		const record = readCentralEntry(view, archive, offset);
		if (!record.ok) return err(record.error);
		records.push({ name: record.value.name, entry: record.value.entry });
		offset = record.value.next;
	}
	return ok(records);
}

/**
 * The entry names of a ZIP archive in central-directory order (repeats
 * kept), without inflating anything: a caller that knows only a name
 * pattern (EDINET's `XBRL_TO_CSV/jpcrp…` report) picks its entry first.
 */
export function listZipEntries(
	archive: Uint8Array,
	limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Result<readonly string[], ZipReaderError> {
	const records = centralEntries(archive, limits);
	return records.ok ? ok(records.value.map((record) => record.name)) : records;
}

/**
 * Extracts exactly the named entries from a ZIP archive. Names that are not
 * present fail the whole read (`ENTRY_NOT_FOUND`): a workbook missing its
 * sheet or its shared strings is corrupt, not half-usable.
 */
export function readZipEntries(
	archive: Uint8Array,
	names: readonly string[],
	limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Result<ReadonlyMap<string, Uint8Array>, ZipReaderError> {
	const records = centralEntries(archive, limits);
	if (!records.ok) return err(records.error);
	const wanted = new Set(names);
	const found = new Map<string, CentralEntry>();
	for (const record of records.value) {
		if (wanted.has(record.name) && !found.has(record.name)) found.set(record.name, record.entry);
	}
	const extracted = new Map<string, Uint8Array>();
	for (const name of names) {
		const entry = found.get(name);
		if (entry === undefined) return err("ENTRY_NOT_FOUND");
		if ((entry.flags & FLAG_ENCRYPTED) !== 0) return err("UNSUPPORTED_ZIP");
		const data = entryData(archive, entry);
		if (!data.ok) return err(data.error);
		const inflated = inflateEntry(data.value, entry, limits.maxEntryBytes);
		if (!inflated.ok) return err(inflated.error);
		extracted.set(name, inflated.value);
	}
	return ok(extracted);
}
