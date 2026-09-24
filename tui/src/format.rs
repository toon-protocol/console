//! Small display formatters shared by views.
//!
//! Kept separate from any one view because the first thing a second view
//! needs is usually a formatter the first view already wrote.

/// Mirrors `formatUptime` in `packages/ui/src/app/health-view.tsx` exactly —
/// same three bands, same rounding (integer seconds in, so there is nothing
/// to round).
pub fn format_uptime(seconds: i64) -> String {
    let seconds = seconds.max(0);
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {}s", seconds % 60);
    }
    let hours = minutes / 60;
    format!("{hours}h {}m", minutes % 60)
}

/// `HH:MM:SS` out of an ISO-8601 UTC timestamp, the terminal's answer to the
/// web view's `new Date(...).toLocaleTimeString()` — no locale to ask a
/// terminal for, so this shows the UTC clock rather than guess one.
pub fn format_time_of_day(iso: &str) -> String {
    // "2026-09-24T00:00:01.000Z" -> the 8 characters at offset 11.
    iso.get(11..19).unwrap_or(iso).to_string()
}

/// An ISO-8601 UTC timestamp (`"2026-09-24T00:00:01.500Z"`, milliseconds
/// optional) to Unix milliseconds — the Rust side of `Date.parse(...)` for
/// the one thing this crate needs it for: ageing a Liveness against the wall
/// clock (`views::directory::liveness_now`, mirroring `livenessNow` in
/// `use-directory.ts`). No date crate: the daemon only ever sends this exact
/// shape, so a hand-rolled parser is less risk than a dependency for one
/// format. Returns `None` on anything that does not match it, rather than
/// guess.
pub fn parse_iso8601_utc_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let digits = |s: &str| s.parse::<i64>().ok();
    let year = digits(text.get(0..4)?)?;
    let month = digits(text.get(5..7)?)?;
    let day = digits(text.get(8..10)?)?;
    let hour = digits(text.get(11..13)?)?;
    let minute = digits(text.get(14..16)?)?;
    let second = digits(text.get(17..19)?)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let millis = match text.get(19..) {
        Some(rest) if rest.starts_with('.') && rest.len() >= 4 => digits(&rest[1..4])?,
        Some("Z") | Some("") => 0,
        _ => return None,
    };

    // Howard Hinnant's civil-to-days algorithm: days since the Unix epoch
    // for a proleptic Gregorian civil date, valid for any year this crate
    // will ever see.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era * 146_097 + doe - 719_468;

    let seconds = days_since_epoch * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(seconds * 1_000 + millis)
}

/// A Liveness countdown or age, the way `formatSeconds` in
/// `packages/ui/src/app/directory-view.tsx` spells it: seconds, then whole
/// minutes, then whole hours, then whole days — never a fraction, and never
/// negative (the caller decides "left" or "ago" from the sign itself).
pub fn format_seconds(seconds: i64) -> String {
    let seconds = seconds.max(0);
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    format!("{}d", hours / 24)
}

/// A Lease Interval as a person reads one, mirroring `formatInterval` in
/// `directory-view.tsx` exactly: the largest whole unit the seconds divide
/// into evenly, seconds left bare when none of them do.
pub fn format_interval(seconds: i64) -> String {
    if seconds % 86_400 == 0 {
        return format!("{}d", seconds / 86_400);
    }
    if seconds % 3_600 == 0 {
        return format!("{}h", seconds / 3_600);
    }
    if seconds % 60 == 0 {
        return format!("{}m", seconds / 60);
    }
    format!("{seconds}s")
}

/// `n.toLocaleString()` in the one locale this crate ever shows a price in:
/// thousands grouped with a comma, same as the web UI's µUSDC amounts.
pub fn format_thousands(n: i64) -> String {
    let sign = if n < 0 { "-" } else { "" };
    let digits = n.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    format!("{sign}{grouped}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uptime_under_a_minute_is_seconds_only() {
        assert_eq!(format_uptime(0), "0s");
        assert_eq!(format_uptime(59), "59s");
    }

    #[test]
    fn uptime_under_an_hour_is_minutes_and_seconds() {
        assert_eq!(format_uptime(60), "1m 0s");
        assert_eq!(format_uptime(125), "2m 5s");
        assert_eq!(format_uptime(3599), "59m 59s");
    }

    #[test]
    fn uptime_an_hour_or_more_is_hours_and_minutes() {
        assert_eq!(format_uptime(3600), "1h 0m");
        assert_eq!(format_uptime(3660), "1h 1m");
        assert_eq!(format_uptime(90_000), "25h 0m");
    }

    #[test]
    fn time_of_day_reads_the_clock_out_of_an_iso_timestamp() {
        assert_eq!(format_time_of_day("2026-09-24T13:05:09.123Z"), "13:05:09");
    }

    #[test]
    fn time_of_day_falls_back_to_the_raw_string_if_it_is_too_short() {
        assert_eq!(format_time_of_day("bad"), "bad");
    }

    #[test]
    fn iso8601_parses_the_unix_epoch_and_a_known_timestamp() {
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:00.000Z"), Some(0));
        // 2026-09-22T12:00:00Z, checked against `date -u -d "2026-09-22T12:00:00Z" +%s`.
        assert_eq!(
            parse_iso8601_utc_ms("2026-09-22T12:00:00.000Z"),
            Some(1_790_078_400_000)
        );
        assert_eq!(
            parse_iso8601_utc_ms("2026-09-22T12:00:00.500Z"),
            Some(1_790_078_400_500)
        );
    }

    #[test]
    fn iso8601_accepts_no_milliseconds_and_refuses_nonsense() {
        assert_eq!(
            parse_iso8601_utc_ms("1970-01-01T00:00:00Z"),
            Some(0),
            "a bare Z with no fraction still parses"
        );
        assert_eq!(parse_iso8601_utc_ms("not a date"), None);
        assert_eq!(parse_iso8601_utc_ms(""), None);
    }

    #[test]
    fn seconds_band_the_same_way_the_web_ui_does() {
        assert_eq!(format_seconds(0), "0s");
        assert_eq!(format_seconds(59), "59s");
        assert_eq!(format_seconds(60), "1m");
        assert_eq!(format_seconds(3599), "59m");
        assert_eq!(format_seconds(3600), "1h");
        assert_eq!(format_seconds(86_399), "23h");
        assert_eq!(format_seconds(86_400), "1d");
        assert_eq!(format_seconds(-5), "0s", "never negative on screen");
    }

    #[test]
    fn interval_picks_the_largest_whole_unit() {
        assert_eq!(format_interval(86_400), "1d");
        assert_eq!(format_interval(3_600), "1h");
        assert_eq!(format_interval(60), "1m");
        assert_eq!(format_interval(90), "90s");
        assert_eq!(format_interval(7_200), "2h");
    }

    #[test]
    fn thousands_groups_like_to_locale_string() {
        assert_eq!(format_thousands(0), "0");
        assert_eq!(format_thousands(800), "800");
        assert_eq!(format_thousands(1000), "1,000");
        assert_eq!(format_thousands(20_000), "20,000");
        assert_eq!(format_thousands(1_234_567), "1,234,567");
        assert_eq!(format_thousands(-2_500), "-2,500");
    }
}
