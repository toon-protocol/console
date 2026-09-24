//! App state and the keymap.
//!
//! This is the seam later view tickets build on: `View` grows a variant per
//! shipped view (it already lists all seven, per ADR 0028's sidebar — an
//! unbuilt one just renders `views::placeholder`), and `handle_key` is the one
//! place a keypress becomes a decision. Nothing here talks to the network;
//! `main.rs` owns fetching and hands this module the results.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::types::Health;
use crate::views::workloads::{self, WorkloadsViewState};

/// The seven views of the sidebar (ADR 0028), in the order `1`-`7` select
/// them. `Health` is sixth, matching the spec's own numbering and the web
/// UI's tab order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Workloads,
    New,
    Directory,
    Funds,
    Account,
    Health,
    Docs,
}

impl View {
    pub const ALL: [View; 7] = [
        View::Workloads,
        View::New,
        View::Directory,
        View::Funds,
        View::Account,
        View::Health,
        View::Docs,
    ];

    pub fn title(self) -> &'static str {
        match self {
            View::Workloads => "Workloads",
            View::New => "New",
            View::Directory => "Directory",
            View::Funds => "Funds",
            View::Account => "Account",
            View::Health => "Health",
            View::Docs => "Docs",
        }
    }

    /// The digit key that jumps straight to this view (`1`-`7`).
    pub fn key(self) -> char {
        match self {
            View::Workloads => '1',
            View::New => '2',
            View::Directory => '3',
            View::Funds => '4',
            View::Account => '5',
            View::Health => '6',
            View::Docs => '7',
        }
    }

    fn index(self) -> usize {
        View::ALL.iter().position(|v| *v == self).unwrap()
    }

    fn from_index(index: usize) -> View {
        View::ALL[index.rem_euclid(View::ALL.len())]
    }

    pub fn next(self) -> View {
        View::from_index(self.index() + 1)
    }

    pub fn previous(self) -> View {
        View::from_index(self.index() + View::ALL.len() - 1)
    }
}

/// Whatever the daemon last said about the connection, for the header's
/// status dot.
#[derive(Debug, Clone, PartialEq)]
pub enum DaemonStatus {
    /// Still waiting on the first answer.
    Connecting,
    Connected,
    /// The daemon is not running. Carries the actionable message shown
    /// full-screen instead of a blank view.
    Down(String),
    /// The daemon answered, but with an error other than "not running" —
    /// shown inline rather than replacing the whole screen, since the daemon
    /// IS there.
    Error(String),
}

pub struct App {
    pub view: View,
    pub help_open: bool,
    pub should_quit: bool,
    pub daemon_status: DaemonStatus,
    pub health: Option<Health>,
    /// Set while a Health fetch is in flight, so the footer can say so
    /// instead of looking stuck.
    pub loading_health: bool,
    /// The Workloads view's own state (TOON_Network#143): its list, its
    /// selected card's detail, and any open confirmation. Kept as one field
    /// rather than flattened into `App`, the way `ui.rs` keeps a view's
    /// drawing to itself — `handle_key` only ever reaches into it through
    /// `views::workloads::handle_key`.
    pub workloads: WorkloadsViewState,
}

impl App {
    pub fn new() -> Self {
        Self {
            view: View::Health,
            help_open: false,
            should_quit: false,
            daemon_status: DaemonStatus::Connecting,
            health: None,
            loading_health: false,
            workloads: WorkloadsViewState::new(),
        }
    }
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

/// What a keypress asks the runtime to do, once `handle_key` has already
/// applied the parts of it that are pure state (switching views, opening
/// help). The runtime owns quitting, redrawing and network calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    None,
    Quit,
    RefreshHealth,
    RefreshWorkloads,
    ExtendWorkload {
        workload_id: String,
        max_price: Option<String>,
    },
    TerminateWorkload {
        workload_id: String,
    },
    CopyToClipboard(String),
}

/// The one place a keypress becomes a decision.
///
/// `?` toggles the help overlay and swallows every other key while it is
/// open, except the keys that close it again — a help screen a keypress
/// falls through is a help screen that also does whatever it was covering.
///
/// The Workloads view gets first refusal on every key (via
/// `views::workloads::handle_key`), the same way `help_open` does above —
/// its own filter box and confirmation modal need to swallow keys (a digit,
/// `Esc`, `q`) that would otherwise switch a view or quit, and only it knows
/// when it is in one of those states. A key it has no opinion about (`None`)
/// falls through to the ordinary keymap below, which is how `Tab`, `1`-`7`
/// and `?` keep working while the Workloads view is merely showing its list.
pub fn handle_key(app: &mut App, key: KeyEvent) -> Command {
    if app.help_open {
        match key.code {
            KeyCode::Char('?') | KeyCode::Esc | KeyCode::Char('q') => app.help_open = false,
            _ => {}
        }
        return Command::None;
    }

    if app.view == View::Workloads {
        if let Some(command) = workloads::handle_key(&mut app.workloads, key) {
            return command;
        }
    }

    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.should_quit = true;
            Command::Quit
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.should_quit = true;
            Command::Quit
        }
        KeyCode::Char('?') => {
            app.help_open = true;
            Command::None
        }
        KeyCode::Tab => {
            app.view = app.view.next();
            Command::None
        }
        KeyCode::BackTab => {
            app.view = app.view.previous();
            Command::None
        }
        KeyCode::Char('l') | KeyCode::Right => {
            app.view = app.view.next();
            Command::None
        }
        KeyCode::Char('h') | KeyCode::Left => {
            app.view = app.view.previous();
            Command::None
        }
        KeyCode::Char(digit @ '1'..='7') => {
            if let Some(view) = View::ALL.iter().find(|v| v.key() == digit) {
                app.view = *view;
            }
            Command::None
        }
        KeyCode::Char('r') | KeyCode::Char('R') if app.view == View::Health => {
            Command::RefreshHealth
        }
        KeyCode::Char('r') | KeyCode::Char('R') if app.view == View::Workloads => {
            Command::RefreshWorkloads
        }
        _ => Command::None,
    }
}

/// Mouse clicks select tabs (ADR 0028: "mouse clicks select tabs and rows").
/// `sidebar_hits` is the on-screen row for each view, built by the layout
/// code that drew the sidebar this frame — the App has no idea where things
/// are on screen, and it should not have to.
pub fn handle_mouse(app: &mut App, mouse: MouseEvent, sidebar_hits: &[(u16, View)]) -> Command {
    if app.help_open {
        return Command::None;
    }
    if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
        for (row, view) in sidebar_hits {
            if *row == mouse.row {
                app.view = *view;
                return Command::None;
            }
        }
    }
    Command::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn digit_keys_1_to_7_select_the_matching_view_in_sidebar_order() {
        let mut app = App::new();
        let expect = [
            ('1', View::Workloads),
            ('2', View::New),
            ('3', View::Directory),
            ('4', View::Funds),
            ('5', View::Account),
            ('6', View::Health),
            ('7', View::Docs),
        ];
        for (digit, view) in expect {
            handle_key(&mut app, key(KeyCode::Char(digit)));
            assert_eq!(app.view, view, "digit {digit}");
        }
    }

    #[test]
    fn tab_cycles_forward_and_wraps() {
        let mut app = App::new();
        app.view = View::Docs; // last
        handle_key(&mut app, key(KeyCode::Tab));
        assert_eq!(app.view, View::Workloads, "wraps back to the first view");
    }

    #[test]
    fn shift_tab_cycles_backward_and_wraps() {
        let mut app = App::new();
        app.view = View::Workloads; // first
        handle_key(&mut app, key(KeyCode::BackTab));
        assert_eq!(app.view, View::Docs, "wraps back to the last view");
    }

    #[test]
    fn h_and_l_move_left_and_right_through_the_sidebar() {
        let mut app = App::new();
        app.view = View::Funds;
        handle_key(&mut app, key(KeyCode::Char('l')));
        assert_eq!(app.view, View::Account);
        handle_key(&mut app, key(KeyCode::Char('h')));
        assert_eq!(app.view, View::Funds);
        handle_key(&mut app, key(KeyCode::Char('h')));
        assert_eq!(app.view, View::Directory);
    }

    #[test]
    fn question_mark_opens_help_and_swallows_other_keys_until_closed() {
        let mut app = App::new();
        app.view = View::Health;
        handle_key(&mut app, key(KeyCode::Char('?')));
        assert!(app.help_open);

        // Every key other than the closers is swallowed: the view underneath
        // must not change while help is open.
        handle_key(&mut app, key(KeyCode::Char('1')));
        assert_eq!(app.view, View::Health, "help swallowed the digit key");
        assert!(app.help_open);

        handle_key(&mut app, key(KeyCode::Char('?')));
        assert!(!app.help_open);
    }

    #[test]
    fn q_quits_and_esc_quits_outside_help() {
        let mut app = App::new();
        assert_eq!(handle_key(&mut app, key(KeyCode::Char('q'))), Command::Quit);
        assert!(app.should_quit);

        let mut app2 = App::new();
        assert_eq!(handle_key(&mut app2, key(KeyCode::Esc)), Command::Quit);
    }

    #[test]
    fn esc_closes_help_instead_of_quitting_when_help_is_open() {
        let mut app = App::new();
        app.help_open = true;
        handle_key(&mut app, key(KeyCode::Esc));
        assert!(!app.help_open);
        assert!(!app.should_quit);
    }

    #[test]
    fn r_refreshes_health_only_on_the_health_view() {
        let mut app = App::new();
        app.view = View::Health;
        assert_eq!(
            handle_key(&mut app, key(KeyCode::Char('r'))),
            Command::RefreshHealth
        );

        app.view = View::Docs;
        assert_eq!(handle_key(&mut app, key(KeyCode::Char('r'))), Command::None);
    }

    #[test]
    fn mouse_click_on_a_sidebar_row_selects_that_view() {
        let mut app = App::new();
        app.view = View::Health;
        let hits = [(1, View::Workloads), (2, View::New), (3, View::Directory)];
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 2,
            row: 2,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse(&mut app, click, &hits);
        assert_eq!(app.view, View::New);
    }

    #[test]
    fn mouse_click_does_nothing_while_help_is_open() {
        let mut app = App::new();
        app.help_open = true;
        app.view = View::Health;
        let hits = [(1, View::Workloads)];
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 2,
            row: 1,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse(&mut app, click, &hits);
        assert_eq!(
            app.view,
            View::Health,
            "click ignored while help covers the screen"
        );
    }

    #[test]
    fn ctrl_c_quits_like_q() {
        let mut app = App::new();
        let ev = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(handle_key(&mut app, ev), Command::Quit);
    }
}
