//! Minimal fail-closed ZIP reader for JPX workbooks (FR-018, SEC-001).
//! Deliberately does not validate CRC or substitute a general ZIP implementation.
use flate2::read::DeflateDecoder;
use std::{collections::BTreeMap, io::Read};
/// Maximum downloaded archive bytes.
pub const MAX_ZIP_ARCHIVE_BYTES: usize = 4_194_304;
/// Maximum inflated bytes per requested entry.
pub const MAX_ZIP_ENTRY_BYTES: usize = 16_777_216;
/// Exact TypeScript reader failure codes, in validation order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ZipReaderError {
	/// Archive cap exceeded.
	#[error("ARCHIVE_TOO_LARGE")]
	ArchiveTooLarge,
	/// No end-of-central-directory record.
	#[error("NOT_A_ZIP")]
	NotAZip,
	/// Encryption, ZIP64, multi-disk, or an unsupported method.
	#[error("UNSUPPORTED_ZIP")]
	UnsupportedZip,
	/// Requested name absent.
	#[error("ENTRY_NOT_FOUND")]
	EntryNotFound,
	/// Declared or actual inflated size exceeds the cap.
	#[error("ENTRY_TOO_LARGE")]
	EntryTooLarge,
	/// Invalid bounds, signatures or compressed bytes.
	#[error("CORRUPT_ENTRY")]
	CorruptEntry,
}
use ZipReaderError::*;
fn u16_at(bytes: &[u8], at: usize) -> Result<u16, ZipReaderError> {
	Ok(u16::from_le_bytes(
		bytes
			.get(at..at + 2)
			.and_then(|v| v.try_into().ok())
			.ok_or(CorruptEntry)?,
	))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, ZipReaderError> {
	Ok(u32::from_le_bytes(
		bytes
			.get(at..at + 4)
			.and_then(|v| v.try_into().ok())
			.ok_or(CorruptEntry)?,
	))
}
fn size(bytes: &[u8], at: usize) -> Result<usize, ZipReaderError> {
	usize::try_from(u32_at(bytes, at)?).map_err(|_| CorruptEntry)
}
struct Entry {
	flags: u16,
	method: u16,
	compressed: usize,
	uncompressed: usize,
	offset: usize,
}
fn directory(bytes: &[u8]) -> Result<(usize, u16), ZipReaderError> {
	let Some(last) = bytes.len().checked_sub(22) else {
		return Err(NotAZip);
	};
	let first = bytes.len().saturating_sub(65_557 + 22);
	for at in (first..=last).rev() {
		if u32_at(bytes, at)? != 0x0605_4b50 {
			continue;
		}
		let count = u16_at(bytes, at + 8)?;
		let len = u32_at(bytes, at + 12)?;
		let offset = u32_at(bytes, at + 16)?;
		if u16_at(bytes, at + 4)? != 0
			|| u16_at(bytes, at + 6)? != 0
			|| count != u16_at(bytes, at + 10)?
			|| count == u16::MAX
			|| len == u32::MAX
			|| offset == u32::MAX
		{
			return Err(UnsupportedZip);
		}
		let len = usize::try_from(len).map_err(|_| CorruptEntry)?;
		let offset = usize::try_from(offset).map_err(|_| CorruptEntry)?;
		if offset + len > bytes.len() {
			return Err(CorruptEntry);
		}
		return Ok((offset, count));
	}
	Err(NotAZip)
}
fn inflate(bytes: &[u8], e: &Entry) -> Result<Vec<u8>, ZipReaderError> {
	if e.flags & 1 != 0 {
		return Err(UnsupportedZip);
	}
	let at = e.offset;
	if at + 30 > bytes.len() || u32_at(bytes, at)? != 0x0403_4b50 {
		return Err(CorruptEntry);
	}
	if u16_at(bytes, at + 6)? & 1 != 0 {
		return Err(UnsupportedZip);
	}
	if u16_at(bytes, at + 8)? != e.method {
		return Err(CorruptEntry);
	}
	let start =
		at + 30 + usize::from(u16_at(bytes, at + 26)?) + usize::from(u16_at(bytes, at + 28)?);
	let data = bytes.get(start..start + e.compressed).ok_or(CorruptEntry)?;
	if e.uncompressed > MAX_ZIP_ENTRY_BYTES {
		return Err(EntryTooLarge);
	}
	if e.method == 0 {
		return if e.compressed == e.uncompressed {
			Ok(data.to_vec())
		} else {
			Err(CorruptEntry)
		};
	}
	if e.method != 8 {
		return Err(UnsupportedZip);
	}
	// Read at most cap+1 bytes, so even a dishonest declared size cannot allocate a bomb.
	let mut output = Vec::with_capacity(e.uncompressed.min(MAX_ZIP_ENTRY_BYTES));
	let result = DeflateDecoder::new(data)
		.take(16_777_217)
		.read_to_end(&mut output);
	if output.len() > MAX_ZIP_ENTRY_BYTES {
		return Err(EntryTooLarge);
	}
	result.map_err(|_| CorruptEntry)?;
	if output.len() != e.uncompressed {
		return Err(CorruptEntry);
	}
	Ok(output)
}
/// Extracts exactly the requested names; first duplicate central entry wins.
pub fn read_zip_entries(
	bytes: &[u8],
	names: &[&str],
) -> Result<BTreeMap<String, Vec<u8>>, ZipReaderError> {
	if bytes.len() > MAX_ZIP_ARCHIVE_BYTES {
		return Err(ArchiveTooLarge);
	}
	let (mut at, count) = directory(bytes)?;
	let mut found = BTreeMap::new();
	for _ in 0..count {
		if at + 46 > bytes.len() || u32_at(bytes, at)? != 0x0201_4b50 {
			return Err(CorruptEntry);
		}
		let start = at + 46;
		let end = start + usize::from(u16_at(bytes, at + 28)?);
		let next =
			end + usize::from(u16_at(bytes, at + 30)?) + usize::from(u16_at(bytes, at + 32)?);
		let entry = Entry {
			flags: u16_at(bytes, at + 8)?,
			method: u16_at(bytes, at + 10)?,
			compressed: size(bytes, at + 20)?,
			uncompressed: size(bytes, at + 24)?,
			offset: size(bytes, at + 42)?,
		};
		if next > bytes.len() || entry.offset >= bytes.len() {
			return Err(CorruptEntry);
		}
		let raw = bytes.get(start..end).ok_or(CorruptEntry)?;
		let name = String::from_utf8_lossy(raw);
		let name = name.strip_prefix('\u{feff}').unwrap_or(&name);
		if names.contains(&name) {
			found.entry(name.to_owned()).or_insert(entry);
		}
		at = next;
	}
	let mut out = BTreeMap::new();
	for name in names {
		out.insert(
			(*name).to_owned(),
			inflate(bytes, found.get(*name).ok_or(EntryNotFound)?)?,
		);
	}
	Ok(out)
}
