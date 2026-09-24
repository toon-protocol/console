//! A single-line text field, masked or plain, that zeroizes its own buffer.
//!
//! `TextField` is the one place a secret a person types (an nsec, a NIP-06
//! mnemonic, a keystore passphrase) is held while it is being typed. It never
//! derives `Debug` or `Serialize` on purpose — printing or sending the whole
//! field, rather than going through [`TextField::take`], is exactly the
//! mistake this type exists to make hard. The buffer itself is a
//! `zeroize::Zeroizing<String>`, so replacing it (on [`TextField::clear`] or
//! [`TextField::take`]) or dropping it overwrites the bytes rather than just
//! releasing them — the same property `packages/daemon`'s keystore leans on
//! for the same reason (see `wipe` in `account-key.ts`).
//!
//! This module is deliberately the first thing #141 (Account) adds under
//! `src/widgets/`, ahead of #142 (Chain Seed import) and #146 (New workload
//! form), which the ticket names as reusing it: every field here is either a
//! plain value (a bunker URI, a template setting) or a secret (a passphrase,
//! an nsec, a mnemonic), and both are the same type with `masked` set
//! differently.
//!
//! `TextField` itself has no idea whether it is focused, and draws nothing by
//! itself — a view lays it out as a [`Line`] alongside whatever else is in
//! its card, via [`TextField::line`]. That keeps this widget usable inside
//! very differently-shaped forms (a two-column sign-in card here, a
//! long single-column spawn form in #146) without imposing a layout.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use zeroize::Zeroizing;

/// A single line of text a person is typing.
pub struct TextField {
    label: &'static str,
    value: Zeroizing<String>,
    /// A byte offset into `value`, always kept on a `char` boundary.
    cursor: usize,
    masked: bool,
}

impl TextField {
    pub fn new(label: &'static str, masked: bool) -> Self {
        Self {
            label,
            value: Zeroizing::new(String::new()),
            cursor: 0,
            masked,
        }
    }

    pub fn label(&self) -> &'static str {
        self.label
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn is_empty(&self) -> bool {
        self.value.trim().is_empty()
    }

    /// Empties the field. The old buffer is dropped here, which zeroizes it
    /// (`Zeroizing`'s whole job) — replacing it, not just truncating it in
    /// place, is what actually overwrites the bytes.
    pub fn clear(&mut self) {
        self.value = Zeroizing::new(String::new());
        self.cursor = 0;
    }

    /// Inserts pasted text at the cursor — the one seam both bracketed paste
    /// (`Event::Paste`) and Ctrl+V (`wl-paste`, run off the UI thread in
    /// `main.rs`) land through, for every field this crate lets a person
    /// paste into. `\r` and `\n` are stripped (a pasted multi-line blob
    /// becomes one line: a bunker URI, an nsec, a mnemonic or a passphrase is
    /// never actually more than one line, and a stray trailing newline from
    /// a terminal's paste buffer must not act like an `Enter` this field
    /// never saw), and the pasted text is trimmed of leading/trailing
    /// whitespace — the field's own EXISTING value is left exactly as
    /// typed, only what was just pasted is trimmed. A paste that is empty or
    /// all whitespace after that is a no-op.
    ///
    /// The filtered copy is held in a [`Zeroizing`] buffer for the whole of
    /// this call, so — like every other mutation of [`Self::value`] — an
    /// intermediate copy of a pasted secret does not outlive the insert.
    pub fn insert_str(&mut self, text: &str) {
        let filtered: Zeroizing<String> =
            Zeroizing::new(text.chars().filter(|c| *c != '\r' && *c != '\n').collect());
        let trimmed = filtered.trim();
        if trimmed.is_empty() {
            return;
        }
        self.value.insert_str(self.cursor, trimmed);
        self.cursor += trimmed.len();
    }

    /// Replaces the buffer with `value` outright, cursor at the end —
    /// prefilling a field from something already known (a profile's current
    /// endpoint, `views::network`'s own use) rather than typed key by key.
    /// The old buffer is dropped the same way `clear` drops it.
    pub fn set_value(&mut self, value: impl Into<String>) {
        self.value = Zeroizing::new(value.into());
        self.cursor = self.value.len();
    }

    /// Hands back the typed value as an owned `String` — the shape a request
    /// body needs — and clears this field's own buffer in the same call.
    ///
    /// Call this at the point a value is folded into the request about to be
    /// posted, not before: nothing between "the value existed only in this
    /// field" and "the value is on its way to the daemon" should be able to
    /// read it back out of this widget.
    pub fn take(&mut self) -> String {
        let out = self.value.to_string();
        self.clear();
        out
    }

    /// Feeds one key into the field's edit state. Returns `true` when the key
    /// was consumed as an edit (typing, deleting, moving the cursor) — the
    /// caller decides what an unconsumed key (Enter, Esc, a view-switch key)
    /// means, this type has no opinion on those.
    pub fn handle_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            // Ctrl+U empties the field, as in a shell's line editor: a paste
            // goes in at the cursor, so replacing a prefilled URL would
            // otherwise mean deleting it a character at a time first.
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.clear();
                true
            }
            KeyCode::Char(c)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.value.insert(self.cursor, c);
                self.cursor += c.len_utf8();
                true
            }
            KeyCode::Backspace => {
                if let Some(previous) = self.value[..self.cursor].chars().next_back() {
                    let start = self.cursor - previous.len_utf8();
                    self.value.replace_range(start..self.cursor, "");
                    self.cursor = start;
                }
                true
            }
            KeyCode::Delete => {
                if let Some(next) = self.value[self.cursor..].chars().next() {
                    let end = self.cursor + next.len_utf8();
                    self.value.replace_range(self.cursor..end, "");
                }
                true
            }
            KeyCode::Left => {
                if let Some(previous) = self.value[..self.cursor].chars().next_back() {
                    self.cursor -= previous.len_utf8();
                }
                true
            }
            KeyCode::Right => {
                if let Some(next) = self.value[self.cursor..].chars().next() {
                    self.cursor += next.len_utf8();
                }
                true
            }
            KeyCode::Home => {
                self.cursor = 0;
                true
            }
            KeyCode::End => {
                self.cursor = self.value.len();
                true
            }
            _ => false,
        }
    }

    /// Renders `label: value` as one styled [`Line`] — masked as a run of
    /// bullets when this field holds a secret, with a block cursor appended
    /// while it is focused so a person can tell where typing will land.
    pub fn line(&self, focused: bool) -> Line<'static> {
        let label_style = Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD);

        Line::from(vec![
            Span::styled(format!("{}: ", self.label), label_style),
            self.value_span(focused),
        ])
    }

    /// Just the value half of [`TextField::line`] — masked and cursor-marked
    /// the same way — for a caller building its own line that only has room
    /// to show the value, not `label: value` (a saved-signer row's inline
    /// passphrase prompt, say).
    pub fn value_span(&self, focused: bool) -> Span<'static> {
        let value_style = if focused {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };

        let shown = if self.masked {
            "•".repeat(self.value.chars().count())
        } else {
            self.value.to_string()
        };
        let shown = if focused {
            format!("{shown}▏")
        } else {
            shown
        };
        let shown = if shown.is_empty() && !focused {
            "…".to_string()
        } else {
            shown
        };

        Span::styled(shown, value_style)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ctrl_u_empties_the_field() {
        let mut field = TextField::new("URL", false);
        field.set_value("https://old.example/ilp");
        assert!(field.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)));
        assert_eq!(field.value(), "");
        field.insert_str("https://new.example/ilp");
        assert_eq!(field.value(), "https://new.example/ilp");
    }

    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    #[test]
    fn typed_characters_append_at_the_cursor() {
        let mut field = TextField::new("x", false);
        field.handle_key(key(KeyCode::Char('a')));
        field.handle_key(key(KeyCode::Char('b')));
        field.handle_key(key(KeyCode::Char('c')));
        assert_eq!(field.value(), "abc");
    }

    #[test]
    fn left_then_a_char_inserts_in_the_middle() {
        let mut field = TextField::new("x", false);
        for c in "ac".chars() {
            field.handle_key(key(KeyCode::Char(c)));
        }
        field.handle_key(key(KeyCode::Left));
        field.handle_key(key(KeyCode::Char('b')));
        assert_eq!(field.value(), "abc");
    }

    #[test]
    fn backspace_removes_the_character_before_the_cursor() {
        let mut field = TextField::new("x", false);
        for c in "abc".chars() {
            field.handle_key(key(KeyCode::Char(c)));
        }
        field.handle_key(key(KeyCode::Backspace));
        assert_eq!(field.value(), "ab");
    }

    #[test]
    fn delete_removes_the_character_at_the_cursor() {
        let mut field = TextField::new("x", false);
        for c in "abc".chars() {
            field.handle_key(key(KeyCode::Char(c)));
        }
        field.handle_key(key(KeyCode::Home));
        field.handle_key(key(KeyCode::Delete));
        assert_eq!(field.value(), "bc");
    }

    #[test]
    fn backspace_and_delete_step_over_multibyte_characters_whole() {
        let mut field = TextField::new("x", false);
        for c in "a→b".chars() {
            field.handle_key(key(KeyCode::Char(c)));
        }
        field.handle_key(key(KeyCode::Backspace)); // removes "b"
        field.handle_key(key(KeyCode::Backspace)); // removes "→" whole, not a byte of it
        assert_eq!(field.value(), "a");
    }

    #[test]
    fn take_returns_the_value_and_clears_the_field() {
        let mut field = TextField::new("nsec", true);
        for c in "nsec1abc".chars() {
            field.handle_key(key(KeyCode::Char(c)));
        }
        let taken = field.take();
        assert_eq!(taken, "nsec1abc");
        assert_eq!(field.value(), "");
        assert!(field.is_empty());
    }

    #[test]
    fn a_masked_field_never_shows_its_value_in_the_rendered_line() {
        let mut field = TextField::new("passphrase", true);
        for c in "hunter2".chars() {
            field.handle_key(key(KeyCode::Char(c)));
        }
        let line = field.line(false);
        let rendered: String = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        assert!(!rendered.contains("hunter2"));
        assert!(rendered.contains("•••••••"));
    }

    #[test]
    fn a_control_modified_char_is_not_treated_as_typed_text() {
        let mut field = TextField::new("x", false);
        field.handle_key(ctrl(KeyCode::Char('c')));
        assert_eq!(field.value(), "");
    }

    #[test]
    fn an_unhandled_key_is_reported_as_not_consumed() {
        let mut field = TextField::new("x", false);
        assert!(!field.handle_key(key(KeyCode::Enter)));
        assert!(!field.handle_key(key(KeyCode::Esc)));
    }

    #[test]
    fn insert_str_appends_pasted_text_at_the_cursor() {
        let mut field = TextField::new("x", false);
        field.handle_key(key(KeyCode::Char('a')));
        field.handle_key(key(KeyCode::Char('d')));
        field.handle_key(key(KeyCode::Left));
        field.insert_str("bc");
        assert_eq!(field.value(), "abcd");
    }

    #[test]
    fn insert_str_strips_embedded_newlines_and_carriage_returns() {
        let mut field = TextField::new("x", false);
        field.insert_str("npub1abc\r\ndef\n");
        assert_eq!(field.value(), "npub1abcdef");
    }

    #[test]
    fn insert_str_trims_leading_and_trailing_whitespace_off_the_pasted_text_only() {
        let mut field = TextField::new("x", false);
        field.handle_key(key(KeyCode::Char(' ')));
        field.insert_str("  hello world  ");
        // The field's own pre-existing leading space is untouched — only the
        // freshly pasted text was trimmed.
        assert_eq!(field.value(), " hello world");
    }

    #[test]
    fn insert_str_on_an_all_whitespace_paste_is_a_no_op() {
        let mut field = TextField::new("x", false);
        field.insert_str("   \n\r  ");
        assert_eq!(field.value(), "");
    }

    #[test]
    fn insert_str_into_a_masked_field_still_never_shows_the_value() {
        let mut field = TextField::new("nsec", true);
        field.insert_str("nsec1verysecretvalue");
        let line = field.line(false);
        let rendered: String = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        assert!(!rendered.contains("nsec1verysecretvalue"));
    }
}
