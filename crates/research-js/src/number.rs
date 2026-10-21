//! JavaScript number formatting: `String(x)` and `x.toFixed(digits)`.
//!
//! `String(x)` uses the shortest digits that round-trip (Rust's `{:e}`
//! produces exactly those) laid out by ECMA-262 `Number::toString`: plain
//! decimals for exponents in [-7, 21), exponent notation (`1e+21`, `1e-7`)
//! outside. `toFixed` rounds the exact binary value and breaks exact ties
//! upwards (`(0.125).toFixed(2) === "0.13"`), where Rust's `{:.2}` breaks
//! them to even (`"0.12"`).

use std::fmt::Write as _;

/// `value` as an integer when it is one of magnitude below 2^53. For those
/// JavaScript prints exactly the integer's digits (an ulp is at most 1, so
/// no shorter decimal identifies the same double). Pure bit arithmetic: no
/// lossy cast.
fn safe_integer(value: f64) -> Option<i64> {
	let bits = value.to_bits();
	let exponent_bits = (bits >> 52) & 0x7ff;
	if exponent_bits == 0 || exponent_bits == 0x7ff {
		return None;
	}
	let mantissa = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
	// value = mantissa × 2^shift_exponent
	let shift_exponent = i64::try_from(exponent_bits).ok()? - 1075;
	let magnitude = match shift_exponent {
		0 => mantissa,
		exponent if exponent > 0 => return None,
		exponent => {
			let shift = u32::try_from(-exponent).ok()?;
			if shift > 52 || mantissa & ((1u64 << shift) - 1) != 0 {
				return None;
			}
			mantissa >> shift
		}
	};
	let magnitude = i64::try_from(magnitude).ok()?;
	Some(if bits >> 63 == 1 {
		-magnitude
	} else {
		magnitude
	})
}

/// Splits Rust's `{:e}` output (`1.2345e3`) into its ASCII digits and exponent.
fn scientific_digits(formatted: &str) -> (Vec<u8>, i32) {
	let (mantissa, exponent) = formatted.split_once('e').unwrap_or((formatted, "0"));
	let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
	(digits, exponent.parse().unwrap_or(0))
}

/// The decimal digits and exponent of `value`'s shortest round-trip form:
/// `value = 0.d1d2…dk × 10^point` with `d1 != 0`. `value` must be finite,
/// positive and non-zero.
fn shortest_digits(value: f64, scratch: &mut String) -> (Vec<u8>, i32) {
	scratch.clear();
	// Writing into a String cannot fail.
	let _ = write!(scratch, "{value:e}");
	let (digits, exponent) = scientific_digits(scratch);
	let digits = prefer_even_on_tie(value, digits, exponent, scratch);
	(digits, exponent + 1)
}

/// Whether the significant digits of `formatted` (`d.ddd…e±x`) at index
/// `position` is `5` and every later digit is `0`.
fn ends_in_single_five(formatted: &str, position: usize) -> bool {
	let mantissa = formatted
		.split_once('e')
		.map_or(formatted, |(mantissa, _)| mantissa);
	let mut digits = mantissa.bytes().filter(u8::is_ascii_digit).skip(position);
	digits.next() == Some(b'5') && digits.all(|digit| digit == b'0')
}

/// The tie check through decimal formatting, for the rare doubles whose
/// exact expansion [`exact_expansion`] does not compute (huge integers):
/// rounded to `len + 1` significant digits a tie must end in 5; rounded to
/// `len + 21` digits it must read `…5000…0`; only then is the exact
/// expansion (up to 1,100 digits) formatted.
fn prefer_even_on_tie_slow(
	value: f64,
	shortest: Vec<u8>,
	exponent: i32,
	scratch: &mut String,
) -> Vec<u8> {
	let length = shortest.len();
	scratch.clear();
	// Writing into a String cannot fail.
	let _ = write!(scratch, "{value:.length$e}");
	if !ends_in_single_five(scratch, length) {
		return shortest;
	}
	scratch.clear();
	let extended = length + 20;
	// Writing into a String cannot fail.
	let _ = write!(scratch, "{value:.extended$e}");
	if !ends_in_single_five(scratch, length) {
		return shortest;
	}
	let (exact, exact_exponent) = scientific_digits(&format!("{value:.1100e}"));
	let exact_length = exact
		.iter()
		.rposition(|digit| *digit != b'0')
		.map_or(0, |last| last + 1);
	if exact_exponent != exponent || exact_length != length + 1 || exact.get(length) != Some(&b'5')
	{
		return shortest;
	}
	let exact = exact.get(..exact_length).unwrap_or_default();
	even_neighbour(value, shortest, exact, exponent)
}

/// The exact decimal expansion of a positive finite double, when it is
/// short enough for a shortest-digits tie (≤ 18 significant digits).
enum Expansion {
	/// Significant digits (no trailing zeros) and the scientific exponent.
	Short(Vec<u8>, i32),
	/// More than 18 significant digits: no tie is possible.
	Long,
	/// Not computed here (an integer between 2^123 and 2^186); use the slow check.
	Unknown,
}

/// Exact decimal expansion by integer arithmetic. With `value = m × 2^e`
/// and `m` odd: for `e < 0` the expansion is `m × 5^-e / 10^-e`, whose
/// numerator is odd and so has no trailing zero (`5^26 > 10^18` bounds the
/// short case); for `e ≥ 0` it is the integer `m × 2^e`.
fn exact_expansion(value: f64) -> Expansion {
	const SHORT: u128 = 1_000_000_000_000_000_000;
	let bits = value.to_bits();
	let exponent_bits = (bits >> 52) & 0x7ff;
	let fraction = bits & ((1u64 << 52) - 1);
	let (mantissa, binary_exponent) = if exponent_bits == 0 {
		(fraction, -1074i64)
	} else {
		(
			fraction | (1u64 << 52),
			i64::try_from(exponent_bits).unwrap_or(0) - 1075,
		)
	};
	if mantissa == 0 {
		return Expansion::Long;
	}
	let zeros = mantissa.trailing_zeros();
	let odd = u128::from(mantissa >> zeros);
	let binary_exponent = binary_exponent + i64::from(zeros);
	let (numerator, decimal_shift) = if binary_exponent < 0 {
		let Ok(power) = u32::try_from(-binary_exponent) else {
			return Expansion::Long;
		};
		if power >= 26 {
			return Expansion::Long;
		}
		(odd * 5u128.pow(power), -binary_exponent)
	} else {
		let Ok(shift) = u32::try_from(binary_exponent) else {
			return Expansion::Unknown;
		};
		// `m × 2^e` has at least ⌊e·log10 2⌋ + 1 digits, and at most 22 trailing
		// zeros (they need factors of 5, and 5^23 > 2^53 > m): from e = 133 on
		// that leaves more than 18 significant digits, so no tie is possible.
		if shift >= 133 {
			return Expansion::Long;
		}
		if shift > 70 {
			return Expansion::Unknown;
		}
		(odd << shift, 0)
	};
	let text = numerator.to_string();
	let significant = text.trim_end_matches('0');
	if numerator >= SHORT && significant.len() > 18 {
		return Expansion::Long;
	}
	let length = i64::try_from(text.len()).unwrap_or(i64::MAX);
	let exponent = i32::try_from(length - 1 - decimal_shift).unwrap_or(i32::MAX);
	Expansion::Short(significant.as_bytes().to_vec(), exponent)
}

/// ECMA-262 `Number::toString`: when two shortest digit strings are equally
/// close to the exact value, the even one is chosen (`1000000000000000.25`
/// prints `…0.2`). Rust's shortest formatter may pick the odd one. It is a
/// tie exactly when the exact digits are the shortest length plus one,
/// ending in a 5; the exact digits come from integer arithmetic, so the
/// common case costs no formatting beyond the shortest digits themselves.
fn prefer_even_on_tie(
	value: f64,
	shortest: Vec<u8>,
	exponent: i32,
	scratch: &mut String,
) -> Vec<u8> {
	let (exact, exact_exponent) = match exact_expansion(value) {
		Expansion::Long => return shortest,
		Expansion::Unknown => return prefer_even_on_tie_slow(value, shortest, exponent, scratch),
		Expansion::Short(digits, exponent) => (digits, exponent),
	};
	let length = shortest.len();
	if exact_exponent != exponent || exact.len() != length + 1 || exact.last() != Some(&b'5') {
		return shortest;
	}
	even_neighbour(value, shortest, &exact, exponent)
}

/// The even one of the two shortest neighbours of a tie, if it round-trips.
fn even_neighbour(value: f64, shortest: Vec<u8>, exact: &[u8], exponent: i32) -> Vec<u8> {
	let length = shortest.len();
	let floor: Vec<u8> = exact.get(..length).unwrap_or_default().to_vec();
	let mut ceil = floor.clone();
	increment_decimal(&mut ceil);
	if ceil.len() != floor.len() || (shortest != floor && shortest != ceil) {
		return shortest;
	}
	let even = if floor.last().is_some_and(|digit| digit % 2 == 0) {
		floor
	} else {
		ceil
	};
	let candidate = format!("0.{}e{}", String::from_utf8_lossy(&even), exponent + 1);
	if candidate.parse::<f64>().is_ok_and(|parsed| parsed == value) {
		even
	} else {
		shortest
	}
}

/// Appends `String(value)` to `out` (no intermediate strings for the common
/// cases: safe integers and short decimals).
pub fn push_js_string(out: &mut String, value: f64) {
	if value.is_nan() {
		out.push_str("NaN");
		return;
	}
	if value.is_infinite() {
		out.push_str(if value > 0.0 { "Infinity" } else { "-Infinity" });
		return;
	}
	if value == 0.0 {
		// Both +0 and -0 print as "0".
		out.push('0');
		return;
	}
	if let Some(integer) = safe_integer(value) {
		// Writing into a String cannot fail.
		let _ = write!(out, "{integer}");
		return;
	}
	if value < 0.0 {
		out.push('-');
	}
	let mut scratch = String::with_capacity(48);
	let (digits, point) = shortest_digits(value.abs(), &mut scratch);
	let push_digits = |out: &mut String, digits: &[u8]| {
		for digit in digits {
			out.push(char::from(*digit));
		}
	};
	let count = i32::try_from(digits.len()).unwrap_or(i32::MAX);
	if count <= point && point <= 21 {
		push_digits(out, &digits);
		for _ in 0..(point - count) {
			out.push('0');
		}
	} else if 0 < point && point <= 21 {
		let split = usize::try_from(point).unwrap_or(0).min(digits.len());
		let (whole, fraction) = digits.split_at(split);
		push_digits(out, whole);
		out.push('.');
		push_digits(out, fraction);
	} else if -6 < point && point <= 0 {
		out.push_str("0.");
		for _ in 0..(-point) {
			out.push('0');
		}
		push_digits(out, &digits);
	} else {
		let exponent = point - 1;
		let (first, rest) = digits
			.split_first()
			.map_or((&b'0', &[][..]), |(first, rest)| (first, rest));
		out.push(char::from(*first));
		if !rest.is_empty() {
			out.push('.');
			push_digits(out, rest);
		}
		out.push('e');
		out.push(if exponent >= 0 { '+' } else { '-' });
		// Writing into a String cannot fail.
		let _ = write!(out, "{}", exponent.unsigned_abs());
	}
}

/// `String(value)` for a JavaScript number.
#[must_use]
pub fn to_js_string(value: f64) -> String {
	let mut out = String::with_capacity(24);
	push_js_string(&mut out, value);
	out
}

/// `String(value)` for an integer (what `${n}` prints for a safe integer).
#[must_use]
pub fn integer_to_js_string(value: i64) -> String {
	value.to_string()
}

/// Adds one to a string of ASCII decimal digits, carrying as needed.
fn increment_decimal(digits: &mut Vec<u8>) {
	for digit in digits.iter_mut().rev() {
		if *digit == b'9' {
			*digit = b'0';
		} else {
			*digit += 1;
			return;
		}
	}
	digits.insert(0, b'1');
}

/// `value.toFixed(fraction_digits)` for `fraction_digits` in `0..=100`
/// (larger values throw a RangeError in JavaScript and are clamped here).
#[must_use]
pub fn to_fixed(value: f64, fraction_digits: u32) -> String {
	let fraction_digits = fraction_digits.min(100);
	if !value.is_finite() || value.abs() >= 1e21 {
		return to_js_string(value);
	}
	// -0 is not "< 0" in JavaScript, so it prints without a sign.
	let negative = value < 0.0;
	// A double's exact decimal expansion ends within 1,074 fraction digits,
	// so this precision prints it exactly; rounding is then done by hand.
	let exact = format!("{:.1100}", value.abs());
	let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
	let keep = usize::try_from(fraction_digits).unwrap_or(0);
	let mut digits: Vec<u8> = whole.bytes().collect();
	digits.extend(fraction.bytes().take(keep));
	while digits.len() < whole.len() + keep {
		digits.push(b'0');
	}
	// Ties go up ("pick the larger n"), so the next digit alone decides.
	if fraction
		.as_bytes()
		.get(keep)
		.is_some_and(|next| *next >= b'5')
	{
		increment_decimal(&mut digits);
	}
	let text = String::from_utf8(digits).unwrap_or_default();
	let integer_len = text.len() - keep;
	let (integer, decimals) = text.split_at(integer_len);
	let integer = integer.trim_start_matches('0');
	let integer = if integer.is_empty() { "0" } else { integer };
	let sign = if negative { "-" } else { "" };
	if keep == 0 {
		format!("{sign}{integer}")
	} else {
		format!("{sign}{integer}.{decimals}")
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn formats_like_number_to_string() {
		assert_eq!(to_js_string(0.0), "0");
		assert_eq!(to_js_string(-0.0), "0");
		assert_eq!(to_js_string(1.0), "1");
		assert_eq!(to_js_string(-1.5), "-1.5");
		assert_eq!(to_js_string(0.1 + 0.2), "0.30000000000000004");
		assert_eq!(to_js_string(1e21), "1e+21");
		assert_eq!(
			to_js_string(123_456_789_012_345_680_000.0),
			"123456789012345680000"
		);
		assert_eq!(to_js_string(1e-7), "1e-7");
		assert_eq!(to_js_string(0.000_001), "0.000001");
		assert_eq!(to_js_string(1.5e-10), "1.5e-10");
		assert_eq!(to_js_string(f64::NAN), "NaN");
		assert_eq!(to_js_string(f64::NEG_INFINITY), "-Infinity");
	}

	#[test]
	fn fixed_rounds_exact_ties_up() {
		assert_eq!(to_fixed(0.125, 2), "0.13");
		assert_eq!(to_fixed(1.005, 2), "1.00");
		assert_eq!(to_fixed(2.5, 0), "3");
		assert_eq!(to_fixed(-0.5, 0), "-1");
		assert_eq!(to_fixed(-0.0, 2), "0.00");
		assert_eq!(to_fixed(-0.0001, 2), "-0.00");
		assert_eq!(to_fixed(99.995, 2), "100.00");
		assert_eq!(to_fixed(1e21, 2), "1e+21");
	}
}
