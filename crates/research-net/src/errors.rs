//! Log-safe failure labels in Node's vocabulary (`describeError` in
//! `safeFetchCore.ts`, spec §4.12).
//!
//! The TypeScript reports an unexpected failure by its `code` (`ECONNRESET`,
//! `ERR_TLS_CERT_ALTNAME_INVALID`, `Z_DATA_ERROR`, …) or its class name —
//! never its message, because Node puts the remote address and port into
//! socket error messages. The Rust sources of the same failures (io errors,
//! rustls, hyper, zlib, brotli) are mapped onto the same labels here, in one
//! table, so details stay comparable across the two runtimes.

use std::io;

/// `describeError` of an error that carries neither a code nor a usable name.
pub const UNKNOWN_ERROR: &str = "unknown error";

/// The `code` Node gives an [`io::Error`], or the class name `Error` when it
/// has none (what `describeError` falls back to for a plain JS `Error`).
#[must_use]
pub fn io_error_code(error: &io::Error) -> &'static str {
	if let Some(code) = error
		.get_ref()
		.and_then(|inner| inner.downcast_ref::<rustls::Error>())
	{
		return tls_error_code(code);
	}
	if let Some(code) = error.raw_os_error().and_then(errno_name) {
		return code;
	}
	match error.kind() {
		io::ErrorKind::ConnectionRefused => "ECONNREFUSED",
		io::ErrorKind::ConnectionReset => "ECONNRESET",
		io::ErrorKind::ConnectionAborted => "ECONNABORTED",
		io::ErrorKind::NetworkUnreachable => "ENETUNREACH",
		io::ErrorKind::HostUnreachable => "EHOSTUNREACH",
		io::ErrorKind::NetworkDown => "ENETDOWN",
		io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
		io::ErrorKind::TimedOut => "ETIMEDOUT",
		io::ErrorKind::BrokenPipe => "EPIPE",
		io::ErrorKind::PermissionDenied => "EACCES",
		io::ErrorKind::NotFound => "ENOENT",
		io::ErrorKind::AlreadyExists => "EEXIST",
		// Node: "Client network socket disconnected before secure TLS
		// connection was established" / "socket hang up" carry ECONNRESET.
		io::ErrorKind::UnexpectedEof => "ECONNRESET",
		_ => "Error",
	}
}

/// The errno name (`EACCES`, `ECONNREFUSED`, …) of an OS error number.
#[must_use]
pub fn errno_name(code: i32) -> Option<&'static str> {
	const NAMES: [(i32, &str); 34] = [
		(libc::EACCES, "EACCES"),
		(libc::EPERM, "EPERM"),
		(libc::ENOENT, "ENOENT"),
		(libc::EEXIST, "EEXIST"),
		(libc::ENOTDIR, "ENOTDIR"),
		(libc::EISDIR, "EISDIR"),
		(libc::ENOTEMPTY, "ENOTEMPTY"),
		(libc::ENOSPC, "ENOSPC"),
		(libc::EDQUOT, "EDQUOT"),
		(libc::EROFS, "EROFS"),
		(libc::EMFILE, "EMFILE"),
		(libc::ENFILE, "ENFILE"),
		(libc::EIO, "EIO"),
		(libc::EBUSY, "EBUSY"),
		(libc::EXDEV, "EXDEV"),
		(libc::ENAMETOOLONG, "ENAMETOOLONG"),
		(libc::ELOOP, "ELOOP"),
		(libc::EINVAL, "EINVAL"),
		(libc::EBADF, "EBADF"),
		(libc::EAGAIN, "EAGAIN"),
		(libc::EINTR, "EINTR"),
		(libc::ENOMEM, "ENOMEM"),
		(libc::ECONNREFUSED, "ECONNREFUSED"),
		(libc::ECONNRESET, "ECONNRESET"),
		(libc::ECONNABORTED, "ECONNABORTED"),
		(libc::ENETUNREACH, "ENETUNREACH"),
		(libc::ENETDOWN, "ENETDOWN"),
		(libc::EHOSTUNREACH, "EHOSTUNREACH"),
		(libc::EHOSTDOWN, "EHOSTDOWN"),
		(libc::ETIMEDOUT, "ETIMEDOUT"),
		(libc::EPIPE, "EPIPE"),
		(libc::EADDRNOTAVAIL, "EADDRNOTAVAIL"),
		(libc::EADDRINUSE, "EADDRINUSE"),
		(libc::EAFNOSUPPORT, "EAFNOSUPPORT"),
	];
	NAMES
		.iter()
		.find(|(number, _)| *number == code)
		.map(|(_, name)| *name)
}

/// The OpenSSL/Node code of a TLS failure.
#[must_use]
pub fn tls_error_code(error: &rustls::Error) -> &'static str {
	use rustls::CertificateError as Cert;
	match error {
		rustls::Error::InvalidCertificate(certificate) => match certificate {
			Cert::NotValidForName | Cert::NotValidForNameContext { .. } => {
				"ERR_TLS_CERT_ALTNAME_INVALID"
			}
			// Node reports an unknown root (self-signed included) this way.
			Cert::UnknownIssuer => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			Cert::Expired | Cert::ExpiredContext { .. } => "CERT_HAS_EXPIRED",
			Cert::NotValidYet | Cert::NotValidYetContext { .. } => "CERT_NOT_YET_VALID",
			Cert::Revoked => "CERT_REVOKED",
			Cert::BadSignature => "CERT_SIGNATURE_FAILURE",
			Cert::InvalidPurpose | Cert::InvalidPurposeContext { .. } => "INVALID_PURPOSE",
			_ => "ERR_SSL_HANDSHAKE_FAILURE",
		},
		_ => "ERR_SSL_HANDSHAKE_FAILURE",
	}
}

/// The Node code of a hyper (HTTP/1 client) failure.
#[must_use]
pub fn hyper_error_code(error: &hyper::Error) -> &'static str {
	// An io error underneath (reset, TLS alert) is the real cause.
	let mut source = std::error::Error::source(error);
	while let Some(cause) = source {
		if let Some(io_error) = cause.downcast_ref::<io::Error>() {
			return io_error_code(io_error);
		}
		source = cause.source();
	}
	// hyper reports a head over `max_header_size` (and too many headers) as
	// "message head is too large"; `is_parse_too_large` exists only with
	// hyper's server feature. llhttp's code for it is HPE_HEADER_OVERFLOW.
	if error.is_parse() && error.to_string().starts_with("message head is too large") {
		return "HPE_HEADER_OVERFLOW";
	}
	if error.is_parse() || error.is_parse_status() {
		// llhttp's family of parse errors (`HPE_*`).
		return "HPE_INVALID_CONSTANT";
	}
	// The peer closed before a complete message ("socket hang up" / "aborted").
	"ECONNRESET"
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn maps_os_errors_to_errno_names() {
		assert_eq!(
			io_error_code(&io::Error::from_raw_os_error(libc::ECONNREFUSED)),
			"ECONNREFUSED"
		);
		assert_eq!(
			io_error_code(&io::Error::from_raw_os_error(libc::EACCES)),
			"EACCES"
		);
		assert_eq!(
			io_error_code(&io::Error::from(io::ErrorKind::UnexpectedEof)),
			"ECONNRESET"
		);
		assert_eq!(io_error_code(&io::Error::other("x")), "Error");
		assert_eq!(errno_name(-12345), None);
	}

	#[test]
	fn maps_tls_failures_to_openssl_codes() {
		let wrapped = io::Error::new(
			io::ErrorKind::InvalidData,
			rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
		);
		assert_eq!(io_error_code(&wrapped), "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
		assert_eq!(
			tls_error_code(&rustls::Error::InvalidCertificate(
				rustls::CertificateError::NotValidForName
			)),
			"ERR_TLS_CERT_ALTNAME_INVALID"
		);
		assert_eq!(
			tls_error_code(&rustls::Error::InvalidCertificate(
				rustls::CertificateError::Expired
			)),
			"CERT_HAS_EXPIRED"
		);
		assert_eq!(
			tls_error_code(&rustls::Error::DecryptError),
			"ERR_SSL_HANDSHAKE_FAILURE"
		);
	}
}
