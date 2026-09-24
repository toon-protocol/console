//! A filterable, keyboard-navigable list's pure state machine
//! (TOON_Network#143, ADR 0028's `j`/`k`, `Enter`, `/` bindings).
//!
//! This holds only the STATE and the KEY-HANDLING RULE, not the rendering —
//! every view's rows carry their own colours and badges (a workload's liveness
//! is not a listing's isolation is not a provider's arch), so a shared row
//! renderer would end up branching on which view called it. What every list
//! genuinely shares is the behaviour: `j`/`k`/arrows move a selection that
//! never runs off either end, `/` starts typing a filter that narrows what is
//! selectable, and `Enter` opens whatever is currently selected. A view drives
//! this with the item count IT computed after applying [`ListState::matches`]
//! to its own rows, and reads `selected` back to know which one to draw as
//! highlighted and which one `Enter` means.

use crossterm::event::{KeyCode, KeyEvent};

/// What a keypress did to the list. `Ignored` means "this list has no
/// opinion about this key" — the view (or the app-level keymap) is free to
/// treat it as something else, e.g. a view-switching digit while the filter
/// is not being edited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListOutcome {
    Ignored,
    Handled,
    /// `Enter` on a real row: its index into the view's own (already
    /// filtered) item list.
    Open(usize),
}

#[derive(Debug, Clone, Default)]
pub struct ListState {
    pub selected: usize,
    pub filter: String,
    pub filtering: bool,
}

impl ListState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `haystack` matches the current filter — empty filter matches
    /// everything, and the comparison is case-insensitive so `/web` finds
    /// `web-3f2a` without a person reaching for Shift.
    pub fn matches(&self, haystack: &str) -> bool {
        self.filter.is_empty()
            || haystack
                .to_lowercase()
                .contains(&self.filter.to_lowercase())
    }

    /// Keeps `selected` inside `[0, visible_count)`, called after a view
    /// re-filters its rows (the count just shrank, or the list just loaded).
    /// A list of zero rows selects nothing meaningful, so `selected` is left
    /// at `0` rather than made to fit — the view checks the count before
    /// reading `selected` as a real row.
    pub fn clamp(&mut self, visible_count: usize) {
        if visible_count == 0 {
            self.selected = 0;
        } else if self.selected >= visible_count {
            self.selected = visible_count - 1;
        }
    }

    /// `visible_count` is the number of rows the view has on screen right
    /// now (after its own filtering), so movement and `Enter` stay inside
    /// bounds without the list knowing anything about the items themselves.
    pub fn handle_key(&mut self, key: KeyEvent, visible_count: usize) -> ListOutcome {
        if self.filtering {
            return match key.code {
                KeyCode::Esc => {
                    self.filtering = false;
                    self.filter.clear();
                    self.clamp(visible_count);
                    ListOutcome::Handled
                }
                KeyCode::Enter => {
                    self.filtering = false;
                    ListOutcome::Handled
                }
                KeyCode::Backspace => {
                    self.filter.pop();
                    self.clamp(visible_count);
                    ListOutcome::Handled
                }
                KeyCode::Char(c) => {
                    self.filter.push(c);
                    self.clamp(visible_count);
                    ListOutcome::Handled
                }
                _ => ListOutcome::Handled,
            };
        }

        match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                if visible_count > 0 {
                    self.selected = (self.selected + 1).min(visible_count - 1);
                }
                ListOutcome::Handled
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.selected = self.selected.saturating_sub(1);
                ListOutcome::Handled
            }
            KeyCode::Char('/') => {
                self.filtering = true;
                ListOutcome::Handled
            }
            KeyCode::Enter => {
                if visible_count == 0 {
                    ListOutcome::Handled
                } else {
                    ListOutcome::Open(self.selected)
                }
            }
            _ => ListOutcome::Ignored,
        }
    }

    /// The block title's suffix: `""` normally, or ` — filter: web` /
    /// ` — 2/5 match "web"` once a filter is in play. A view appends this to
    /// its own title rather than this module knowing the title's words.
    pub fn title_suffix(&self, matched: usize, total: usize) -> String {
        if self.filtering {
            format!(" — filter: {}\u{2588}", self.filter)
        } else if !self.filter.is_empty() {
            format!(" — {matched}/{total} match \"{}\"", self.filter)
        } else {
            String::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn j_and_k_move_selection_without_running_off_either_end() {
        let mut list = ListState::new();
        assert_eq!(
            list.handle_key(key(KeyCode::Char('k')), 3),
            ListOutcome::Handled
        );
        assert_eq!(list.selected, 0, "k at the top stays at the top");

        list.handle_key(key(KeyCode::Char('j')), 3);
        list.handle_key(key(KeyCode::Char('j')), 3);
        assert_eq!(list.selected, 2);

        list.handle_key(key(KeyCode::Char('j')), 3);
        assert_eq!(list.selected, 2, "j at the bottom stays at the bottom");
    }

    #[test]
    fn j_on_an_empty_list_does_not_panic_or_move() {
        let mut list = ListState::new();
        list.handle_key(key(KeyCode::Char('j')), 0);
        assert_eq!(list.selected, 0);
    }

    #[test]
    fn enter_opens_the_selected_row() {
        let mut list = ListState::new();
        list.selected = 1;
        assert_eq!(
            list.handle_key(key(KeyCode::Enter), 3),
            ListOutcome::Open(1)
        );
    }

    #[test]
    fn enter_on_an_empty_list_is_handled_not_opened() {
        let mut list = ListState::new();
        assert_eq!(
            list.handle_key(key(KeyCode::Enter), 0),
            ListOutcome::Handled
        );
    }

    #[test]
    fn slash_starts_filtering_and_swallows_every_key_until_esc_or_enter() {
        let mut list = ListState::new();
        list.handle_key(key(KeyCode::Char('/')), 5);
        assert!(list.filtering);

        // Digits and letters that would otherwise switch a view or move the
        // selection go into the filter text instead.
        list.handle_key(key(KeyCode::Char('w')), 5);
        list.handle_key(key(KeyCode::Char('3')), 5);
        assert_eq!(list.filter, "w3");
        assert!(list.filtering);

        list.handle_key(key(KeyCode::Enter), 5);
        assert!(
            !list.filtering,
            "Enter applies the filter and stops editing it"
        );
        assert_eq!(list.filter, "w3", "Enter keeps the typed filter");
    }

    #[test]
    fn esc_while_filtering_clears_the_filter_instead_of_quitting() {
        let mut list = ListState::new();
        list.handle_key(key(KeyCode::Char('/')), 5);
        list.handle_key(key(KeyCode::Char('x')), 5);
        list.handle_key(key(KeyCode::Esc), 5);
        assert!(!list.filtering);
        assert_eq!(list.filter, "");
    }

    #[test]
    fn matches_is_case_insensitive_and_empty_filter_matches_everything() {
        let mut list = ListState::new();
        assert!(list.matches("anything"));
        list.filter = "WEB".to_string();
        assert!(list.matches("web-3f2a"));
        assert!(!list.matches("db-77e1"));
    }

    #[test]
    fn clamp_keeps_selection_inside_a_shrunk_list_and_zeroes_an_empty_one() {
        let mut list = ListState::new();
        list.selected = 4;
        list.clamp(2);
        assert_eq!(list.selected, 1);
        list.clamp(0);
        assert_eq!(list.selected, 0);
    }

    #[test]
    fn an_unrecognised_key_is_ignored_so_the_app_can_still_switch_views() {
        let mut list = ListState::new();
        assert_eq!(
            list.handle_key(key(KeyCode::Char('1')), 3),
            ListOutcome::Ignored
        );
        assert_eq!(list.handle_key(key(KeyCode::Tab), 3), ListOutcome::Ignored);
    }
}
