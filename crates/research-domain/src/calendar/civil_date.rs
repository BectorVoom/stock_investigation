//! Port of `packages/domain/src/calendar/civilDate.ts`: UTC civil dates as
//! ISO text, with no clock and no time zone.
//!
//! The TypeScript goes through `Date.UTC`, whose two-digit-year rule maps
//! years 0..=99 to 1900..=1999: `isValidIsoDate` therefore rejects every year
//! below 100, and so does this port (the vectors pin it).

/// `CivilDateError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CivilDateError {
	/// `INVALID_DATE`.
	#[error("INVALID_DATE")]
	InvalidDate,
	/// `INVALID_DAYS`.
	#[error("INVALID_DAYS")]
	InvalidDays,
}

impl CivilDateError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::InvalidDate => "INVALID_DATE",
			Self::InvalidDays => "INVALID_DAYS",
		}
	}
}

/// `ExcelSerialError::InvalidSerial` = `INVALID_SERIAL`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("INVALID_SERIAL")]
pub struct ExcelSerialError;

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's
/// `days_from_civil`); exact for every `i64` year this crate passes.
#[must_use]
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
	let month = i64::from(month);
	let day = i64::from(day);
	let year = if month <= 2 { year - 1 } else { year };
	let era = year.div_euclid(400);
	let year_of_era = year - era * 400;
	let shifted_month = (month + 9) % 12;
	let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	era * 146_097 + day_of_era - 719_468
}

/// The civil date of a day number (inverse of [`days_from_civil`]).
#[must_use]
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
	let shifted = days + 719_468;
	let era = shifted.div_euclid(146_097);
	let day_of_era = shifted - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let shifted_month = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
	let month = if shifted_month < 10 {
		shifted_month + 3
	} else {
		shifted_month - 9
	};
	let year = year_of_era + era * 400 + i64::from(month <= 2);
	(
		year,
		u32::try_from(month).unwrap_or(1),
		u32::try_from(day).unwrap_or(1),
	)
}

/// Days in `month` (1..=12) of `year`.
#[must_use]
pub(crate) const fn days_in_month(year: i64, month: u32) -> u32 {
	match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
		2 => 28,
		_ => 0,
	}
}

/// Value of an ASCII digit run (the caller checked every byte is a digit).
fn digits_value(digits: &[u8]) -> u32 {
	digits
		.iter()
		.fold(0, |value, digit| value * 10 + u32::from(digit - b'0'))
}

/// `/^(\d{4})-(\d{2})-(\d{2})$/` (ASCII digits): year, month, day.
#[must_use]
pub(crate) fn split_iso_date(value: &str) -> Option<(i64, u32, u32)> {
	let bytes = value.as_bytes();
	let [y0, y1, y2, y3, b'-', m0, m1, b'-', d0, d1] = bytes else {
		return None;
	};
	if ![*y0, *y1, *y2, *y3, *m0, *m1, *d0, *d1]
		.iter()
		.all(u8::is_ascii_digit)
	{
		return None;
	}
	let year = i64::from(digits_value(&[*y0, *y1, *y2, *y3]));
	Some((year, digits_value(&[*m0, *m1]), digits_value(&[*d0, *d1])))
}

/// `isValidIsoDate`: true only for a real calendar date in `YYYY-MM-DD` form
/// whose year `Date.UTC` reads literally (100..=9999).
#[must_use]
pub fn is_valid_iso_date(value: &str) -> bool {
	let Some((year, month, day)) = split_iso_date(value) else {
		return false;
	};
	// `Date.UTC(0..=99, …)` means 1900..=1999, so the round trip fails.
	year >= 100 && (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
}

/// `formatIsoDate` for a day number, or `None` when the TypeScript would
/// print something `isValidIsoDate` rejects (a year outside 100..=9999 —
/// `padStart(4)` of a negative or five-digit year, or of `NaN`).
fn format_valid_day(days: i64) -> Option<String> {
	let (year, month, day) = civil_from_days(days);
	(100..=9999)
		.contains(&year)
		.then(|| format!("{year:04}-{month:02}-{day:02}"))
}

/// `addDaysIso`: `iso_date` plus `days` calendar days (UTC, ISO text only).
/// `days` must be an integer; magnitudes that leave the date range fail
/// instead of wrapping.
///
/// # Errors
///
/// `INVALID_DATE` for an invalid date, `INVALID_DAYS` for a non-integer
/// shift or a result outside the valid range.
pub fn add_days_iso(iso_date: &str, days: f64) -> Result<String, CivilDateError> {
	let Some((year, month, day)) = split_iso_date(iso_date).filter(|_| is_valid_iso_date(iso_date))
	else {
		return Err(CivilDateError::InvalidDate);
	};
	if !days.is_finite() || days.trunc() != days {
		return Err(CivilDateError::InvalidDays);
	}
	// Any shift beyond ten million days leaves years 100..=9999 whatever the
	// start, so the exact integer path below never sees a lossy conversion.
	if days.abs() > 10_000_000.0 {
		return Err(CivilDateError::InvalidDays);
	}
	let shift = format!("{days:.0}")
		.parse::<i64>()
		.map_err(|_| CivilDateError::InvalidDays)?;
	format_valid_day(days_from_civil(year, month, day) + shift).ok_or(CivilDateError::InvalidDays)
}

/// `excelSerialToIsoDate`: Excel 1900 date system serial to ISO date. For
/// every accepted serial (integers 61..=2 958 465, 1900-03-01 to 9999-12-31)
/// the date is `1899-12-30 + serial days` (Excel's phantom 1900-02-29 lies
/// below the floor).
///
/// # Errors
///
/// [`ExcelSerialError`] for any other serial.
pub fn excel_serial_to_iso_date(serial: f64) -> Result<String, ExcelSerialError> {
	if !serial.is_finite() || serial.trunc() != serial || !(61.0..=2_958_465.0).contains(&serial) {
		return Err(ExcelSerialError);
	}
	let offset = format!("{serial:.0}")
		.parse::<i64>()
		.map_err(|_| ExcelSerialError)?;
	format_valid_day(days_from_civil(1899, 12, 30) + offset).ok_or(ExcelSerialError)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn day_numbers_round_trip() {
		assert_eq!(days_from_civil(1970, 1, 1), 0);
		assert_eq!(days_from_civil(2000, 3, 1), 11_017);
		for days in [-800_000, -1, 0, 59, 60, 11_016, 2_932_896] {
			let (year, month, day) = civil_from_days(days);
			assert_eq!(days_from_civil(year, month, day), days);
		}
	}

	#[test]
	fn validates_like_date_utc() {
		assert!(is_valid_iso_date("2024-02-29"));
		assert!(!is_valid_iso_date("2023-02-29"));
		assert!(!is_valid_iso_date("0050-01-01"));
		assert!(is_valid_iso_date("0100-01-01"));
		assert!(!is_valid_iso_date("2026-1-01"));
		assert!(!is_valid_iso_date("２０２６-01-01"));
	}

	#[test]
	fn adds_days_and_converts_serials() {
		assert_eq!(add_days_iso("2026-12-31", 1.0), Ok("2027-01-01".to_owned()));
		assert_eq!(
			add_days_iso("2026-03-01", -1.0),
			Ok("2026-02-28".to_owned())
		);
		assert_eq!(
			add_days_iso("2026-03-01", 0.5),
			Err(CivilDateError::InvalidDays)
		);
		assert_eq!(
			add_days_iso("9999-12-31", 1.0),
			Err(CivilDateError::InvalidDays)
		);
		assert_eq!(
			add_days_iso("2026-02-30", 1.0),
			Err(CivilDateError::InvalidDate)
		);
		assert_eq!(excel_serial_to_iso_date(61.0), Ok("1900-03-01".to_owned()));
		assert_eq!(
			excel_serial_to_iso_date(2_958_465.0),
			Ok("9999-12-31".to_owned())
		);
		assert_eq!(excel_serial_to_iso_date(60.0), Err(ExcelSerialError));
	}
}
