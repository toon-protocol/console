//! The Account view (TOON_Network#141).
//!
//! A terminal mirror of `packages/ui/src/app/account-view.tsx`,
//! `sign-in-view.tsx` and `profile-switcher.tsx`, and of the two hooks behind
//! them, `use-account.ts` and `use-console.ts`: sign in with a NIP-46 bunker
//! URI or the local keystore (generate, import an nsec, import a NIP-06
//! mnemonic), see who is signed in and their relays, sign out, sign back in
//! with a signer already on this machine, forget one, and switch the network
//! profile. Signed in, it also draws the Chain Seed section (TOON_Network#142,
//! see `views::chain_seed`) below the account's own details — the same
//! stacking `console-app.tsx` uses for `AccountCard` and `ChainSeedCard`.
//!
//! **How the keymap works here, since this is the first view with forms:**
//! this view keeps one flat, ordered list of [`Target`]s — every field and
//! button currently on screen, built fresh from `SessionStatus`,
//! `Profiles` and (signed in) `ChainSeedStatus` by [`targets`] — and a
//! `cursor` index into it. `j`/`k` (or the arrow keys) move the cursor when
//! nothing is being typed into; `Enter` on a field starts typing into it
//! (`editing = true`) and `Enter` on a button fires its
//! [`crate::app::Command`] straight away. While `editing` is true, every key
//! goes to the focused [`crate::widgets::input::TextField`] instead —
//! including digits, `q` and `Tab`, which on every other view are global
//! shortcuts. That is the one rule #146 needs to keep in mind reusing this
//! pattern: a key a form is allowed to type must not also be a global
//! binding while that form has focus.
//!
//! [`targets`] is used by both [`handle_key`] (to know what the cursor is on)
//! and [`draw`] (to know what to highlight) — one list, so the two can never
//! disagree about what is focused. The Chain Seed section's own targets are
//! `views::chain_seed::Target`, wrapped in `Target::ChainSeed` so they share
//! this one cursor and this one `editing` flag rather than keeping a second,
//! independent focus of their own — the mnemonic field it can put into
//! `editing` is a [`TextField`] like any of this view's, just held in
//! [`crate::views::chain_seed::ChainSeedViewState`] instead of here.
//! Before every other key, this view also checks whether the Chain Seed
//! section's confirm modal is open (a publish is a paid relay write) and,
//! if so, hands the key to it and nothing else — see the top of
//! [`handle_key`].

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::format::account_display_name;
use crate::types::{
    ChainSeedStatus, LocalSignerMode, LocalSignerRequest, Profiles, SessionStatus, SignerKind,
};
use crate::views::chain_seed::{self, ChainSeedViewState};
use crate::widgets::confirm::ConfirmOutcome;
use crate::widgets::input::TextField;

/// One focusable thing on screen, in the order `j`/`k` walk them and `draw`
/// lays them out. Built fresh from the current `SessionStatus`/`Profiles` by
/// [`targets`] rather than stored, so it can never drift from what is
/// actually on screen this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    BunkerUri,
    BunkerPassphrase,
    ConnectBunker,
    ModeGenerate,
    ModeNsec,
    ModeNip06,
    Nsec,
    Mnemonic,
    LocalPassphrase,
    SubmitLocal,
    SavedPassphrase(usize),
    SavedSignIn(usize),
    SavedForget(usize),
    SignOut,
    /// TOON_Network#142's own targets, wrapped rather than duplicated here —
    /// see the module doc comment.
    ChainSeed(chain_seed::Target),
    SwitchProfile(usize),
}

fn targets(
    status: Option<&SessionStatus>,
    profiles: Option<&Profiles>,
    chain_seed_status: Option<&ChainSeedStatus>,
    local_mode: LocalSignerMode,
    show_import: bool,
) -> Vec<Target> {
    let mut out = Vec::new();

    if let Some(status) = status {
        if status.signed_in {
            out.push(Target::SignOut);
            for sub in chain_seed::targets(chain_seed_status, show_import) {
                out.push(Target::ChainSeed(sub));
            }
        } else {
            let needs_passphrase = status.keystore.needs_passphrase;

            out.push(Target::BunkerUri);
            if needs_passphrase {
                out.push(Target::BunkerPassphrase);
            }
            out.push(Target::ConnectBunker);

            out.push(Target::ModeGenerate);
            out.push(Target::ModeNsec);
            out.push(Target::ModeNip06);
            match local_mode {
                LocalSignerMode::Generate => {}
                LocalSignerMode::Nsec => out.push(Target::Nsec),
                LocalSignerMode::Nip06 => out.push(Target::Mnemonic),
            }
            if needs_passphrase {
                out.push(Target::LocalPassphrase);
            }
            out.push(Target::SubmitLocal);

            for index in 0..status.signers.len() {
                if needs_passphrase {
                    out.push(Target::SavedPassphrase(index));
                }
                out.push(Target::SavedSignIn(index));
                out.push(Target::SavedForget(index));
            }
        }
    }

    if let Some(profiles) = profiles {
        for index in 0..profiles.profiles.len() {
            out.push(Target::SwitchProfile(index));
        }
    }

    out
}

/// The Account view's own state: the cursor into [`targets`], whether the
/// focused field is currently capturing keystrokes, which local-keystore mode
/// is selected, and one [`TextField`] per secret or value a form here can
/// collect. `App` owns one of these for the life of the process — signing in
/// does not reset it, so a half-typed field in one card is not lost by
/// activity in another.
pub struct AccountViewState {
    cursor: usize,
    editing: bool,
    local_mode: LocalSignerMode,
    bunker_uri: TextField,
    bunker_passphrase: TextField,
    nsec: TextField,
    mnemonic: TextField,
    local_passphrase: TextField,
    /// Shared by every saved signer's sign-in row. The web UI keeps one
    /// passphrase per row (`Record<string, string>`); this view keeps one
    /// field and lets the cursor say which row it is for — a saved signer is
    /// nearly always signed back into one at a time, and this is the
    /// simplification that keeps `Target` (and this struct) from growing a
    /// vector of fields sized to a list.
    saved_passphrase: TextField,
    /// TOON_Network#142's own state (the import-mnemonic field, whether its
    /// form is open, and its publish confirm modal) — kept in its own type
    /// rather than flattened here, so `views::chain_seed` stays the one
    /// place that state is read or written.
    pub chain_seed: ChainSeedViewState,
}

impl AccountViewState {
    pub fn new() -> Self {
        Self {
            cursor: 0,
            editing: false,
            local_mode: LocalSignerMode::Generate,
            bunker_uri: TextField::new("Bunker URI", false),
            bunker_passphrase: TextField::new("Keystore passphrase", true),
            nsec: TextField::new("Secret key (nsec)", true),
            mnemonic: TextField::new("NIP-06 words", true),
            local_passphrase: TextField::new("Keystore passphrase", true),
            saved_passphrase: TextField::new("Passphrase", true),
            chain_seed: ChainSeedViewState::new(),
        }
    }
}

impl Default for AccountViewState {
    fn default() -> Self {
        Self::new()
    }
}

fn field_mut(state: &mut AccountViewState, target: Target) -> Option<&mut TextField> {
    match target {
        Target::BunkerUri => Some(&mut state.bunker_uri),
        Target::BunkerPassphrase => Some(&mut state.bunker_passphrase),
        Target::Nsec => Some(&mut state.nsec),
        Target::Mnemonic => Some(&mut state.mnemonic),
        Target::LocalPassphrase => Some(&mut state.local_passphrase),
        Target::SavedPassphrase(_) => Some(&mut state.saved_passphrase),
        Target::ChainSeed(chain_seed::Target::Mnemonic) => Some(&mut state.chain_seed.mnemonic),
        _ => None,
    }
}

/// The Account view's half of [`crate::app::handle_key`]'s delegation.
/// Returns `None` for a key this view has no use for right now (so the
/// global keymap handles it, e.g. `1`-`7`, `Tab`, `q` while nothing is being
/// typed into), and `Some(command)` — often `Some(Command::None)`, to swallow
/// the key without asking the runtime to do anything — for one it acted on.
pub fn handle_key(
    state: &mut AccountViewState,
    status: Option<&SessionStatus>,
    profiles: Option<&Profiles>,
    chain_seed_status: Option<&ChainSeedStatus>,
    key: KeyEvent,
) -> Option<Command> {
    // Publishing a Chain Seed is a paid relay write (#120): while its
    // confirm modal is open, every key goes to it and nothing else —
    // including `q` and the digits that would otherwise switch views — so
    // typing `yes` then `Enter` to confirm is never mixed up with this
    // view's own cursor movement.
    if let Some(confirm) = &mut state.chain_seed.confirm {
        return Some(match confirm.handle_key(key) {
            ConfirmOutcome::Confirmed(()) => {
                state.chain_seed.confirm = None;
                Command::PublishChainSeed
            }
            ConfirmOutcome::Cancelled => {
                state.chain_seed.confirm = None;
                Command::None
            }
            ConfirmOutcome::Pending => Command::None,
        });
    }

    let list = targets(
        status,
        profiles,
        chain_seed_status,
        state.local_mode,
        state.chain_seed.show_import,
    );
    if list.is_empty() {
        return None;
    }
    if state.cursor >= list.len() {
        state.cursor = list.len() - 1;
    }

    if state.editing {
        match key.code {
            KeyCode::Enter | KeyCode::Esc => state.editing = false,
            _ => {
                let target = list[state.cursor];
                if let Some(field) = field_mut(state, target) {
                    field.handle_key(key);
                }
            }
        }
        return Some(Command::None);
    }

    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            state.cursor = state.cursor.saturating_sub(1);
            Some(Command::None)
        }
        KeyCode::Down | KeyCode::Char('j') => {
            state.cursor = (state.cursor + 1).min(list.len() - 1);
            Some(Command::None)
        }
        KeyCode::Enter => {
            let target = list[state.cursor];
            Some(activate(state, status, profiles, chain_seed_status, target))
        }
        _ => None,
    }
}

/// Turns an `Enter` on `target` into either a state change (entering edit
/// mode, picking a local-keystore mode — `Command::None`, nothing to send)
/// or a [`Command`] carrying a request body, built from whatever the
/// relevant [`TextField`]s hold. Every field a command reads is `.take()`n
/// here, in the same branch that builds the command — so a secret is in this
/// view's own memory for exactly as long as it takes to move it into the
/// request about to be sent, and not one keypress longer.
fn activate(
    state: &mut AccountViewState,
    status: Option<&SessionStatus>,
    profiles: Option<&Profiles>,
    chain_seed_status: Option<&ChainSeedStatus>,
    target: Target,
) -> Command {
    let needs_passphrase = status
        .map(|status| status.keystore.needs_passphrase)
        .unwrap_or(false);

    match target {
        Target::BunkerUri
        | Target::BunkerPassphrase
        | Target::Nsec
        | Target::Mnemonic
        | Target::LocalPassphrase
        | Target::SavedPassphrase(_) => {
            state.editing = true;
            Command::None
        }
        Target::ModeGenerate => {
            state.local_mode = LocalSignerMode::Generate;
            Command::None
        }
        Target::ModeNsec => {
            state.local_mode = LocalSignerMode::Nsec;
            Command::None
        }
        Target::ModeNip06 => {
            state.local_mode = LocalSignerMode::Nip06;
            Command::None
        }
        Target::ConnectBunker => {
            if state.bunker_uri.is_empty() {
                return Command::None;
            }
            let uri = state.bunker_uri.take();
            let passphrase = take_if(&mut state.bunker_passphrase, needs_passphrase);
            Command::AddBunkerSigner { uri, passphrase }
        }
        Target::SubmitLocal => {
            let mode = state.local_mode;
            let nsec = match mode {
                LocalSignerMode::Nsec if !state.nsec.is_empty() => Some(state.nsec.take()),
                LocalSignerMode::Nsec => return Command::None,
                _ => None,
            };
            let mnemonic = match mode {
                LocalSignerMode::Nip06 if !state.mnemonic.is_empty() => Some(state.mnemonic.take()),
                LocalSignerMode::Nip06 => return Command::None,
                _ => None,
            };
            let passphrase = take_if(&mut state.local_passphrase, needs_passphrase);
            Command::AddLocalSigner(LocalSignerRequest {
                mode,
                nsec,
                mnemonic,
                label: None,
                passphrase,
            })
        }
        Target::SavedSignIn(index) => {
            let Some(signer) = status.and_then(|status| status.signers.get(index)) else {
                return Command::None;
            };
            let passphrase = take_if(&mut state.saved_passphrase, needs_passphrase);
            Command::SignIn {
                id: signer.id.clone(),
                passphrase,
            }
        }
        Target::SavedForget(index) => {
            let Some(signer) = status.and_then(|status| status.signers.get(index)) else {
                return Command::None;
            };
            Command::ForgetSigner(signer.id.clone())
        }
        Target::SignOut => Command::SignOut,
        // The mnemonic field is the one `ChainSeed` target this view's own
        // `editing` flag governs (see `field_mut`); every other one is
        // handled by `views::chain_seed::activate`.
        Target::ChainSeed(chain_seed::Target::Mnemonic) => {
            state.editing = true;
            Command::None
        }
        Target::ChainSeed(sub) => {
            chain_seed::activate(&mut state.chain_seed, chain_seed_status, sub)
        }
        Target::SwitchProfile(index) => {
            let Some(profile) = profiles.and_then(|profiles| profiles.profiles.get(index)) else {
                return Command::None;
            };
            Command::SwitchProfile(profile.id.clone())
        }
    }
}

/// `field.take()` when `condition` holds and the field is not blank, else
/// just clears it (there is nothing to zeroize-and-send, but nothing typed
/// there — into a passphrase field the daemon will not even ask for — should
/// linger either) and reports `None`.
fn take_if(field: &mut TextField, condition: bool) -> Option<String> {
    if condition && !field.is_empty() {
        Some(field.take())
    } else {
        field.clear();
        None
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

pub fn draw(
    frame: &mut Frame,
    area: Rect,
    state: &AccountViewState,
    status: &SessionStatus,
    profiles: Option<&Profiles>,
    chain_seed_status: Option<&ChainSeedStatus>,
    error: Option<&str>,
) {
    let list = targets(
        Some(status),
        profiles,
        chain_seed_status,
        state.local_mode,
        state.chain_seed.show_import,
    );
    let focused = |target: Target| list.get(state.cursor) == Some(&target);
    let chain_seed_focused = |sub: chain_seed::Target| focused(Target::ChainSeed(sub));

    let error_height = if error.is_some() { 2 } else { 0 };
    let profiles_height = profiles.map(|p| p.profiles.len() as u16 + 2).unwrap_or(3);

    if status.signed_in {
        let chain_seed_height = chain_seed::height(chain_seed_status);
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(9),
                Constraint::Length(chain_seed_height),
                Constraint::Length(profiles_height),
                Constraint::Length(error_height),
                Constraint::Min(0),
            ])
            .split(area);
        draw_signed_in(frame, rows[0], status, focused);
        chain_seed::draw(
            frame,
            rows[1],
            &state.chain_seed,
            chain_seed_status,
            chain_seed_focused,
        );
        draw_profiles(frame, rows[2], profiles, focused);
        draw_error(frame, rows[3], error);
        // The confirm modal (Publish is a paid relay write) draws last, over
        // this whole view's content, the same way `ui::draw_help` draws over
        // the whole screen — see the module doc comment.
        if let Some(confirm) = &state.chain_seed.confirm {
            crate::widgets::confirm::draw(frame, area, confirm);
        }
    } else {
        let saved_height = if status.signers.is_empty() {
            0
        } else {
            status.signers.len() as u16 + 3
        };
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(9),
                Constraint::Length(saved_height),
                Constraint::Length(profiles_height),
                Constraint::Length(error_height),
                Constraint::Min(0),
            ])
            .split(area);

        let top = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(rows[0]);
        draw_remote_signer(frame, top[0], state, status, focused);
        draw_local_keystore(frame, top[1], state, status, focused);

        if !status.signers.is_empty() {
            draw_saved_signers(frame, rows[1], state, status, focused);
        }
        draw_profiles(frame, rows[2], profiles, focused);
        draw_error(frame, rows[3], error);
    }
}

fn card_style(focused: bool) -> Style {
    if focused {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().add_modifier(Modifier::BOLD)
    }
}

fn button_line(label: &str, focused: bool) -> Line<'static> {
    Line::from(Span::styled(format!(" {label} "), card_style(focused)))
}

fn mode_line(label: &str, selected: bool, focused: bool) -> Line<'static> {
    let marker = if selected { "(x) " } else { "( ) " };
    let style = if focused {
        card_style(true)
    } else if selected {
        Style::default().add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    Line::from(Span::styled(format!("{marker}{label}"), style))
}

fn draw_remote_signer(
    frame: &mut Frame,
    area: Rect,
    state: &AccountViewState,
    status: &SessionStatus,
    focused: impl Fn(Target) -> bool,
) {
    let block = Block::default()
        .title(" Connect a remote signer ")
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![
        Line::from(Span::styled(
            "NIP-46: Amber, nsec.app or `nak bunker`. The key never leaves it.",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        )),
        Line::raw(""),
        state.bunker_uri.line(focused(Target::BunkerUri)),
    ];
    if status.keystore.needs_passphrase {
        lines.push(
            state
                .bunker_passphrase
                .line(focused(Target::BunkerPassphrase)),
        );
    }
    lines.push(Line::raw(""));
    lines.push(button_line("Connect", focused(Target::ConnectBunker)));

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_local_keystore(
    frame: &mut Frame,
    area: Rect,
    state: &AccountViewState,
    status: &SessionStatus,
    focused: impl Fn(Target) -> bool,
) {
    let backend = match status.keystore.backend {
        crate::types::KeystoreBackend::Libsecret => "gnome-keyring",
        crate::types::KeystoreBackend::File => "encrypted file",
    };
    let title = format!(" Use the local keystore ({backend}) ");
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![
        Line::from(Span::styled(
            format!("Sealed into {}.", status.keystore.location),
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        )),
        Line::raw(""),
        mode_line(
            "Generate",
            state.local_mode == LocalSignerMode::Generate,
            focused(Target::ModeGenerate),
        ),
        mode_line(
            "Import nsec",
            state.local_mode == LocalSignerMode::Nsec,
            focused(Target::ModeNsec),
        ),
        mode_line(
            "Import mnemonic",
            state.local_mode == LocalSignerMode::Nip06,
            focused(Target::ModeNip06),
        ),
    ];

    match state.local_mode {
        LocalSignerMode::Generate => {}
        LocalSignerMode::Nsec => lines.push(state.nsec.line(focused(Target::Nsec))),
        LocalSignerMode::Nip06 => lines.push(state.mnemonic.line(focused(Target::Mnemonic))),
    }
    if status.keystore.needs_passphrase {
        lines.push(
            state
                .local_passphrase
                .line(focused(Target::LocalPassphrase)),
        );
    }
    lines.push(Line::raw(""));
    let submit_label = match state.local_mode {
        LocalSignerMode::Generate => "Generate and sign in",
        LocalSignerMode::Nsec | LocalSignerMode::Nip06 => "Import and sign in",
    };
    lines.push(button_line(submit_label, focused(Target::SubmitLocal)));

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_saved_signers(
    frame: &mut Frame,
    area: Rect,
    state: &AccountViewState,
    status: &SessionStatus,
    focused: impl Fn(Target) -> bool,
) {
    let block = Block::default()
        .title(" Signers on this machine ")
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = Vec::new();
    for (index, signer) in status.signers.iter().enumerate() {
        let kind = match signer.kind {
            SignerKind::Remote => "remote signer",
            SignerKind::Local => "local key",
        };
        let mut spans = vec![
            Span::styled(
                format!("{}  ", signer.label),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("{kind}  "), Style::default().fg(Color::DarkGray)),
        ];
        if status.keystore.needs_passphrase && focused(Target::SavedPassphrase(index)) {
            spans.push(state.saved_passphrase.value_span(true));
            spans.push(Span::raw("  "));
        }
        spans.push(Span::styled(
            " Sign in ",
            card_style(focused(Target::SavedSignIn(index))),
        ));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(
            " Forget ",
            card_style(focused(Target::SavedForget(index))),
        ));
        lines.push(Line::from(spans));
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_signed_in(
    frame: &mut Frame,
    area: Rect,
    status: &SessionStatus,
    focused: impl Fn(Target) -> bool,
) {
    let block = Block::default().title(" Account ").borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let Some(view) = &status.account else {
        frame.render_widget(
            Paragraph::new("Signed in, waiting on the account's details…"),
            inner,
        );
        return;
    };

    let name = account_display_name(view);
    let signer_kind = match view.signer_kind {
        SignerKind::Remote => "remote signer",
        SignerKind::Local => "local keystore",
    };

    let mut lines = vec![
        Line::from(Span::styled(
            name,
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            view.npub.clone(),
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
        field_line("Signer", format!("{} ({signer_kind})", view.signer_label)),
        field_line("Relays", relays_summary(view)),
    ];
    lines.push(Line::raw(""));
    lines.push(button_line("Sign out", focused(Target::SignOut)));

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

/// Mirrors `describeProfile` in `packages/ui/src/app/account-view.tsx`, plus
/// the relay list itself — the web UI shows that separately (the account's
/// relays live on the card below this text there); one line says both here.
fn relays_summary(view: &crate::types::AccountView) -> String {
    use crate::types::{ProfileState, RelaySource};
    let description = match view.profile_state {
        ProfileState::Loading => return "reading the account's relays…".to_string(),
        ProfileState::None => match view.profile.as_ref().map(|p| p.relay_source) {
            Some(RelaySource::None) => {
                return "this network profile names no relay to read from".to_string()
            }
            _ => return "this account has published no kind-0 on the relays read".to_string(),
        },
        ProfileState::Ready => match view.profile.as_ref().map(|p| p.relay_source) {
            Some(RelaySource::Nip65) => "the account's own relays (NIP-65)",
            _ => "the network profile's relay",
        },
    };
    match view.profile.as_ref() {
        Some(profile) if !profile.relays.is_empty() => {
            format!("{description}: {}", profile.relays.join(", "))
        }
        _ => description.to_string(),
    }
}

fn field_line(label: &str, value: String) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{label}: "),
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(value),
    ])
}

fn draw_profiles(
    frame: &mut Frame,
    area: Rect,
    profiles: Option<&Profiles>,
    focused: impl Fn(Target) -> bool,
) {
    let block = Block::default()
        .title(" Network profile ")
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let Some(profiles) = profiles else {
        frame.render_widget(Paragraph::new("Reading profiles…"), inner);
        return;
    };

    let mut spans = Vec::new();
    for (index, profile) in profiles.profiles.iter().enumerate() {
        let marker = if profile.active { "● " } else { "○ " };
        let label = format!(" {marker}{} ", profile.label);
        let style = if focused(Target::SwitchProfile(index)) {
            card_style(true)
        } else if profile.active {
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        spans.push(Span::styled(label, style));
        if !profile.configured {
            spans.push(Span::styled(
                "unconfigured ",
                Style::default().fg(Color::DarkGray),
            ));
        }
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).wrap(Wrap { trim: false }),
        inner,
    );
}

fn draw_error(frame: &mut Frame, area: Rect, error: Option<&str>) {
    if area.height == 0 {
        return;
    }
    if let Some(message) = error {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                message.to_string(),
                Style::default().fg(Color::Red),
            )))
            .wrap(Wrap { trim: false }),
            area,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AccountMetadata, AccountProfile, AccountView, KeystoreBackend, KeystoreInfo, ProfileState,
        ProfileView, RelaySource, SignerRecord,
    };
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::fs;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn signed_out(needs_passphrase: bool, signers: Vec<SignerRecord>) -> SessionStatus {
        SessionStatus {
            signed_in: false,
            account: None,
            signers,
            keystore: KeystoreInfo {
                backend: KeystoreBackend::File,
                location: "/home/tester/.config/toon-console/keystore.json".to_string(),
                needs_passphrase,
            },
            invitation: None,
        }
    }

    fn sample_signer() -> SignerRecord {
        SignerRecord {
            id: "signer-1".to_string(),
            kind: SignerKind::Local,
            label: "agent".to_string(),
            pubkey: "abc123".to_string(),
            npub: "npub1exampleexampleexampleexampleexampleexampleexampleexamplex".to_string(),
            backend: KeystoreBackend::File,
            origin: Some(crate::types::SignerOrigin::Generated),
            bunker_relays: None,
            bunker_pubkey: None,
            created_at: "2026-09-24T00:00:00.000Z".to_string(),
            last_used_at: None,
        }
    }

    fn signed_in() -> SessionStatus {
        SessionStatus {
            signed_in: true,
            account: Some(AccountView {
                pubkey: "abc123".to_string(),
                npub: "npub1exampleexampleexampleexampleexampleexampleexampleexamplex".to_string(),
                signer_id: "signer-1".to_string(),
                signer_kind: SignerKind::Local,
                signer_label: "agent".to_string(),
                signed_in_at: "2026-09-24T00:00:00.000Z".to_string(),
                profile_state: ProfileState::Ready,
                profile: Some(AccountProfile {
                    metadata: Some(AccountMetadata {
                        name: Some("agent".to_string()),
                        display_name: Some("Agent Smith".to_string()),
                        about: None,
                        picture: None,
                        nip05: None,
                        published_at: None,
                    }),
                    relays: vec!["wss://relay.devnet.toonprotocol.dev".to_string()],
                    relay_source: RelaySource::Nip65,
                    read_at: "2026-09-24T00:00:01.000Z".to_string(),
                }),
            }),
            signers: vec![sample_signer()],
            keystore: KeystoreInfo {
                backend: KeystoreBackend::File,
                location: "/home/tester/.config/toon-console/keystore.json".to_string(),
                needs_passphrase: true,
            },
            invitation: None,
        }
    }

    fn sample_profiles() -> Profiles {
        Profiles {
            active_id: "devnet".to_string(),
            profiles: vec![
                ProfileView {
                    id: "devnet".to_string(),
                    label: "Devnet".to_string(),
                    description: "d".to_string(),
                    connector_url: "https://c".to_string(),
                    relay_url: "wss://r".to_string(),
                    gateway_domain: "g".to_string(),
                    gateway_connector_url: "https://g".to_string(),
                    faucet_url: None,
                    rpc: None,
                    origin: "built-in".to_string(),
                    configured: true,
                    active: true,
                },
                ProfileView {
                    id: "sandbox".to_string(),
                    label: "Sandbox".to_string(),
                    description: "s".to_string(),
                    connector_url: "https://c2".to_string(),
                    relay_url: "wss://r2".to_string(),
                    gateway_domain: "g2".to_string(),
                    gateway_connector_url: "https://g2".to_string(),
                    faucet_url: None,
                    rpc: None,
                    origin: "built-in".to_string(),
                    configured: true,
                    active: false,
                },
            ],
        }
    }

    // -- key handling: pure state, no rendering ----------------------------

    #[test]
    fn j_and_k_move_the_cursor_through_the_target_list_and_clamp_at_the_ends() {
        let mut state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        let list = targets(Some(&status), None, None, state.local_mode, false);
        assert!(list.len() > 3, "fixture should have several targets");

        for _ in 0..list.len() + 3 {
            handle_key(
                &mut state,
                Some(&status),
                None,
                None,
                key(KeyCode::Char('j')),
            );
        }
        assert_eq!(state.cursor, list.len() - 1, "clamped at the last target");

        for _ in 0..list.len() + 3 {
            handle_key(
                &mut state,
                Some(&status),
                None,
                None,
                key(KeyCode::Char('k')),
            );
        }
        assert_eq!(state.cursor, 0, "clamped at the first target");
    }

    #[test]
    fn enter_on_the_bunker_uri_field_starts_editing_and_typed_keys_fill_it() {
        let mut state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        assert_eq!(
            targets(Some(&status), None, None, state.local_mode, false)[0],
            Target::BunkerUri
        );

        handle_key(&mut state, Some(&status), None, None, key(KeyCode::Enter));
        assert!(state.editing);
        for c in "bunker://npub1x?relay=wss://r".chars() {
            handle_key(&mut state, Some(&status), None, None, key(KeyCode::Char(c)));
        }
        assert_eq!(state.bunker_uri.value(), "bunker://npub1x?relay=wss://r");

        // A digit typed while editing must NOT be treated as a view-switch —
        // this view swallowed it. (It types the digit into the field.)
        assert_eq!(
            handle_key(
                &mut state,
                Some(&status),
                None,
                None,
                key(KeyCode::Char('1'))
            ),
            Some(Command::None)
        );

        // Esc stops editing without discarding what was typed.
        handle_key(&mut state, Some(&status), None, None, key(KeyCode::Esc));
        assert!(!state.editing);
        assert!(state.bunker_uri.value().contains("bunker://"));
    }

    #[test]
    fn connect_bunker_is_a_no_op_with_an_empty_uri() {
        let mut state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        // Cursor starts on BunkerUri; move to ConnectBunker.
        handle_key(
            &mut state,
            Some(&status),
            None,
            None,
            key(KeyCode::Char('j')),
        );
        let list = targets(Some(&status), None, None, state.local_mode, false);
        assert_eq!(list[state.cursor], Target::ConnectBunker);

        let command = handle_key(&mut state, Some(&status), None, None, key(KeyCode::Enter));
        assert_eq!(command, Some(Command::None));
    }

    #[test]
    fn connect_bunker_clears_the_typed_uri_and_sends_a_command() {
        let mut state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        handle_key(&mut state, Some(&status), None, None, key(KeyCode::Enter)); // edit uri
        for c in "bunker://npub1x".chars() {
            handle_key(&mut state, Some(&status), None, None, key(KeyCode::Char(c)));
        }
        handle_key(&mut state, Some(&status), None, None, key(KeyCode::Esc)); // stop editing
        handle_key(
            &mut state,
            Some(&status),
            None,
            None,
            key(KeyCode::Char('j')),
        ); // -> Connect
        let command = handle_key(&mut state, Some(&status), None, None, key(KeyCode::Enter));
        assert_eq!(
            command,
            Some(Command::AddBunkerSigner {
                uri: "bunker://npub1x".to_string(),
                passphrase: None,
            })
        );
        assert_eq!(
            state.bunker_uri.value(),
            "",
            "the field is cleared the moment its value is taken for the command"
        );
    }

    #[test]
    fn submitting_the_local_form_in_nsec_mode_with_a_blank_nsec_does_nothing() {
        let mut state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        state.local_mode = LocalSignerMode::Nsec;
        let list = targets(Some(&status), None, None, state.local_mode, false);
        let submit = list.iter().position(|t| *t == Target::SubmitLocal).unwrap();
        state.cursor = submit;
        let command = handle_key(&mut state, Some(&status), None, None, key(KeyCode::Enter));
        assert_eq!(command, Some(Command::None));
    }

    #[test]
    fn a_passphrase_is_only_attached_to_the_command_when_the_keystore_needs_one() {
        let mut state = AccountViewState::new();
        let status = signed_out(false, vec![]); // needs_passphrase: false
        state.local_passphrase.handle_key(key(KeyCode::Char('x')));

        let list = targets(Some(&status), None, None, state.local_mode, false);
        let submit = list.iter().position(|t| *t == Target::SubmitLocal).unwrap();
        state.cursor = submit;
        let command = handle_key(&mut state, Some(&status), None, None, key(KeyCode::Enter));
        assert_eq!(
            command,
            Some(Command::AddLocalSigner(LocalSignerRequest {
                mode: LocalSignerMode::Generate,
                nsec: None,
                mnemonic: None,
                label: None,
                passphrase: None,
            }))
        );
    }

    #[test]
    fn sign_out_fires_immediately_with_no_editing_step() {
        let mut state = AccountViewState::new();
        let status = signed_in();
        assert_eq!(
            targets(Some(&status), None, None, state.local_mode, false),
            vec![Target::SignOut]
        );
        let command = handle_key(&mut state, Some(&status), None, None, key(KeyCode::Enter));
        assert_eq!(command, Some(Command::SignOut));
    }

    #[test]
    fn switch_profile_targets_follow_signed_in_or_out_targets_in_the_list() {
        let state = AccountViewState::new();
        let status = signed_in();
        let profiles = sample_profiles();
        let list = targets(
            Some(&status),
            Some(&profiles),
            None,
            state.local_mode,
            false,
        );
        assert_eq!(
            list,
            vec![
                Target::SignOut,
                Target::SwitchProfile(0),
                Target::SwitchProfile(1)
            ]
        );
    }

    #[test]
    fn enter_on_a_switch_profile_target_sends_the_chosen_profiles_id() {
        let mut state = AccountViewState::new();
        let status = signed_in();
        let profiles = sample_profiles();
        state.cursor = 1; // Target::SwitchProfile(0), "devnet" — sandbox is index 1 overall
        let command = handle_key(
            &mut state,
            Some(&status),
            Some(&profiles),
            None,
            key(KeyCode::Enter),
        );
        assert_eq!(command, Some(Command::SwitchProfile("devnet".to_string())));
    }

    #[test]
    fn a_view_switch_digit_still_works_when_nothing_is_being_edited() {
        let mut state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        // Not editing, cursor on BunkerUri: '1' is not a Target key, so this
        // view must hand it back (`None`) for the global keymap to switch views.
        let command = handle_key(
            &mut state,
            Some(&status),
            None,
            None,
            key(KeyCode::Char('1')),
        );
        assert_eq!(command, None);
    }

    // -- rendering -----------------------------------------------------------

    fn render(draw_fn: impl FnOnce(&mut Frame)) -> String {
        let backend = TestBackend::new(110, 34);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw_fn(frame)).unwrap();
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
    fn renders_the_signed_out_state() {
        let state = AccountViewState::new();
        let status = signed_out(true, vec![sample_signer()]);
        let profiles = sample_profiles();
        let output = render(|frame| {
            draw(
                frame,
                frame.area(),
                &state,
                &status,
                Some(&profiles),
                None,
                None,
            );
        });
        insta::assert_snapshot!(output);
    }

    #[test]
    fn renders_the_signed_in_state() {
        let state = AccountViewState::new();
        let status = signed_in();
        let profiles = sample_profiles();
        let output = render(|frame| {
            draw(
                frame,
                frame.area(),
                &state,
                &status,
                Some(&profiles),
                None,
                None,
            );
        });
        insta::assert_snapshot!(output);
    }

    #[test]
    fn renders_with_an_inline_error_without_panicking() {
        let state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        render(|frame| {
            draw(
                frame,
                frame.area(),
                &state,
                &status,
                None,
                None,
                Some("the daemon rejected this window's token"),
            );
        });
    }

    fn real_fixture(name: &str) -> String {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        fs::read_to_string(&path).unwrap_or_else(|err| panic!("could not read {path}: {err}"))
    }

    /// The daemon's own real, volatile answers must still render without
    /// panicking — see `views::health`'s tests for why this is separate from
    /// the deterministic snapshots above.
    #[test]
    fn renders_the_real_account_fixtures_without_panicking() {
        let state = AccountViewState::new();
        for name in ["account-signed-out", "account-signed-in"] {
            let text = real_fixture(name);
            let status: SessionStatus = serde_json::from_str(&text)
                .unwrap_or_else(|err| panic!("fixture {name} did not deserialize: {err}"));
            render(|frame| {
                draw(frame, frame.area(), &state, &status, None, None, None);
            });
        }
    }

    #[test]
    fn renders_the_real_profiles_fixture_without_panicking() {
        let state = AccountViewState::new();
        let status = signed_out(false, vec![]);
        let text = real_fixture("profiles");
        let profiles: Profiles = serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture profiles did not deserialize: {err}"));
        render(|frame| {
            draw(
                frame,
                frame.area(),
                &state,
                &status,
                Some(&profiles),
                None,
                None,
            );
        });
    }

    /// The Chain Seed section's own states each get a snapshot in
    /// `views::chain_seed`'s own tests; this one is here instead because
    /// the confirm modal (TOON_Network#142) is layered over the WHOLE
    /// Account view by this module's `draw`, not by `chain_seed::draw` —
    /// see both modules' doc comments.
    #[test]
    fn renders_the_confirm_modal_over_the_whole_account_view() {
        let mut state = AccountViewState::new();
        let status = signed_in();
        let text = real_fixture("chain-seed-not-yet-recoverable");
        let chain_seed: ChainSeedStatus = serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture did not deserialize: {err}"));
        chain_seed::activate(
            &mut state.chain_seed,
            Some(&chain_seed),
            chain_seed::Target::Publish,
        );
        assert!(state.chain_seed.confirm.is_some());
        let output = render(|frame| {
            draw(
                frame,
                frame.area(),
                &state,
                &status,
                None,
                Some(&chain_seed),
                None,
            );
        });
        assert!(
            output.contains("Type") && output.contains("yes"),
            "shows the typed-confirmation prompt"
        );
    }
}
