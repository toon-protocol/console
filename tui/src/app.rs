//! App state and the keymap.
//!
//! This is the seam later view tickets build on: `View` grows a variant per
//! shipped view (it already lists all seven, per ADR 0028's sidebar — an
//! unbuilt one just renders `views::placeholder`), and `handle_key` is the one
//! place a keypress becomes a decision. Nothing here talks to the network;
//! `main.rs` owns fetching and hands this module the results.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::types::{DocsIndex, DocsPage, Health, LocalSignerRequest, Profiles, SessionStatus};
use crate::views::account::{self, AccountViewState};
use crate::views::directory::{self, DirectoryCommand, DirectoryViewState};

/// How many lines `PageUp`/`PageDown` scroll the Docs article — arbitrary,
/// but big enough that a page key visibly moves a full screen's worth on a
/// typical terminal height.
const DOCS_PAGE_SCROLL: u16 = 10;

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
    /// Who is signed in (TOON_Network#141) — read once at connect, like
    /// `health`, so the header can show it on every view, not only while the
    /// Account view is open.
    pub account: Option<SessionStatus>,
    pub loading_account: bool,
    /// The last account action's failure, if any (a wrong passphrase, an
    /// invalid nsec) — shown by the Account view next to whichever form
    /// caused it, and cleared the moment a fresh `SessionStatus` arrives.
    pub account_error: Option<String>,
    /// Every configured network profile, active one included — the
    /// switcher's data. Also read once at connect.
    pub profiles: Option<Profiles>,
    /// The id being switched to while a profile switch is in flight, so the
    /// switcher can show which one and disable the rest.
    pub switching_profile: Option<String>,
    /// The Account view's own form state (focus, typed fields). Kept out of
    /// this struct's own fields, the way a view with no forms (Health) needs
    /// none of its own — a later view ticket with a form follows this same
    /// shape rather than growing `App` per field.
    pub account_view: AccountViewState,
    /// The Directory view's own state (TOON_Network#145): filters, the last
    /// read's relay summary and its `ListingPicker`. See
    /// `views::directory` — this crate's shell only feeds it and draws it.
    pub directory: DirectoryViewState,
    /// Set while a Directory fetch is in flight.
    pub loading_directory: bool,
    /// A wall-clock reading, refreshed once a second regardless of which
    /// view is showing, used only to age a Liveness countdown on screen
    /// (`views::directory::liveness_now`) — every other view reads the
    /// daemon's own timestamps instead.
    pub now_ms: i64,
    /// The Docs reading list (TOON_Network#148): `GET /api/docs`.
    pub docs_index: Option<DocsIndex>,
    /// The article open, if any: `GET /api/docs/<d>`. `Some` is what puts the
    /// view into "reading an article" mode rather than "picking one".
    pub docs_page: Option<DocsPage>,
    pub loading_docs: bool,
    /// `GET /api/docs` failed. Shown in the reading list.
    pub docs_error: Option<String>,
    /// Reused for two failures that never happen at once, since only one is
    /// ever showable at a time: `GET /api/docs/<d>` failed (shown in the
    /// reading list, mirroring `use-docs.ts`'s `openError`), or `xdg-open`
    /// failed on a focused link (shown over the open article instead).
    pub docs_open_error: Option<String>,
    /// Which row of the reading list `j`/`k` has selected.
    pub docs_selected: usize,
    /// How far `j`/`k`/`PageUp`/`PageDown` have scrolled the open article.
    pub docs_scroll: u16,
    /// The open article's links, in reading order — just the hrefs, so `o`
    /// can open one without re-parsing the Markdown on every keypress. Set
    /// alongside `docs_page` and cleared when it closes.
    pub docs_link_hrefs: Vec<String>,
    /// Which of `docs_link_hrefs` `n`/`N` has focused; `o` opens this one.
    pub docs_link_index: usize,
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
            account: None,
            loading_account: false,
            account_error: None,
            profiles: None,
            switching_profile: None,
            account_view: AccountViewState::new(),
            directory: DirectoryViewState::new(),
            loading_directory: false,
            now_ms: now_ms(),
            docs_index: None,
            docs_page: None,
            loading_docs: false,
            docs_error: None,
            docs_open_error: None,
            docs_selected: 0,
            docs_scroll: 0,
            docs_link_hrefs: Vec::new(),
            docs_link_index: 0,
        }
    }
}

/// The wall clock, in Unix milliseconds — `App::now_ms`'s only source.
/// `main.rs`'s per-second tick calls this too, so there is exactly one place
/// this crate reaches for `SystemTime::now()`.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

/// What a keypress asks the runtime to do, once `handle_key` has already
/// applied the parts of it that are pure state (switching views, opening
/// help). The runtime owns quitting, redrawing and network calls.
///
/// Not `Copy`: `OpenDoc`/`OpenDocsLink`/`AddLocalSigner`/... carry owned data
/// (a `d`, an `href`, a `LocalSignerRequest`, ...), which a `Copy` type
/// cannot hold. Not `Eq` either: `LocalSignerRequest` (from `types.rs`,
/// mirroring the daemon's request body) derives only `PartialEq`.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    None,
    Quit,
    RefreshHealth,
    /// `views::directory::DirectoryCommand::Refresh`, translated: re-read
    /// `GET /api/directory` with `app.directory.filters`.
    RefreshDirectory,
    /// Re-read the Docs index, or the open article if one is open — the
    /// runtime decides which by checking `App::docs_page`.
    RefreshDocs,
    /// Fetch `GET /api/docs/<d>` for the article at this `d`.
    OpenDoc(String),
    /// Open this URL with `xdg-open`.
    OpenDocsLink(String),
    /// Re-read `GET /api/account`, e.g. `r` on the Account view.
    RefreshAccount,
    AddLocalSigner(LocalSignerRequest),
    AddBunkerSigner {
        uri: String,
        passphrase: Option<String>,
    },
    SignIn {
        id: String,
        passphrase: Option<String>,
    },
    SignOut,
    ForgetSigner(String),
    /// Switch the active network profile — every view with its own data
    /// re-fetches once this lands (ADR 0028's "the new profile's connector
    /// is a different machine with different terms").
    SwitchProfile(String),
}

/// The one place a keypress becomes a decision.
///
/// `?` toggles the help overlay and swallows every other key while it is
/// open, except the keys that close it again — a help screen a keypress
/// falls through is a help screen that also does whatever it was covering.
pub fn handle_key(app: &mut App, key: KeyEvent) -> Command {
    if app.help_open {
        match key.code {
            KeyCode::Char('?') | KeyCode::Esc | KeyCode::Char('q') => app.help_open = false,
            _ => {}
        }
        return Command::None;
    }

    // Mirrors the help overlay just above: while the Directory view's detail
    // popup covers the screen, only the keys that close it do anything, so
    // Esc closes the popup rather than quitting the app underneath it.
    if app.view == View::Directory && app.directory.detail_open {
        return match directory::handle_key(&mut app.directory, key) {
            DirectoryCommand::Refresh => Command::RefreshDirectory,
            DirectoryCommand::None => Command::None,
        };
    }

    // The Account view has its own forms: while it is on screen, it gets
    // first look at every key. It hands back `Some(command)` for a key it
    // acted on (typing into a field, moving the highlighted row, submitting
    // a form) and `None` for one it has no use for — a digit, `Tab`, `q` —
    // so those still fall through to the global bindings below exactly as
    // they do on every other view. The one exception is while a field is
    // being typed into: then it claims everything, so a `q` in a passphrase
    // does not quit the app.
    if app.view == View::Account {
        if let Some(command) = account::handle_key(
            &mut app.account_view,
            app.account.as_ref(),
            app.profiles.as_ref(),
            key,
        ) {
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
        KeyCode::Char('r') | KeyCode::Char('R') if app.view == View::Account => {
            Command::RefreshAccount
        }
        KeyCode::Char('r') | KeyCode::Char('R') if app.view == View::Docs => Command::RefreshDocs,
        // Reading list (no article open): `j`/`k` move the selection, `Enter`
        // opens it.
        KeyCode::Char('j') | KeyCode::Down if app.view == View::Docs && app.docs_page.is_none() => {
            if let Some(len) = app.docs_index.as_ref().map(|index| index.docs.len()) {
                if len > 0 {
                    app.docs_selected = (app.docs_selected + 1).min(len - 1);
                }
            }
            Command::None
        }
        KeyCode::Char('k') | KeyCode::Up if app.view == View::Docs && app.docs_page.is_none() => {
            app.docs_selected = app.docs_selected.saturating_sub(1);
            Command::None
        }
        KeyCode::Enter if app.view == View::Docs && app.docs_page.is_none() => {
            match app
                .docs_index
                .as_ref()
                .and_then(|index| index.docs.get(app.docs_selected))
            {
                Some(doc) => Command::OpenDoc(doc.d.clone()),
                None => Command::None,
            }
        }
        // An open article: `j`/`k`/`PageUp`/`PageDown` scroll it, `n`/`N`
        // cycle which link is focused, `o` opens the focused one, and
        // `Backspace` goes back to the reading list.
        KeyCode::Char('j') | KeyCode::Down if app.view == View::Docs && app.docs_page.is_some() => {
            app.docs_scroll = app.docs_scroll.saturating_add(1);
            Command::None
        }
        KeyCode::Char('k') | KeyCode::Up if app.view == View::Docs && app.docs_page.is_some() => {
            app.docs_scroll = app.docs_scroll.saturating_sub(1);
            Command::None
        }
        KeyCode::PageDown if app.view == View::Docs && app.docs_page.is_some() => {
            app.docs_scroll = app.docs_scroll.saturating_add(DOCS_PAGE_SCROLL);
            Command::None
        }
        KeyCode::PageUp if app.view == View::Docs && app.docs_page.is_some() => {
            app.docs_scroll = app.docs_scroll.saturating_sub(DOCS_PAGE_SCROLL);
            Command::None
        }
        KeyCode::Char('n') if app.view == View::Docs && app.docs_page.is_some() => {
            let len = app.docs_link_hrefs.len();
            if len > 0 {
                app.docs_link_index = (app.docs_link_index + 1) % len;
            }
            Command::None
        }
        KeyCode::Char('N') if app.view == View::Docs && app.docs_page.is_some() => {
            let len = app.docs_link_hrefs.len();
            if len > 0 {
                app.docs_link_index = (app.docs_link_index + len - 1) % len;
            }
            Command::None
        }
        KeyCode::Char('o') if app.view == View::Docs && app.docs_page.is_some() => {
            match app.docs_link_hrefs.get(app.docs_link_index) {
                Some(href) => Command::OpenDocsLink(href.clone()),
                None => Command::None,
            }
        }
        KeyCode::Backspace if app.view == View::Docs && app.docs_page.is_some() => {
            app.docs_page = None;
            app.docs_link_hrefs.clear();
            app.docs_link_index = 0;
            app.docs_scroll = 0;
            app.docs_open_error = None;
            Command::None
        }
        // Directory has no forms of its own — every key it does not want
        // itself (its filter toggles, `j`/`k`/`Enter` in the picker) falls
        // to this catch, placed last among the guarded arms so the global
        // keys above (quit, help, view switching, digits) still win even
        // while Directory is the current view.
        _ if app.view == View::Directory => match directory::handle_key(&mut app.directory, key) {
            DirectoryCommand::Refresh => Command::RefreshDirectory,
            DirectoryCommand::None => Command::None,
        },
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
    fn r_refreshes_health_on_the_health_view_and_docs_on_the_docs_view() {
        let mut app = App::new();
        app.view = View::Health;
        assert_eq!(
            handle_key(&mut app, key(KeyCode::Char('r'))),
            Command::RefreshHealth
        );

        app.view = View::Docs;
        assert_eq!(
            handle_key(&mut app, key(KeyCode::Char('r'))),
            Command::RefreshDocs
        );

        // Neither fires on a view with no refresh of its own (TOON_Network#148
        // added Docs' case; every other still-unbuilt view has none yet).
        app.view = View::Workloads;
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
