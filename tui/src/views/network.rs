//! The network profile editor (TOON_Network#150).
//!
//! Reachable from the Account view's "Network profile" section: `e` edits
//! the profile the cursor is on, `n` adds one under a new id, `D` resets or
//! removes it through [`crate::widgets::confirm`] — see `views::account`,
//! which owns opening and closing this and treats it as a modal the same
//! way it treats `views::chain_seed`'s publish confirmation: every key goes
//! here and nothing else while it is open ([`handle_key`] never returns
//! `None`).
//!
//! One [`TextField`] row per endpoint — `profiles.ts`'s own list: the
//! connector, the relay, the gateway's domain, the gateway's OWN connector,
//! the gas station's connector, the faucet, and the two RPC endpoints —
//! plus a label for a brand-new id. A field left blank at `Save` is not
//! "blank" to the daemon: [`NetworkEditorState::request`] DROPS it from the
//! body entirely, so it falls through to the built-in (or stays unset, for
//! a profile with none), exactly what `profile-store.ts`'s `setEndpoints`
//! does with an absent field. That is also why an already-overridden field
//! opens PRE-FILLED with its current value rather than blank: clearing it
//! and saving is how a person resets just that one field, and every field
//! still at the built-in's own value shows that value as a dim placeholder
//! instead — [`NetworkEditorState::for_edit`] is where both are decided,
//! from `ProfileView::overridden_fields` (TOON_Network#150's daemon side).

use std::collections::HashMap;

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::types::{ProfileEndpointsRequest, ProfileRpcRequest, ProfileView};
use crate::widgets::confirm::Confirm;
use crate::widgets::input::TextField;

/// The three built-in ids, for this module's own COPY only — "reset to its
/// built-in defaults" versus "remove it" in [`confirm_for`]'s wording.
/// Never for validation: whether an id is safe, or a built-in's own, is
/// entirely the daemon's call (`profile-store.ts`, `profile-validation.ts`),
/// and this list drifting from it costs a confirm dialog's wording, never a
/// wrong write.
const BUILT_IN_IDS: [&str; 3] = ["devnet", "sandbox", "mainnet"];

fn is_built_in(id: &str) -> bool {
    BUILT_IN_IDS.contains(&id)
}

/// One row of the form, in the order it is drawn and `j`/`k`/`Tab` walk it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Label,
    ConnectorUrl,
    RelayUrl,
    GatewayDomain,
    GatewayConnectorUrl,
    GasConnectorUrl,
    FaucetUrl,
    RpcEvm,
    RpcSolana,
    Save,
    Cancel,
}

fn fields(is_new: bool) -> Vec<Field> {
    let mut out = Vec::new();
    if is_new {
        out.push(Field::Label);
    }
    out.extend([
        Field::ConnectorUrl,
        Field::RelayUrl,
        Field::GatewayDomain,
        Field::GatewayConnectorUrl,
        Field::GasConnectorUrl,
        Field::FaucetUrl,
        Field::RpcEvm,
        Field::RpcSolana,
        Field::Save,
        Field::Cancel,
    ]);
    out
}

/// The daemon's own field name for a per-field validation error
/// (`profile-validation.ts`'s `ENDPOINT_FIELD_NAMES`, plus `"label"` for a
/// brand-new id with none) — `None` for the two buttons.
fn error_key(field: Field) -> Option<&'static str> {
    match field {
        Field::Label => Some("label"),
        Field::ConnectorUrl => Some("connectorUrl"),
        Field::RelayUrl => Some("relayUrl"),
        Field::GatewayDomain => Some("gatewayDomain"),
        Field::GatewayConnectorUrl => Some("gatewayConnectorUrl"),
        Field::GasConnectorUrl => Some("gasConnectorUrl"),
        Field::FaucetUrl => Some("faucetUrl"),
        Field::RpcEvm => Some("rpc.evm"),
        Field::RpcSolana => Some("rpc.solana"),
        Field::Save | Field::Cancel => None,
    }
}

fn field_label(field: Field) -> &'static str {
    match field {
        Field::Label => "Label",
        Field::ConnectorUrl => "Connector URL",
        Field::RelayUrl => "Relay URL",
        Field::GatewayDomain => "Gateway domain",
        Field::GatewayConnectorUrl => "Gateway's connector URL",
        Field::GasConnectorUrl => "Gas station's connector URL",
        Field::FaucetUrl => "Faucet URL",
        Field::RpcEvm => "EVM RPC URL",
        Field::RpcSolana => "Solana RPC URL",
        Field::Save | Field::Cancel => "",
    }
}

/// The built-in's own current value for a field not overridden, shown as a
/// dim placeholder — see the module doc comment. Every field empty for a
/// brand-new profile: there is no built-in to fall back to.
#[derive(Debug, Clone, Default)]
struct Placeholders {
    connector_url: String,
    relay_url: String,
    gateway_domain: String,
    gateway_connector_url: String,
    gas_connector_url: String,
    faucet_url: String,
    rpc_evm: String,
    rpc_solana: String,
}

impl Placeholders {
    fn for_field(&self, field: Field) -> &str {
        match field {
            Field::ConnectorUrl => &self.connector_url,
            Field::RelayUrl => &self.relay_url,
            Field::GatewayDomain => &self.gateway_domain,
            Field::GatewayConnectorUrl => &self.gateway_connector_url,
            Field::GasConnectorUrl => &self.gas_connector_url,
            Field::FaucetUrl => &self.faucet_url,
            Field::RpcEvm => &self.rpc_evm,
            Field::RpcSolana => &self.rpc_solana,
            Field::Label | Field::Save | Field::Cancel => "",
        }
    }
}

pub struct NetworkEditorState {
    pub id: String,
    pub is_new: bool,
    label: TextField,
    connector_url: TextField,
    relay_url: TextField,
    gateway_domain: TextField,
    gateway_connector_url: TextField,
    gas_connector_url: TextField,
    faucet_url: TextField,
    rpc_evm: TextField,
    rpc_solana: TextField,
    placeholders: Placeholders,
    cursor: usize,
    editing: bool,
    /// Per-field messages from the daemon's last 400 — `error_key`'s own
    /// spelling. Cleared the moment a fresh `Save` goes out.
    pub errors: HashMap<String, String>,
    /// A refusal that names no field (an invalid id, a network error).
    pub general_error: Option<String>,
    /// Set the moment `Save` fires, cleared by whichever `RuntimeEvent`
    /// answers it — the form's own "in flight" flag, drawn as a small note
    /// rather than blocking input (a slow daemon must not freeze the form).
    pub saving: bool,
}

impl NetworkEditorState {
    /// `n`: a blank form under no id yet.
    pub fn for_new() -> Self {
        Self {
            id: String::new(),
            is_new: true,
            label: TextField::new("Label", false),
            connector_url: TextField::new("Connector URL", false),
            relay_url: TextField::new("Relay URL", false),
            gateway_domain: TextField::new("Gateway domain", false),
            gateway_connector_url: TextField::new("Gateway's connector URL", false),
            gas_connector_url: TextField::new("Gas station's connector URL", false),
            faucet_url: TextField::new("Faucet URL", false),
            rpc_evm: TextField::new("EVM RPC URL", false),
            rpc_solana: TextField::new("Solana RPC URL", false),
            placeholders: Placeholders::default(),
            cursor: 0,
            editing: false,
            errors: HashMap::new(),
            general_error: None,
            saving: false,
        }
    }

    /// `e` on a profile row — see the module doc comment for the
    /// prefill/placeholder split.
    pub fn for_edit(profile: &ProfileView) -> Self {
        let overridden = |name: &str| profile.overridden_fields.iter().any(|f| f == name);
        let mut state = Self::for_new();
        state.id = profile.id.clone();
        state.is_new = false;

        let prefill = |field: &mut TextField, placeholder: &mut String, name: &str, value: &str| {
            *placeholder = value.to_string();
            if overridden(name) {
                field.set_value(value.to_string());
            }
        };
        prefill(
            &mut state.connector_url,
            &mut state.placeholders.connector_url,
            "connectorUrl",
            &profile.connector_url,
        );
        prefill(
            &mut state.relay_url,
            &mut state.placeholders.relay_url,
            "relayUrl",
            &profile.relay_url,
        );
        prefill(
            &mut state.gateway_domain,
            &mut state.placeholders.gateway_domain,
            "gatewayDomain",
            &profile.gateway_domain,
        );
        prefill(
            &mut state.gateway_connector_url,
            &mut state.placeholders.gateway_connector_url,
            "gatewayConnectorUrl",
            &profile.gateway_connector_url,
        );
        prefill(
            &mut state.gas_connector_url,
            &mut state.placeholders.gas_connector_url,
            "gasConnectorUrl",
            &profile.gas_connector_url,
        );
        prefill(
            &mut state.faucet_url,
            &mut state.placeholders.faucet_url,
            "faucetUrl",
            profile.faucet_url.as_deref().unwrap_or(""),
        );
        let rpc = profile.rpc.as_ref();
        prefill(
            &mut state.rpc_evm,
            &mut state.placeholders.rpc_evm,
            "rpc.evm",
            rpc.and_then(|r| r.evm.as_deref()).unwrap_or(""),
        );
        prefill(
            &mut state.rpc_solana,
            &mut state.placeholders.rpc_solana,
            "rpc.solana",
            rpc.and_then(|r| r.solana.as_deref()).unwrap_or(""),
        );
        state
    }

    fn field_list(&self) -> Vec<Field> {
        fields(self.is_new)
    }

    fn field_mut(&mut self, field: Field) -> Option<&mut TextField> {
        match field {
            Field::Label => Some(&mut self.label),
            Field::ConnectorUrl => Some(&mut self.connector_url),
            Field::RelayUrl => Some(&mut self.relay_url),
            Field::GatewayDomain => Some(&mut self.gateway_domain),
            Field::GatewayConnectorUrl => Some(&mut self.gateway_connector_url),
            Field::GasConnectorUrl => Some(&mut self.gas_connector_url),
            Field::FaucetUrl => Some(&mut self.faucet_url),
            Field::RpcEvm => Some(&mut self.rpc_evm),
            Field::RpcSolana => Some(&mut self.rpc_solana),
            Field::Save | Field::Cancel => None,
        }
    }

    fn field_ref(&self, field: Field) -> Option<&TextField> {
        match field {
            Field::Label => Some(&self.label),
            Field::ConnectorUrl => Some(&self.connector_url),
            Field::RelayUrl => Some(&self.relay_url),
            Field::GatewayDomain => Some(&self.gateway_domain),
            Field::GatewayConnectorUrl => Some(&self.gateway_connector_url),
            Field::GasConnectorUrl => Some(&self.gas_connector_url),
            Field::FaucetUrl => Some(&self.faucet_url),
            Field::RpcEvm => Some(&self.rpc_evm),
            Field::RpcSolana => Some(&self.rpc_solana),
            Field::Save | Field::Cancel => None,
        }
    }

    /// Every non-empty field, folded into the request `Save` sends — a
    /// blank field is left OUT of the body entirely (never sent as `""`),
    /// which is what makes clearing an overridden field back to blank and
    /// saving the way to reset just that one field (see the module doc
    /// comment).
    fn request(&self) -> ProfileEndpointsRequest {
        let non_empty = |field: &TextField| {
            let value = field.value().trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        };
        let evm = non_empty(&self.rpc_evm);
        let solana = non_empty(&self.rpc_solana);
        ProfileEndpointsRequest {
            label: non_empty(&self.label),
            connector_url: non_empty(&self.connector_url),
            relay_url: non_empty(&self.relay_url),
            gateway_domain: non_empty(&self.gateway_domain),
            gateway_connector_url: non_empty(&self.gateway_connector_url),
            gas_connector_url: non_empty(&self.gas_connector_url),
            faucet_url: non_empty(&self.faucet_url),
            rpc: if evm.is_some() || solana.is_some() {
                Some(ProfileRpcRequest { evm, solana })
            } else {
                None
            },
        }
    }
}

/// A label typed for a brand-new profile, turned into the id the request
/// names — lowercase, spaces and runs of anything else folded to one `-`,
/// no leading or trailing one. A best effort only: `profile-validation.ts`'s
/// `isValidProfileId` is what actually decides, and a label that still
/// produces something outside it (starts with a digit, say) comes back as
/// `general_error` off the daemon's own 400, same as any other refusal.
fn slugify(label: &str) -> String {
    let mut out = String::new();
    let mut last_was_dash = true; // swallows a leading separator too
    for ch in label.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// What a keypress did — `views::account::handle_key` turns this into
/// whether the editor stays open.
pub enum Outcome {
    /// Still open; nothing to send yet.
    Pending,
    /// Closed with nothing sent (`Esc`, or `Enter` on Cancel).
    Cancelled,
    /// Closed, and this command should be sent.
    Save(Box<Command>),
}

/// Every key while the editor is open goes here and nothing else — see the
/// module doc comment.
pub fn handle_key(state: &mut NetworkEditorState, key: KeyEvent) -> Outcome {
    let list = state.field_list();

    if state.editing {
        match key.code {
            KeyCode::Enter | KeyCode::Esc => state.editing = false,
            _ => {
                let field = list[state.cursor];
                if let Some(text) = state.field_mut(field) {
                    text.handle_key(key);
                }
            }
        }
        return Outcome::Pending;
    }

    match key.code {
        KeyCode::Esc => Outcome::Cancelled,
        KeyCode::Up | KeyCode::Char('k') => {
            state.cursor = state.cursor.saturating_sub(1);
            Outcome::Pending
        }
        KeyCode::Down | KeyCode::Char('j') => {
            state.cursor = (state.cursor + 1).min(list.len() - 1);
            Outcome::Pending
        }
        KeyCode::Tab => {
            state.cursor = (state.cursor + 1) % list.len();
            Outcome::Pending
        }
        KeyCode::Enter => match list[state.cursor] {
            Field::Save => {
                let id = if state.is_new {
                    slugify(state.label.value())
                } else {
                    state.id.clone()
                };
                if state.is_new {
                    state.id = id.clone();
                }
                state.saving = true;
                Outcome::Save(Box::new(Command::SaveProfile {
                    id,
                    request: state.request(),
                }))
            }
            Field::Cancel => Outcome::Cancelled,
            _ => {
                state.editing = true;
                Outcome::Pending
            }
        },
        _ => Outcome::Pending,
    }
}

/// `D` on a profile row (`views::account`) — a built-in's own wording
/// ("reset") versus an added profile's ("remove"), decided from
/// [`is_built_in`], never from anything security-relevant.
pub fn confirm_for(profile: &ProfileView) -> Confirm<String> {
    if is_built_in(&profile.id) {
        Confirm::new(
            "Reset to built-in defaults",
            vec![format!(
                "\"{}\" goes back to its built-in endpoints. Anything you overrode is dropped.",
                profile.label
            )],
            profile.id.clone(),
        )
    } else {
        Confirm::new(
            "Remove this profile",
            vec![format!(
                "\"{}\" is removed. This cannot be undone.",
                profile.label
            )],
            profile.id.clone(),
        )
    }
}

fn field_span(field: &TextField, placeholder: &str, focused: bool) -> Span<'static> {
    if field.is_empty() && !focused && !placeholder.is_empty() {
        Span::styled(
            placeholder.to_string(),
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        )
    } else {
        field.value_span(focused)
    }
}

fn button_span(label: &str, focused: bool) -> Span<'static> {
    let style = if focused {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().add_modifier(Modifier::BOLD)
    };
    Span::styled(format!(" {label} "), style)
}

pub fn draw(frame: &mut Frame, area: Rect, state: &NetworkEditorState) {
    let width = 74u16.min(area.width.saturating_sub(4)).max(30);
    let list = state.field_list();
    // Two lines reserved per field (value + a possible error line), plus the
    // button row, a blank, a general-error line and borders — generous
    // rather than exact, since `Paragraph`'s own wrap absorbs the slack.
    let height = (list.len() as u16 * 2 + 5).min(area.height.saturating_sub(2));
    let popup = centered(area, width, height);
    frame.render_widget(Clear, popup);

    let title = if state.is_new {
        " Add a network profile "
    } else {
        " Edit network profile "
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let focused = |field: Field| list.get(state.cursor) == Some(&field);
    let mut lines: Vec<Line> = Vec::new();
    for field in &list {
        match field {
            Field::Save => {
                lines.push(Line::from(vec![
                    button_span("Save", focused(Field::Save)),
                    Span::raw("  "),
                    button_span("Cancel", focused(Field::Cancel)),
                ]));
            }
            Field::Cancel => {} // drawn alongside Save, above
            other => {
                let Some(value) = state.field_ref(*other) else {
                    continue;
                };
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("{}: ", field_label(*other)),
                        Style::default()
                            .fg(Color::DarkGray)
                            .add_modifier(Modifier::BOLD),
                    ),
                    field_span(value, state.placeholders.for_field(*other), focused(*other)),
                ]));
                if let Some(key) = error_key(*other) {
                    if let Some(message) = state.errors.get(key) {
                        lines.push(Line::from(Span::styled(
                            format!("  {message}"),
                            Style::default().fg(Color::Red),
                        )));
                    }
                }
            }
        }
    }
    if let Some(message) = &state.general_error {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            message.clone(),
            Style::default().fg(Color::Red),
        )));
    }
    if state.saving {
        lines.push(Line::from(Span::styled(
            "saving…",
            Style::default().fg(Color::DarkGray),
        )));
    }

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
    use crossterm::event::KeyModifiers;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn sample_profile(overridden: &[&str]) -> ProfileView {
        ProfileView {
            id: "devnet".to_string(),
            label: "Devnet".to_string(),
            description: "d".to_string(),
            connector_url: "https://connector.example/ilp".to_string(),
            relay_url: "wss://relay.example".to_string(),
            gateway_domain: "gw.example".to_string(),
            gateway_connector_url: "https://gateway.example/ilp".to_string(),
            gas_connector_url: "https://gas.example/ilp".to_string(),
            faucet_url: Some("https://faucet.example".to_string()),
            rpc: None,
            origin: "built-in".to_string(),
            configured: true,
            active: true,
            overridden_fields: overridden.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn slugify_folds_spaces_and_punctuation_to_single_hyphens() {
        assert_eq!(slugify("My Devnet Fork!"), "my-devnet-fork");
        assert_eq!(slugify("  leading and trailing  "), "leading-and-trailing");
        assert_eq!(slugify("a--b"), "a-b");
    }

    #[test]
    fn for_new_opens_every_field_blank_with_no_placeholder() {
        let state = NetworkEditorState::for_new();
        assert!(state.is_new);
        assert_eq!(state.connector_url.value(), "");
        assert_eq!(state.placeholders.connector_url, "");
    }

    #[test]
    fn for_edit_prefills_an_overridden_field_and_placeholders_the_rest() {
        let profile = sample_profile(&["connectorUrl"]);
        let state = NetworkEditorState::for_edit(&profile);
        assert!(!state.is_new);
        assert_eq!(state.id, "devnet");
        // Overridden: the actual value, ready to edit.
        assert_eq!(state.connector_url.value(), "https://connector.example/ilp");
        // Not overridden: blank, with the built-in's value remembered as a
        // placeholder rather than typed into the field.
        assert_eq!(state.relay_url.value(), "");
        assert_eq!(state.placeholders.relay_url, "wss://relay.example");
    }

    #[test]
    fn j_and_k_move_the_cursor_and_clamp() {
        let mut state = NetworkEditorState::for_new();
        let list = state.field_list();
        for _ in 0..list.len() + 3 {
            handle_key(&mut state, key(KeyCode::Char('j')));
        }
        assert_eq!(state.cursor, list.len() - 1);
        for _ in 0..list.len() + 3 {
            handle_key(&mut state, key(KeyCode::Char('k')));
        }
        assert_eq!(state.cursor, 0);
    }

    #[test]
    fn enter_on_a_field_starts_editing_and_typed_keys_fill_it() {
        let mut state = NetworkEditorState::for_edit(&sample_profile(&[]));
        assert_eq!(state.field_list()[0], Field::ConnectorUrl);
        handle_key(&mut state, key(KeyCode::Enter));
        assert!(state.editing);
        for c in "https://my-fork.example/ilp".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        assert_eq!(state.connector_url.value(), "https://my-fork.example/ilp");
        handle_key(&mut state, key(KeyCode::Esc));
        assert!(!state.editing);
        assert_eq!(state.connector_url.value(), "https://my-fork.example/ilp");
    }

    #[test]
    fn esc_outside_a_field_cancels_the_whole_form() {
        let mut state = NetworkEditorState::for_new();
        assert!(matches!(
            handle_key(&mut state, key(KeyCode::Esc)),
            Outcome::Cancelled
        ));
    }

    #[test]
    fn enter_on_cancel_cancels_without_sending_anything() {
        let mut state = NetworkEditorState::for_new();
        state.cursor = state.field_list().len() - 1; // Cancel is last
        assert!(matches!(
            handle_key(&mut state, key(KeyCode::Enter)),
            Outcome::Cancelled
        ));
    }

    #[test]
    fn saving_a_new_profile_derives_the_id_from_the_label_and_sends_only_typed_fields() {
        let mut state = NetworkEditorState::for_new();
        // Type into Label.
        handle_key(&mut state, key(KeyCode::Enter));
        for c in "My Devnet Fork".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        handle_key(&mut state, key(KeyCode::Esc));
        // Move to ConnectorUrl and type.
        handle_key(&mut state, key(KeyCode::Char('j')));
        handle_key(&mut state, key(KeyCode::Enter));
        for c in "https://my-fork.example/ilp".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        handle_key(&mut state, key(KeyCode::Esc));
        // Move to Save.
        let save_index = state
            .field_list()
            .iter()
            .position(|f| *f == Field::Save)
            .unwrap();
        state.cursor = save_index;
        let outcome = handle_key(&mut state, key(KeyCode::Enter));
        match outcome {
            Outcome::Save(command) => {
                let Command::SaveProfile { id, request } = *command else {
                    panic!("expected Command::SaveProfile");
                };
                assert_eq!(id, "my-devnet-fork");
                assert_eq!(request.label.as_deref(), Some("My Devnet Fork"));
                assert_eq!(
                    request.connector_url.as_deref(),
                    Some("https://my-fork.example/ilp")
                );
                assert_eq!(request.relay_url, None, "an untouched field is left out");
            }
            _ => panic!("expected Outcome::Save"),
        }
        assert!(state.saving);
    }

    #[test]
    fn clearing_an_overridden_field_and_saving_omits_it_which_resets_it() {
        let mut state = NetworkEditorState::for_edit(&sample_profile(&["connectorUrl"]));
        assert_eq!(state.connector_url.value(), "https://connector.example/ilp");
        handle_key(&mut state, key(KeyCode::Enter)); // start editing ConnectorUrl
        for _ in 0.."https://connector.example/ilp".chars().count() {
            handle_key(&mut state, key(KeyCode::Backspace));
        }
        handle_key(&mut state, key(KeyCode::Esc));
        let request = state.request();
        assert_eq!(request.connector_url, None);
    }

    #[test]
    fn confirm_for_a_built_in_offers_a_reset_and_for_an_added_profile_a_removal() {
        let built_in = sample_profile(&[]);
        let confirm = confirm_for(&built_in);
        assert_eq!(confirm.title, "Reset to built-in defaults");

        let mut added = sample_profile(&[]);
        added.id = "my-devnet".to_string();
        added.origin = "user".to_string();
        let confirm = confirm_for(&added);
        assert_eq!(confirm.title, "Remove this profile");
    }

    fn render(draw_fn: impl FnOnce(&mut Frame)) -> String {
        let backend = TestBackend::new(100, 34);
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
    fn renders_an_edit_form_with_a_placeholder_and_an_override() {
        let state = NetworkEditorState::for_edit(&sample_profile(&["connectorUrl"]));
        let output = render(|frame| draw(frame, frame.area(), &state));
        insta::assert_snapshot!(output);
    }

    #[test]
    fn renders_a_validation_error_beside_its_field() {
        let mut state = NetworkEditorState::for_edit(&sample_profile(&["connectorUrl"]));
        state.errors.insert(
            "connectorUrl".to_string(),
            "the connector URL must use https://".to_string(),
        );
        let output = render(|frame| draw(frame, frame.area(), &state));
        assert!(output.contains("must use https"));
        insta::assert_snapshot!(output);
    }

    #[test]
    fn renders_the_add_form_without_panicking() {
        let state = NetworkEditorState::for_new();
        render(|frame| draw(frame, frame.area(), &state));
    }
}
