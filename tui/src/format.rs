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

/// Mirrors `shortNpub` in `packages/ui/src/app/account-view.tsx`: enough of
/// an npub to recognise it at a glance, not all sixty-three characters —
/// used both by the header (TOON_Network#141) and the Account view itself.
pub fn short_npub(npub: &str) -> String {
    if npub.len() <= 16 {
        return npub.to_string();
    }
    format!("{}…{}", &npub[..10], &npub[npub.len() - 4..])
}

/// The name shown for a signed-in account: its kind-0 `displayName`, then
/// its `name`, then its short npub — `AccountChip`'s own fallback chain in
/// `packages/ui/src/app/account-view.tsx`.
pub fn account_display_name(view: &crate::types::AccountView) -> String {
    view.profile
        .as_ref()
        .and_then(|profile| profile.metadata.as_ref())
        .and_then(|metadata| {
            metadata
                .display_name
                .clone()
                .or_else(|| metadata.name.clone())
        })
        .unwrap_or_else(|| short_npub(&view.npub))
}

/// Base units, scaled for READING only — mirrors `formatAmount`/`scale` in
/// `packages/ui/src/app/funding-view.tsx` exactly, including its reason for
/// existing: a balance can be larger than an `f64` holds exactly, so this is
/// string arithmetic on the decimal digits, never a float division. Nothing
/// built here is fed back into a request; what goes to the daemon is always
/// the integer base-unit string the chain reported.
pub fn format_amount(amount: Option<&crate::types::Amount>) -> String {
    let Some(amount) = amount else {
        return "unknown".to_string();
    };
    let text = match amount.decimals {
        Some(decimals) => scale(&amount.amount, decimals),
        None => amount.amount.clone(),
    };
    match &amount.symbol {
        Some(symbol) => format!("{text} {symbol}"),
        None => text,
    }
}

fn scale(amount: &str, decimals: i64) -> String {
    if decimals <= 0 || amount.is_empty() || !amount.bytes().all(|b| b.is_ascii_digit()) {
        return amount.to_string();
    }
    let decimals = decimals as usize;
    let padded = format!("{amount:0>width$}", width = decimals + 1);
    let split_at = padded.len() - decimals;
    let whole = &padded[..split_at];
    let fraction = padded[split_at..].trim_end_matches('0');
    if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    }
}

/// Schoolbook addition on two non-negative base-10, base-unit strings — no
/// sign, no dependency on a bignum crate, and (unlike `f64`) exact at any
/// length, which is the same reason `scale` above does not divide with one.
fn add_decimal(a: &str, b: &str) -> String {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let mut out = Vec::with_capacity(a.len().max(b.len()) + 1);
    let mut carry = 0u32;
    let mut i = 0usize;
    loop {
        let da = a.len().checked_sub(1 + i).map(|at| u32::from(a[at] - b'0'));
        let db = b.len().checked_sub(1 + i).map(|at| u32::from(b[at] - b'0'));
        if da.is_none() && db.is_none() && carry == 0 {
            break;
        }
        let sum = da.unwrap_or(0) + db.unwrap_or(0) + carry;
        out.push(b'0' + (sum % 10) as u8);
        carry = sum / 10;
        i += 1;
    }
    if out.is_empty() {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).expect("only ASCII digits were pushed")
}

/// The header's "total channel balance" (ADR 0028's Funds view): every OPEN
/// channel's `available`, scaled by its own chain's token decimals and
/// summed per distinct symbol. Two chains rarely share a token, so two
/// symbols show as two terms rather than one figure that quietly added a
/// wei amount to a lamport amount. `None` (funding not read yet) reads as
/// `…`; loaded with no open channel reads as `none`.
pub fn total_channel_balance(funding: Option<&crate::types::FundingStatus>) -> String {
    let Some(funding) = funding else {
        return "…".to_string();
    };
    let mut totals: std::collections::BTreeMap<String, (String, i64)> =
        std::collections::BTreeMap::new();
    for chain in &funding.chains {
        if chain.channel.phase != "open" {
            continue;
        }
        let Some(available) = &chain.channel.available else {
            continue;
        };
        if available.is_empty() || !available.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let symbol = chain
            .balances
            .token
            .as_ref()
            .and_then(|token| token.symbol.clone())
            .unwrap_or_default();
        let decimals = chain.token.decimals;
        let entry = totals
            .entry(symbol)
            .or_insert_with(|| ("0".to_string(), decimals));
        entry.0 = add_decimal(&entry.0, available);
    }
    if totals.is_empty() {
        return "none".to_string();
    }
    totals
        .into_iter()
        .map(|(symbol, (sum, decimals))| {
            let scaled = scale(&sum, decimals);
            if symbol.is_empty() {
                scaled
            } else {
                format!("{scaled} {symbol}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
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

    #[test]
    fn a_short_npub_is_shown_in_full() {
        assert_eq!(short_npub("npub1abc"), "npub1abc");
    }

    #[test]
    fn a_full_length_npub_is_shortened_to_its_ends() {
        let npub = "npub1exampleexampleexampleexampleexampleexampleexampleexamplex";
        assert_eq!(short_npub(npub), "npub1examp…plex");
    }

    fn amount(value: &str, decimals: Option<i64>, symbol: Option<&str>) -> crate::types::Amount {
        crate::types::Amount {
            amount: value.to_string(),
            decimals,
            symbol: symbol.map(str::to_string),
            address: None,
        }
    }

    #[test]
    fn format_amount_is_unknown_for_none() {
        assert_eq!(format_amount(None), "unknown");
    }

    #[test]
    fn format_amount_scales_by_decimals_and_appends_the_symbol() {
        let a = amount("5000000", Some(6), Some("USDC"));
        assert_eq!(format_amount(Some(&a)), "5 USDC");

        let b = amount("1500000", Some(6), Some("USDC"));
        assert_eq!(format_amount(Some(&b)), "1.5 USDC");
    }

    #[test]
    fn format_amount_with_no_decimals_field_is_shown_raw() {
        let a = amount("42", None, Some("wei"));
        assert_eq!(format_amount(Some(&a)), "42 wei");
    }

    #[test]
    fn format_amount_with_no_symbol_omits_it() {
        let a = amount("5000000", Some(6), None);
        assert_eq!(format_amount(Some(&a)), "5");
    }

    #[test]
    fn scale_leaves_a_non_digit_amount_untouched() {
        // Exercised through `format_amount`, since `scale` is private: a
        // malformed base-unit string must render as itself, never panic.
        let a = amount("not-a-number", Some(6), None);
        assert_eq!(format_amount(Some(&a)), "not-a-number");
    }

    fn chain_with_channel(
        phase: &str,
        available: Option<&str>,
        symbol: Option<&str>,
        decimals: i64,
    ) -> crate::types::ChainFundingView {
        use crate::types::*;
        ChainFundingView {
            chain: "evm:84532".to_string(),
            kind: "evm".to_string(),
            counterparty: "https://connector.example".to_string(),
            token: TokenRef {
                address: "0xusdc".to_string(),
                decimals,
            },
            deposit: ChainAddress {
                address: "0xdead".to_string(),
                path: "m/44'/60'/0'/0/0".to_string(),
            },
            rpc: RpcRef {
                url: "https://rpc.example".to_string(),
                source: "profile".to_string(),
            },
            balances: BalanceView {
                state: "read".to_string(),
                native: None,
                token: Some(Amount {
                    amount: "0".to_string(),
                    decimals: Some(decimals),
                    symbol: symbol.map(str::to_string),
                    address: None,
                }),
                reason: None,
                read_at: None,
            },
            gas: GasView {
                verdict: "present".to_string(),
                symbol: None,
                headline: String::new(),
                detail: String::new(),
                command: None,
                faucet_gives_gas: false,
            },
            channel: ChannelView {
                phase: phase.to_string(),
                channel_id: None,
                deposit: None,
                spent: None,
                available: available.map(str::to_string),
                nonce: None,
                opened_at: None,
                started_at: None,
                tx_hash: None,
                reason: None,
                out_of_gas: None,
                watermark_uncertain: None,
            },
            can_open: true,
            blocked_by: None,
            suggested_deposit: None,
        }
    }

    fn funding_with(chains: Vec<crate::types::ChainFundingView>) -> crate::types::FundingStatus {
        use crate::types::*;
        FundingStatus {
            state: "ready".to_string(),
            profile: FundingProfileRef {
                id: "devnet".to_string(),
                label: "Devnet".to_string(),
            },
            pubkey: None,
            custody: CustodyView {
                text: String::new(),
                acknowledged_at: None,
            },
            superseded_seeds: 0,
            held_seed: None,
            chains,
            quote: None,
            faucet: None,
            channel_store_path: None,
            reason: None,
            checked_at: "2026-09-24T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn total_channel_balance_is_an_ellipsis_before_funding_loads() {
        assert_eq!(total_channel_balance(None), "…");
    }

    #[test]
    fn total_channel_balance_is_none_with_no_open_channel() {
        let funding = funding_with(vec![chain_with_channel("none", None, None, 6)]);
        assert_eq!(total_channel_balance(Some(&funding)), "none");
    }

    #[test]
    fn total_channel_balance_ignores_a_channel_that_is_only_opening() {
        let funding = funding_with(vec![chain_with_channel(
            "opening",
            Some("1000000"),
            Some("USDC"),
            6,
        )]);
        assert_eq!(total_channel_balance(Some(&funding)), "none");
    }

    #[test]
    fn total_channel_balance_scales_and_sums_one_open_channel() {
        let funding = funding_with(vec![chain_with_channel(
            "open",
            Some("1500000"),
            Some("USDC"),
            6,
        )]);
        assert_eq!(total_channel_balance(Some(&funding)), "1.5 USDC");
    }

    #[test]
    fn total_channel_balance_sums_two_open_channels_with_the_same_symbol() {
        let mut a = chain_with_channel("open", Some("1000000"), Some("USDC"), 6);
        a.chain = "evm:84532".to_string();
        let mut b = chain_with_channel("open", Some("2500000"), Some("USDC"), 6);
        b.chain = "evm:8453".to_string();
        let funding = funding_with(vec![a, b]);
        assert_eq!(total_channel_balance(Some(&funding)), "3.5 USDC");
    }

    #[test]
    fn total_channel_balance_keeps_distinct_symbols_as_separate_terms() {
        let mut a = chain_with_channel("open", Some("1000000"), Some("USDC"), 6);
        a.chain = "evm:84532".to_string();
        let mut b = chain_with_channel("open", Some("2000000000"), Some("SOL-USDC"), 6);
        b.chain = "solana".to_string();
        let funding = funding_with(vec![a, b]);
        // Sorted by symbol (a `BTreeMap` key), not by insertion order.
        assert_eq!(
            total_channel_balance(Some(&funding)),
            "2000 SOL-USDC, 1 USDC"
        );
    }

    #[test]
    fn total_channel_balance_carries_a_sum_larger_than_a_u64() {
        // The whole reason this is string addition and not `u128`: a
        // balance can be bigger than that too, and this proves it does not
        // quietly wrap.
        let mut a = chain_with_channel(
            "open",
            Some("340282366920938463463374607431768211455"),
            Some("WEI"),
            0,
        );
        a.chain = "evm:1".to_string();
        let mut b = chain_with_channel("open", Some("1"), Some("WEI"), 0);
        b.chain = "evm:2".to_string();
        let funding = funding_with(vec![a, b]);
        assert_eq!(
            total_channel_balance(Some(&funding)),
            "340282366920938463463374607431768211456 WEI"
        );
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
