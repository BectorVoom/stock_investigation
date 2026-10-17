//! JavaScript number formatting: `String(x)` and `x.toFixed(digits)`.
//!
//! `String(x)` uses the shortest digits that round-trip (Rust's `{:e}`
//! produces exactly those) laid out by ECMA-262 `Number::toString`: plain
//! decimals for exponents in [-7, 21), exponent notation (`1e+21`, `1e-7`)
//! outside. `toFixed` rounds the exact binary value and breaks exact ties
//! upwards (`(0.125).toFixed(2) === "0.13"`), where Rust's `{:.2}` breaks
//! them to even (`"0.12"`).

/// The decimal digits and exponent of `value`'s shortest round-trip form:
/// `value = 0.d1d2…dk × 10^point` with `d1 != 0`. `value` must be finite
/// and non-zero.
fn shortest_digits(value: f64) -> (String, i32) {
	let (digits, exponent) = scientific_digits(&format!("{:e}", value.abs()));
	let digits = prefer_even_on_tie(value.abs(), digits, exponent);
	(digits, exponent + 1)
}

/// Splits Rust's `{:e}` output (`1.2345e3`) into its digits and exponent.
fn scientific_digits(formatted: &str) -> (String, i32) {
	let (mantissa, exponent) = formatted.split_once('e').unwrap_or((formatted, "0"));
	let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
	(digits, exponent.parse().unwrap_or(0))
}

/// ECMA-262 `Number::toString`: when two shortest digit strings are equally
/// close to the exact value, the even one is chosen (`1000000000000000.25`
/// prints `…0.2`). Rust's shortest formatter may pick the odd one, so the
/// tie is detected on the exact expansion: it is a tie exactly when the
/// exact digits are the shortest length plus one, ending in a single 5.
fn prefer_even_on_tie(value: f64, shortest: String, exponent: i32) -> String {
	// Cheap pre-check: a tie needs a short exact expansion ending in 5. Forty
	// digits can only suggest one falsely through rounding, which the exact
	// expansion below then rules out.
	let (rough, _) = scientific_digits(&format!("{value:.40e}"));
	let rough = rough.trim_end_matches('0');
	if rough.len() != shortest.len() + 1 || !rough.ends_with('5') {
		return shortest;
	}
	let (exact, exact_exponent) = scientific_digits(&format!("{value:.1100e}"));
	let exact = exact.trim_end_matches('0');
	if exact_exponent != exponent || exact.len() != shortest.len() + 1 || !exact.ends_with('5') {
		return shortest;
	}
	let floor = exact.get(..shortest.len()).unwrap_or_default().to_owned();
	let mut ceil = floor.clone().into_bytes();
	increment_decimal(&mut ceil);
	let ceil = String::from_utf8(ceil).unwrap_or_default();
	if ceil.len() != floor.len() || (shortest != floor && shortest != ceil) {
		return shortest;
	}
	let even = if floor.ends_with(['0', '2', '4', '6', '8']) {
		floor
	} else {
		ceil
	};
	let round_trips = format!("0.{even}e{}", exponent + 1)
		.parse::<f64>()
		.is_ok_and(|parsed| parsed == value);
	if round_trips { even } else { shortest }
}

/// `String(value)` for a JavaScript number.
#[must_use]
pub fn to_js_string(value: f64) -> String {
	if value.is_nan() {
		return "NaN".to_owned();
	}
	if value.is_infinite() {
		return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
	}
	if value == 0.0 {
		// Both +0 and -0 print as "0".
		return "0".to_owned();
	}
	let sign = if value < 0.0 { "-" } else { "" };
	let (digits, point) = shortest_digits(value);
	let count = i32::try_from(digits.len()).unwrap_or(i32::MAX);
	let body = if count <= point && point <= 21 {
		let zeros = usize::try_from(point - count).unwrap_or(0);
		format!("{digits}{}", "0".repeat(zeros))
	} else if 0 < point && point <= 21 {
		let split = usize::try_from(point).unwrap_or(0);
		let (whole, fraction) = digits.split_at(split.min(digits.len()));
		format!("{whole}.{fraction}")
	} else if -6 < point && point <= 0 {
		let zeros = usize::try_from(-point).unwrap_or(0);
		format!("0.{}{digits}", "0".repeat(zeros))
	} else {
		let exponent = point - 1;
		let exponent_sign = if exponent >= 0 { "+" } else { "-" };
		let mut characters = digits.chars();
		let first = characters.next().unwrap_or('0');
		let rest: String = characters.collect();
		if rest.is_empty() {
			format!("{first}e{exponent_sign}{}", exponent.unsigned_abs())
		} else {
			format!("{first}.{rest}e{exponent_sign}{}", exponent.unsigned_abs())
		}
	};
	format!("{sign}{body}")
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
