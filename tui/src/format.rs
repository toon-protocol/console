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
}
