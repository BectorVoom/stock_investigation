//! ECMAScript StringToNumber for provider numeric strings.

/// `Number(text)`, including JS whitespace, unsigned radix literals and signed zero.
#[must_use]
pub fn string_to_number(text: &str) -> f64 {
	let text = crate::whitespace::trim(text);
	if text.is_empty() { return 0.0; }
	match text {
		"Infinity" | "+Infinity" => return f64::INFINITY,
		"-Infinity" => return f64::NEG_INFINITY,
		_ => {}
	}
	if let Some((radix, rest)) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")).map(|s| (16, s))
		.or_else(|| text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")).map(|s| (2, s)))
		.or_else(|| text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")).map(|s| (8, s))) {
		if rest.is_empty() { return f64::NAN; }
		let width = match radix { 16 => 4, 8 => 3, _ => 1 };
		let mut significant = 0usize;
		let mut mantissa = 0u64;
		let mut guard = false;
		let mut sticky = false;
		for ch in rest.chars() {
			let Some(digit) = ch.to_digit(radix).filter(|_| ch.is_ascii()) else { return f64::NAN; };
			for bit in (0..width).rev() {
				let set = digit & (1 << bit) != 0;
				if significant == 0 && !set { continue; }
				significant = significant.saturating_add(1);
				if significant <= 53 { mantissa = (mantissa << 1) | u64::from(set); }
				else if significant == 54 { guard = set; } else { sticky |= set; }
			}
		}
		if guard && (sticky || mantissa & 1 != 0) { mantissa += 1; }
		let number = mantissa.to_string().parse::<f64>().unwrap_or(f64::NAN);
		let shift = i32::try_from(significant.saturating_sub(53)).unwrap_or(i32::MAX);
		return if shift > 1023 { f64::INFINITY } else { number * 2f64.powi(shift) };
	}
	let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
	let mut chars = unsigned.bytes().peekable();
	let mut digits = 0usize;
	while chars.peek().is_some_and(u8::is_ascii_digit) { digits += 1; chars.next(); }
	if chars.peek() == Some(&b'.') {
		chars.next();
		while chars.peek().is_some_and(u8::is_ascii_digit) { digits += 1; chars.next(); }
	}
	if digits == 0 { return f64::NAN; }
	if chars.peek().is_some_and(|b| matches!(b, b'e' | b'E')) {
		chars.next();
		if chars.peek().is_some_and(|b| matches!(b, b'+' | b'-')) { chars.next(); }
		let mut exponent_digits = 0;
		while chars.peek().is_some_and(u8::is_ascii_digit) { exponent_digits += 1; chars.next(); }
		if exponent_digits == 0 { return f64::NAN; }
	}
	if chars.next().is_some() { return f64::NAN; }
	text.parse().unwrap_or(f64::NAN)
}
