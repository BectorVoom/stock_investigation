/** Minimal ZIP writer for tests (mirrors what the reader supports). Never a fixture file. */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE: readonly number[] = (() => {
	const table: number[] = [];
	for (let byte = 0; byte < 256; byte += 1) {
		let crc = byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc % 2 === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
		}
		table.push(crc >>> 0);
	}
	return table;
})();

export function testCrc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)) >>> 0;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
	return new Uint8Array([
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff,
	]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

export interface TestZipEntry {
	readonly name: string;
	readonly text: string;
	readonly method: 0 | 8;
}

/** A minimal ZIP with stored/deflated entries by exact name (test-only). */
export function buildTestZip(entries: readonly TestZipEntry[]): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const raw = encoder.encode(entry.text);
		const data = entry.method === 8 ? deflateRawSync(raw) : raw;
		const name = encoder.encode(entry.name);
		const header = concat([
			u32(0x04034b50),
			u16(20),
			u16(0),
			u16(entry.method),
			u16(0),
			u16(0),
			u32(testCrc32(raw)),
			u32(data.byteLength),
			u32(raw.byteLength),
			u16(name.byteLength),
			u16(0),
			name,
		]);
		locals.push(header, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		centrals.push(
			concat([
				u32(0x02014b50),
				u16(20),
				u16(20),
				u16(0),
				u16(entry.method),
				u16(0),
				u16(0),
				u32(testCrc32(raw)),
				u32(data.byteLength),
				u32(raw.byteLength),
				u16(name.byteLength),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(0),
				u32(offset),
				name,
			]),
		);
		offset += header.byteLength + data.byteLength;
	}
	const directory = concat(centrals);
	const end = concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(directory.byteLength),
		u32(offset),
		u16(0),
	]);
	return concat([...locals, directory, end]);
}

/** Byte offset of a little-endian signature, or -1. */
export function findSignature(archive: Uint8Array, signature: number): number {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	for (let offset = 0; offset + 4 <= archive.byteLength; offset += 1) {
		if (view.getUint32(offset, true) === signature) return offset;
	}
	return -1;
}

export function patchU16(archive: Uint8Array, offset: number, value: number): Uint8Array {
	const copy = Uint8Array.from(archive);
	new DataView(copy.buffer).setUint16(offset, value, true);
	return copy;
}

export function patchU32(archive: Uint8Array, offset: number, value: number): Uint8Array {
	const copy = Uint8Array.from(archive);
	new DataView(copy.buffer).setUint32(offset, value, true);
	return copy;
}

export function patchByte(archive: Uint8Array, offset: number, value: number): Uint8Array {
	const copy = Uint8Array.from(archive);
	copy[offset] = value;
	return copy;
}
