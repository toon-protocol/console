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

/// Seconds as something a person reads — whole units, never a false
/// precision. Mirrors `duration` in `packages/ui/src/app/workload-card.tsx`
/// exactly: the runway figure is the daemon's own arithmetic (never
/// recomputed here), and this is only the words it is shown in.
pub fn duration(seconds: i64) -> String {
    if seconds <= 0 {
        return "none".to_string();
    }
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3600;
    let minutes = (seconds % 3600) / 60;
    if days > 0 {
        return format!("{days} d {hours} h");
    }
    if hours > 0 {
        return format!("{hours} h {minutes} min");
    }
    if minutes > 0 {
        return format!("{minutes} min");
    }
    format!("{seconds} s")
}

/// RFC 4648 base32, lowercase, unpadded — the alphabet a DNS label allows.
/// Mirrors `base32Lower` in `packages/daemon/src/gateway-name.ts` exactly.
const BASE32_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

fn base32_lower(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    for &byte in bytes {
        value = (value << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32_ALPHABET[((value >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32_ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// The hostname a Workload Gateway serves this workload at (spec §12.2,
/// TOON_Network#97), mirroring `hostnameFor` in
/// `packages/daemon/src/gateway-name.ts` byte for byte: it is DERIVED from
/// the workload id and the active profile's `gatewayDomain` alone, never
/// fetched — so a row can show it the moment the dashboard loads, with no
/// extra packet per workload and nothing here to disagree with the gateway
/// (comparing the two, rather than trusting one, is a later ticket's `g`
/// action).
///
/// `None` when the id is not 64 lowercase hex characters, or the profile
/// names no gateway domain — both ordinary states (mainnet today; a
/// workload id this console has not validated), not errors to surface.
pub fn gateway_hostname_for(workload_id: &str, gateway_domain: &str) -> Option<String> {
    let domain = gateway_domain.trim().trim_end_matches('.').to_lowercase();
    if domain.is_empty() {
        return None;
    }
    let is_lowercase_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    if workload_id.len() != 64 || !workload_id.bytes().all(is_lowercase_hex) {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&workload_id[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(format!("{}.{domain}", base32_lower(&bytes)))
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
    fn duration_matches_the_webs_own_duration_function() {
        assert_eq!(duration(0), "none");
        assert_eq!(duration(-5), "none");
        assert_eq!(duration(59), "59 s");
        assert_eq!(duration(60), "1 min");
        assert_eq!(duration(3599), "59 min");
        assert_eq!(duration(3600), "1 h 0 min");
        assert_eq!(duration(90_000), "1 d 1 h");
    }

    #[test]
    fn gateway_hostname_matches_the_daemons_own_gateway_name_ts_byte_for_byte() {
        // Cross-checked against `hostnameFor` in
        // `packages/daemon/src/gateway-name.ts` for these exact inputs.
        assert_eq!(
            gateway_hostname_for(
                "b2e292ee009eb3fc064aaa7a1bc70a28adc1039f495751d4caa0cb9c08fd8abd",
                "gw.devnet.toonprotocol.dev"
            ),
            Some(
                "wlrjf3qat2z7ybskvj5bxrykfcw4ca47jflvdvgkudfzych5rk6q.gw.devnet.toonprotocol.dev"
                    .to_string()
            )
        );
        assert_eq!(
            gateway_hostname_for(&"0".repeat(64), "gw.devnet.toonprotocol.dev"),
            Some(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.gw.devnet.toonprotocol.dev"
                    .to_string()
            )
        );
    }

    #[test]
    fn gateway_hostname_is_none_for_an_id_that_is_not_64_lowercase_hex_characters() {
        assert_eq!(
            gateway_hostname_for("not-a-workload-id", "gw.example.dev"),
            None
        );
        assert_eq!(
            gateway_hostname_for(&"f".repeat(63), "gw.example.dev"),
            None
        );
        assert_eq!(
            gateway_hostname_for(&"F".repeat(64), "gw.example.dev"),
            None
        );
    }

    #[test]
    fn gateway_hostname_is_none_when_the_profile_names_no_gateway_domain() {
        assert_eq!(gateway_hostname_for(&"a".repeat(64), ""), None);
        assert_eq!(gateway_hostname_for(&"a".repeat(64), "   "), None);
    }

    #[test]
    fn gateway_hostname_lowercases_the_domain_and_drops_a_trailing_dot() {
        let with_case = gateway_hostname_for(&"a".repeat(64), "GW.Example.Dev.");
        let plain = gateway_hostname_for(&"a".repeat(64), "gw.example.dev");
        assert_eq!(with_case, plain);
    }
}
