//! Streaming TextDecoder and UTF-16 bounded line splitting.
use research_js::utf16::{slice, utf16_len};

/// The same bound as `splitLines` in the CLI and SSE adapters.
pub const MAX_LINE_CHARS: usize = 16 * 1024 * 1024;
/// A lossy UTF-8 decoder which retains incomplete multibyte sequences.
#[derive(Default)]
pub struct Utf8Decoder {
	pending: Vec<u8>,
	started: bool,
	strip_bom: bool,
}
impl Utf8Decoder {
	/// stdout strips one BOM; stderr preserves it.
	pub fn new(strip_bom: bool) -> Self {
		Self {
			strip_bom,
			..Self::default()
		}
	}
	/// Decodes bytes; `end` flushes incomplete input as U+FFFD.
	pub fn push(&mut self, bytes: &[u8], end: bool) -> String {
		self.pending.extend_from_slice(bytes);
		let length = if end {
			self.pending.len()
		} else {
			match std::str::from_utf8(&self.pending) {
				Ok(_) => self.pending.len(),
				Err(_) => {
					// Only an incomplete sequence at the end is retained. Invalid bytes
					// elsewhere are consumed by the WHATWG maximal-subpart replacement.
					let mut offset = 0;
					loop {
						match std::str::from_utf8(self.pending.get(offset..).unwrap_or_default()) {
							Ok(_) => break self.pending.len(),
							Err(error) => {
								offset += error.valid_up_to();
								if let Some(n) = error.error_len() {
									offset += n;
								} else {
									break offset;
								}
							}
						}
					}
				}
			}
		};
		let mut text =
			String::from_utf8_lossy(self.pending.get(..length).unwrap_or_default()).into_owned();
		self.pending.drain(..length);
		if !self.started && !text.is_empty() {
			self.started = true;
			if self.strip_bom && text.starts_with('\u{feff}') {
				text.drain(..3);
			}
		}
		text
	}
}
/// Incremental line splitter. String chunks deliberately bypass BOM decoding.
pub struct LineSplitter {
	decoder: Utf8Decoder,
	pending: String,
	max: usize,
}
impl LineSplitter {
	/// Limits are UTF-16 code units, including astral characters.
	pub fn new(max: usize) -> Self {
		Self {
			decoder: Utf8Decoder::new(true),
			pending: String::new(),
			max: max.max(1),
		}
	}
	/// A byte chunk from stdout / HTTP.
	pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
		let text = self.decoder.push(bytes, false);
		self.push_text(&text)
	}
	/// A string chunk (scripted Node process runners do not strip its BOM).
	pub fn push_text(&mut self, text: &str) -> Vec<String> {
		self.pending.push_str(text);
		let mut lines = Vec::new();
		let mut consumed = 0;
		for newline in memchr::memchr_iter(b'\n', self.pending.as_bytes()) {
			let line = self.pending.get(consumed..newline).unwrap_or_default();
			lines.push(line.strip_suffix('\r').unwrap_or(line).to_owned());
			consumed = newline + 1;
		}
		if consumed > 0 {
			self.pending.drain(..consumed);
		}
		let mut units = utf16_len(&self.pending);
		while units > self.max {
			lines.push(slice(&self.pending, 0, self.max).into_owned());
			self.pending = slice(&self.pending, self.max, units).into_owned();
			units -= self.max;
		}
		lines
	}
	/// Flushes the decoder and final unterminated line.
	pub fn finish(&mut self) -> Vec<String> {
		let text = self.decoder.push(&[], true);
		// TS does not force-split the final decoder flush.
		self.pending.push_str(&text);
		if self.pending.is_empty() {
			vec![]
		} else {
			let pending = std::mem::take(&mut self.pending);
			vec![pending.strip_suffix('\r').unwrap_or(&pending).to_owned()]
		}
	}
}
