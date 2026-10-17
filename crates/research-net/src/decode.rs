//! Streaming `Content-Encoding` decoders (`decodedBody` in `pinnedConnect.ts`).
//!
//! Node pipes the wire bytes through `createGunzip` / `createInflate` /
//! `createBrotliDecompress`; the observable behaviour reproduced here
//! (checked against Node 23 by probes, see the tests):
//! - gzip: every byte after a member starts a new member (`gzip, gzip`
//!   bodies decode to both; trailing garbage is `Z_DATA_ERROR`);
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

/// One inflate call; `Ok((step, stream_end))`.
fn inflate(
	inflater: &mut Decompress,
	input: &[u8],
	output: &mut [u8],
) -> Result<(Step, bool), DecodeError> {
	let (in_before, out_before) = (inflater.total_in(), inflater.total_out());
	let status = inflater
		.decompress(input, output, FlushDecompress::None)
		.map_err(|error| inflate_error(&error))?;
	let step = Step {
		consumed: delta(inflater.total_in(), in_before),
		produced: delta(inflater.total_out(), out_before),
	};
	Ok((step, status == Status::StreamEnd))
}

impl ContentDecoder {
	/// Decodes from `input` into `output`. Consumes or produces at least one
	/// byte unless `input` is empty, `output` is empty, or the stream ended.
	///
	/// # Errors
	/// Corrupt data, with Node's error code.
	pub fn step(&mut self, input: &[u8], output: &mut [u8]) -> Result<Step, DecodeError> {
		match self {
			Self::Gzip {
				inflater,
				member_done,
			} => {
				if input.is_empty() {
					return Ok(Step {
						consumed: 0,
						produced: 0,
					});
				}
				if *member_done {
					// Node starts a new member on ANY further byte.
					*inflater = new_gzip_member();
					*member_done = false;
				}
				let (step, ended) = inflate(inflater, input, output)?;
				*member_done = ended;
				Ok(step)
			}
			Self::Deflate { inflater, done } => {
				if *done {
					return Ok(Step {
						consumed: input.len(),
						produced: 0,
					});
				}
				let (step, ended) = inflate(inflater, input, output)?;
				*done = ended;
				Ok(step)
			}
			Self::Brotli { state, done } => {
				if *done {
					return Ok(Step {
						consumed: input.len(),
						produced: 0,
					});
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
					BrotliResult::ResultFailure => {
						// Node: "ERR_" + the C error name without "BROTLI_DECODER",
						// e.g. ERR__ERROR_FORMAT_PADDING_2.
						let name = format!("{:?}", state.error_code);
						let suffix = name.strip_prefix("BROTLI_DECODER").unwrap_or(&name);
						Err(DecodeError(format!("ERR_{suffix}")))
					}
					BrotliResult::ResultSuccess => {
						*done = true;
						// Trailing bytes after the stream are ignored, like Node.
						Ok(Step {
							consumed: input.len(),
							produced: output_offset,
						})
					}
					BrotliResult::NeedsMoreInput | BrotliResult::NeedsMoreOutput => Ok(Step {
						consumed: input_offset,
						produced: output_offset,
					}),
				}
			}
		}
	}

	/// Pulls decoded bytes still buffered inside the decoder (brotli and
	/// inflate may hold output when `output` was full).
	///
	/// # Errors
	/// Corrupt data, with Node's error code.
	pub fn drain(&mut self, output: &mut [u8]) -> Result<usize, DecodeError> {
		match self {
			Self::Gzip {
				inflater,
				member_done: false,
			}
			| Self::Deflate {
				inflater,
				done: false,
			} => Ok(inflate(inflater, &[], output)?.0.produced),
			Self::Brotli { done: false, .. } => Ok(self.step(&[], output)?.produced),
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
