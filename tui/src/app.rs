//! App state and the keymap.
//!
//! This is the seam later view tickets build on: `View` grows a variant per
//! shipped view (it already lists all seven, per ADR 0028's sidebar — an
//! unbuilt one just renders `views::placeholder`), and `handle_key` is the one
//! place a keypress becomes a decision. Nothing here talks to the network;
//! `main.rs` owns fetching and hands this module the results.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::types::{
    ChainSeedStatus, ExpandTemplateRequest, Health, LocalSignerRequest, ProfileEndpointsRequest,
    Profiles, SessionStatus, SpawnRequestBody, StandbySetRequestBody, TemplateSpawnRequestBody,
};
use crate::views::account::{self, AccountViewState};
use crate::views::directory::{self, DirectoryViewState};
use crate::views::docs;
use crate::views::funds::{self, FundsState};
use crate::views::health;
use crate::views::new_workload::{self, NewWorkloadViewState};
use crate::views::workloads::{self, WorkloadsViewState};
use crate::widgets::copy_picker::{CopyPicker, CopyPickerOutcome};

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
    /// The signed-in account's Chain Seed (TOON_Network#142) — read once the
    /// account is known signed in, the way `health` and `account` are read
    /// once at connect, and again on `r` or a network-profile switch (a
    /// different profile is a different connector, and `writes` is quoted by
    /// the profile's connector).
    pub chain_seed: Option<ChainSeedStatus>,
    pub loading_chain_seed: bool,
    /// The pubkey `chain_seed` was last read for, so a newly signed-in
    /// account (or a different one) triggers a fresh read rather than
    /// showing the previous account's Chain Seed for one frame.
    pub chain_seed_for_pubkey: Option<String>,
    /// The pubkey whose first relay read of its Chain Seed has been asked
    /// for — see `views::chain_seed::first_read_needed`.
    pub chain_seed_read_for: Option<String>,
    /// The last Chain Seed action's failure, if any — shown next to the
    /// section the same way `account_error` is, and cleared the moment a
    /// fresh `ChainSeedStatus` arrives.
    pub chain_seed_error: Option<String>,
    /// The Account view's own form state (focus, typed fields — including
    /// the Chain Seed section's, see `views::chain_seed`). Kept out of this
    /// struct's own fields, the way a view with no forms (Health) needs none
    /// of its own — a later view ticket with a form follows this same shape
    /// rather than growing `App` per field.
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
    /// The Docs view's own state (TOON_Network#148): the reading list, an
    /// open article, and where the cursor/scroll/focused-link is. Kept as
    /// one field the same way every other view's state is — `handle_key`
    /// only ever reaches into it through `views::docs::handle_key`.
    pub docs: docs::DocsViewState,
    /// The Funds view's own state (TOON_Network#147) — deposits, channel
    /// balances, the gas station and its confirmations. Kept as one field
    /// rather than spread across `App` so `views::funds` owns its shape.
    pub funds: FundsState,
    /// The Workloads view's own state (TOON_Network#143): its list, its
    /// selected card's detail, and any open confirmation. Kept as one field
    /// rather than flattened into `App`, the way `ui.rs` keeps a view's
    /// drawing to itself — `handle_key` only ever reaches into it through
    /// `views::workloads::handle_key`.
    pub workloads: WorkloadsViewState,
    /// The New workload view's own state (TOON_Network#146): the wizard
    /// stage, the Template gallery, the form, the Listing and Standbys
    /// pickers, and any open preflight or spawn confirmation. Kept as one
    /// field the same way `workloads` is — `handle_key` only ever reaches
    /// into it through `views::new_workload::handle_key`.
    pub new_workload: NewWorkloadViewState,
    /// The one copy mechanism for the whole app (TOON_Network#138): open
    /// while `y` has more than one thing the current view could copy — see
    /// `widgets::copy_picker`. `handle_key` gives it first refusal on every
    /// key, the same "modal swallows everything underneath it" rule
    /// `help_open` follows.
    pub copy_picker: Option<CopyPicker>,
    /// The last copy or paste outcome, shown in the footer regardless of
    /// which view is current (`ui::draw_footer`) — set by `main.rs` once
    /// `Command::CopyToClipboard`/`Command::RequestClipboardPaste` answers.
    pub clipboard_status: Option<String>,
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
            chain_seed: None,
            loading_chain_seed: false,
            chain_seed_for_pubkey: None,
            chain_seed_read_for: None,
            chain_seed_error: None,
            account_view: AccountViewState::new(),
            directory: DirectoryViewState::new(),
            loading_directory: false,
            now_ms: now_ms(),
            docs: docs::DocsViewState::new(),
            funds: FundsState::default(),
            workloads: WorkloadsViewState::new(),
            new_workload: NewWorkloadViewState::new(),
            copy_picker: None,
            clipboard_status: None,
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
/// Not `Copy`: `OpenDoc`/`OpenDocsLink`/`AddLocalSigner`/the Funds and
/// Workloads variants/... carry owned data (a `d`, an `href`, a
/// `LocalSignerRequest`, a chain id, a workload id, ...), which a `Copy`
/// type cannot hold. Not `Eq` either: `LocalSignerRequest` (from
/// `types.rs`, mirroring the daemon's request body) derives only
/// `PartialEq`.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    None,
    Quit,
    RefreshHealth,
    /// `views::directory::handle_key`'s own `i`/`a`/`g`/`d`/`n`/`H`/`x`/`r`:
    /// re-read `GET /api/directory` with `app.directory.filters`.
    RefreshDirectory,
    /// Re-read the Docs index, or the open article if one is open — the
    /// runtime decides which by checking `App::docs`'s
    /// [`docs::DocsViewState::page`](crate::views::docs::DocsViewState::page).
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
    /// `PUT /api/profiles/<id>` (TOON_Network#150) — `views::network`'s own
    /// `Save`, for an override, an edit, or a brand-new id. When `id` is the
    /// active profile, everything that reads it re-fetches the same way a
    /// `SwitchProfile` does — see `main.rs`'s `RuntimeEvent::ProfileSaved`.
    SaveProfile {
        id: String,
        request: ProfileEndpointsRequest,
    },
    /// `DELETE /api/profiles/<id>` — `D` on a profile row, through
    /// `widgets::confirm`. Resets a built-in's override, or removes a
    /// profile added under a new id; the daemon refuses this while `id` is
    /// active.
    ResetProfile(String),
    /// `POST /api/chain-seed/acknowledge` (TOON_Network#142) — the custody
    /// warning, read once.
    AcknowledgeChainSeedWarning,
    /// `POST /api/chain-seed/mint`. Answers `not_yet_recoverable`: minting
    /// never publishes on its own (#120).
    MintChainSeed,
    /// `POST /api/chain-seed/import`, carrying the typed mnemonic for
    /// exactly as long as it takes to reach `main.rs`'s request — see
    /// `widgets::input::TextField::take`.
    ImportChainSeed(String),
    /// `POST /api/chain-seed/publish` — **spends money**: one paid relay
    /// write. Only reachable through `widgets::confirm::Confirm`'s own
    /// typed-`yes` dance (see `views::chain_seed`); nothing in this
    /// module's keymap can produce it from a single keypress.
    PublishChainSeed,
    /// `POST /api/chain-seed/refresh` — free; looks again without
    /// publishing anything.
    RefreshChainSeed,
    // -- Funds (TOON_Network#147) --
    FetchFunding {
        refresh: bool,
    },
    FetchGasStation,
    /// Issued only after a confirmation has been shown and accepted
    /// (`views::funds::handle_confirm_key`) — never straight from a
    /// keypress.
    OpenChannel {
        chain: String,
        deposit: Option<String>,
        connector: Option<String>,
    },
    /// `GET /api/funding?connector=<url>` (TOON_Network#138) — New
    /// workload's Preflight stage's `o`, "open a channel with this
    /// connector": reads a connector's own funding state before offering to
    /// open one there. Issued only when the current preflight's `payment`
    /// names a connector with no bound channel (`views::new_workload`'s
    /// `missing_channel_connector`) — never straight from an arbitrary
    /// keypress on an unrelated problem.
    FetchFundingForConnector(String),
    /// `POST /api/funding/channel` with a connector that is not necessarily
    /// the profile's own — issued only after New workload's own channel
    /// confirmation (`views::new_workload::handle_key`'s `channel_confirm`)
    /// has been shown and accepted. Kept separate from `OpenChannel` above:
    /// that one updates the Funds tab's own `app.funds.funding` (the
    /// profile's own connector); this one updates New workload's
    /// `connector_funding` instead, and can trigger a re-preflight once the
    /// channel turns `open`.
    OpenChannelForConnector {
        chain: String,
        deposit: Option<String>,
        connector: String,
    },
    Drip {
        chain: String,
    },
    QuoteGas {
        chain: String,
    },
    /// Issued only after a confirmation has been shown and accepted, same as
    /// `OpenChannel`.
    BuyGas {
        chain: String,
        quote_id: String,
    },
    RefreshWorkloads,
    ExtendWorkload {
        workload_id: String,
        max_price: Option<String>,
    },
    TerminateWorkload {
        workload_id: String,
    },
    /// `POST …/auto-extend` with `confirm: true` (TOON_Network#144).
    ArmAutoExtend {
        workload_id: String,
        budget: String,
        agreed_price: String,
    },
    /// `DELETE …/auto-extend`.
    DisarmAutoExtend {
        workload_id: String,
    },
    /// `POST …/rotate` (spec §6.8, ADR 0018).
    RotateWorkload {
        workload_id: String,
    },
    /// `POST …/gateway/handover`.
    HandOverWorkload {
        workload_id: String,
    },
    /// `POST …/gateway/withdraw`.
    WithdrawWorkload {
        workload_id: String,
    },
    /// `DELETE /api/workloads/<id>` (TOON_Network#138) — `D` on an ended
    /// workload, through `widgets::confirm`. Drops this account's Lease
    /// Vault entry for it; the daemon refuses this outright on anything
    /// still live.
    ForgetWorkload {
        workload_id: String,
    },
    /// `label` is what the footer says was copied (TOON_Network#138: "never
    /// the value when it is long"); `value` is what actually reaches
    /// `wl-copy`. Issued only by `app::handle_key`'s `y` binding, whether
    /// that copied straight away (one copyable) or via `widgets::copy_picker`
    /// (more than one) — every view's own `y` used to build this directly;
    /// now `copyables()` is the one seam that decides what is offered.
    CopyToClipboard {
        label: String,
        value: String,
    },
    /// Ctrl+V while a text field is focused (TOON_Network#138): reads the
    /// system clipboard with `wl-paste --no-newline`, off the UI thread,
    /// the same way a copy runs `wl-copy` off it. The daemon this crate
    /// talks to is never involved — `main.rs` answers this itself, without a
    /// `client`.
    RequestClipboardPaste,
    // -- New workload (TOON_Network#146) --
    /// `GET /api/templates` — read once on connect and on a profile switch
    /// (a Template gallery is per network, like the Directory), and again
    /// on `r` while the Gallery stage is showing.
    RefreshTemplates,
    /// `POST /api/templates/expand` — free; the Form stage's "Preview the
    /// spawn" once it has validated.
    ExpandTemplate(ExpandTemplateRequest),
    /// `POST /api/leases/preflight` — free; sent once a Listing is chosen
    /// and the Standbys stage is left with no standby added.
    PreflightSpawn(SpawnRequestBody),
    /// `POST /api/leases/standby-set/preflight` — free; the same moment as
    /// `PreflightSpawn`, but with at least one Warm Standby added.
    PreflightStandbySet(StandbySetRequestBody),
    /// `POST /api/templates/spawn` — **spends money** (spec §5, ADR 0003).
    /// Only ever reached after `widgets::confirm::Confirm`'s typed-`yes`
    /// dance (see `views::new_workload`); nothing in this module's keymap
    /// can produce it from a single keypress. The Template route rather than
    /// `POST /api/leases/spawn`, so the lease's record names its Template
    /// (TOON_Network#149).
    SpawnFromTemplate(TemplateSpawnRequestBody),
    /// `POST /api/leases/standby-set` — **spends at every member** (ADR
    /// 0003). Same confirmation gate as `SpawnFromTemplate`.
    SpawnStandbySet(StandbySetRequestBody),
}

/// The one place a keypress becomes a decision.
///
/// One mechanism (TOON_Network#138's code review): every view exposes its
/// own `fn handle_key(&mut state, key) -> Option<Command>` — [`view_key`]
/// below is the whole dispatch, one arm per [`View`] — and `None` means
/// "not mine," falling through to the global keymap beneath it. A view with
/// a modal to swallow keys for (a confirm dialog, a detail popup, a focused
/// text field) does that inside its own `handle_key`, the same way
/// [`app.help_open`](App::help_open) does here: checked first, and
/// answering `Some` for literally every key while it is open, closers
/// included, so nothing underneath ever sees one.
pub fn handle_key(app: &mut App, key: KeyEvent) -> Command {
    if app.help_open {
        match key.code {
            KeyCode::Char('?') | KeyCode::Esc | KeyCode::Char('q') => app.help_open = false,
            _ => {}
        }
        return Command::None;
    }

    // The copy picker (TOON_Network#138) swallows every key while it is
    // open, the same "modal covers everything underneath it" rule
    // `help_open` follows above — checked before `view_key` so a `j`/`k`/
    // `Enter`/`Esc` meant for the picker is never also read by whatever
    // view opened it.
    if let Some(picker) = &mut app.copy_picker {
        return match picker.handle_key(key) {
            CopyPickerOutcome::Pending => Command::None,
            CopyPickerOutcome::Cancelled => {
                app.copy_picker = None;
                Command::None
            }
            CopyPickerOutcome::Copy { label, value } => {
                app.copy_picker = None;
                Command::CopyToClipboard { label, value }
            }
        };
    }

    if let Some(command) = view_key(app, key) {
        return command;
    }

    global_key(app, key)
}

/// Routes a bracketed-paste event (`Event::Paste`, or Ctrl+V's `wl-paste`
/// answer in `main.rs`) to whichever text field the current view has focused
/// and is actively editing — the same "one seam" [`view_key`] is for
/// keystrokes. Every view not currently editing a field (including one with
/// a confirm modal or its own filter/budget-entry popup open) simply drops
/// the paste: "A paste while no field is editing is ignored and never
/// interpreted as keystrokes" (TOON_Network#138). Unlike [`handle_key`] this
/// never produces a [`Command`] — inserting text into a field is a pure
/// state change, nothing here talks to the network or the clipboard.
pub fn handle_paste(app: &mut App, text: &str) {
    if app.help_open || app.copy_picker.is_some() {
        return;
    }
    match app.view {
        View::Account => account::handle_paste(
            &mut app.account_view,
            app.account.as_ref(),
            app.profiles.as_ref(),
            app.chain_seed.as_ref(),
            text,
        ),
        View::New => new_workload::handle_paste(&mut app.new_workload, text),
        View::Workloads => workloads::handle_paste(&mut app.workloads, text),
        // Directory, Funds, Health and Docs have no text field to paste
        // into today.
        View::Directory | View::Funds | View::Health | View::Docs => {}
    }
}

/// Gives the current view first refusal on a key. `None` means it has no
/// opinion — a digit, `Tab`, `q`, `?`, ... while nothing view-specific is
/// open — and [`global_key`] gets it next.
fn view_key(app: &mut App, key: KeyEvent) -> Option<Command> {
    match app.view {
        View::Workloads => workloads::handle_key(&mut app.workloads, key),
        View::New => new_workload::handle_key(&mut app.new_workload, key),
        View::Directory => directory::handle_key(&mut app.directory, key),
        View::Funds => funds::handle_key(&mut app.funds, key),
        View::Account => account::handle_key(
            &mut app.account_view,
            app.account.as_ref(),
            app.profiles.as_ref(),
            app.chain_seed.as_ref(),
            key,
        ),
        View::Health => health::handle_key(key),
        View::Docs => docs::handle_key(&mut app.docs, key),
    }
}

/// The keys every view shares: quit, help, view switching. Nothing here is
/// conditioned on `app.view` any more — a key one view needs to treat
/// differently belongs in that view's own `handle_key` ([`view_key`]),
/// tried first.
fn global_key(app: &mut App, key: KeyEvent) -> Command {
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
        // TOON_Network#138: the one `y` for the whole app. Reached only once
        // every view's own `handle_key` has had first refusal — a view
        // editing a field or showing its own confirm/filter/budget-entry
        // modal already answered `Some` for `y` above (so it types, or is
        // part of "yes"), and never falls through to here.
        KeyCode::Char('y') => open_copy_picker(app),
        _ => Command::None,
    }
}

/// Builds the current view's `copyables()` and turns it into the one `y`
/// mechanism's decision: nothing to copy is a no-op, exactly one copies
/// straight away (no modal for a view with only one thing on offer), and two
/// or more open [`CopyPicker`].
fn open_copy_picker(app: &mut App) -> Command {
    let items = view_copyables(app);
    match items.len() {
        0 => Command::None,
        1 => {
            let (label, value) = items
                .into_iter()
                .next()
                .expect("checked items.len() == 1 above");
            Command::CopyToClipboard { label, value }
        }
        _ => {
            app.copy_picker = Some(CopyPicker::new(items));
            Command::None
        }
    }
}

/// Every view's own `copyables()` — TOON_Network#138: "Each view exposes
/// `fn copyables(&state, …) -> Vec<(label, value)>` for what is on screen or
/// selected." One arm per [`View`], mirroring [`view_key`]'s own dispatch.
fn view_copyables(app: &App) -> Vec<(String, String)> {
    match app.view {
        View::Workloads => workloads::copyables(&app.workloads),
        View::New => new_workload::copyables(&app.new_workload),
        View::Directory => directory::copyables(&app.directory),
        View::Funds => funds::copyables(&app.funds),
        View::Account => account::copyables(app.account.as_ref(), app.chain_seed.as_ref()),
        View::Health => health::copyables(app.health.as_ref(), app.funds.gas.as_ref()),
        View::Docs => docs::copyables(&app.docs),
    }
}

/// Mouse clicks select tabs (ADR 0028: "mouse clicks select tabs and rows").
/// `sidebar_hits` is the on-screen row for each view, built by the layout
/// code that drew the sidebar this frame — the App has no idea where things
/// are on screen, and it should not have to.
/// `row_hits` is the current view's own main list, if it has one —
/// `ui::Hits::rows`, built by the same frame's `ui::draw` — and a click on
/// one of them only MOVES that view's own selection to the row's index,
/// the same as `j`/`k`: a click never fires an action of its own, and
/// `Enter` (or whatever key opens/acts on the selection) still does that.
pub fn handle_mouse(
    app: &mut App,
    mouse: MouseEvent,
    sidebar_hits: &[(u16, View)],
    row_hits: &[(u16, usize)],
) -> Command {
    if app.help_open || app.copy_picker.is_some() {
        return Command::None;
    }
    if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
        for (row, view) in sidebar_hits {
            if *row == mouse.row {
                app.view = *view;
                return Command::None;
            }
        }
        for (row, index) in row_hits {
            if *row == mouse.row {
                select_row(app, *index);
                return Command::None;
            }
        }
    }
    Command::None
}

/// Selects row `index` of whatever list the current view is showing — see
/// [`handle_mouse`]'s own doc comment. A view with no clickable list of its
/// own (Health, Funds) does nothing, matching `ui::draw_content` never
/// handing back a row hit for either.
fn select_row(app: &mut App, index: usize) {
    match app.view {
        View::Workloads => app.workloads.list.selected = index,
        View::New => match app.new_workload.stage {
            new_workload::Stage::Gallery => app.new_workload.gallery_list.selected = index,
            new_workload::Stage::Listing => app.new_workload.picker.select(index),
            new_workload::Stage::Standbys => app.new_workload.standby_picker.select(index),
            new_workload::Stage::Form | new_workload::Stage::Preflight => {}
        },
        View::Directory => app.directory.picker.select(index),
        View::Docs => {
            if app.docs.page.is_none() {
                app.docs.selected = index;
            }
        }
        View::Account => app.account_view.select(index),
        View::Funds | View::Health => {}
    }
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

        // Lowercase `r` does not refresh Workloads (TOON_Network#144 frees it
        // for rotate) — capital `R` does, and `views::workloads::handle_key`
        // gets first refusal on `r` regardless, here returning `Command::None`
        // because no card is selected in a fresh `App`.
        app.view = View::Workloads;
        assert_eq!(handle_key(&mut app, key(KeyCode::Char('r'))), Command::None);
        assert_eq!(
            handle_key(&mut app, key(KeyCode::Char('R'))),
            Command::RefreshWorkloads
        );
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
        handle_mouse(&mut app, click, &hits, &[]);
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
        handle_mouse(&mut app, click, &hits, &[]);
        assert_eq!(
            app.view,
            View::Health,
            "click ignored while help covers the screen"
        );
    }

    #[test]
    fn clicking_a_row_hit_selects_it_on_the_current_view_and_fires_no_command() {
        let mut app = App::new();
        app.view = View::Workloads;
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 2,
            row: 7,
            modifiers: KeyModifiers::NONE,
        };
        let row_hits = [(7, 2usize)];
        let command = handle_mouse(&mut app, click, &[], &row_hits);
        assert_eq!(command, Command::None, "a click only selects, never acts");
        assert_eq!(app.workloads.list.selected, 2);
    }

    #[test]
    fn clicking_a_row_hit_on_the_docs_view_moves_its_selection() {
        let mut app = App::new();
        app.view = View::Docs;
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 2,
            row: 4,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse(&mut app, click, &[], &[(4, 1usize)]);
        assert_eq!(app.docs.selected, 1);
    }

    #[test]
    fn a_click_that_matches_no_row_or_sidebar_hit_does_nothing() {
        let mut app = App::new();
        app.view = View::Workloads;
        app.workloads.list.selected = 0;
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 2,
            row: 99,
            modifiers: KeyModifiers::NONE,
        };
        let command = handle_mouse(&mut app, click, &[], &[(7, 2)]);
        assert_eq!(command, Command::None);
        assert_eq!(app.workloads.list.selected, 0, "row 99 hit nothing");
    }

    #[test]
    fn ctrl_c_quits_like_q() {
        let mut app = App::new();
        let ev = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(handle_key(&mut app, ev), Command::Quit);
    }

    /// TOON_Network#138's code review: since every view now gets first
    /// refusal (`view_key`) before the global keymap (`global_key`), this
    /// proves the one thing that refactor must not break — `1`-`7`, `Tab`
    /// and `?` still work, and `q` still quits, on EVERY view, with no text
    /// field focused. A view whose own `handle_key` swallowed one of these
    /// instead of returning `None` would fail here.
    #[test]
    fn global_keys_work_on_every_view_while_nothing_is_focused() {
        for view in View::ALL {
            let mut app = App::new();
            app.view = view;
            handle_key(&mut app, key(KeyCode::Tab));
            assert_eq!(
                app.view,
                view.next(),
                "Tab should move off {view:?} to the next view"
            );

            let mut app = App::new();
            app.view = view;
            for (digit, target) in [
                ('1', View::Workloads),
                ('2', View::New),
                ('3', View::Directory),
                ('4', View::Funds),
                ('5', View::Account),
                ('6', View::Health),
                ('7', View::Docs),
            ] {
                handle_key(&mut app, key(KeyCode::Char(digit)));
                assert_eq!(app.view, target, "digit {digit} from {view:?}");
            }

            let mut app = App::new();
            app.view = view;
            assert!(!app.help_open);
            handle_key(&mut app, key(KeyCode::Char('?')));
            assert!(app.help_open, "? should open help from {view:?}");

            let mut app = App::new();
            app.view = view;
            assert_eq!(
                handle_key(&mut app, key(KeyCode::Char('q'))),
                Command::Quit,
                "q should quit from {view:?}"
            );
            assert!(app.should_quit);
        }
    }

    // -- copy picker routing (TOON_Network#138) ------------------------------

    #[test]
    fn y_on_a_view_with_nothing_to_copy_does_nothing() {
        let mut app = App::new();
        app.view = View::Docs; // no page open: `docs::copyables` is empty
        let command = handle_key(&mut app, key(KeyCode::Char('y')));
        assert_eq!(command, Command::None);
        assert!(app.copy_picker.is_none());
    }

    #[test]
    fn the_open_picker_swallows_j_k_until_enter_or_esc() {
        let mut app = App::new();
        app.copy_picker = Some(crate::widgets::copy_picker::CopyPicker::new(vec![
            ("First".to_string(), "value-1".to_string()),
            ("Second".to_string(), "value-2".to_string()),
        ]));

        // A digit that would otherwise switch views is swallowed.
        handle_key(&mut app, key(KeyCode::Char('1')));
        assert_eq!(
            app.view,
            View::Health,
            "the picker, not the digit, ate this"
        );
        assert!(app.copy_picker.is_some());

        handle_key(&mut app, key(KeyCode::Char('j')));
        let command = handle_key(&mut app, key(KeyCode::Enter));
        assert_eq!(
            command,
            Command::CopyToClipboard {
                label: "Second".to_string(),
                value: "value-2".to_string(),
            }
        );
        assert!(app.copy_picker.is_none(), "Enter closes the picker");
    }

    #[test]
    fn esc_closes_the_picker_without_copying_anything() {
        let mut app = App::new();
        app.copy_picker = Some(crate::widgets::copy_picker::CopyPicker::new(vec![(
            "First".to_string(),
            "value-1".to_string(),
        )]));
        let command = handle_key(&mut app, key(KeyCode::Esc));
        assert_eq!(command, Command::None);
        assert!(app.copy_picker.is_none());
    }

    #[test]
    fn mouse_clicks_are_ignored_while_the_picker_is_open() {
        let mut app = App::new();
        app.view = View::Health;
        app.copy_picker = Some(crate::widgets::copy_picker::CopyPicker::new(vec![(
            "First".to_string(),
            "value-1".to_string(),
        )]));
        let hits = [(1, View::Workloads)];
        let click = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 2,
            row: 1,
            modifiers: KeyModifiers::NONE,
        };
        handle_mouse(&mut app, click, &hits, &[]);
        assert_eq!(
            app.view,
            View::Health,
            "click ignored while the picker is open"
        );
    }

    /// TOON_Network#138's own acceptance line: "While a text field is being
    /// edited, `y` must type a `y`." Reached through `handle_key`, not
    /// `views::account::handle_key` directly, so this proves the GLOBAL `y`
    /// binding never gets a look at the key while a view's own `handle_key`
    /// already claimed it — the same guarantee `global_keys_work_on_every_view`
    /// above checks for `1`-`7`/`Tab`/`?`/`q`.
    #[test]
    fn y_types_a_y_while_a_field_is_being_edited_instead_of_opening_the_picker() {
        use crate::types::{KeystoreBackend, KeystoreInfo, SessionStatus};

        let mut app = App::new();
        app.view = View::Account;
        app.account = Some(SessionStatus {
            signed_in: false,
            account: None,
            signers: vec![],
            keystore: KeystoreInfo {
                backend: KeystoreBackend::File,
                location: "/tmp/keystore.json".to_string(),
                needs_passphrase: false,
            },
            invitation: None,
        });

        // Enter on the (first, Bunker URI) field starts editing it.
        handle_key(&mut app, key(KeyCode::Enter));
        assert!(app.account_view.is_editing_for_test());

        let command = handle_key(&mut app, key(KeyCode::Char('y')));
        assert_eq!(command, Command::None);
        assert!(
            app.copy_picker.is_none(),
            "y must not open the picker while editing"
        );
    }
}
