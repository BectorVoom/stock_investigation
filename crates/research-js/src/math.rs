//! `Math.pow` (and `**`), `Math.exp` and `Math.log` with V8's results.
//!
//! V8 does not call the platform libm for these: `src/base/ieee754.cc`
//! carries fdlibm. Node on arm64 is compiled by clang, whose default
//! `-ffp-contract=on` fuses every `a * b + c` (and `a * b - c`, `c - a * b`,
//! `c += a * b`) inside one C expression into a fused multiply-add, and the
//! last bit of `exp` and `log` depends on it. This port spells each fusion
//! out with `mul_add` where clang forms it (the left multiplication of
//! `a * b + c * d`), and leaves every other operation unfused.
//!
//! Measured against Node 23 on arm64 (`vectors/domain/math.json`): `exp` and
//! `log` agree bit for bit. `pow` is fdlibm's `e_pow.c` with the same
//! treatment, and still differs from V8 by one unit in the last place for
//! about 5% of random inputs (the platform `powf` differs for about 10%); no
//! contraction pattern closes the gap, so V8's `pow` evidently computes some
//! step differently. Known deviation, recorded in the conformance test.
//!
//! On x86-64 V8 is built without FMA contraction (baseline SSE2 has no FMA),
//! so a Node there can differ from these vectors in the last bit.

/// High 32 bits of a double, as fdlibm's `GET_HIGH_WORD`.
fn high_word(value: f64) -> u32 {
	u32::try_from(value.to_bits() >> 32).unwrap_or(0)
}

/// Low 32 bits of a double, as fdlibm's `GET_LOW_WORD`.
fn low_word(value: f64) -> u32 {
	u32::try_from(value.to_bits() & 0xFFFF_FFFF).unwrap_or(0)
}

/// `INSERT_WORDS`.
fn from_words(high: u32, low: u32) -> f64 {
	f64::from_bits((u64::from(high) << 32) | u64::from(low))
}

/// `SET_LOW_WORD(value, low)`.
fn with_low_word(value: f64, low: u32) -> f64 {
	from_words(high_word(value), low)
}

/// `SET_HIGH_WORD(value, high)`.
fn with_high_word(value: f64, high: u32) -> f64 {
	from_words(high, low_word(value))
}

/// The C reinterpretation `(int32_t)word`.
const fn signed(word: u32) -> i32 {
	i32::from_ne_bytes(word.to_ne_bytes())
}

/// The C reinterpretation `(uint32_t)word`.
const fn unsigned(word: i32) -> u32 {
	u32::from_ne_bytes(word.to_ne_bytes())
}

/// C's `(int)value` for a value the caller has bounded to a small range.
#[allow(clippy::cast_possible_truncation)]
const fn truncate_small(value: f64) -> i32 {
	// Rust's `as` is defined (saturating) for every input, and the callers
	// pass |value| < 1100, where it truncates toward zero exactly like C.
	value as i32
}

/// `scalbn(x, n)`: `x · 2ⁿ` with one rounding (musl's algorithm).
fn scalbn(x: f64, n: i32) -> f64 {
	let two_pow = |exponent: i32| f64::from_bits(u64::from(unsigned(0x3ff + exponent)) << 52);
	let mut y = x;
	let mut n = n;
	if n > 1023 {
		y *= two_pow(1023);
		n -= 1023;
		if n > 1023 {
			y *= two_pow(1023);
			n -= 1023;
			n = n.min(1023);
		}
	} else if n < -1022 {
		// Scale by 2^-1022 · 2^53 so the intermediate stays normal and the
		// final multiplication is the only rounding.
		y *= two_pow(-1022) * two_pow(53);
		n += 1022 - 53;
		if n < -1022 {
			y *= two_pow(-1022) * two_pow(53);
			n += 1022 - 53;
			n = n.max(-1022);
		}
	}
	y * two_pow(n)
}

const BP: [f64; 2] = [1.0, 1.5];
const DP_H: [f64; 2] = [0.0, f64::from_bits(0x3fe2_b803_4000_0000)];
const DP_L: [f64; 2] = [0.0, f64::from_bits(0x3e4c_fdeb_43cf_d006)];
const TWO53: f64 = 9_007_199_254_740_992.0;
const HUGE: f64 = 1.0e300;
const ONE_THIRD: f64 = f64::from_bits(0x3fd5_5555_5555_5555);
const TINY: f64 = 1.0e-300;
const L1: f64 = f64::from_bits(0x3fe3_3333_3333_3303);
const L2: f64 = f64::from_bits(0x3fdb_6db6_db6f_abff);
const L3: f64 = f64::from_bits(0x3fd5_5555_518f_264d);
const L4: f64 = f64::from_bits(0x3fd1_7460_a91d_4101);
const L5: f64 = f64::from_bits(0x3fcd_864a_93c9_db65);
const L6: f64 = f64::from_bits(0x3fca_7e28_4a45_4eef);
const P1: f64 = f64::from_bits(0x3fc5_5555_5555_553e);
const P2: f64 = f64::from_bits(0xbf66_c16c_16be_bd93);
const P3: f64 = f64::from_bits(0x3f11_566a_af25_de2c);
const P4: f64 = f64::from_bits(0xbebb_bd41_c5d2_6bf1);
const P5: f64 = f64::from_bits(0x3e66_3769_72be_a4d0);
const LG2: f64 = f64::from_bits(0x3fe6_2e42_fefa_39ef);
const LG2_H: f64 = f64::from_bits(0x3fe6_2e43_0000_0000);
const LG2_L: f64 = f64::from_bits(0xbe20_5c61_0ca8_6c39);
const OVT: f64 = f64::from_bits(0x3c97_1547_652b_82fe);
const CP: f64 = f64::from_bits(0x3fee_c709_dc3a_03fd);
const CP_H: f64 = f64::from_bits(0x3fee_c709_e000_0000);
const CP_L: f64 = f64::from_bits(0xbe3e_2fe0_145b_01f5);
const IVLN2: f64 = f64::from_bits(0x3ff7_1547_652b_82fe);
const IVLN2_H: f64 = f64::from_bits(0x3ff7_1547_6000_0000);
/// `ln2` split for exact argument reduction (`exp`, `log`).
const LN2_HI_BITS: f64 = f64::from_bits(0x3fe6_2e42_fee0_0000);
const LN2_LO_BITS: f64 = f64::from_bits(0x3dea_39ef_3579_3c76);
const IVLN2_L: f64 = f64::from_bits(0x3e54_ae0b_f85d_df44);

/// Horner evaluation `c0 + t·(c1 + t·(…))` as clang fuses it.
fn horner(t: f64, coefficients: &[f64]) -> f64 {
	let mut iter = coefficients.iter().rev();
	let mut value = iter.next().copied().unwrap_or(0.0);
	for coefficient in iter {
		value = t.mul_add(value, *coefficient);
	}
	value
}

/// `Math.pow(x, y)` / `x ** y` (ECMAScript Number::exponentiate on V8).
#[must_use]
pub fn pow(x: f64, y: f64) -> f64 {
	// ECMAScript special cases that fdlibm answers differently.
	if y.is_nan() {
		return f64::NAN;
	}
	if y == 0.0 {
		return 1.0;
	}
	if x.is_nan() || (x.abs() == 1.0 && y.is_infinite()) {
		return f64::NAN;
	}
	fdlibm_pow(x, y)
}

/// fdlibm `__ieee754_pow` with clang's contractions (see the module docs).
#[allow(clippy::too_many_lines, clippy::many_single_char_names)]
fn fdlibm_pow(x: f64, y: f64) -> f64 {
	let hx = signed(high_word(x));
	let lx = low_word(x);
	let hy = signed(high_word(y));
	let ly = low_word(y);
	let mut ix = hx & 0x7fff_ffff;
	let iy = hy & 0x7fff_ffff;

	// x**0 = 1 (handled by the caller); NaN arguments (also the caller's).
	if (unsigned(iy) | ly) == 0 {
		return 1.0;
	}
	if ix > 0x7ff0_0000
		|| (ix == 0x7ff0_0000 && lx != 0)
		|| iy > 0x7ff0_0000
		|| (iy == 0x7ff0_0000 && ly != 0)
	{
		return x + y;
	}

	// yisint = 0: y is not an integer; 1: odd integer; 2: even integer.
	let mut yisint = 0;
	if hx < 0 {
		if iy >= 0x4340_0000 {
			yisint = 2;
		} else if iy >= 0x3ff0_0000 {
			let k = (iy >> 20) - 0x3ff;
			if k > 20 {
				let j = ly >> (52 - k);
				if (j << (52 - k)) == ly {
					yisint = 2 - signed(j & 1);
				}
			} else if ly == 0 {
				let j = iy >> (20 - k);
				if (j << (20 - k)) == iy {
					yisint = 2 - (j & 1);
				}
			}
		}
	}

	if ly == 0 {
		if iy == 0x7ff0_0000 {
			// y is ±∞.
			return if ((ix - 0x3ff0_0000) | signed(lx)) == 0 {
				// (±1)^±∞ is NaN in ECMAScript (the caller answers it first).
				f64::NAN
			} else if ix >= 0x3ff0_0000 {
				if hy >= 0 { y } else { 0.0 }
			} else if hy >= 0 {
				0.0
			} else {
				-y
			};
		}
		if iy == 0x3ff0_0000 {
			return if hy < 0 { 1.0 / x } else { x };
		}
		if hy == 0x4000_0000 {
			return x * x;
		}
		if hy == 0x3fe0_0000 && hx >= 0 {
			return x.sqrt();
		}
	}

	let mut ax = x.abs();
	if lx == 0 && (ix == 0x7ff0_0000 || ix == 0 || ix == 0x3ff0_0000) {
		// x is ±0, ±∞ or ±1.
		let mut z = ax;
		if hy < 0 {
			z = 1.0 / z;
		}
		if hx < 0 {
			if ((ix - 0x3ff0_0000) | yisint) == 0 {
				z = f64::NAN;
			} else if yisint == 1 {
				z = -z;
			}
		}
		return z;
	}

	let mut s = 1.0;
	if hx < 0 {
		if yisint == 0 {
			return f64::NAN;
		}
		if yisint == 1 {
			s = -1.0;
		}
	}

	let t1: f64;
	let t2: f64;
	if iy > 0x41e0_0000 {
		// |y| > 2^31.
		if iy > 0x43f0_0000 {
			if ix <= 0x3fef_ffff {
				return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
			}
			if ix >= 0x3ff0_0000 {
				return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
			}
		}
		if ix < 0x3fef_ffff {
			return if hy < 0 {
				s * HUGE * HUGE
			} else {
				s * TINY * TINY
			};
		}
		if ix > 0x3ff0_0000 {
			return if hy > 0 {
				s * HUGE * HUGE
			} else {
				s * TINY * TINY
			};
		}
		// |1 - x| <= 2^-20: log(x) by x - x²/2 + x³/3 - x⁴/4.
		let t = ax - 1.0;
		let w = (t * t) * (-t).mul_add((-t).mul_add(0.25, ONE_THIRD), 0.5);
		let u = IVLN2_H * t;
		let v = t.mul_add(IVLN2_L, -(w * IVLN2));
		t1 = with_low_word(u + v, 0);
		t2 = v - (t1 - u);
	} else {
		let mut n = 0;
		if ix < 0x0010_0000 {
			ax *= TWO53;
			n -= 53;
			ix = signed(high_word(ax));
		}
		n += (ix >> 20) - 0x3ff;
		let j = ix & 0x000f_ffff;
		ix = j | 0x3ff0_0000;
		let k: usize = if j <= 0x3988e {
			0
		} else if j < 0xbb67a {
			1
		} else {
			n += 1;
			ix -= 0x0010_0000;
			0
		};
		ax = with_high_word(ax, unsigned(ix));
		let bp = BP.get(k).copied().unwrap_or(1.0);
		let dp_h = DP_H.get(k).copied().unwrap_or(0.0);
		let dp_l = DP_L.get(k).copied().unwrap_or(0.0);

		// ss = s_h + s_l = (x - 1)/(x + 1) or (x - 1.5)/(x + 1.5).
		let u = ax - bp;
		let v = 1.0 / (ax + bp);
		let ss = u * v;
		let s_h = with_low_word(ss, 0);
		let k_bits = if k == 1 { 1u32 << 18 } else { 0 };
		let t_h = from_words(
			((unsigned(ix) >> 1) | 0x2000_0000) + 0x0008_0000 + k_bits,
			0,
		);
		let t_l = ax - (t_h - bp);
		let s_l = v * (-s_h).mul_add(t_l, (-s_h).mul_add(t_h, u));

		// log(ax).
		let s2 = ss * ss;
		let mut r = s2 * s2 * horner(s2, &[L1, L2, L3, L4, L5, L6]);
		r = s_l.mul_add(s_h + ss, r);
		let s2 = s_h * s_h;
		let t_h = with_low_word(3.0 + s2 + r, 0);
		let t_l = r - ((t_h - 3.0) - s2);

		// u + v = ss·(1 + …).
		let u = s_h * t_h;
		let v = s_l.mul_add(t_h, t_l * ss);

		// 2/(3·log2)·(ss + …).
		let p_h = with_low_word(u + v, 0);
		let p_l = v - (p_h - u);
		let z_h = CP_H * p_h;
		let z_l = CP_L.mul_add(p_h, p_l * CP) + dp_l;

		// log2(ax) = (ss + …)·2/(3·log2) = n + dp_h + z_h + z_l.
		let t = f64::from(n);
		t1 = with_low_word(((z_h + z_l) + dp_h) + t, 0);
		t2 = z_l - (((t1 - t) - dp_h) - z_h);
	}

	// Split y into y1 + y2 and compute (y1 + y2)·(t1 + t2).
	let y1 = with_low_word(y, 0);
	let p_l = (y - y1).mul_add(t1, y * t2);
	let mut p_h = y1 * t1;
	let z = p_l + p_h;
	let mut j = signed(high_word(z));
	let i = signed(low_word(z));
	if j >= 0x4090_0000 {
		// z >= 1024.
		if ((j - 0x4090_0000) | i) != 0 || p_l + OVT > z - p_h {
			return s * HUGE * HUGE;
		}
	} else if (j & 0x7fff_ffff) >= 0x4090_cc00 {
		// z <= -1075.
		if (unsigned(j).wrapping_sub(0xc090_cc00) | unsigned(i)) != 0 || p_l <= z - p_h {
			return s * TINY * TINY;
		}
	}

	// 2^(p_h + p_l).
	let i = j & 0x7fff_ffff;
	let mut k = (i >> 20) - 0x3ff;
	let mut n = 0;
	if i > 0x3fe0_0000 {
		n = j + (0x0010_0000 >> (k + 1));
		k = ((n & 0x7fff_ffff) >> 20) - 0x3ff;
		let t = from_words(unsigned(n & !(0x000f_ffff >> k)), 0);
		n = ((n & 0x000f_ffff) | 0x0010_0000) >> (20 - k);
		if j < 0 {
			n = -n;
		}
		p_h -= t;
	}
	let t = with_low_word(p_l + p_h, 0);
	let u = t * LG2_H;
	let v = (p_l - (t - p_h)).mul_add(LG2, t * LG2_L);
	let mut z = u + v;
	let w = v - (z - u);
	let t = z * z;
	let t1 = (-t).mul_add(horner(t, &[P1, P2, P3, P4, P5]), z);
	let r = (z * t1) / (t1 - 2.0) - z.mul_add(w, w);
	z = 1.0 - (r - z);
	j = signed(high_word(z));
	j += n << 20;
	if (j >> 20) <= 0 {
		z = scalbn(z, n);
	} else {
		z = with_high_word(z, unsigned(j));
	}
	s * z
}

/// `Math.exp(x)` (fdlibm `__ieee754_exp` as V8 carries it).
#[must_use]
#[allow(clippy::many_single_char_names)]
pub fn exp(x: f64) -> f64 {
	const HALF: [f64; 2] = [0.5, -0.5];
	const O_THRESHOLD: f64 = f64::from_bits(0x4086_2e42_fefa_39ef);
	const U_THRESHOLD: f64 = f64::from_bits(0xc087_4910_d52d_3051);
	const LN2_HI: [f64; 2] = [LN2_HI_BITS, -LN2_HI_BITS];
	const LN2_LO: [f64; 2] = [LN2_LO_BITS, -LN2_LO_BITS];
	const INVLN2: f64 = IVLN2;
	const TWO_M1000: f64 = f64::from_bits(0x0170_0000_0000_0000);
	const TWO1023: f64 = f64::from_bits(0x7fe0_0000_0000_0000);
	const E: f64 = std::f64::consts::E;

	let mut x = x;
	let high = high_word(x);
	let xsb = usize::from(high >> 31 == 1);
	let hx = high & 0x7fff_ffff;
	if hx >= 0x4086_2e42 {
		if hx >= 0x7ff0_0000 {
			if ((hx & 0xfffff) | low_word(x)) != 0 {
				return x + x;
			}
			return if xsb == 0 { x } else { 0.0 };
		}
		if x > O_THRESHOLD {
			return HUGE * HUGE;
		}
		if x < U_THRESHOLD {
			return TWO_M1000 * TWO_M1000;
		}
	}
	let ln2_hi = LN2_HI.get(xsb).copied().unwrap_or(0.0);
	let ln2_lo = LN2_LO.get(xsb).copied().unwrap_or(0.0);
	let mut hi = 0.0;
	let mut lo = 0.0;
	let mut k: i32 = 0;
	if hx > 0x3fd6_2e42 {
		if hx < 0x3ff0_a2b2 {
			// V8 special-cases exp(1) so that it is exactly E.
			if x == 1.0 {
				return E;
			}
			hi = x - ln2_hi;
			lo = ln2_lo;
			k = if xsb == 0 { 1 } else { -1 };
		} else {
			k = truncate_small(INVLN2.mul_add(x, HALF.get(xsb).copied().unwrap_or(0.5)));
			let t = f64::from(k);
			hi = (-t).mul_add(LN2_HI_BITS, x);
			lo = t * LN2_LO_BITS;
		}
		x = hi - lo;
	} else if hx < 0x3e30_0000 && HUGE + x > 1.0 {
		// |x| < 2^-28 (fdlibm's `huge + x > one` also raises inexact).
		return 1.0 + x;
	}
	let t = x * x;
	let twopk = if k >= -1021 {
		from_words(unsigned(0x3ff0_0000 + (k << 20)), 0)
	} else {
		from_words(unsigned(0x3ff0_0000 + ((k + 1000) << 20)), 0)
	};
	let c = (-t).mul_add(horner(t, &[P1, P2, P3, P4, P5]), x);
	if k == 0 {
		return 1.0 - ((x * c) / (c - 2.0) - x);
	}
	let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
	if k >= -1021 {
		if k == 1024 {
			return y * 2.0 * TWO1023;
		}
		return y * twopk;
	}
	y * twopk * TWO_M1000
}

/// `Math.log(x)` (fdlibm `__ieee754_log` as V8 carries it).
#[must_use]
#[allow(clippy::many_single_char_names)]
pub fn log(x: f64) -> f64 {
	const LN2_HI: f64 = LN2_HI_BITS;
	const LN2_LO: f64 = LN2_LO_BITS;
	const TWO54: f64 = f64::from_bits(0x4350_0000_0000_0000);
	const LG1: f64 = f64::from_bits(0x3fe5_5555_5555_5593);
	const LG2_: f64 = f64::from_bits(0x3fd9_9999_9997_fa04);
	const LG3: f64 = f64::from_bits(0x3fd2_4924_9422_9359);
	const LG4: f64 = f64::from_bits(0x3fcc_71c5_1d8e_78af);
	const LG5: f64 = f64::from_bits(0x3fc7_4664_96cb_03de);
	const LG6: f64 = f64::from_bits(0x3fc3_9a09_d078_c69f);
	const LG7: f64 = f64::from_bits(0x3fc2_f112_df3e_5244);

	let mut x = x;
	let mut hx = signed(high_word(x));
	let lx = low_word(x);
	let mut k: i32 = 0;
	if hx < 0x0010_0000 {
		if ((hx & 0x7fff_ffff) | signed(lx)) == 0 {
			return f64::NEG_INFINITY;
		}
		if hx < 0 {
			return f64::NAN;
		}
		k -= 54;
		x *= TWO54;
		hx = signed(high_word(x));
	}
	if hx >= 0x7ff0_0000 {
		return x + x;
	}
	k += (hx >> 20) - 1023;
	hx &= 0x000f_ffff;
	let i = (hx + 0x95f64) & 0x0010_0000;
	x = with_high_word(x, unsigned(hx | (i ^ 0x3ff0_0000)));
	k += i >> 20;
	let f = x - 1.0;
	let dk = f64::from(k);
	if (0x000f_ffff & (2 + hx)) < 3 {
		// -2^-20 <= f < 2^-20.
		if f == 0.0 {
			return if k == 0 {
				0.0
			} else {
				dk.mul_add(LN2_HI, dk * LN2_LO)
			};
		}
		let r = (f * f) * (-ONE_THIRD).mul_add(f, 0.5);
		return if k == 0 {
			f - r
		} else {
			dk.mul_add(LN2_HI, -((-dk).mul_add(LN2_LO, r) - f))
		};
	}
	let s = f / (2.0 + f);
	let z = s * s;
	let mut i = hx - 0x6147a;
	let w = z * z;
	let j = 0x6b851 - hx;
	let t1 = w * horner(w, &[LG2_, LG4, LG6]);
	let t2 = z * horner(w, &[LG1, LG3, LG5, LG7]);
	i |= j;
	let r = t2 + t1;
	if i > 0 {
		let hfsq = 0.5 * f * f;
		if k == 0 {
			f - (-s).mul_add(hfsq + r, hfsq)
		} else {
			dk.mul_add(LN2_HI, -((hfsq - s.mul_add(hfsq + r, dk * LN2_LO)) - f))
		}
	} else if k == 0 {
		(-s).mul_add(f - r, f)
	} else {
		dk.mul_add(LN2_HI, -(s.mul_add(f - r, -(dk * LN2_LO)) - f))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn special_cases_follow_ecmascript() {
		assert!(pow(1.0, f64::INFINITY).is_nan());
		assert!(pow(-1.0, f64::NEG_INFINITY).is_nan());
		assert!(pow(1.0, f64::NAN).is_nan());
		assert_eq!(pow(f64::NAN, 0.0), 1.0);
		assert_eq!(pow(2.0, 10.0), 1024.0);
		assert_eq!(pow(-8.0, 3.0), -512.0);
		assert!(pow(-8.0, 1.0 / 3.0).is_nan());
		assert_eq!(pow(0.0, -1.0), f64::INFINITY);
		assert_eq!(pow(-0.0, -1.0), f64::NEG_INFINITY);
		assert_eq!(exp(1.0), std::f64::consts::E);
		assert_eq!(exp(0.0), 1.0);
		assert_eq!(log(1.0), 0.0);
		assert_eq!(log(0.0), f64::NEG_INFINITY);
		assert!(log(-1.0).is_nan());
	}
}
