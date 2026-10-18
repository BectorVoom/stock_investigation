//! `Array.prototype.sort` with a comparator, as V8 runs it: TimSort
//! (`third_party/v8/builtins/array-sort.tq`, itself CPython's `listsort`):
//! run detection, binary insertion sort for short runs, `minrun`, galloping
//! merges with V8's `min_gallop` handling.
//!
//! Why not `slice::sort_by`: a JavaScript comparator may be inconsistent
//! (a `NaN` difference, random answers), where Rust's sort panics or orders
//! differently. Here the answer of the comparator is read exactly as V8 reads
//! it (a number below zero means "less", `NaN` counts as zero, anything else
//! as "not less"), the algorithm never panics whatever the comparator says,
//! and the result is V8's, element for element. With a consistent comparator
//! it is a stable sort.
//!
//! Checked against Node by `vectors/js/array-sort.json`.

const MIN_GALLOP_WINS: usize = 7;

/// Sorts `items` like `items.sort(compare)` in V8. `compare(x, y)` is the
/// comparator's numeric answer.
pub fn sort_by_js<T: Clone>(items: &mut [T], compare: impl FnMut(&T, &T) -> f64) {
	if items.len() < 2 {
		return;
	}
	let mut sorter = Sorter {
		a: items.to_vec(),
		cmp: compare,
		min_gallop: MIN_GALLOP_WINS,
		runs: Vec::new(),
	};
	// `None` is unreachable (V8's invariants hold for any comparator); the
	// array is then left as sorted so far rather than panicking.
	let _ = sorter.sort();
	for (slot, value) in items.iter_mut().zip(sorter.a) {
		*slot = value;
	}
}

struct Sorter<T, F> {
	a: Vec<T>,
	cmp: F,
	min_gallop: usize,
	/// Pending runs `(base, length)`.
	runs: Vec<(usize, usize)>,
}

fn at(index: i64) -> Option<usize> {
	usize::try_from(index).ok()
}

fn to_i(value: usize) -> i64 {
	i64::try_from(value).unwrap_or(i64::MAX)
}

impl<T: Clone, F: FnMut(&T, &T) -> f64> Sorter<T, F> {
	fn order(cmp: &mut F, x: &T, y: &T) -> f64 {
		let value = cmp(x, y);
		if value.is_nan() { 0.0 } else { value }
	}

	fn get(&self, index: usize) -> Option<T> {
		self.a.get(index).cloned()
	}

	fn set(&mut self, index: usize, value: T) -> Option<()> {
		*self.a.get_mut(index)? = value;
		Some(())
	}

	fn sort(&mut self) -> Option<()> {
		let length = self.a.len();
		let mut low = 0;
		let mut remaining = length;
		let min_run = compute_min_run_length(remaining);
		while remaining != 0 {
			let mut current = self.count_and_make_run(low, low + remaining)?;
			if current < min_run {
				let forced = min_run.min(remaining);
				self.binary_insertion_sort(low, low + current, low + forced)?;
				current = forced;
			}
			self.runs.push((low, current));
			self.merge_collapse()?;
			low += current;
			remaining -= current;
		}
		self.merge_force_collapse()
	}

	fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> Option<usize> {
		let low = low_arg + 1;
		if low == high {
			return Some(1);
		}
		let mut run_length = 2;
		let element_low = self.get(low)?;
		let element_high = self.get(low - 1)?;
		let descending = Self::order(&mut self.cmp, &element_low, &element_high) < 0.0;
		let mut previous = element_low;
		for index in low + 1..high {
			let current = self.get(index)?;
			let order = Self::order(&mut self.cmp, &current, &previous);
			if descending {
				if order >= 0.0 {
					break;
				}
			} else if order < 0.0 {
				break;
			}
			previous = current;
			run_length += 1;
		}
		if descending {
			let end = low_arg + run_length;
			self.a.get_mut(low_arg..end)?.reverse();
		}
		Some(run_length)
	}

	fn binary_insertion_sort(&mut self, low: usize, start_arg: usize, high: usize) -> Option<()> {
		let mut start = if low == start_arg {
			start_arg + 1
		} else {
			start_arg
		};
		while start < high {
			let mut left = low;
			let mut right = start;
			let pivot = self.get(right)?;
			while left < right {
				let mid = left + ((right - left) >> 1);
				let probe = self.get(mid)?;
				if Self::order(&mut self.cmp, &pivot, &probe) < 0.0 {
					right = mid;
				} else {
					left = mid + 1;
				}
			}
			// Shift [left, start) up by one and drop the pivot in.
			self.a.get_mut(left..=start)?.rotate_right(1);
			self.set(left, pivot)?;
			start += 1;
		}
		Some(())
	}

	fn run_invariant_established(&self, n: usize) -> bool {
		if n < 2 {
			return true;
		}
		let length = |i: usize| self.runs.get(i).map_or(0, |run| run.1);
		length(n - 2) > length(n - 1) + length(n)
	}

	fn run_length(&self, n: usize) -> usize {
		self.runs.get(n).map_or(0, |run| run.1)
	}

	fn merge_collapse(&mut self) -> Option<()> {
		while self.runs.len() > 1 {
			let mut n = self.runs.len() - 2;
			if !self.run_invariant_established(n + 1) || !self.run_invariant_established(n) {
				if n > 0 && self.run_length(n - 1) < self.run_length(n + 1) {
					n -= 1;
				}
				self.merge_at(n)?;
			} else if self.run_length(n) <= self.run_length(n + 1) {
				self.merge_at(n)?;
			} else {
				break;
			}
		}
		Some(())
	}

	fn merge_force_collapse(&mut self) -> Option<()> {
		while self.runs.len() > 1 {
			let mut n = self.runs.len() - 2;
			if n > 0 && self.run_length(n - 1) < self.run_length(n + 1) {
				n -= 1;
			}
			self.merge_at(n)?;
		}
		Some(())
	}

	fn merge_at(&mut self, i: usize) -> Option<()> {
		let (mut base_a, mut length_a) = *self.runs.get(i)?;
		let (base_b, mut length_b) = *self.runs.get(i + 1)?;
		self.runs.get_mut(i)?.1 = length_a + length_b;
		self.runs.remove(i + 1);
		// Where does the first element of run B go in run A?
		let key_right = self.get(base_b)?;
		let k = Self::gallop_right(&mut self.cmp, &self.a, &key_right, base_a, length_a, 0)?;
		base_a += k;
		length_a -= k;
		if length_a == 0 {
			return Some(());
		}
		// Where does the last element of run A go in run B?
		let key_left = self.get(base_a + length_a - 1)?;
		length_b = Self::gallop_left(
			&mut self.cmp,
			&self.a,
			&key_left,
			base_b,
			length_b,
			length_b - 1,
		)?;
		if length_b == 0 {
			return Some(());
		}
		if length_a <= length_b {
			self.merge_low(base_a, length_a, base_b, length_b)
		} else {
			self.merge_high(base_a, length_a, base_b, length_b)
		}
	}

	/// `GallopLeft`: the leftmost position in `array[base..base + length]`
	/// where `key` fits.
	fn gallop_left(
		cmp: &mut F,
		array: &[T],
		key: &T,
		base: usize,
		length: usize,
		hint: usize,
	) -> Option<usize> {
		let (length, hint) = (to_i(length), to_i(hint));
		let item = |offset: i64| array.get(at(to_i(base) + offset)?);
		let mut last_ofs: i64 = 0;
		let mut offset: i64 = 1;
		if Self::order(cmp, item(hint)?, key) < 0.0 {
			// array[hint] < key: gallop right.
			let max_ofs = length - hint;
			while offset < max_ofs {
				if Self::order(cmp, item(hint + offset)?, key) >= 0.0 {
					break;
				}
				last_ofs = offset;
				offset = (offset << 1) + 1;
			}
			offset = offset.min(max_ofs);
			last_ofs += hint;
			offset += hint;
		} else {
			// key <= array[hint]: gallop left.
			let max_ofs = hint + 1;
			while offset < max_ofs {
				if Self::order(cmp, item(hint - offset)?, key) < 0.0 {
					break;
				}
				last_ofs = offset;
				offset = (offset << 1) + 1;
			}
			offset = offset.min(max_ofs);
			let tmp = last_ofs;
			last_ofs = hint - offset;
			offset = hint - tmp;
		}
		last_ofs += 1;
		while last_ofs < offset {
			let m = last_ofs + ((offset - last_ofs) >> 1);
			if Self::order(cmp, item(m)?, key) < 0.0 {
				last_ofs = m + 1;
			} else {
				offset = m;
			}
		}
		at(offset)
	}

	/// `GallopRight`: the rightmost position where `key` fits.
	fn gallop_right(
		cmp: &mut F,
		array: &[T],
		key: &T,
		base: usize,
		length: usize,
		hint: usize,
	) -> Option<usize> {
		let (length, hint) = (to_i(length), to_i(hint));
		let item = |offset: i64| array.get(at(to_i(base) + offset)?);
		let mut last_ofs: i64 = 0;
		let mut offset: i64 = 1;
		if Self::order(cmp, key, item(hint)?) < 0.0 {
			// key < array[hint]: gallop left.
			let max_ofs = hint + 1;
			while offset < max_ofs {
				if Self::order(cmp, key, item(hint - offset)?) >= 0.0 {
					break;
				}
				last_ofs = offset;
				offset = (offset << 1) + 1;
			}
			offset = offset.min(max_ofs);
			let tmp = last_ofs;
			last_ofs = hint - offset;
			offset = hint - tmp;
		} else {
			// array[hint] <= key: gallop right.
			let max_ofs = length - hint;
			while offset < max_ofs {
				if Self::order(cmp, key, item(hint + offset)?) < 0.0 {
					break;
				}
				last_ofs = offset;
				offset = (offset << 1) + 1;
			}
			offset = offset.min(max_ofs);
			last_ofs += hint;
			offset += hint;
		}
		last_ofs += 1;
		while last_ofs < offset {
			let m = last_ofs + ((offset - last_ofs) >> 1);
			if Self::order(cmp, key, item(m)?) < 0.0 {
				offset = m;
			} else {
				last_ofs = m + 1;
			}
		}
		at(offset)
	}

	/// Copies `count` elements `from` to `to` within the array (memmove).
	fn move_within(&mut self, from: usize, to: usize, count: usize) -> Option<()> {
		if count == 0 {
			return Some(());
		}
		let chunk: Vec<T> = self.a.get(from..from + count)?.to_vec();
		self.a.get_mut(to..to + count)?.clone_from_slice(&chunk);
		Some(())
	}

	fn copy_from(&mut self, source: &[T], from: usize, to: usize, count: usize) -> Option<()> {
		if count == 0 {
			return Some(());
		}
		self.a
			.get_mut(to..to + count)?
			.clone_from_slice(source.get(from..from + count)?);
		Some(())
	}

	fn merge_low(
		&mut self,
		base_a: usize,
		length_a_arg: usize,
		base_b: usize,
		length_b_arg: usize,
	) -> Option<()> {
		let (mut length_a, mut length_b) = (length_a_arg, length_b_arg);
		let temp: Vec<T> = self.a.get(base_a..base_a + length_a)?.to_vec();
		let mut dest = base_a;
		let mut cursor_temp = 0;
		let mut cursor_b = base_b;
		let first = self.get(cursor_b)?;
		self.set(dest, first)?;
		dest += 1;
		cursor_b += 1;
		enum End {
			Succeed,
			CopyB,
		}
		let end = 'merge: {
			length_b -= 1;
			if length_b == 0 {
				break 'merge End::Succeed;
			}
			if length_a == 1 {
				break 'merge End::CopyB;
			}
			let mut min_gallop = self.min_gallop;
			loop {
				let mut wins_a = 0;
				let mut wins_b = 0;
				// Straightforward merge until one run wins consistently.
				loop {
					let from_b = self.get(cursor_b)?;
					let from_a = temp.get(cursor_temp)?;
					if Self::order(&mut self.cmp, &from_b, from_a) < 0.0 {
						self.set(dest, from_b)?;
						dest += 1;
						cursor_b += 1;
						wins_b += 1;
						length_b -= 1;
						wins_a = 0;
						if length_b == 0 {
							break 'merge End::Succeed;
						}
						if wins_b >= min_gallop {
							break;
						}
					} else {
						self.set(dest, from_a.clone())?;
						dest += 1;
						cursor_temp += 1;
						wins_a += 1;
						length_a -= 1;
						wins_b = 0;
						if length_a == 1 {
							break 'merge End::CopyB;
						}
						if wins_a >= min_gallop {
							break;
						}
					}
				}
				// Galloping.
				min_gallop += 1;
				let mut first_iteration = true;
				while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first_iteration {
					first_iteration = false;
					min_gallop = 1.max(min_gallop - 1);
					self.min_gallop = min_gallop;
					let key = self.get(cursor_b)?;
					wins_a =
						Self::gallop_right(&mut self.cmp, &temp, &key, cursor_temp, length_a, 0)?;
					if wins_a > 0 {
						self.copy_from(&temp, cursor_temp, dest, wins_a)?;
						dest += wins_a;
						cursor_temp += wins_a;
						length_a -= wins_a;
						if length_a == 1 {
							break 'merge End::CopyB;
						}
						if length_a == 0 {
							break 'merge End::Succeed;
						}
					}
					let from_b = self.get(cursor_b)?;
					self.set(dest, from_b)?;
					dest += 1;
					cursor_b += 1;
					length_b -= 1;
					if length_b == 0 {
						break 'merge End::Succeed;
					}
					let key = temp.get(cursor_temp)?.clone();
					wins_b =
						Self::gallop_left(&mut self.cmp, &self.a, &key, cursor_b, length_b, 0)?;
					if wins_b > 0 {
						self.move_within(cursor_b, dest, wins_b)?;
						dest += wins_b;
						cursor_b += wins_b;
						length_b -= wins_b;
						if length_b == 0 {
							break 'merge End::Succeed;
						}
					}
					self.set(dest, temp.get(cursor_temp)?.clone())?;
					dest += 1;
					cursor_temp += 1;
					length_a -= 1;
					if length_a == 1 {
						break 'merge End::CopyB;
					}
				}
				min_gallop += 1;
				self.min_gallop = min_gallop;
			}
		};
		match end {
			End::Succeed => {
				if length_a > 0 {
					self.copy_from(&temp, cursor_temp, dest, length_a)?;
				}
			}
			End::CopyB => {
				// The last element of run A belongs at the end of the merge.
				self.move_within(cursor_b, dest, length_b)?;
				self.set(dest + length_b, temp.get(cursor_temp)?.clone())?;
			}
		}
		Some(())
	}

	fn merge_high(
		&mut self,
		base_a: usize,
		length_a_arg: usize,
		base_b: usize,
		length_b_arg: usize,
	) -> Option<()> {
		let (mut length_a, mut length_b) = (length_a_arg, length_b_arg);
		let temp: Vec<T> = self.a.get(base_b..base_b + length_b)?.to_vec();
		// Signed cursors: they may step one below zero at the very end.
		let mut dest = to_i(base_b + length_b) - 1;
		let mut cursor_temp = to_i(length_b) - 1;
		let mut cursor_a = to_i(base_a + length_a) - 1;
		let first = self.get(at(cursor_a)?)?;
		self.set(at(dest)?, first)?;
		dest -= 1;
		cursor_a -= 1;
		enum End {
			Succeed,
			CopyA,
		}
		let end = 'merge: {
			length_a -= 1;
			if length_a == 0 {
				break 'merge End::Succeed;
			}
			if length_b == 1 {
				break 'merge End::CopyA;
			}
			let mut min_gallop = self.min_gallop;
			loop {
				let mut wins_a = 0;
				let mut wins_b = 0;
				loop {
					let from_temp = temp.get(at(cursor_temp)?)?.clone();
					let from_a = self.get(at(cursor_a)?)?;
					if Self::order(&mut self.cmp, &from_temp, &from_a) < 0.0 {
						self.set(at(dest)?, from_a)?;
						dest -= 1;
						cursor_a -= 1;
						wins_a += 1;
						length_a -= 1;
						wins_b = 0;
						if length_a == 0 {
							break 'merge End::Succeed;
						}
						if wins_a >= min_gallop {
							break;
						}
					} else {
						self.set(at(dest)?, from_temp)?;
						dest -= 1;
						cursor_temp -= 1;
						wins_b += 1;
						length_b -= 1;
						wins_a = 0;
						if length_b == 1 {
							break 'merge End::CopyA;
						}
						if wins_b >= min_gallop {
							break;
						}
					}
				}
				min_gallop += 1;
				let mut first_iteration = true;
				while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first_iteration {
					first_iteration = false;
					min_gallop = 1.max(min_gallop - 1);
					self.min_gallop = min_gallop;
					let key = temp.get(at(cursor_temp)?)?.clone();
					let k = Self::gallop_right(
						&mut self.cmp,
						&self.a,
						&key,
						base_a,
						length_a,
						length_a - 1,
					)?;
					wins_a = length_a - k;
					if wins_a > 0 {
						dest -= to_i(wins_a);
						cursor_a -= to_i(wins_a);
						self.move_within(at(cursor_a + 1)?, at(dest + 1)?, wins_a)?;
						length_a -= wins_a;
						if length_a == 0 {
							break 'merge End::Succeed;
						}
					}
					self.set(at(dest)?, temp.get(at(cursor_temp)?)?.clone())?;
					dest -= 1;
					cursor_temp -= 1;
					length_b -= 1;
					if length_b == 1 {
						break 'merge End::CopyA;
					}
					let key = self.get(at(cursor_a)?)?;
					let k =
						Self::gallop_left(&mut self.cmp, &temp, &key, 0, length_b, length_b - 1)?;
					wins_b = length_b - k;
					if wins_b > 0 {
						dest -= to_i(wins_b);
						cursor_temp -= to_i(wins_b);
						self.copy_from(&temp, at(cursor_temp + 1)?, at(dest + 1)?, wins_b)?;
						length_b -= wins_b;
						if length_b == 1 {
							break 'merge End::CopyA;
						}
						if length_b == 0 {
							break 'merge End::Succeed;
						}
					}
					let from_a = self.get(at(cursor_a)?)?;
					self.set(at(dest)?, from_a)?;
					dest -= 1;
					cursor_a -= 1;
					length_a -= 1;
					if length_a == 0 {
						break 'merge End::Succeed;
					}
				}
				min_gallop += 1;
				self.min_gallop = min_gallop;
			}
		};
		match end {
			End::Succeed => {
				if length_b > 0 {
					let from = cursor_temp - (to_i(length_b) - 1);
					let to = dest - (to_i(length_b) - 1);
					self.copy_from(&temp, at(from)?, at(to)?, length_b)?;
				}
			}
			End::CopyA => {
				// The first element of run B belongs at the front of the merge.
				dest -= to_i(length_a);
				cursor_a -= to_i(length_a);
				self.move_within(at(cursor_a + 1)?, at(dest + 1)?, length_a)?;
				self.set(at(dest)?, temp.get(at(cursor_temp)?)?.clone())?;
			}
		}
		Some(())
	}
}

fn compute_min_run_length(mut n: usize) -> usize {
	let mut r = 0;
	while n >= 64 {
		r |= n & 1;
		n >>= 1;
	}
	n + r
}

#[cfg(test)]
#[allow(
	clippy::cast_possible_truncation,
	clippy::cast_possible_wrap,
	clippy::cast_sign_loss,
	clippy::cast_precision_loss,
	clippy::indexing_slicing,
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic
)]
mod tests {
	use super::*;

	#[test]
	fn sorts_stably_with_a_consistent_comparator() {
		let mut items: Vec<(u32, usize)> = (0..500).map(|i| ((i * 7919 % 13) as u32, i)).collect();
		sort_by_js(&mut items, |a, b| f64::from(a.0) - f64::from(b.0));
		assert!(
			items
				.windows(2)
				.all(|w| w[0].0 < w[1].0 || (w[0].0 == w[1].0 && w[0].1 < w[1].1))
		);
	}

	#[test]
	fn never_panics_on_an_inconsistent_comparator() {
		let mut state = 12345u32;
		for size in 0..200usize {
			let mut items: Vec<usize> = (0..size).collect();
			sort_by_js(&mut items, |_, _| {
				state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
				match state >> 29 {
					0 => f64::NAN,
					1 => -1.0,
					2 => 1.0,
					3 => 0.0,
					_ => f64::from(state >> 20) - 2048.0,
				}
			});
			let mut sorted = items.clone();
			sorted.sort_unstable();
			assert_eq!(sorted, (0..size).collect::<Vec<_>>());
		}
	}
}

#[cfg(test)]
#[allow(
	clippy::cast_possible_truncation,
	clippy::cast_possible_wrap,
	clippy::cast_sign_loss,
	clippy::cast_precision_loss,
	clippy::indexing_slicing,
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic
)]
mod vector_tests {
	use super::*;
	use crate::json::{Value, parse};

	#[derive(Clone)]
	struct Element {
		id: i64,
		key: f64,
		other: f64,
	}

	fn number(value: &Value) -> f64 {
		match value {
			Value::Number(n) => *n,
			_ => f64::INFINITY,
		}
	}

	fn table_answer(seed: i64, a: i64, b: i64) -> f64 {
		const TABLE: [f64; 8] = [f64::NAN, -1.0, 1.0, 0.0, -7.0, 3.0, 0.5, -0.25];
		let hash = (a as i32).wrapping_mul(73_856_093)
			^ (b as i32).wrapping_mul(19_349_663)
			^ (seed as i32).wrapping_mul(83_492_791);
		TABLE[(hash as u32 % 8) as usize]
	}

	#[test]
	fn matches_v8() {
		let path = format!(
			"{}/../../vectors/js/array-sort.json",
			env!("CARGO_MANIFEST_DIR")
		);
		let text = std::fs::read_to_string(&path).unwrap();
		let cases = parse(&text).unwrap();
		let cases = cases.as_array().unwrap();
		assert!(cases.len() > 1000);
		let mut failures = Vec::new();
		for (index, case) in cases.iter().enumerate() {
			let object = case.as_object().unwrap();
			let kind = object.get("kind").and_then(Value::as_str).unwrap();
			let seed = object.get("seed").and_then(Value::as_f64).unwrap() as i64;
			let keys = object.get("keys").and_then(Value::as_array).unwrap();
			let others = object.get("others").and_then(Value::as_array).unwrap();
			let mut items: Vec<Element> = keys
				.iter()
				.enumerate()
				.map(|(id, key)| Element {
					id: id as i64,
					key: number(key),
					other: others.get(id).map_or(0.0, number),
				})
				.collect();
			match kind {
				"consistent" => sort_by_js(&mut items, |a, b| a.key - b.key),
				"table" => sort_by_js(&mut items, |a, b| table_answer(seed, a.id, b.id)),
				_ => sort_by_js(&mut items, |a, b| {
					let delta = |x: &Element| (x.key - x.other).abs();
					let d = delta(b) - delta(a);
					if d.is_nan() || d == 0.0 {
						(a.id - b.id) as f64
					} else {
						d
					}
				}),
			}
			let order: Vec<i64> = items.iter().map(|e| e.id).collect();
			let expected: Vec<i64> = object
				.get("order")
				.and_then(Value::as_array)
				.unwrap()
				.iter()
				.map(|v| number(v) as i64)
				.collect();
			if order != expected {
				failures.push(format!("case {index} ({kind}, n={})", keys.len()));
			}
		}
		assert!(
			failures.is_empty(),
			"{} mismatches, first {:?}",
			failures.len(),
			failures.iter().take(8).collect::<Vec<_>>()
		);
	}
}

#[cfg(test)]
#[allow(
	clippy::cast_possible_truncation,
	clippy::cast_possible_wrap,
	clippy::cast_sign_loss,
	clippy::cast_precision_loss,
	clippy::indexing_slicing,
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic
)]
mod gallop_tests {
	use super::*;
	#[test]
	fn gallops_agree_with_bounds() {
		type S = Sorter<i32, fn(&i32, &i32) -> f64>;
		let cmp: fn(&i32, &i32) -> f64 = |a, b| f64::from(*a) - f64::from(*b);
		for len in 1..40usize {
			let arr: Vec<i32> = (0..len as i32).map(|i| i / 3).collect();
			for key in -1..16 {
				for hint in 0..len {
					let lo = arr.iter().filter(|v| **v < key).count();
					let hi = arr.iter().filter(|v| **v <= key).count();
					let mut c = cmp;
					let l = S::gallop_left(&mut c, &arr, &key, 0, len, hint).unwrap();
					let r = S::gallop_right(&mut c, &arr, &key, 0, len, hint).unwrap();
					assert_eq!((l, r), (lo, hi), "len {len} key {key} hint {hint}");
				}
			}
		}
	}
}

#[cfg(test)]
#[allow(
	clippy::cast_possible_truncation,
	clippy::cast_possible_wrap,
	clippy::cast_sign_loss,
	clippy::cast_precision_loss,
	clippy::indexing_slicing,
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic
)]
mod merge_tests {
	use super::*;
	#[test]
	fn merges_match_stable_merge() {
		let mut s = 7u64;
		for la in 1..30usize {
			for lb in 1..30usize {
				for modulus in [2u64, 5, 100] {
					let make = |n: usize, tag: usize, s: &mut u64| {
						let mut v: Vec<(u64, usize)> = (0..n)
							.map(|i| {
								*s = s
									.wrapping_mul(6364136223846793005)
									.wrapping_add(1442695040888963407);
								((*s >> 33) % modulus, tag * 1000 + i)
							})
							.collect();
						v.sort_by_key(|x| x.0);
						v
					};
					let a = make(la, 0, &mut s);
					let b = make(lb, 1, &mut s);
					let mut all = a.clone();
					all.extend(b.clone());
					let mut expected = all.clone();
					expected.sort_by_key(|x| x.0);
					let mut sorter = Sorter {
						a: all,
						cmp: |x: &(u64, usize), y: &(u64, usize)| x.0 as f64 - y.0 as f64,
						min_gallop: 7,
						runs: vec![(0, la), (la, lb)],
					};
					let low = la <= lb;
					assert!(
						sorter.merge_at(0).is_some(),
						"None la {la} lb {lb} mod {modulus}"
					);
					assert_eq!(
						sorter.a, expected,
						"la {la} lb {lb} mod {modulus} low {low}"
					);
				}
			}
		}
	}
}
