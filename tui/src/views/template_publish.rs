//! "Publish a Template" (TOON_Network#138): a small form the New workload
//! Gallery stage opens with `p` — read a local `template.json`, preview the
//! Image Registry entry and the Template it would build, and publish both as
//! the signed-in account, paid from its own relay channel. See
//! `packages/daemon/src/template-publish.ts`'s `ConsoleTemplatePublisher`
//! for the daemon half: signing goes through the session's `ConsoleSigner`
//! and paying goes through `relay-write.ts`, the console's only writer —
//! never a key this crate could see.
//!
//! Two inner stages:
//! 1. **Form** — a path ([`widgets::input::TextField`], paste supported;
//!    prefilled with the repo's own `images/ssh-box/template.json` when it
//!    can be found relative to the working directory, else empty) and an
//!    image reference (prefilled with the ssh-box digest this ticket
//!    names). `Enter` on "Preview" reads the file — this crate's own job,
//!    never the daemon's, and nothing here is a secret — and sends
//!    `POST /api/templates/publish/preview`, which spends nothing.
//! 2. **Preview** — the Template's title/summary, the image digest, both
//!    event kinds and addresses, and the price per write plus the total, or
//!    why nothing here is payable right now. `Enter` on "Publish" opens
//!    [`widgets::confirm`] naming the total price; `Backspace` returns to
//!    the form to try again.
//!
//! `Esc` at either stage closes the whole thing and returns to the Gallery
//! underneath it, exactly like every other modal in this crate
//! (`widgets::confirm`, `widgets::copy_picker`). `main.rs` owns the file
//! read and the two network calls; this module holds only state and
//! key-handling, tested without a terminal the same way every other view
//! here is.

use std::path::PathBuf;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::types::{TemplatePublishPreview, TemplatePublishRequestBody};
use crate::widgets::confirm::{Confirm, ConfirmOutcome};
use crate::widgets::input::TextField;

/// The image this ticket names: `ghcr.io/toon-protocol/ssh-box`, already
/// public on GHCR, pinned by digest.
pub const SSH_BOX_IMAGE: &str = "ghcr.io/toon-protocol/ssh-box@sha256:\
f9f8eb3e68dd23d8bbac21ca253a02bcf20ebbcc44eb5d4b7ca0d7d972fc4e97";

const SSH_BOX_TEMPLATE_RELATIVE: &str = "images/ssh-box/template.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Form,
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormTarget {
    Path,
    Image,
    Preview,
}

const FORM_TARGETS: [FormTarget; 3] = [FormTarget::Path, FormTarget::Image, FormTarget::Preview];

/// What a confirmed "Publish" carries — the exact body the preview was
/// built from, sent again unchanged.
pub type PublishAction = TemplatePublishRequestBody;

/// What [`handle_key`] decided: a command for `main.rs` to run, or "close
/// this whole modal and go back to the Gallery." Boxed: `Command` is the
/// biggest type in this crate's whole keymap (it carries every request body,
/// `TemplateSpawnRequestBody` included), and `Close` otherwise makes this
/// enum many times the size of the `Command` it wraps.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Command(Box<Command>),
    Close,
}

fn cmd(command: Command) -> Outcome {
    Outcome::Command(Box::new(command))
}

pub struct TemplatePublishState {
    stage: Stage,
    path: TextField,
    image: TextField,
    cursor: usize,
    editing: bool,
    loading: bool,
    error: Option<String>,
    preview: Option<TemplatePublishPreview>,
    /// The exact body the current preview was built from — carried into
    /// `Confirm` and sent again, unchanged, once "Publish" is confirmed.
    request: Option<TemplatePublishRequestBody>,
    confirm: Option<Confirm<PublishAction>>,
    publishing: bool,
}

impl TemplatePublishState {
    pub fn new() -> Self {
        Self::new_with_finder(find_ssh_box_template)
    }

    /// Split out so a test can hand a fake "does this path exist" finder
    /// instead of touching the real filesystem.
    fn new_with_finder(finder: impl FnOnce() -> Option<String>) -> Self {
        let mut path = TextField::new("template.json path", false);
        if let Some(found) = finder() {
            path.set_value(found);
        }
        let mut image = TextField::new("Image (by digest)", false);
        image.set_value(SSH_BOX_IMAGE);
        Self {
            stage: Stage::Form,
            path,
            image,
            cursor: 0,
            editing: false,
            loading: false,
            error: None,
            preview: None,
            request: None,
            confirm: None,
            publishing: false,
        }
    }
}

impl Default for TemplatePublishState {
    fn default() -> Self {
        Self::new()
    }
}

/// A handful of relative candidates for the repo's own ssh-box Template,
/// tried from the working directory this binary was launched from — `cargo
/// run` inside `tui/` has the repo root one level up, and a launcher started
/// from the repo root has it right there. Best-effort only: an empty field
/// is always fine, this just saves retyping the common case.
fn find_ssh_box_template() -> Option<String> {
    [
        PathBuf::from(SSH_BOX_TEMPLATE_RELATIVE),
        PathBuf::from("..").join(SSH_BOX_TEMPLATE_RELATIVE),
        PathBuf::from("../..").join(SSH_BOX_TEMPLATE_RELATIVE),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
    .map(|found| found.to_string_lossy().into_owned())
}

fn field_mut(state: &mut TemplatePublishState, target: FormTarget) -> Option<&mut TextField> {
    match target {
        FormTarget::Path => Some(&mut state.path),
        FormTarget::Image => Some(&mut state.image),
        FormTarget::Preview => None,
    }
}

/// The one place a keypress becomes a decision for this modal — swallows
/// every key while it is open, the same "modal covers everything underneath
/// it" rule `widgets::confirm` and `widgets::copy_picker` follow.
pub fn handle_key(state: &mut TemplatePublishState, key: KeyEvent) -> Outcome {
    if let Some(confirm) = &mut state.confirm {
        return match confirm.handle_key(key) {
            ConfirmOutcome::Pending => cmd(Command::None),
            ConfirmOutcome::Cancelled => {
                state.confirm = None;
                cmd(Command::None)
            }
            ConfirmOutcome::Confirmed(action) => {
                state.confirm = None;
                state.publishing = true;
                state.error = None;
                cmd(Command::PublishTemplate(action))
            }
        };
    }

    match state.stage {
        Stage::Form => form_handle_key(state, key),
        Stage::Preview => preview_handle_key(state, key),
    }
}

fn form_handle_key(state: &mut TemplatePublishState, key: KeyEvent) -> Outcome {
    if state.editing {
        match key.code {
            KeyCode::Enter | KeyCode::Esc => state.editing = false,
            // TOON_Network#138: Ctrl+V reads the system clipboard instead of
            // typing a `v` — the same rule every other field-editing mode in
            // this crate follows.
            KeyCode::Char('v') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return cmd(Command::RequestClipboardPaste);
            }
            _ => {
                let target = FORM_TARGETS[state.cursor];
                if let Some(field) = field_mut(state, target) {
                    field.handle_key(key);
                }
            }
        }
        return cmd(Command::None);
    }

    match key.code {
        KeyCode::Esc => Outcome::Close,
        KeyCode::Up | KeyCode::Char('k') => {
            state.cursor = state.cursor.saturating_sub(1);
            cmd(Command::None)
        }
        KeyCode::Down | KeyCode::Char('j') => {
            state.cursor = (state.cursor + 1).min(FORM_TARGETS.len() - 1);
            cmd(Command::None)
        }
        KeyCode::Enter => form_activate(state, FORM_TARGETS[state.cursor]),
        _ => cmd(Command::None),
    }
}

fn form_activate(state: &mut TemplatePublishState, target: FormTarget) -> Outcome {
    match target {
        FormTarget::Path | FormTarget::Image => {
            state.editing = true;
            cmd(Command::None)
        }
        FormTarget::Preview => {
            if state.loading {
                return cmd(Command::None);
            }
            let path = state.path.value().trim().to_string();
            let image = state.image.value().trim().to_string();
            if path.is_empty() {
                state.error = Some("A template.json path is required.".to_string());
                return cmd(Command::None);
            }
            if image.is_empty() {
                state.error = Some("An image reference is required.".to_string());
                return cmd(Command::None);
            }
            state.loading = true;
            state.error = None;
            cmd(Command::PreviewTemplatePublish { path, image })
        }
    }
}

fn preview_handle_key(state: &mut TemplatePublishState, key: KeyEvent) -> Outcome {
    match key.code {
        KeyCode::Esc => Outcome::Close,
        KeyCode::Backspace => {
            state.stage = Stage::Form;
            state.preview = None;
            state.request = None;
            state.error = None;
            cmd(Command::None)
        }
        KeyCode::Enter => {
            if state.publishing {
                return cmd(Command::None);
            }
            let (Some(preview), Some(request)) = (&state.preview, &state.request) else {
                return cmd(Command::None);
            };
            if !preview.targets.ready {
                return cmd(Command::None);
            }
            let lines = confirm_lines(preview);
            state.confirm = Some(Confirm::new("Publish Template", lines, request.clone()));
            cmd(Command::None)
        }
        _ => cmd(Command::None),
    }
}

fn confirm_lines(preview: &TemplatePublishPreview) -> Vec<String> {
    vec![
        format!("{} \u{2014} {}", preview.title, preview.summary),
        "This publishes two paid relay writes, signed by the signed-in account and paid \
         from its own channel. It cannot be undone."
            .to_string(),
        total_line(preview),
    ]
}

fn total_line(preview: &TemplatePublishPreview) -> String {
    match per_write_price(preview) {
        Some(price) => format!("{} base units total for both writes.", doubled(price)),
        None => "An unknown amount, in total.".to_string(),
    }
}

fn per_write_price(preview: &TemplatePublishPreview) -> Option<&str> {
    preview
        .targets
        .total_price
        .as_deref()
        .or(preview.targets.price.as_deref())
}

/// Two writes (the Image Registry entry, then the Template) at the same
/// per-write price — never recomputed from anything but the daemon's own
/// quote, the same doubling `main-template-publish.ts`'s `printQuote` does.
fn doubled(price: &str) -> String {
    price
        .parse::<i128>()
        .map(|value| (value * 2).to_string())
        .unwrap_or_else(|_| format!("2\u{d7}{price}"))
}

/// Routes a paste to whichever field is currently being edited
/// (TOON_Network#138) — a no-op on the Preview stage, while a confirm is
/// open, or while nothing is being edited, the same "ignored" rule every
/// other paste target in this crate follows.
pub fn handle_paste(state: &mut TemplatePublishState, text: &str) {
    if state.confirm.is_some() || state.stage != Stage::Form || !state.editing {
        return;
    }
    let target = FORM_TARGETS[state.cursor];
    if let Some(field) = field_mut(state, target) {
        field.insert_str(text);
    }
}

/// `main.rs` calls this once `POST /api/templates/publish/preview` answers
/// (or once reading the local file itself failed, which never reaches the
/// daemon at all).
pub fn apply_preview(
    state: &mut TemplatePublishState,
    result: Result<(TemplatePublishRequestBody, TemplatePublishPreview), String>,
) {
    state.loading = false;
    match result {
        Ok((request, preview)) => {
            state.request = Some(request);
            state.preview = Some(preview);
            state.error = None;
            state.stage = Stage::Preview;
        }
        Err(message) => state.error = Some(message),
    }
}

/// `main.rs` calls this once `POST /api/templates/publish` answers.
/// `Some(address)` means the whole modal is done — the caller closes it,
/// refreshes the gallery, and selects the Template at that address; `None`
/// leaves the Preview stage showing the error so a person can try again
/// without re-reading the file.
pub fn apply_publish(
    state: &mut TemplatePublishState,
    result: Result<String, String>,
) -> Option<String> {
    state.publishing = false;
    match result {
        Ok(template_address) => Some(template_address),
        Err(message) => {
            state.error = Some(message);
            None
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

pub fn draw(frame: &mut Frame, area: Rect, state: &TemplatePublishState) {
    let width = 76u16.min(area.width.saturating_sub(4)).max(30);
    let height = 18u16.min(area.height.saturating_sub(2));
    let popup = centered(area, width, height);
    frame.render_widget(Clear, popup);

    let title = match state.stage {
        Stage::Form => " Publish a Template ",
        Stage::Preview => " Publish a Template \u{2014} preview ",
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    match state.stage {
        Stage::Form => draw_form(frame, inner, state),
        Stage::Preview => draw_preview(frame, inner, state),
    }

    if let Some(confirm) = &state.confirm {
        crate::widgets::confirm::draw(frame, area, confirm);
    }
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

fn draw_form(frame: &mut Frame, area: Rect, state: &TemplatePublishState) {
    let path_focused = state.cursor == 0 && state.editing;
    let image_focused = state.cursor == 1 && state.editing;
    let preview_focused = state.cursor == 2;

    let mut lines: Vec<Line> = vec![
        state.path.line(path_focused),
        state.image.line(image_focused),
        Line::raw(""),
        button_line(
            if state.loading {
                "Previewing\u{2026}"
            } else {
                "Preview"
            },
            preview_focused,
        ),
    ];
    if let Some(err) = &state.error {
        lines.push(error_line(err));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn draw_preview(frame: &mut Frame, area: Rect, state: &TemplatePublishState) {
    let Some(preview) = &state.preview else {
        frame.render_widget(Paragraph::new("Nothing to show."), area);
        return;
    };

    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            preview.title.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::raw(preview.summary.clone()),
        Line::raw(""),
        Line::raw(format!("Image digest: {}", preview.image_digest)),
        Line::raw(""),
        Line::raw(format!(
            "kind {} \u{2014} Image Registry entry",
            preview.entry_kind
        )),
        Line::raw(format!("  {}", preview.entry_address)),
        Line::raw(format!("kind {} \u{2014} Template", preview.template_kind)),
        Line::raw(format!("  {}", preview.template_address)),
        Line::raw(""),
        price_line(preview),
        Line::raw(""),
        button_line(
            if state.publishing {
                "Publishing\u{2026}"
            } else {
                "Publish"
            },
            preview.targets.ready,
        ),
    ];
    if let Some(err) = &state.error {
        lines.push(error_line(err));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn price_line(preview: &TemplatePublishPreview) -> Line<'static> {
    if !preview.targets.ready {
        return Line::from(Span::styled(
            preview
                .targets
                .blocked_by
                .clone()
                .unwrap_or_else(|| "Not payable right now.".to_string()),
            Style::default().fg(Color::Red),
        ));
    }
    let per_write = per_write_price(preview).unwrap_or("an unknown amount of");
    Line::raw(format!(
        "{per_write} base units per write \u{2014} {} total for both writes.",
        doubled(per_write)
    ))
}

fn button_line(label: &str, focused: bool) -> Line<'static> {
    let style = if focused {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().add_modifier(Modifier::BOLD)
    };
    Line::from(Span::styled(format!(" {label} "), style))
}

fn error_line(message: &str) -> Line<'static> {
    Line::from(Span::styled(
        format!("  {message}"),
        Style::default().fg(Color::Red),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RelayWriteTarget, RelayWriteTargets};
    use crossterm::event::KeyModifiers;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn state_with_no_prefill() -> TemplatePublishState {
        TemplatePublishState::new_with_finder(|| None)
    }

    fn sample_preview(ready: bool) -> TemplatePublishPreview {
        let targets = if ready {
            RelayWriteTargets {
                relays: vec!["wss://relay.test".to_string()],
                plan: vec![RelayWriteTarget {
                    url: "wss://relay.test".to_string(),
                    ready: true,
                    destination: Some("g.toon.relay".to_string()),
                    pay_at: Some("https://connector.test/ilp".to_string()),
                    price: Some("1".to_string()),
                    chain: Some("evm:31337".to_string()),
                    channel_id: Some("0xchannel".to_string()),
                    code: None,
                    reason: None,
                }],
                destination: Some("g.toon.relay".to_string()),
                pay_at: Some("https://connector.test/ilp".to_string()),
                price: Some("1".to_string()),
                total_price: Some("1".to_string()),
                ready: true,
                blocked_by: None,
            }
        } else {
            RelayWriteTargets {
                relays: Vec::new(),
                plan: Vec::new(),
                destination: None,
                pay_at: None,
                price: None,
                total_price: None,
                ready: false,
                blocked_by: Some("No channel to pay with.".to_string()),
            }
        };
        TemplatePublishPreview {
            entry_kind: 30434,
            entry_address: "30434:abc:ssh-box:latest".to_string(),
            entry_event: crate::types::UnsignedTemplateEvent {
                kind: 30434,
                created_at: 0,
                tags: Vec::new(),
                content: "{}".to_string(),
            },
            template_kind: 30436,
            template_address: "30436:abc:ssh-box".to_string(),
            template_event: crate::types::UnsignedTemplateEvent {
                kind: 30436,
                created_at: 0,
                tags: Vec::new(),
                content: "{}".to_string(),
            },
            image_digest: "sha256:aaaa".to_string(),
            title: "SSH box (Alpine)".to_string(),
            summary: "An SSH shell with your key and nothing else.".to_string(),
            targets,
        }
    }

    #[test]
    fn prefills_the_image_but_not_the_path_when_nothing_is_found() {
        let state = state_with_no_prefill();
        assert_eq!(state.path.value(), "");
        assert_eq!(state.image.value(), SSH_BOX_IMAGE);
    }

    #[test]
    fn a_finder_that_finds_something_prefills_the_path() {
        let state = TemplatePublishState::new_with_finder(|| {
            Some("images/ssh-box/template.json".to_string())
        });
        assert_eq!(state.path.value(), "images/ssh-box/template.json");
    }

    #[test]
    fn esc_on_the_form_closes_the_modal() {
        let mut state = state_with_no_prefill();
        assert_eq!(handle_key(&mut state, key(KeyCode::Esc)), Outcome::Close);
    }

    #[test]
    fn pressing_preview_with_an_empty_path_shows_an_error_and_sends_nothing() {
        let mut state = state_with_no_prefill();
        state.path.clear();
        state.cursor = 2;
        let outcome = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(outcome, cmd(Command::None));
        assert!(state.error.is_some());
    }

    #[test]
    fn preview_reads_the_typed_path_and_image() {
        let mut state = state_with_no_prefill();
        state.path.set_value("images/ssh-box/template.json");
        state.cursor = 2;
        let outcome = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(
            outcome,
            cmd(Command::PreviewTemplatePublish {
                path: "images/ssh-box/template.json".to_string(),
                image: SSH_BOX_IMAGE.to_string(),
            })
        );
        assert!(state.loading);
    }

    #[test]
    fn applying_a_successful_preview_moves_to_the_preview_stage() {
        let mut state = state_with_no_prefill();
        state.loading = true;
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request, sample_preview(true))));
        assert_eq!(state.stage, Stage::Preview);
        assert!(!state.loading);
        assert!(state.preview.is_some());
    }

    #[test]
    fn applying_a_failed_preview_stays_on_the_form_with_the_error_shown() {
        let mut state = state_with_no_prefill();
        state.loading = true;
        apply_preview(&mut state, Err("404: not found".to_string()));
        assert_eq!(state.stage, Stage::Form);
        assert!(!state.loading);
        assert_eq!(state.error.as_deref(), Some("404: not found"));
    }

    #[test]
    fn enter_on_a_ready_preview_opens_the_confirm_dialog() {
        let mut state = state_with_no_prefill();
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request, sample_preview(true))));
        let outcome = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(outcome, cmd(Command::None));
        assert!(state.confirm.is_some());
    }

    #[test]
    fn enter_on_a_blocked_preview_does_not_open_a_confirm() {
        let mut state = state_with_no_prefill();
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request, sample_preview(false))));
        handle_key(&mut state, key(KeyCode::Enter));
        assert!(state.confirm.is_none());
    }

    #[test]
    fn typing_yes_then_enter_confirms_and_publishes_the_same_request() {
        let mut state = state_with_no_prefill();
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({"name": "ssh-box"}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request.clone(), sample_preview(true))));
        handle_key(&mut state, key(KeyCode::Enter));
        for c in "yes".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        let outcome = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(outcome, cmd(Command::PublishTemplate(request)));
        assert!(state.publishing);
    }

    #[test]
    fn backspace_on_the_preview_returns_to_the_form_and_clears_it() {
        let mut state = state_with_no_prefill();
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request, sample_preview(true))));
        handle_key(&mut state, key(KeyCode::Backspace));
        assert_eq!(state.stage, Stage::Form);
        assert!(state.preview.is_none());
    }

    #[test]
    fn apply_publish_success_hands_back_the_template_address() {
        let mut state = state_with_no_prefill();
        state.publishing = true;
        let address = apply_publish(&mut state, Ok("30436:abc:ssh-box".to_string()));
        assert_eq!(address.as_deref(), Some("30436:abc:ssh-box"));
        assert!(!state.publishing);
    }

    #[test]
    fn apply_publish_failure_keeps_the_modal_open_with_the_error() {
        let mut state = state_with_no_prefill();
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request, sample_preview(true))));
        state.publishing = true;
        let address = apply_publish(&mut state, Err("no channel".to_string()));
        assert_eq!(address, None);
        assert_eq!(state.error.as_deref(), Some("no channel"));
        // Still on the Preview stage, so a person can retry without
        // re-reading the file.
        assert_eq!(state.stage, Stage::Preview);
    }

    #[test]
    fn paste_lands_in_the_focused_field_only_while_editing_the_form() {
        let mut state = state_with_no_prefill();
        state.cursor = 0;
        state.editing = true;
        handle_paste(&mut state, "images/other/template.json");
        assert_eq!(state.path.value(), "images/other/template.json");
    }

    #[test]
    fn paste_is_ignored_while_not_editing() {
        let mut state = state_with_no_prefill();
        state.path.clear();
        handle_paste(&mut state, "images/other/template.json");
        assert_eq!(state.path.value(), "");
    }

    fn render(state: &TemplatePublishState) -> String {
        let backend = TestBackend::new(90, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), state))
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
    fn snapshot_form() {
        let state = state_with_no_prefill();
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_preview() {
        let mut state = state_with_no_prefill();
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request, sample_preview(true))));
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_preview_blocked() {
        let mut state = state_with_no_prefill();
        let request = TemplatePublishRequestBody {
            template: serde_json::json!({}),
            image: SSH_BOX_IMAGE.to_string(),
        };
        apply_preview(&mut state, Ok((request, sample_preview(false))));
        insta::assert_snapshot!(render(&state));
    }
}
