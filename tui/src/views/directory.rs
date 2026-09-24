//! The Directory view (TOON_Network#145).
//!
//! A terminal mirror of `packages/ui/src/app/directory-view.tsx`,
//! `directory-filters.tsx` and `hooks/use-directory.ts`: browse the Provider
//! Directory, filter it the same five ways the web UI does, and open a
//! listing's detail with `Enter`.
//!
//! Two pieces, on purpose:
//! - [`ListingPicker`] is the reusable half — its own state, its own key
//!   handling (`j`/`k` move, `Enter` chooses), its own `draw` into whatever
//!   `Rect` it is given, and [`ListingPicker::selected_listing`] as the one
//!   thing a caller reads out of it. #146 (New workload) embeds this
//!   directly to choose a Listing to spawn against; it never needs to know
//!   about filters, relay summaries or this file's [`DirectoryViewState`].
//! - [`DirectoryViewState`] is the whole Directory view: it owns the filter
//!   values, the last relay read's summary, and a `ListingPicker`.
//!
//! Liveness is never trusted from the moment it was read. Like
//! `livenessNow` in `use-directory.ts`, every render recomputes "live" or
//! "stale" against a wall-clock reading the caller passes in (`now_ms`) —
//! nothing here owns a clock or refetches on its own.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

use crate::format::{format_interval, format_seconds, format_thousands, parse_iso8601_utc_ms};
use crate::types::{Directory, DirectoryFilters, ListingView, LivenessView, ProviderView};

/// The label vocabulary §4.4 defines for isolation, in cycle order. Mirrors
/// `ISOLATIONS` in `directory-filters.tsx` (its "Any isolation" option is
/// `None` here).
const ISOLATIONS: &[&str] = &["shared-kernel", "dedicated-host"];
/// Mirrors `ARCHITECTURES` in `directory-filters.tsx`.
const ARCHITECTURES: &[&str] = &["amd64", "arm64"];
/// §4.4 has specified these two; anything else a Listing grants is shown as
/// it came, never toggled by name. Mirrors `CAPABILITIES` in
/// `directory-filters.tsx`.
const CAPABILITIES: &[&str] = &["docker", "nesting"];
/// The GPU filter's constant option, meaning "has a GPU, any model" —
/// `ANY_GPU` in `packages/daemon/src/directory.ts`.
const ANY_GPU: &str = "any";

/// What a keypress this view handled asks the runtime to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectoryCommand {
    None,
    /// A filter changed, or `r` was pressed: re-read `GET /api/directory`
    /// with the state's current `filters`.
    Refresh,
}

/// One (provider, listing) choice, and nothing else — what a picker hands
/// back once something is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerEvent {
    None,
    /// The selection moved; nothing was chosen.
    Moved,
    /// `Enter` was pressed on a row that holds a Listing.
    Chosen,
}

enum PickerRow {
    Header(usize),
    Listing(usize, usize),
}

/// The reusable half: Providers and their Listings, one list, `j`/`k` to
/// move, `Enter` to choose. Self-contained on purpose (see module docs) —
/// #146 embeds this directly.
#[derive(Default)]
pub struct ListingPicker {
    providers: Vec<ProviderView>,
    rows: Vec<PickerRow>,
    /// An index into `rows`. Always a `Listing` row's index while any exist;
    /// meaningless (and never read) while `rows` holds none.
    selected: usize,
}

impl ListingPicker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    /// Replaces the Providers this picker shows, rebuilding the flattened
    /// row list and landing the selection on the first Listing there is —
    /// a stale selection index into a directory that no longer exists is
    /// worse than losing the previous choice.
    pub fn set_providers(&mut self, providers: Vec<ProviderView>) {
        self.providers = providers;
        self.rows = Vec::new();
        for (provider_index, provider) in self.providers.iter().enumerate() {
            self.rows.push(PickerRow::Header(provider_index));
            for listing_index in 0..provider.listings.len() {
                self.rows
                    .push(PickerRow::Listing(provider_index, listing_index));
            }
        }
        self.selected = self.listing_positions().first().copied().unwrap_or(0);
    }

    fn listing_positions(&self) -> Vec<usize> {
        self.rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| matches!(row, PickerRow::Listing(..)).then_some(index))
            .collect()
    }

    /// Moves the selection by `delta` positions among Listing rows only —
    /// a provider's header is shown but never selectable. Clamps at either
    /// end rather than wrapping, so repeatedly pressing `j` at the bottom of
    /// a long directory does nothing surprising.
    pub fn move_selection(&mut self, delta: isize) {
        let positions = self.listing_positions();
        if positions.is_empty() {
            return;
        }
        let current = positions
            .iter()
            .position(|&position| position == self.selected)
            .unwrap_or(0);
        let next = (current as isize + delta).clamp(0, positions.len() as isize - 1) as usize;
        self.selected = positions[next];
    }

    pub fn selected_listing(&self) -> Option<(&ProviderView, &ListingView)> {
        match self.rows.get(self.selected) {
            Some(PickerRow::Listing(provider_index, listing_index)) => {
                let provider = &self.providers[*provider_index];
                Some((provider, &provider.listings[*listing_index]))
            }
            _ => None,
        }
    }

    /// The one place a keypress becomes a decision for this component, so a
    /// caller embedding it (this file's own [`DirectoryViewState`], or #146)
    /// never has to know which keys mean "move" or "choose".
    pub fn handle_key(&mut self, key: KeyEvent) -> PickerEvent {
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                self.move_selection(1);
                PickerEvent::Moved
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.move_selection(-1);
                PickerEvent::Moved
            }
            KeyCode::Enter => {
                if self.selected_listing().is_some() {
                    PickerEvent::Chosen
                } else {
                    PickerEvent::None
                }
            }
            _ => PickerEvent::None,
        }
    }

    /// Draws the flattened Provider/Listing list into `area`, scrolled so
    /// the selected row is always on screen. `now_ms` ages every Liveness
    /// shown (see module docs).
    pub fn draw(&self, frame: &mut Frame, area: Rect, now_ms: i64) {
        let lines: Vec<Line> = self
            .rows
            .iter()
            .map(|row| self.row_line(row, now_ms))
            .collect();

        let height = area.height as usize;
        let offset = if lines.len() <= height {
            0
        } else {
            self.selected
                .saturating_sub(height.saturating_sub(1))
                .min(lines.len().saturating_sub(height))
        };
        let visible: Vec<Line> = lines.into_iter().skip(offset).take(height).collect();
        frame.render_widget(Paragraph::new(visible), area);
    }

    fn row_line(&self, row: &PickerRow, now_ms: i64) -> Line<'static> {
        match row {
            PickerRow::Header(provider_index) => {
                provider_header_line(&self.providers[*provider_index], now_ms)
            }
            PickerRow::Listing(provider_index, listing_index) => {
                let provider = &self.providers[*provider_index];
                let listing = &provider.listings[*listing_index];
                let selected = self.rows.iter().position(|candidate| {
                    matches!(candidate, PickerRow::Listing(p, l) if *p == *provider_index && *l == *listing_index)
                }) == Some(self.selected);
                listing_line(listing, selected)
            }
        }
    }
}

fn label(text: &str) -> Span<'static> {
    Span::styled(
        text.to_string(),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    )
}

fn field(name: &str, value: String) -> Line<'static> {
    Line::from(vec![label(&format!("{name}: ")), Span::raw(value)])
}

/// `live`/`stale`/`unknown`, recomputed against `now_ms` — never trusted
/// from the payload, since a Liveness ages the moment it is read (§4.3,
/// ADR 0007).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivenessDisplayState {
    Live,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LivenessNow {
    pub state: LivenessDisplayState,
    /// Positive while live, negative once stale; meaningless when unknown.
    pub seconds: i64,
}

fn parse_state(state: &str) -> LivenessDisplayState {
    match state {
        "live" => LivenessDisplayState::Live,
        "stale" => LivenessDisplayState::Stale,
        _ => LivenessDisplayState::Unknown,
    }
}

/// Mirrors `livenessNow` in `use-directory.ts` exactly: no `expiresAt` means
/// there is nothing to age, so the daemon's own `state` is shown as-is;
/// otherwise the countdown against `now_ms` is the only thing that decides
/// live or stale, even if the daemon's own `state` said something else a
/// second ago.
pub fn liveness_now(liveness: &LivenessView, now_ms: i64) -> LivenessNow {
    let Some(expires_at) = &liveness.expires_at else {
        return LivenessNow {
            state: parse_state(&liveness.state),
            seconds: 0,
        };
    };
    let Some(expiry_ms) = parse_iso8601_utc_ms(expires_at) else {
        return LivenessNow {
            state: parse_state(&liveness.state),
            seconds: 0,
        };
    };
    let seconds = ((expiry_ms - now_ms) as f64 / 1000.0).round() as i64;
    let state = if seconds > 0 {
        LivenessDisplayState::Live
    } else {
        LivenessDisplayState::Stale
    };
    LivenessNow { state, seconds }
}

fn liveness_badge(now: &LivenessNow) -> Span<'static> {
    match now.state {
        LivenessDisplayState::Unknown => {
            Span::styled(" no liveness ", Style::default().fg(Color::Yellow))
        }
        LivenessDisplayState::Live => Span::styled(
            format!(" live \u{b7} {} left ", format_seconds(now.seconds)),
            Style::default().fg(Color::Black).bg(Color::Green),
        ),
        LivenessDisplayState::Stale => Span::styled(
            format!(" stale \u{b7} {} ago ", format_seconds(-now.seconds)),
            Style::default().fg(Color::White).bg(Color::Red),
        ),
    }
}

/// A Hidden Provider is marked with the word itself, not only a colour —
/// spelled out because #145's acceptance criteria says so explicitly: it
/// must be distinguishable at a glance without relying on colour alone.
fn hidden_badge() -> Span<'static> {
    Span::styled(
        " HIDDEN ",
        Style::default()
            .fg(Color::Black)
            .bg(Color::Yellow)
            .add_modifier(Modifier::BOLD),
    )
}

fn provider_header_line(provider: &ProviderView, now_ms: i64) -> Line<'static> {
    let mut spans = vec![
        Span::styled(
            provider.profile.ilp_address.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::raw(format!("[{}]", provider.profile.isolation)),
        Span::raw("  "),
    ];
    if provider.profile.hidden {
        spans.push(hidden_badge());
        spans.push(Span::raw("  "));
    }
    spans.push(liveness_badge(&liveness_now(&provider.liveness, now_ms)));
    Line::from(spans)
}

fn listing_line(listing: &ListingView, selected: bool) -> Line<'static> {
    // The marker is textual on purpose, same reasoning as the hidden badge:
    // the row that is about to be chosen is legible even with no colour and
    // no reverse video at all.
    let marker = if selected { "\u{25b6} " } else { "  " };
    let style = if selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    };

    let mut text = format!(
        "{marker}{:<12} v{:<3} {:<6} {} \u{b5}USDC/{}",
        listing.name,
        listing.version,
        listing.arch,
        format_thousands(listing.price),
        format_interval(listing.lease_interval_seconds)
    );
    match listing.standby_price {
        Some(standby) => {
            text.push_str(&format!(
                "  standby {} \u{b5}USDC/{}",
                format_thousands(standby),
                format_interval(listing.lease_interval_seconds)
            ));
        }
        None => text.push_str("  no standby"),
    }
    text.push_str(&format!(
        "  {} mCPU {} MB {} GB",
        listing.resources.cpu_millicores, listing.resources.memory_mb, listing.resources.storage_gb
    ));
    if let Some(gpu) = &listing.resources.gpu {
        text.push_str(&format!("  [{gpu}]"));
    }
    if !listing.capabilities.is_empty() {
        text.push_str(&format!("  {}", listing.capabilities.join(",")));
    }
    if let Some(available) = listing.available {
        text.push_str(&format!("  {available} avail"));
    }

    Line::from(Span::styled(text, style))
}

/// What was read the last time this view fetched the directory — everything
/// `RelayLine` shows in `directory-view.tsx`, boiled down to what the draw
/// function needs.
#[derive(Debug, Clone, Default)]
pub struct RelaySummary {
    pub read_count: usize,
    /// `(url, state)` for every relay that did not answer `read`.
    pub failed: Vec<(String, String)>,
    pub listings_without_profile: i64,
    pub rejected_events: i64,
    pub read_at: String,
}

/// The whole Directory view: filters, the last read's relay summary, and a
/// [`ListingPicker`]. `Enter` on a picker row opens this view's own detail
/// overlay — a picker embedded elsewhere (#146) never sees that state.
#[derive(Default)]
pub struct DirectoryViewState {
    pub filters: DirectoryFilters,
    pub picker: ListingPicker,
    /// Every GPU model seen in the last read, for the `g` cycle — an open
    /// vocabulary (§4.4), so this is read off the wire, never hard-coded
    /// (mirrors `gpuModels` in `directory-view.tsx`).
    pub gpu_models: Vec<String>,
    pub relay_summary: Option<RelaySummary>,
    pub unconfigured_reason: Option<String>,
    pub detail_open: bool,
}

impl DirectoryViewState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The active filter count, for the "N filtered" badge — mirrors
    /// `Object.keys(filters).length` in `directory-filters.tsx` exactly,
    /// one count per FIELD set, not per capability.
    pub fn active_filter_count(&self) -> usize {
        [
            self.filters.isolation.is_some(),
            self.filters.arch.is_some(),
            self.filters.gpu.is_some(),
            !self.filters.capabilities.is_empty(),
            self.filters.hidden.is_some(),
        ]
        .into_iter()
        .filter(|set| *set)
        .count()
    }

    /// Applies a fresh `GET /api/directory` answer: replaces the picker's
    /// Providers, the relay summary and the GPU model list together, so
    /// nothing on screen mixes one read with another's.
    pub fn apply(&mut self, directory: Directory) {
        match directory {
            Directory::Ok {
                relays,
                providers,
                listings_without_profile,
                rejected_events,
                read_at,
                ..
            } => {
                let mut gpu_models: Vec<String> = providers
                    .iter()
                    .flat_map(|provider| provider.listings.iter())
                    .filter_map(|listing| listing.resources.gpu.clone())
                    .collect();
                gpu_models.sort();
                gpu_models.dedup();

                self.relay_summary = Some(RelaySummary {
                    read_count: relays.read.len(),
                    failed: relays
                        .read
                        .iter()
                        .filter(|outcome| outcome.state != "read")
                        .map(|outcome| (outcome.url.clone(), outcome.state.clone()))
                        .collect(),
                    listings_without_profile,
                    rejected_events,
                    read_at,
                });
                self.unconfigured_reason = None;
                self.gpu_models = gpu_models;
                self.picker.set_providers(providers);
            }
            Directory::Unconfigured { reason } => {
                self.unconfigured_reason = Some(reason);
                self.relay_summary = None;
                self.gpu_models = Vec::new();
                self.picker.set_providers(Vec::new());
            }
        }
        self.detail_open = false;
    }
}

fn cycle_option(options: &[&str], current: &Option<String>) -> Option<String> {
    let index = current
        .as_deref()
        .and_then(|value| options.iter().position(|option| *option == value));
    let next = match index {
        Some(i) => i + 1,
        None => 0,
    };
    options.get(next).map(|s| s.to_string())
}

fn cycle_gpu(options: &[String], current: &Option<String>) -> Option<String> {
    // "any" (has a GPU, unspecified model) always leads, then every concrete
    // model this read actually saw — mirrors the `gpus` list built in
    // `directory-filters.tsx`.
    let mut all: Vec<&str> = vec![ANY_GPU];
    all.extend(options.iter().map(|s| s.as_str()));
    let index = current
        .as_deref()
        .and_then(|value| all.iter().position(|option| *option == value));
    let next = match index {
        Some(i) => i + 1,
        None => 0,
    };
    all.get(next).map(|s| s.to_string())
}

fn cycle_hidden(current: Option<bool>) -> Option<bool> {
    match current {
        None => Some(false),
        Some(false) => Some(true),
        Some(true) => None,
    }
}

fn toggle_capability(capabilities: &mut Vec<String>, name: &str) {
    match capabilities.iter().position(|held| held == name) {
        Some(position) => {
            capabilities.remove(position);
        }
        None => capabilities.push(name.to_string()),
    }
}

/// The one place a keypress becomes a decision for the whole Directory view.
/// Filter and refresh keys are handled here; everything else (`j`/`k`,
/// `Enter`) falls through to the picker.
pub fn handle_key(state: &mut DirectoryViewState, key: KeyEvent) -> DirectoryCommand {
    if state.detail_open {
        // Mirrors `app::handle_key`'s help overlay: while the detail popup
        // covers the screen, only the keys that close it do anything.
        match key.code {
            KeyCode::Enter | KeyCode::Esc | KeyCode::Char('q') => state.detail_open = false,
            _ => {}
        }
        return DirectoryCommand::None;
    }

    match key.code {
        KeyCode::Char('i') => {
            state.filters.isolation = cycle_option(ISOLATIONS, &state.filters.isolation);
            DirectoryCommand::Refresh
        }
        KeyCode::Char('a') => {
            state.filters.arch = cycle_option(ARCHITECTURES, &state.filters.arch);
            DirectoryCommand::Refresh
        }
        KeyCode::Char('g') => {
            state.filters.gpu = cycle_gpu(&state.gpu_models, &state.filters.gpu);
            DirectoryCommand::Refresh
        }
        KeyCode::Char('d') => {
            toggle_capability(&mut state.filters.capabilities, CAPABILITIES[0]);
            DirectoryCommand::Refresh
        }
        KeyCode::Char('n') => {
            toggle_capability(&mut state.filters.capabilities, CAPABILITIES[1]);
            DirectoryCommand::Refresh
        }
        KeyCode::Char('H') => {
            state.filters.hidden = cycle_hidden(state.filters.hidden);
            DirectoryCommand::Refresh
        }
        KeyCode::Char('x') => {
            if state.active_filter_count() == 0 {
                DirectoryCommand::None
            } else {
                state.filters = DirectoryFilters::default();
                DirectoryCommand::Refresh
            }
        }
        KeyCode::Char('r') | KeyCode::Char('R') => DirectoryCommand::Refresh,
        _ => {
            if state.picker.handle_key(key) == PickerEvent::Chosen {
                state.detail_open = true;
            }
            DirectoryCommand::None
        }
    }
}

fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The filters, as the daemon's query string spells them — the Rust side of
/// `directoryQuery` in `packages/ui/src/lib/daemon.ts`, byte for byte the
/// same parameter names and order.
pub fn directory_query(filters: &DirectoryFilters) -> String {
    let mut parts = Vec::new();
    if let Some(value) = &filters.isolation {
        parts.push(format!("isolation={}", url_encode(value)));
    }
    if let Some(value) = &filters.arch {
        parts.push(format!("arch={}", url_encode(value)));
    }
    if let Some(value) = &filters.gpu {
        parts.push(format!("gpu={}", url_encode(value)));
    }
    for capability in &filters.capabilities {
        parts.push(format!("capability={}", url_encode(capability)));
    }
    if let Some(hidden) = filters.hidden {
        parts.push(format!("hidden={hidden}"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

fn filter_bar_lines(state: &DirectoryViewState) -> Vec<Line<'static>> {
    let value_or =
        |value: &Option<String>, none: &str| value.clone().unwrap_or_else(|| none.to_string());
    let hidden_text = match state.filters.hidden {
        None => "both".to_string(),
        Some(true) => "hidden only".to_string(),
        Some(false) => "public only".to_string(),
    };
    let grants = if state.filters.capabilities.is_empty() {
        "none".to_string()
    } else {
        state.filters.capabilities.join(",")
    };
    let mut first = vec![
        label("Isolation "),
        Span::raw(value_or(&state.filters.isolation, "any")),
        Span::raw("  "),
        label("Arch "),
        Span::raw(value_or(&state.filters.arch, "any")),
        Span::raw("  "),
        label("GPU "),
        Span::raw(value_or(&state.filters.gpu, "any")),
        Span::raw("  "),
        label("Hidden "),
        Span::raw(hidden_text),
        Span::raw("  "),
        label("Grants "),
        Span::raw(grants),
    ];
    let count = state.active_filter_count();
    if count > 0 {
        first.push(Span::raw("  "));
        first.push(Span::styled(
            format!("{count} filtered"),
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));
    }
    let second = Line::from(Span::styled(
        "i isolation  a arch  g gpu  d/n capability  H hidden  x clear  r refresh  Enter detail",
        Style::default().fg(Color::DarkGray),
    ));
    vec![Line::from(first), second]
}

fn relay_line(summary: &RelaySummary) -> Line<'static> {
    let mut spans = vec![Span::styled(
        format!(
            "Read free over NIP-01 from {} relay{} at {}",
            summary.read_count,
            if summary.read_count == 1 { "" } else { "s" },
            summary.read_at
        ),
        Style::default().fg(Color::DarkGray),
    )];
    if !summary.failed.is_empty() {
        let text = summary
            .failed
            .iter()
            .map(|(url, state)| format!("{url} ({state})"))
            .collect::<Vec<_>>()
            .join(", ");
        spans.push(Span::styled(
            format!(" \u{2014} {text}"),
            Style::default().fg(Color::Yellow),
        ));
    }
    if summary.listings_without_profile > 0 {
        spans.push(Span::styled(
            format!(
                " \u{2014} {} Listing(s) hidden: no Provider Profile found",
                summary.listings_without_profile
            ),
            Style::default().fg(Color::DarkGray),
        ));
    }
    if summary.rejected_events > 0 {
        spans.push(Span::styled(
            format!(
                " \u{2014} {} event(s) dropped: bad signature",
                summary.rejected_events
            ),
            Style::default().fg(Color::DarkGray),
        ));
    }
    Line::from(spans)
}

fn message_paragraph(text: &str) -> Paragraph<'static> {
    Paragraph::new(Line::from(Span::styled(
        text.to_string(),
        Style::default().fg(Color::DarkGray),
    )))
    .wrap(Wrap { trim: false })
}

/// Draws the whole Directory view: filter bar, relay line, the Provider/
/// Listing list (or a message when there is nothing to show), and the
/// detail overlay when one is open.
pub fn draw(frame: &mut Frame, area: Rect, state: &DirectoryViewState, now_ms: i64, loading: bool) {
    let block = Block::default().title(" Directory ").borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Length(1),
            Constraint::Min(1),
        ])
        .split(inner);

    frame.render_widget(Paragraph::new(filter_bar_lines(state)), rows[0]);

    match &state.relay_summary {
        Some(summary) => frame.render_widget(relay_line(summary), rows[1]),
        None => frame.render_widget(Paragraph::new(Line::raw("")), rows[1]),
    }

    if let Some(reason) = &state.unconfigured_reason {
        frame.render_widget(message_paragraph(reason), rows[2]);
    } else if state.picker.is_empty() {
        let message = if loading {
            "Reading relays\u{2026}"
        } else if state.relay_summary.is_some() {
            "No provider on this network publishes a Listing that matches. Reading the directory is free, so widening a filter costs nothing."
        } else {
            "Nothing read yet."
        };
        frame.render_widget(message_paragraph(message), rows[2]);
    } else {
        state.picker.draw(frame, rows[2], now_ms);
    }

    if state.detail_open {
        if let Some((provider, listing)) = state.picker.selected_listing() {
            draw_detail(frame, area, provider, listing, now_ms);
        }
    }
}

fn draw_detail(
    frame: &mut Frame,
    area: Rect,
    provider: &ProviderView,
    listing: &ListingView,
    now_ms: i64,
) {
    let width = 76u16.min(area.width.saturating_sub(4)).max(20);
    let height = 20u16.min(area.height.saturating_sub(2)).max(8);
    let popup = centered(area, width, height);
    frame.render_widget(Clear, popup);

    let title = format!(
        " {} \u{2014} {} ",
        listing.name, provider.profile.ilp_address
    );
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let resources = &listing.resources;
    let mut lines = vec![
        field(
            "Price",
            format!(
                "{} \u{b5}USDC / {}",
                format_thousands(listing.price),
                format_interval(listing.lease_interval_seconds)
            ),
        ),
        field(
            "Standby",
            match listing.standby_price {
                Some(price) => format!(
                    "{} \u{b5}USDC / {}",
                    format_thousands(price),
                    format_interval(listing.lease_interval_seconds)
                ),
                None => "no warm standby".to_string(),
            },
        ),
        field(
            "Resources",
            format!(
                "{} mCPU \u{b7} {} MB \u{b7} {} GB{}",
                resources.cpu_millicores,
                resources.memory_mb,
                resources.storage_gb,
                resources
                    .gpu
                    .as_ref()
                    .map(|gpu| format!(" \u{b7} {gpu}"))
                    .unwrap_or_default()
            ),
        ),
        field(
            "Arch / Isolation",
            format!("{} / {}", listing.arch, listing.isolation),
        ),
        field(
            "Capabilities",
            if listing.capabilities.is_empty() {
                "none".to_string()
            } else {
                listing.capabilities.join(", ")
            },
        ),
        field(
            "Available now",
            listing
                .available
                .map(|available| available.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
        ),
        Line::raw(""),
        Line::from(Span::styled(
            "Provider Profile",
            Style::default().add_modifier(Modifier::BOLD),
        )),
        field("Pubkey", provider.pubkey.clone()),
        field("Connector", provider.profile.connector_url.clone()),
        field(
            "Host",
            provider.profile.host.clone().unwrap_or_else(|| {
                if provider.profile.hidden {
                    "hidden \u{2014} no host published".to_string()
                } else {
                    "none published".to_string()
                }
            }),
        ),
        field(
            "Relay Set",
            if provider.profile.relays.is_empty() {
                "none published".to_string()
            } else {
                provider.profile.relays.join(", ")
            },
        ),
        field(
            "Settles",
            if provider.profile.settlement.is_empty() {
                "nothing published".to_string()
            } else {
                provider
                    .profile
                    .settlement
                    .iter()
                    .map(|term| term.chain.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            },
        ),
    ];

    let liveness = liveness_now(&provider.liveness, now_ms);
    let liveness_text = match liveness.state {
        LivenessDisplayState::Unknown => "no liveness".to_string(),
        LivenessDisplayState::Live => {
            format!("live \u{b7} {} left", format_seconds(liveness.seconds))
        }
        LivenessDisplayState::Stale => {
            format!("stale \u{b7} {} ago", format_seconds(-liveness.seconds))
        }
    };
    lines.push(field("Liveness", liveness_text));

    if provider.profile.hidden {
        lines.push(Line::from(Span::styled(
            "HIDDEN PROVIDER \u{2014} location not published",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "Enter / Esc / q closes",
        Style::default().fg(Color::DarkGray),
    )));

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    Rect {
        x,
        y,
        width: width.min(area.width),
        height: height.min(area.height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ListingResources, ProviderProfileView, SettlementTerm};
    use crossterm::event::KeyModifiers;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::fs;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn key_char(c: char) -> KeyEvent {
        key(KeyCode::Char(c))
    }

    fn provider(pubkey: &str, hidden: bool, listings: Vec<ListingView>) -> ProviderView {
        ProviderView {
            pubkey: pubkey.to_string(),
            profile: ProviderProfileView {
                ilp_address: format!("g.{pubkey}"),
                connector_url: "https://connector.test/ilp".to_string(),
                connector_seal_key: "0x04".to_string(),
                relays: vec!["wss://seed.test".to_string()],
                settlement: vec![SettlementTerm {
                    chain: "evm:84532".to_string(),
                    token: "0xtoken".to_string(),
                    decimals: 6,
                }],
                isolation: "shared-kernel".to_string(),
                hidden,
                host: if hidden {
                    None
                } else {
                    Some("203.0.113.7".to_string())
                },
                liveness_cadence_seconds: Some(60),
                published_at: "2026-09-21T14:13:20.000Z".to_string(),
                event_id: "e-profile".to_string(),
            },
            liveness: LivenessView {
                state: "live".to_string(),
                published_at: Some("2026-09-22T11:57:00.000Z".to_string()),
                expires_at: Some("2026-09-22T12:02:00.000Z".to_string()),
                seconds_until_expiry: Some(120),
                cadence_seconds: Some(60),
            },
            listings,
            relays_read: vec!["wss://seed.test".to_string()],
            superseded_listings: 0,
            rejected_listings: vec![],
        }
    }

    fn listing(name: &str, price: i64, gpu: Option<&str>, capabilities: &[&str]) -> ListingView {
        ListingView {
            name: name.to_string(),
            address: format!("30432:pk:{name}"),
            version: 1,
            resources: ListingResources {
                cpu_millicores: 1000,
                memory_mb: 1024,
                storage_gb: 10,
                gpu: gpu.map(str::to_string),
            },
            arch: "amd64".to_string(),
            isolation: "shared-kernel".to_string(),
            hidden: false,
            lease_interval_seconds: 3600,
            price,
            standby_price: None,
            capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
            unspecified_capabilities: vec![],
            geohash: None,
            published_at: "2026-09-21T14:13:20.000Z".to_string(),
            event_id: format!("e-{name}"),
            available: Some(3),
        }
    }

    const NOW_MS: i64 = 1_790_078_400_000; // 2026-09-22T12:00:00.000Z

    // ---- liveness_now ----

    #[test]
    fn liveness_now_is_live_before_expiry_and_stale_after() {
        let live = LivenessView {
            state: "live".to_string(),
            published_at: None,
            expires_at: Some("2026-09-22T12:02:00.000Z".to_string()),
            seconds_until_expiry: None,
            cadence_seconds: None,
        };
        let before = liveness_now(&live, NOW_MS);
        assert_eq!(before.state, LivenessDisplayState::Live);
        assert_eq!(before.seconds, 120);

        let after = liveness_now(&live, NOW_MS + 121_000);
        assert_eq!(after.state, LivenessDisplayState::Stale);
        assert_eq!(after.seconds, -1);
    }

    #[test]
    fn liveness_now_is_unknown_with_no_expiry() {
        let unknown = LivenessView {
            state: "unknown".to_string(),
            published_at: None,
            expires_at: None,
            seconds_until_expiry: None,
            cadence_seconds: None,
        };
        assert_eq!(
            liveness_now(&unknown, NOW_MS).state,
            LivenessDisplayState::Unknown
        );
    }

    // ---- directory_query ----

    #[test]
    fn directory_query_is_empty_for_no_filters() {
        assert_eq!(directory_query(&DirectoryFilters::default()), "");
    }

    #[test]
    fn directory_query_carries_every_filter_in_the_daemons_order() {
        let filters = DirectoryFilters {
            isolation: Some("dedicated-host".to_string()),
            arch: Some("arm64".to_string()),
            gpu: Some("nvidia-rtx-4090".to_string()),
            capabilities: vec!["docker".to_string(), "nesting".to_string()],
            hidden: Some(true),
        };
        assert_eq!(
            directory_query(&filters),
            "?isolation=dedicated-host&arch=arm64&gpu=nvidia-rtx-4090&capability=docker&capability=nesting&hidden=true"
        );
    }

    // ---- ListingPicker ----

    #[test]
    fn picker_lands_selection_on_the_first_listing() {
        let mut picker = ListingPicker::new();
        assert!(picker.is_empty());
        picker.set_providers(vec![provider(
            "acme",
            false,
            vec![listing("basic", 1000, None, &[])],
        )]);
        assert!(!picker.is_empty());
        let (provider, listing) = picker.selected_listing().expect("a listing is selected");
        assert_eq!(provider.pubkey, "acme");
        assert_eq!(listing.name, "basic");
    }

    #[test]
    fn picker_movement_skips_headers_and_clamps_at_both_ends() {
        let mut picker = ListingPicker::new();
        picker.set_providers(vec![
            provider("acme", false, vec![listing("basic", 1000, None, &[])]),
            provider("shady", true, vec![listing("quiet", 9000, None, &[])]),
        ]);
        assert_eq!(picker.selected_listing().unwrap().1.name, "basic");

        picker.move_selection(-1);
        assert_eq!(
            picker.selected_listing().unwrap().1.name,
            "basic",
            "clamped at the top"
        );

        picker.move_selection(1);
        assert_eq!(picker.selected_listing().unwrap().1.name, "quiet");

        picker.move_selection(1);
        assert_eq!(
            picker.selected_listing().unwrap().1.name,
            "quiet",
            "clamped at the bottom"
        );
    }

    #[test]
    fn picker_handle_key_enter_chooses_only_when_something_is_selected() {
        let mut picker = ListingPicker::new();
        assert_eq!(picker.handle_key(key(KeyCode::Enter)), PickerEvent::None);

        picker.set_providers(vec![provider(
            "acme",
            false,
            vec![listing("basic", 1000, None, &[])],
        )]);
        assert_eq!(picker.handle_key(key(KeyCode::Enter)), PickerEvent::Chosen);
        assert_eq!(picker.handle_key(key_char('j')), PickerEvent::Moved);
    }

    // ---- DirectoryViewState / handle_key ----

    fn ok_directory() -> Directory {
        Directory::Ok {
            relays: crate::types::DirectoryRelays {
                seed: vec!["wss://seed.test".to_string()],
                read: vec![
                    crate::types::DirectoryRelayOutcome {
                        url: "wss://seed.test".to_string(),
                        state: "read".to_string(),
                        events: 9,
                        reason: None,
                    },
                    crate::types::DirectoryRelayOutcome {
                        url: "wss://acme.relay.test".to_string(),
                        state: "failed".to_string(),
                        events: 0,
                        reason: Some("no relay at wss://acme.relay.test".to_string()),
                    },
                ],
            },
            filters: DirectoryFilters::default(),
            providers: vec![
                provider(
                    "acme",
                    false,
                    vec![
                        listing("basic", 1000, None, &[]),
                        listing("ci", 5000, None, &["docker"]),
                        listing("gpu", 20000, Some("nvidia-a100-80gb"), &[]),
                    ],
                ),
                provider("shady", true, vec![listing("quiet", 9000, None, &[])]),
            ],
            listings_without_profile: 0,
            rejected_events: 0,
            read_at: "2026-09-22T12:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn apply_feeds_the_picker_and_the_gpu_model_list() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        assert!(!state.picker.is_empty());
        assert_eq!(state.gpu_models, vec!["nvidia-a100-80gb".to_string()]);
        assert_eq!(state.relay_summary.as_ref().unwrap().read_count, 2);
        assert_eq!(state.relay_summary.as_ref().unwrap().failed.len(), 1);
    }

    #[test]
    fn apply_unconfigured_clears_the_picker_and_sets_the_reason() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        state.apply(Directory::Unconfigured {
            reason: "Devnet names no relay yet.".to_string(),
        });
        assert!(state.picker.is_empty());
        assert_eq!(
            state.unconfigured_reason.as_deref(),
            Some("Devnet names no relay yet.")
        );
        assert!(state.relay_summary.is_none());
    }

    #[test]
    fn isolation_and_arch_and_hidden_cycle_through_any_and_back() {
        let mut state = DirectoryViewState::new();
        assert_eq!(
            handle_key(&mut state, key_char('i')),
            DirectoryCommand::Refresh
        );
        assert_eq!(state.filters.isolation.as_deref(), Some("shared-kernel"));
        handle_key(&mut state, key_char('i'));
        assert_eq!(state.filters.isolation.as_deref(), Some("dedicated-host"));
        handle_key(&mut state, key_char('i'));
        assert_eq!(state.filters.isolation, None, "cycles back to Any");

        handle_key(&mut state, key_char('a'));
        assert_eq!(state.filters.arch.as_deref(), Some("amd64"));
        handle_key(&mut state, key_char('a'));
        assert_eq!(state.filters.arch.as_deref(), Some("arm64"));
        handle_key(&mut state, key_char('a'));
        assert_eq!(state.filters.arch, None);

        handle_key(&mut state, key_char('H'));
        assert_eq!(state.filters.hidden, Some(false));
        handle_key(&mut state, key_char('H'));
        assert_eq!(state.filters.hidden, Some(true));
        handle_key(&mut state, key_char('H'));
        assert_eq!(state.filters.hidden, None);
    }

    #[test]
    fn gpu_cycles_any_then_every_model_this_read_saw() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        handle_key(&mut state, key_char('g'));
        assert_eq!(state.filters.gpu.as_deref(), Some("any"));
        handle_key(&mut state, key_char('g'));
        assert_eq!(state.filters.gpu.as_deref(), Some("nvidia-a100-80gb"));
        handle_key(&mut state, key_char('g'));
        assert_eq!(state.filters.gpu, None);
    }

    #[test]
    fn d_and_n_toggle_the_two_specified_capabilities_independently() {
        let mut state = DirectoryViewState::new();
        handle_key(&mut state, key_char('d'));
        assert_eq!(state.filters.capabilities, vec!["docker".to_string()]);
        handle_key(&mut state, key_char('n'));
        assert_eq!(
            state.filters.capabilities,
            vec!["docker".to_string(), "nesting".to_string()]
        );
        handle_key(&mut state, key_char('d'));
        assert_eq!(state.filters.capabilities, vec!["nesting".to_string()]);
    }

    #[test]
    fn x_clears_every_filter_at_once_and_does_nothing_when_none_are_set() {
        let mut state = DirectoryViewState::new();
        assert_eq!(
            handle_key(&mut state, key_char('x')),
            DirectoryCommand::None
        );

        handle_key(&mut state, key_char('i'));
        handle_key(&mut state, key_char('d'));
        assert_eq!(state.active_filter_count(), 2);
        assert_eq!(
            handle_key(&mut state, key_char('x')),
            DirectoryCommand::Refresh
        );
        assert_eq!(state.active_filter_count(), 0);
    }

    #[test]
    fn r_always_asks_for_a_refresh() {
        let mut state = DirectoryViewState::new();
        assert_eq!(
            handle_key(&mut state, key_char('r')),
            DirectoryCommand::Refresh
        );
    }

    #[test]
    fn j_and_k_move_the_picker_without_asking_for_a_refresh() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        assert_eq!(
            handle_key(&mut state, key_char('j')),
            DirectoryCommand::None
        );
        assert_eq!(
            state.picker.selected_listing().unwrap().1.name,
            "ci",
            "moved down from `basic`"
        );
    }

    #[test]
    fn enter_opens_detail_and_only_close_keys_close_it() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        handle_key(&mut state, key(KeyCode::Enter));
        assert!(state.detail_open);

        // Swallowed: a filter key must not change filters while detail is open.
        handle_key(&mut state, key_char('i'));
        assert_eq!(state.filters.isolation, None);
        assert!(state.detail_open);

        handle_key(&mut state, key(KeyCode::Esc));
        assert!(!state.detail_open);
    }

    #[test]
    fn applying_a_fresh_read_closes_any_open_detail() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        handle_key(&mut state, key(KeyCode::Enter));
        assert!(state.detail_open);
        state.apply(ok_directory());
        assert!(!state.detail_open);
    }

    // ---- rendering ----

    fn render(state: &DirectoryViewState, now_ms: i64, loading: bool) -> String {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), state, now_ms, loading))
            .unwrap();
        buffer_to_string(terminal.backend().buffer())
    }

    fn buffer_to_string(buffer: &ratatui::buffer::Buffer) -> String {
        let area = buffer.area;
        let mut out = String::new();
        for y in area.top()..area.bottom() {
            for x in area.left()..area.right() {
                out.push_str(buffer[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn renders_nothing_read_yet_before_any_fetch() {
        let state = DirectoryViewState::new();
        insta::assert_snapshot!(render(&state, NOW_MS, false));
    }

    #[test]
    fn renders_unfiltered_with_a_hidden_provider_and_a_gpu_tier() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        insta::assert_snapshot!(render(&state, NOW_MS, false));
    }

    #[test]
    fn renders_with_active_filters_shown_in_the_bar() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        handle_key(&mut state, key_char('i'));
        handle_key(&mut state, key_char('H'));
        insta::assert_snapshot!(render(&state, NOW_MS, false));
    }

    #[test]
    fn renders_the_detail_overlay() {
        let mut state = DirectoryViewState::new();
        state.apply(ok_directory());
        handle_key(&mut state, key(KeyCode::Enter));
        insta::assert_snapshot!(render(&state, NOW_MS, false));
    }

    #[test]
    fn renders_without_panicking_while_loading_and_when_unconfigured() {
        let mut state = DirectoryViewState::new();
        render(&state, NOW_MS, true);
        state.apply(Directory::Unconfigured {
            reason: "Devnet names no relay yet.".to_string(),
        });
        render(&state, NOW_MS, false);
    }

    /// The daemon's own real, unfiltered fixture must still render without
    /// panicking — proof against the real shape `packages/daemon` produces
    /// today, not only the hand-built one above (same reasoning as
    /// `views::health`'s equivalent test).
    #[test]
    fn renders_the_real_daemon_fixture_without_panicking() {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/directory.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read fixture {path}: {err}"));
        let directory: Directory = serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture {path} did not deserialize as Directory: {err}"));
        let mut state = DirectoryViewState::new();
        state.apply(directory);
        render(&state, NOW_MS, false);
    }
}
