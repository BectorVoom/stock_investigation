//! Streaming `Content-Encoding` decoders (`decodedBody` in `pinnedConnect.ts`).
//!
//! Node pipes the wire bytes through `createGunzip` / `createInflate` /
//! `createBrotliDecompress`; the observable behaviour reproduced here
//! (checked against Node 23 by probes, see the tests):
//! - gzip: bytes after a member start a new member (`gzip, gzip` bodies
//!   decode to both; trailing garbage is `Z_DATA_ERROR`), except that a
//!   leftover starting with 0x00 is padding and ignored (per write, as Node);
//! - deflate (zlib-wrapped, NOT raw) and brotli: bytes after the end of the
//!   stream are ignored;
//! - an empty or truncated stream fails with `Z_BUF_ERROR` (Node: "unexpected
//!   end of file"), corrupt data with `Z_DATA_ERROR` (gzip/deflate) or
//!   `ERR_<brotli error name>` (brotli).
//!
//! Each [`ContentDecoder::step`] writes into a caller-sized buffer, so a
//! compression bomb never expands past one buffer before the caller's byte
//! count sees it.

use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState, StandardAlloc};
use flate2::{Decompress, FlushDecompress, Status};

/// A decoding failure, as Node's error code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeError(pub String);

impl DecodeError {
	fn truncated() -> Self {
		Self("Z_BUF_ERROR".to_owned())
	}
}

/// Progress of one decoding step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
	/// Input bytes consumed.
	pub consumed: usize,
	/// Output bytes written.
	pub produced: usize,
	/// Node ends the decoded stream here: the write left input the decoder did
	/// not take (zero padding after a gzip member, bytes after the end of a
	/// deflate or brotli stream). `zlib.js` `processCallback` then pushes the
	/// end of the stream, so later wire bytes are never looked at.
	pub ended: bool,
}

impl Step {
	const NONE: Self = Self {
		consumed: 0,
		produced: 0,
		ended: false,
	};

	/// The rest of the write is ignored and the decoded stream ends.
	fn end_after(consumed_all: usize, produced: usize) -> Self {
		Self {
			consumed: consumed_all,
			produced,
			ended: true,
		}
	}
}

/// One of the encodings Node's pinned connect decodes.
pub enum ContentDecoder {
	/// `gzip` / `x-gzip` (multi-member).
	Gzip {
		/// The current member's inflater.
		inflater: Box<Decompress>,
		/// The current member ended; more input starts a new member.
		member_done: bool,
	},
	/// `deflate`: a zlib-wrapped stream.
	Deflate {
		/// The inflater.
		inflater: Box<Decompress>,
		/// The stream ended; further input is ignored.
		done: bool,
	},
	/// `br`.
	Brotli {
		/// Decoder state (large, so boxed).
		state: Box<BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>>,
		/// The stream ended; further input is ignored.
		done: bool,
	},
}

impl std::fmt::Debug for ContentDecoder {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter.write_str(match self {
			Self::Gzip { .. } => "ContentDecoder::Gzip",
			Self::Deflate { .. } => "ContentDecoder::Deflate",
			Self::Brotli { .. } => "ContentDecoder::Brotli",
		})
	}
}

/// How a response body is to be decoded.
#[derive(Debug)]
pub enum Encoding {
	/// `identity` or empty: passed through, so the caller's count IS the wire count.
	Identity,
	/// Decoded here; wire bytes are counted separately.
	Decoded(ContentDecoder),
	/// Anything else (`zstd`, lists such as `gzip, br`): refused.
	Unsupported,
}

fn new_gzip_member() -> Box<Decompress> {
	Box::new(Decompress::new_gzip(15))
}

/// The decoder for a `Content-Encoding` value (first value, trimmed, lower-cased).
#[must_use]
pub fn encoding_for(content_encoding: Option<&str>) -> Encoding {
	let value = content_encoding.map_or_else(
		|| "identity".to_owned(),
		|value| research_js::whitespace::trim(value).to_lowercase(),
	);
	match value.as_str() {
		"identity" | "" => Encoding::Identity,
		"gzip" | "x-gzip" => Encoding::Decoded(ContentDecoder::Gzip {
			inflater: new_gzip_member(),
			member_done: false,
		}),
		"deflate" => Encoding::Decoded(ContentDecoder::Deflate {
			inflater: Box::new(Decompress::new(true)),
			done: false,
		}),
		"br" => {
			let mut state = Box::new(BrotliState::new(
				StandardAlloc::default(),
				StandardAlloc::default(),
				StandardAlloc::default(),
			));
			// Node's decoder leaves BROTLI_DECODER_PARAM_LARGE_WINDOW off.
			state.large_window = false;
			Encoding::Decoded(ContentDecoder::Brotli { state, done: false })
		}
		_ => Encoding::Unsupported,
	}
}

/// Node's code for a brotli failure: "ERR_" + the C error name without
/// "BROTLI_DECODER", e.g. `ERR__ERROR_FORMAT_PADDING_2`.
fn brotli_error(state: &BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>) -> DecodeError {
	// KNOWN DIVERGENCE (brotli-decompressor 5.0.3): C brotli also checks a
	// negative meta-block remainder in BROTLI_STATE_METABLOCK_DONE
	// (BLOCK_LENGTH_2); the Rust port only has the ring-buffer check
	// (BLOCK_LENGTH_1), so some corrupt streams carry the other name.
	let name = format!("{:?}", state.error_code);
	let suffix = name.strip_prefix("BROTLI_DECODER").unwrap_or(&name);
	DecodeError(format!("ERR_{suffix}"))
}

fn delta(after: u64, before: u64) -> usize {
	usize::try_from(after.saturating_sub(before)).unwrap_or(usize::MAX)
}

fn inflate_error(error: &flate2::DecompressError) -> DecodeError {
	DecodeError(if error.needs_dictionary().is_some() {
		"Z_NEED_DICT".to_owned()
	} else {
		"Z_DATA_ERROR".to_owned()
	})
}

/// One inflate call; `Ok((consumed, produced, stream_end))`.
fn inflate(
	inflater: &mut Decompress,
	input: &[u8],
	output: &mut [u8],
) -> Result<(usize, usize, bool), DecodeError> {
	let (in_before, out_before) = (inflater.total_in(), inflater.total_out());
	let status = inflater
		.decompress(input, output, FlushDecompress::None)
		.map_err(|error| inflate_error(&error))?;
	Ok((
		delta(inflater.total_in(), in_before),
		delta(inflater.total_out(), out_before),
		status == Status::StreamEnd,
	))
}

/// What C zlib's `inflate` does in ONE call, over zlib-rs (which may return
/// earlier, e.g. before reading a gzip trailer): keep going while there is
/// progress, until the output is full, the input is exhausted or the stream
/// ends. An error discards the whole call's output, as Node does.
fn inflate_call(
	inflater: &mut Decompress,
	input: &[u8],
	output: &mut [u8],
	consumed: &mut usize,
	produced: &mut usize,
) -> Result<bool, DecodeError> {
	loop {
		let rest_in = input.get(*consumed..).unwrap_or(&[]);
		let rest_out = output.get_mut(*produced..).unwrap_or(&mut []);
		if rest_out.is_empty() {
			return Ok(false);
		}
		let (used, wrote, ended) = inflate(inflater, rest_in, rest_out)?;
		*consumed += used;
		*produced += wrote;
		if ended {
			return Ok(true);
		}
		if used == 0 && wrote == 0 {
			return Ok(false);
		}
	}
}

impl ContentDecoder {
	/// One Node decoder call over one write (`input`) into `output`.
	/// Call again with the unconsumed rest while `consumed < input.len()` and
	/// not `ended` (the output was full).
	///
	/// # Errors
	/// Corrupt data, with Node's error code; the call's output is discarded.
	pub fn step(&mut self, input: &[u8], output: &mut [u8]) -> Result<Step, DecodeError> {
		if input.is_empty() {
			return Ok(Step::NONE);
		}
		match self {
			Self::Gzip {
				inflater,
				member_done,
			} => {
				let mut consumed = 0;
				let mut produced = 0;
				loop {
					if *member_done {
						// Node's zlib (`ZlibContext::DoThreadPoolWork`, GUNZIP): after a
						// member ends, leftover input starts a new member unless its
						// first byte is 0x00 — padding, which leaves the rest of the
						// write unconsumed and so ends the stream.
						match input.get(consumed) {
							None => break,
							Some(0) => return Ok(Step::end_after(input.len(), produced)),
							Some(_) => {
								*inflater = new_gzip_member();
								*member_done = false;
							}
						}
					}
					let ended =
						inflate_call(inflater, input, output, &mut consumed, &mut produced)?;
					*member_done = ended;
					if !ended {
						break;
					}
				}
				Ok(Step {
					consumed,
					produced,
					ended: false,
				})
			}
			Self::Deflate { inflater, done } => {
				if *done {
					return Ok(Step::end_after(input.len(), 0));
				}
				let mut consumed = 0;
				let mut produced = 0;
				*done = inflate_call(inflater, input, output, &mut consumed, &mut produced)?;
				if *done && consumed < input.len() {
					return Ok(Step::end_after(input.len(), produced));
				}
				Ok(Step {
					consumed,
					produced,
					ended: false,
				})
			}
			Self::Brotli { state, done } => {
				if *done {
					return Ok(Step::end_after(input.len(), 0));
				}
				let mut available_in = input.len();
				let mut input_offset = 0;
				let mut available_out = output.len();
				let mut output_offset = 0;
				let mut total_out = 0;
				let result = BrotliDecompressStream(
					&mut available_in,
					&mut input_offset,
					input,
					&mut available_out,
					&mut output_offset,
					output,
					&mut total_out,
					state,
				);
				match result {
					BrotliResult::ResultFailure => Err(brotli_error(state)),
					BrotliResult::ResultSuccess => {
						*done = true;
						if input_offset < input.len() {
							return Ok(Step::end_after(input.len(), output_offset));
						}
						Ok(Step {
							consumed: input_offset,
							produced: output_offset,
							ended: false,
						})
					}
					BrotliResult::NeedsMoreInput | BrotliResult::NeedsMoreOutput => Ok(Step {
						consumed: input_offset,
						produced: output_offset,
						ended: false,
					}),
				}
			}
		}
	}

	/// Pulls decoded bytes still buffered inside the decoder after the wire
	/// ended (Node's final `Z_FINISH` call).
	///
	/// # Errors
	/// Corrupt data, with Node's error code.
	pub fn drain(&mut self, output: &mut [u8]) -> Result<usize, DecodeError> {
		let mut consumed = 0;
		let mut produced = 0;
		match self {
			Self::Gzip {
				inflater,
				member_done: false,
			}
			| Self::Deflate {
				inflater,
				done: false,
			} => {
				let ended = inflate_call(inflater, &[], output, &mut consumed, &mut produced)?;
				if ended {
					match self {
						Self::Gzip { member_done, .. } => *member_done = true,
						Self::Deflate { done, .. } => *done = true,
						Self::Brotli { .. } => {}
					}
				}
				Ok(produced)
			}
			Self::Brotli { state, done: false } => {
				let mut available_in = 0;
				let mut input_offset = 0;
				let mut available_out = output.len();
				let mut total_out = 0;
				match BrotliDecompressStream(
					&mut available_in,
					&mut input_offset,
					&[],
					&mut available_out,
					&mut produced,
					output,
					&mut total_out,
					state,
				) {
					BrotliResult::ResultFailure => Err(brotli_error(state)),
					BrotliResult::ResultSuccess => {
						if let Self::Brotli { done, .. } = self {
							*done = true;
						}
						Ok(produced)
					}
					_ => Ok(produced),
				}
			}
			_ => Ok(0),
		}
	}

	/// Called once the wire is exhausted.
	///
	/// # Errors
	/// `Z_BUF_ERROR` when the stream is empty or incomplete.
	pub fn finish(&self) -> Result<(), DecodeError> {
		let complete = match self {
			Self::Gzip { member_done, .. } => *member_done,
			Self::Deflate { done, .. } | Self::Brotli { done, .. } => *done,
		};
		if complete {
			Ok(())
		} else {
			Err(DecodeError::truncated())
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;

	fn gzip(data: &[u8]) -> Vec<u8> {
		let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
		encoder.write_all(data).unwrap();
		encoder.finish().unwrap()
	}

	fn zlib(data: &[u8]) -> Vec<u8> {
		let mut encoder =
			flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
		encoder.write_all(data).unwrap();
		encoder.finish().unwrap()
	}

	/// Decodes `wire` fed in `piece`-byte slices, with a small output buffer.
	fn decode(encoding: &str, wire: &[u8], piece: usize) -> Result<Vec<u8>, DecodeError> {
		let Encoding::Decoded(mut decoder) = encoding_for(Some(encoding)) else {
			panic!("not a decoded encoding");
		};
		let mut out = Vec::new();
		let mut buffer = [0u8; 7];
		for chunk in wire.chunks(piece.max(1)) {
			let mut rest = chunk;
			loop {
				let step = decoder.step(rest, &mut buffer)?;
				out.extend_from_slice(&buffer[..step.produced]);
				if step.ended {
					return Ok(out);
				}
				rest = &rest[step.consumed..];
				if rest.is_empty() && step.produced < buffer.len() {
					break;
				}
			}
		}
		loop {
			let produced = decoder.drain(&mut buffer)?;
			if produced == 0 {
				break;
			}
			out.extend_from_slice(&buffer[..produced]);
		}
		decoder.finish()?;
		Ok(out)
	}

	fn good_gzip() -> Vec<u8> {
		gzip(b"hello")
	}

	const BROTLI_HELLO: [u8; 9] = [0x0b, 0x02, 0x80, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x03];

	#[test]
	fn matches_node_on_complete_streams() {
		let text = "圧縮された応答 compressed answer ".repeat(20);
		for piece in [1, 3, 1000] {
			assert_eq!(
				decode("gzip", &gzip(text.as_bytes()), piece).unwrap(),
				text.as_bytes()
			);
			assert_eq!(
				decode(" X-GZIP ", &gzip(b"hello"), piece).unwrap(),
				b"hello"
			);
			assert_eq!(
				decode("deflate", &zlib(text.as_bytes()), piece).unwrap(),
				text.as_bytes()
			);
			assert_eq!(decode("br", &BROTLI_HELLO, piece).unwrap(), b"hello");
		}
		let two = [gzip(b"hello"), gzip(b"hello")].concat();
		assert_eq!(decode("gzip", &two, 4).unwrap(), b"hellohello");
		// Zero padding after a member is ignored, per write (reviewer probe, Node 23).
		for tail in [&b"\0\0\0\0"[..], b"\0x"] {
			let padded = [good_gzip(), tail.to_vec()].concat();
			assert_eq!(decode("gzip", &padded, 1000).unwrap(), b"hello");
		}
		let mut br_trailing = BROTLI_HELLO.to_vec();
		br_trailing.push(b'x');
		assert_eq!(decode("br", &br_trailing, 2).unwrap(), b"hello");
		let mut zlib_trailing = zlib(b"hello");
		zlib_trailing.push(b'x');
		assert_eq!(decode("deflate", &zlib_trailing, 2).unwrap(), b"hello");
	}

	#[test]
	fn matches_node_on_broken_streams() {
		let truncated = DecodeError("Z_BUF_ERROR".to_owned());
		let corrupt = DecodeError("Z_DATA_ERROR".to_owned());
		let good = gzip(b"hello");
		assert_eq!(decode("gzip", b"", 1), Err(truncated.clone()));
		assert_eq!(
			decode("gzip", &good[..good.len() - 3], 1),
			Err(truncated.clone())
		);
		assert_eq!(decode("gzip", &good[..5], 1), Err(truncated.clone()));
		assert_eq!(
			decode("gzip", &[good.clone(), b"xyz".to_vec()].concat(), 2),
			Err(corrupt.clone())
		);
		assert_eq!(decode("gzip", b"not gzip at all", 4), Err(corrupt.clone()));
		let mut bad_crc = good.clone();
		let index = bad_crc.len() - 5;
		bad_crc[index] ^= 1;
		assert_eq!(decode("gzip", &bad_crc, 3), Err(corrupt.clone()));
		assert_eq!(decode("deflate", b"", 1), Err(truncated.clone()));
		let raw = {
			let mut encoder =
				flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
			encoder.write_all(b"hello").unwrap();
			encoder.finish().unwrap()
		};
		assert_eq!(decode("deflate", &raw, 3), Err(corrupt));
		assert_eq!(decode("br", b"", 1), Err(truncated.clone()));
		assert_eq!(decode("br", &BROTLI_HELLO[..8], 1), Err(truncated));
		assert_eq!(
			decode("br", &[0xff, 0xff, 0xff, 0xff, 0xff], 5),
			Err(DecodeError("ERR__ERROR_FORMAT_PADDING_2".to_owned()))
		);
	}

	#[test]
	fn classifies_encodings_like_node() {
		assert!(matches!(encoding_for(None), Encoding::Identity));
		assert!(matches!(
			encoding_for(Some(" Identity ")),
			Encoding::Identity
		));
		assert!(matches!(encoding_for(Some("")), Encoding::Identity));
		assert!(matches!(encoding_for(Some("zstd")), Encoding::Unsupported));
		assert!(matches!(
			encoding_for(Some("gzip, br")),
			Encoding::Unsupported
		));
	}

	#[test]
	fn a_bomb_expands_one_buffer_at_a_time() {
		let wire = gzip(&vec![0u8; 5_000_000]);
		let Encoding::Decoded(mut decoder) = encoding_for(Some("gzip")) else {
			panic!();
		};
		let mut buffer = vec![0u8; 16_384];
		let step = decoder.step(&wire, &mut buffer).unwrap();
		assert_eq!(step.produced, buffer.len());
		assert!(step.consumed < wire.len());
	}
}
