//! Minimal fail-closed ZIP reader for JPX workbooks (FR-018, SEC-001) and
//! EDINET's XBRL-to-CSV archives (ADR-0045). Deliberately does not validate
//! CRC or substitute a general ZIP implementation.
use flate2::read::DeflateDecoder;
use std::{collections::BTreeMap, io::Read};
/// Maximum downloaded archive bytes.
pub const MAX_ZIP_ARCHIVE_BYTES: usize = 4_194_304;
/// Maximum inflated bytes per requested entry.
pub const MAX_ZIP_ENTRY_BYTES: usize = 16_777_216;

/// Ceilings of one read (`ZipLimits`). A caller whose documents are larger
/// than the JPX workbook (EDINET: 16 MB archives, 64 MB CSV entries) raises
/// them for its own calls only; the defaults stay the JPX ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZipLimits {
	/// Maximum archive bytes.
	pub max_archive_bytes: usize,
	/// Maximum inflated bytes per requested entry.
	pub max_entry_bytes: usize,
}

/// `DEFAULT_ZIP_LIMITS`: the JPX ceilings.
pub const DEFAULT_ZIP_LIMITS: ZipLimits = ZipLimits {
	max_archive_bytes: MAX_ZIP_ARCHIVE_BYTES,
	max_entry_bytes: MAX_ZIP_ENTRY_BYTES,
};
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
fn inflate(bytes: &[u8], e: &Entry, max_entry_bytes: usize) -> Result<Vec<u8>, ZipReaderError> {
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
	if e.uncompressed > max_entry_bytes {
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
	let mut output = Vec::with_capacity(e.uncompressed.min(max_entry_bytes));
	let cap = u64::try_from(max_entry_bytes)
		.unwrap_or(u64::MAX)
		.saturating_add(1);
	let result = DeflateDecoder::new(data).take(cap).read_to_end(&mut output);
	if output.len() > max_entry_bytes {
		return Err(EntryTooLarge);
	}
	result.map_err(|_| CorruptEntry)?;
	if output.len() != e.uncompressed {
		return Err(CorruptEntry);
	}
	Ok(output)
}
/// Every central-directory record (name, entry) in directory order, repeats kept.
fn central_entries(
	bytes: &[u8],
	limits: ZipLimits,
) -> Result<Vec<(String, Entry)>, ZipReaderError> {
	if bytes.len() > limits.max_archive_bytes {
		return Err(ArchiveTooLarge);
	}
	let (mut at, count) = directory(bytes)?;
	let mut records = Vec::with_capacity(usize::from(count));
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
		let name = name.strip_prefix('\u{feff}').unwrap_or(&name).to_owned();
		records.push((name, entry));
		at = next;
	}
	Ok(records)
}

/// `listZipEntries`: the entry names in central-directory order (repeats
/// kept), without inflating anything, so a caller that knows only a name
/// pattern (EDINET's `XBRL_TO_CSV/jpcrp…` report) can pick its entry first.
pub fn list_zip_entries(bytes: &[u8], limits: ZipLimits) -> Result<Vec<String>, ZipReaderError> {
	Ok(central_entries(bytes, limits)?
		.into_iter()
		.map(|(name, _)| name)
		.collect())
}

/// Extracts exactly the requested names; first duplicate central entry wins.
pub fn read_zip_entries(
	bytes: &[u8],
	names: &[&str],
) -> Result<BTreeMap<String, Vec<u8>>, ZipReaderError> {
	read_zip_entries_within(bytes, names, DEFAULT_ZIP_LIMITS)
}

/// [`read_zip_entries`] under the caller's own ceilings.
pub fn read_zip_entries_within(
	bytes: &[u8],
	names: &[&str],
	limits: ZipLimits,
) -> Result<BTreeMap<String, Vec<u8>>, ZipReaderError> {
	let mut found: BTreeMap<String, Entry> = BTreeMap::new();
	for (name, entry) in central_entries(bytes, limits)? {
		if names.contains(&name.as_str()) {
			found.entry(name).or_insert(entry);
		}
	}
	let mut out = BTreeMap::new();
	for name in names {
		out.insert(
			(*name).to_owned(),
			inflate(
				bytes,
				found.get(*name).ok_or(EntryNotFound)?,
				limits.max_entry_bytes,
			)?,
		);
	}
	Ok(out)
}
