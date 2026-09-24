//! New workload (TOON_Network#146): starting a lease entirely from the TUI.
//!
//! A terminal mirror of `packages/ui/src/app/templates-view.tsx`,
//! `hooks/use-templates.ts`, and the spawn/preflight half of
//! `packages/ui/src/app/workloads-view.tsx` and `hooks/use-leases.ts` — the
//! web UI never wires those two together itself (the Templates view only
//! previews an expansion; a person retypes it by hand into the generic
//! spawn form), but this ticket's own acceptance criteria describe exactly
//! that pipeline, so this view builds it: expand a Template, pick a
//! Listing, optionally add Warm Standbys, see the preflight, confirm.
//!
//! Five stages ([`Stage`]), walked in order, `Backspace` to go back one:
//!
//! 1. **Gallery** — `GET /api/templates`, `j`/`k`/`/`/`Enter` over
//!    [`crate::widgets::list::ListState`], same as every other list in this
//!    crate. `Enter` on an unavailable Template does nothing but say so; an
//!    available one opens the form.
//! 2. **Form** — one [`crate::widgets::input::TextField`] per tenant-settable
//!    env name (`template.envTenant` minus `envFixed`'s keys — exactly
//!    `SpawnForm`'s own `settable` in `templates-view.tsx`), one for the SSH
//!    public key, one for an optional volume size. `Enter` on "Preview the
//!    spawn" validates (an empty SSH key or a non-numeric volume shows its
//!    error on the line right after the field, per this ticket's acceptance
//!    criterion) and, if it passes, sends `POST /api/templates/expand` —
//!    free, and the same content a manual spawn of the expanded image would
//!    carry (spec §6.2).
//! 3. **Listing** — [`crate::views::directory::ListingPicker`], embedded
//!    exactly as its own module doc says #146 would: fed from the same
//!    `GET /api/directory` read every other view shares (`apply_directory`),
//!    never a filtered or separate copy. Since an unfiltered read shows
//!    Hidden Providers alongside the rest, picking one here is how a Hidden
//!    Provider is chosen — there is no separate toggle, the same as the web
//!    form (`workloads-view.tsx`'s `<select>` lists every provider the
//!    Directory returned).
//! 4. **Standbys** — a second, independently-fed `ListingPicker`, holding
//!    only providers that are not the primary and sell a tier with a
//!    `standbyPrice` (mirrors `Standbys` in `workloads-view.tsx`). `Enter`
//!    adds one, `d` removes the last, `n` continues (with zero is fine — an
//!    ordinary spawn, not a Standby Set).
//! 5. **Preflight** — `POST /api/leases/preflight` or, with standbys,
//!    `POST /api/leases/standby-set/preflight`; `L` toggles "local only" and
//!    re-prices; `s` opens [`crate::widgets::confirm::Confirm`] (typing `yes`
//!    then Enter — one keypress cannot pass it), which on confirmation sends
//!    `POST /api/leases/spawn` or `.../standby-set`.
//!
//! `main.rs` owns the network calls and the `Stage::Form` -> `Stage::Listing`
//! transition (it only happens once `POST /api/templates/expand` answers);
//! everything else here is this module's own state machine, tested without a
//! terminal the same way `views::workloads` and `views::account` are.

use std::collections::BTreeMap;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::types::{
    ChainFundingView, Directory, ExpandTemplateRequest, ExpandedTemplate, FundingStatus,
    ListingView, PreflightView, ProviderView, RegistryEntryRequest, SpawnContentImage,
    SpawnImageRequest, SpawnPortRequest, SpawnRequestBody, StandbyMemberRequest,
    StandbySetPreflightView, StandbySetRequestBody, TemplateAvailability, TemplateGallery,
    TemplateSpawnRequestBody, TemplateView,
};
use crate::views::directory::{ListingPicker, PickerEvent};
use crate::views::template_publish::{self, TemplatePublishState};
use crate::widgets::confirm::{Confirm, ConfirmOutcome};
use crate::widgets::input::TextField;
use crate::widgets::list::{ListOutcome, ListState};

/// The five steps of the wizard, walked in order. `Backspace` moves back
/// one; nothing here skips ahead — each stage's own key handling is what
/// advances to the next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Gallery,
    Form,
    Listing,
    Standbys,
    Preflight,
}

/// One focusable field or button in the Form stage, in cursor order — the
/// same `targets()`-plus-`cursor` shape `views::account` documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormTarget {
    Env(usize),
    Ssh,
    Volume,
    Preview,
}

/// The Form stage's own fields, rebuilt fresh by [`FormFields::new`] each
/// time a Template is opened from the gallery — a stale field from a
/// PREVIOUS Template must never leak into this one's request.
pub struct FormFields {
    /// Parallel to `env_fields`: `env_names[i]` is the env var `env_fields[i]`
    /// holds a value for.
    env_names: Vec<String>,
    env_fields: Vec<TextField>,
    ssh: TextField,
    volume: TextField,
    cursor: usize,
    editing: bool,
    /// Validation errors from the last "Preview the spawn" attempt, shown
    /// beside the field they are about — cleared and rebuilt on every
    /// attempt, never accumulated.
    errors: Vec<(FormTarget, String)>,
}

impl FormFields {
    fn new(template: &TemplateView) -> Self {
        let env_names = settable_env_names(template);
        let env_fields = env_names
            .iter()
            .map(|_| TextField::new("", false))
            .collect();
        Self {
            env_names,
            env_fields,
            ssh: TextField::new("SSH public key", false),
            volume: TextField::new("Volume (GB, optional)", false),
            cursor: 0,
            editing: false,
            errors: Vec::new(),
        }
    }
}

impl Default for FormFields {
    fn default() -> Self {
        Self {
            env_names: Vec::new(),
            env_fields: Vec::new(),
            ssh: TextField::new("SSH public key", false),
            volume: TextField::new("Volume (GB, optional)", false),
            cursor: 0,
            editing: false,
            errors: Vec::new(),
        }
    }
}

/// Every name a Template marks tenant-settable, minus the ones it fixed —
/// `SpawnForm`'s own `settable` in `templates-view.tsx`.
fn settable_env_names(template: &TemplateView) -> Vec<String> {
    template
        .env_tenant
        .iter()
        .filter(|name| !template.env_fixed.contains_key(*name))
        .cloned()
        .collect()
}

/// One Warm Standby chosen in the Standbys stage — just enough to build a
/// [`StandbyMemberRequest`] and to show what was picked; `views::directory`'s
/// own [`ListingView`]/[`ProviderView`] are not kept around once chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandbyMember {
    pub provider_pubkey: String,
    pub provider_label: String,
    pub listing_name: String,
    pub listing_label: String,
}

/// What a confirmed `s` becomes, once the person has typed `yes` — carried
/// out by `main.rs`, the only place this crate calls the network.
#[derive(Debug, Clone, PartialEq)]
pub enum SpawnAction {
    Spawn(TemplateSpawnRequestBody),
    // Boxed: a set carries every member, and the variant would otherwise be
    // twice the size of an ordinary spawn.
    StandbySet(Box<StandbySetRequestBody>),
}

/// What a confirmed `o` becomes (TOON_Network#138: "open a channel with this
/// connector"), captured at the moment the confirmation was shown so that
/// typing `yes`+`Enter` sends provably the same chain, connector and deposit
/// that were on screen — nothing is recomputed in between.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenChannelPlan {
    pub chain: String,
    pub connector: String,
    pub deposit: Option<String>,
}

pub struct NewWorkloadViewState {
    pub stage: Stage,

    // -- Gallery --
    pub gallery: Option<TemplateGallery>,
    pub loading_gallery: bool,
    pub gallery_error: Option<String>,
    pub gallery_list: ListState,
    /// A Template's `address` to select once the NEXT `GET /api/templates`
    /// read lands — set the moment `POST /api/templates/publish` succeeds
    /// (TOON_Network#138), consumed (and cleared) by `main.rs`'s
    /// `TemplatesLoaded` handler the same way `workloads::pending_select` is.
    pub pending_select: Option<String>,
    /// "Publish a Template" (TOON_Network#138), opened with `p` on the
    /// Gallery stage. An overlay rather than a `Stage` of its own: it always
    /// opens and closes on top of the Gallery, the same way `confirm` and
    /// `channel_confirm` overlay the Preflight stage below.
    pub publish: Option<TemplatePublishState>,

    /// The Template chosen from the gallery, carried through every later
    /// stage — cleared only when the wizard resets.
    pub template: Option<TemplateView>,

    // -- Form --
    pub form: FormFields,
    pub expanding: bool,
    pub expand_error: Option<String>,
    /// The §6.2 spawn content the Template expanded to. Set once
    /// `POST /api/templates/expand` answers (`main.rs`), which is also what
    /// moves `stage` on to [`Stage::Listing`].
    pub expansion: Option<ExpandedTemplate>,
    /// The settings that expansion was asked for — what
    /// `POST /api/templates/spawn` is sent again, so the daemon expands the
    /// same Template the same way when it buys the lease.
    pub expanded_with: Option<ExpandTemplateRequest>,

    // -- Listing --
    /// Fed by [`apply_directory`] from the same `GET /api/directory` read
    /// every other view shares — never its own fetch (see the module doc).
    pub picker: ListingPicker,
    /// The raw providers from the last directory read, kept so the Standbys
    /// stage can filter them down to candidates independently of what the
    /// primary picker currently shows.
    all_providers: Vec<ProviderView>,
    pub directory_error: Option<String>,

    // -- Standbys --
    pub standby_picker: ListingPicker,
    pub standbys: Vec<StandbyMember>,

    // -- Shared / Preflight --
    pub local_only: bool,
    pub preflight_loading: bool,
    pub preflight_error: Option<String>,
    pub preflight: Option<PreflightView>,
    pub set_preflight: Option<StandbySetPreflightView>,
    pub confirm: Option<Confirm<SpawnAction>>,
    pub spawning: bool,
    pub spawn_error: Option<String>,
    /// A message from the last cancelled confirmation or a successful
    /// spawn — cleared the next time something meaningful changes.
    pub status: Option<String>,

    // -- "Open a channel with this connector" (TOON_Network#138) --
    /// The connector `o` last asked `GET /api/funding?connector=<url>` about
    /// — `missing_channel_connector`'s answer at the moment `o` was pressed,
    /// kept so a later poll or a fresh answer knows what it is scoped to.
    pub connector_funding_url: Option<String>,
    /// That connector's own funding read — same `FundingStatus` shape the
    /// Funds tab's own `app.funds.funding` is, scoped to a connector that
    /// need not be the profile's own.
    pub connector_funding: Option<FundingStatus>,
    pub connector_funding_loading: bool,
    pub connector_funding_error: Option<String>,
    /// Shown once `connector_funding` has answered with an openable chain —
    /// a second, independent confirmation from `confirm` above (that one
    /// spawns; this one opens a channel), so both can never collide.
    pub channel_confirm: Option<Confirm<OpenChannelPlan>>,
    /// The chain a confirmed open is in flight for — which of
    /// `connector_funding`'s chains the poll (main.rs, Funds cadence) and
    /// the "did it just turn open" check both watch. A connector can settle
    /// on more than one chain, and only the one actually being opened
    /// matters.
    pub opening_chain: Option<String>,
}

impl NewWorkloadViewState {
    pub fn new() -> Self {
        Self {
            stage: Stage::Gallery,
            gallery: None,
            loading_gallery: false,
            gallery_error: None,
            gallery_list: ListState::new(),
            pending_select: None,
            publish: None,
            template: None,
            form: FormFields::default(),
            expanding: false,
            expand_error: None,
            expansion: None,
            expanded_with: None,
            picker: ListingPicker::new(),
            all_providers: Vec::new(),
            directory_error: None,
            standby_picker: ListingPicker::new(),
            standbys: Vec::new(),
            local_only: false,
            preflight_loading: false,
            preflight_error: None,
            preflight: None,
            set_preflight: None,
            confirm: None,
            spawning: false,
            spawn_error: None,
            status: None,
            connector_funding_url: None,
            connector_funding: None,
            connector_funding_loading: false,
            connector_funding_error: None,
            channel_confirm: None,
            opening_chain: None,
        }
    }
}

impl Default for NewWorkloadViewState {
    fn default() -> Self {
        Self::new()
    }
}

/// Applies a fresh `GET /api/directory` answer (`main.rs` calls this
/// alongside `app.directory.apply`, every time — see the module doc:
/// this view never fetches its own copy). Unfiltered, so a Hidden Provider
/// is right there to choose, exactly like the web form.
pub fn apply_directory(state: &mut NewWorkloadViewState, directory: &Directory) {
    match directory {
        Directory::Ok { providers, .. } => {
            state.all_providers = providers.clone();
            state.picker.set_providers(providers.clone());
            state.directory_error = None;
        }
        Directory::Unconfigured { reason } => {
            state.all_providers = Vec::new();
            state.picker.set_providers(Vec::new());
            state.directory_error = Some(reason.clone());
        }
    }
}

/// Back to the gallery, everything past it cleared — called once a spawn has
/// gone through (`main.rs`, after `views::workloads::select_workload`). The
/// gallery and the directory data are left alone: both are free to keep
/// around, and refetching them would just show the same thing again.
pub fn reset_wizard(state: &mut NewWorkloadViewState, status: impl Into<String>) {
    state.stage = Stage::Gallery;
    state.template = None;
    state.form = FormFields::default();
    state.expanding = false;
    state.expand_error = None;
    state.expansion = None;
    state.expanded_with = None;
    state.standby_picker = ListingPicker::new();
    state.standbys.clear();
    state.local_only = false;
    state.preflight_loading = false;
    state.preflight_error = None;
    state.preflight = None;
    state.set_preflight = None;
    state.confirm = None;
    state.spawning = false;
    state.spawn_error = None;
    state.status = Some(status.into());
    clear_connector_funding(state);
}

/// Drops every "open a channel with this connector" field back to its
/// starting point — called on a full wizard reset and whenever Backspace
/// leaves the Preflight stage, so a stale read or a stale confirmation from
/// one Listing's connector never leaks into a different one's.
fn clear_connector_funding(state: &mut NewWorkloadViewState) {
    state.connector_funding_url = None;
    state.connector_funding = None;
    state.connector_funding_loading = false;
    state.connector_funding_error = None;
    state.channel_confirm = None;
    state.opening_chain = None;
}

/// The one place a keypress becomes a decision for this view — the same
/// "first refusal" shape `app::handle_key` gives Account and Workloads.
/// Returns `None` for a key this view has no opinion about right now, so the
/// global keymap (view switching, `?`, quit) still gets it.
pub fn handle_key(state: &mut NewWorkloadViewState, key: KeyEvent) -> Option<Command> {
    // TOON_Network#138: "Publish a Template" is its own small overlay,
    // opened only from the Gallery stage (`gallery_handle_key`'s `p`) — but
    // checked here, first, the same "modal covers everything underneath it"
    // rule `confirm`/`channel_confirm` follow below, so nothing on the
    // Gallery underneath it ever sees a key while it is open.
    if let Some(publish) = &mut state.publish {
        return Some(match template_publish::handle_key(publish, key) {
            template_publish::Outcome::Command(command) => *command,
            template_publish::Outcome::Close => {
                state.publish = None;
                Command::None
            }
        });
    }

    // Checked before `confirm` below: only one of the two can ever be open
    // at once (`offer_open_channel_confirm` and `preflight_handle_key`'s `s`
    // arm both refuse to run while the other kind is showing), but this is
    // the seam that would decide if that ever changed.
    if let Some(confirm) = &mut state.channel_confirm {
        return Some(match confirm.handle_key(key) {
            ConfirmOutcome::Pending => Command::None,
            ConfirmOutcome::Cancelled => {
                state.channel_confirm = None;
                state.status = Some("Cancelled. No channel was opened.".to_string());
                Command::None
            }
            ConfirmOutcome::Confirmed(plan) => {
                state.channel_confirm = None;
                state.opening_chain = Some(plan.chain.clone());
                Command::OpenChannelForConnector {
                    chain: plan.chain,
                    deposit: plan.deposit,
                    connector: plan.connector,
                }
            }
        });
    }

    if let Some(confirm) = &mut state.confirm {
        return Some(match confirm.handle_key(key) {
            ConfirmOutcome::Pending => Command::None,
            ConfirmOutcome::Cancelled => {
                state.confirm = None;
                state.status = Some("Cancelled. Nothing was sent.".to_string());
                Command::None
            }
            ConfirmOutcome::Confirmed(action) => {
                state.confirm = None;
                state.spawning = true;
                state.spawn_error = None;
                match action {
                    SpawnAction::Spawn(body) => Command::SpawnFromTemplate(body),
                    SpawnAction::StandbySet(body) => Command::SpawnStandbySet(*body),
                }
            }
        });
    }

    // `p` opens "Publish a Template" from every step, not only the gallery:
    // the tab stays on whichever step a person left it at, and a key that
    // silently did nothing there read as a broken one. Never while a field
    // is being typed in, where `p` is a letter.
    if state.stage != Stage::Gallery
        && !state.form.editing
        && key.code == KeyCode::Char('p')
        && key.modifiers.is_empty()
    {
        state.publish = Some(TemplatePublishState::new());
        return Some(Command::None);
    }

    match state.stage {
        Stage::Gallery => gallery_handle_key(state, key),
        Stage::Form => form_handle_key(state, key),
        Stage::Listing => listing_handle_key(state, key),
        Stage::Standbys => standbys_handle_key(state, key),
        Stage::Preflight => preflight_handle_key(state, key),
    }
}

/* -------------------------------------------------------------------------- */
/* Gallery                                                                    */
/* -------------------------------------------------------------------------- */

fn gallery_rows(state: &NewWorkloadViewState) -> Vec<&TemplateView> {
    let Some(TemplateGallery::Ok { templates, .. }) = &state.gallery else {
        return Vec::new();
    };
    templates
        .iter()
        .filter(|template| {
            let haystack = format!(
                "{} {} {}",
                template.name,
                template
                    .publisher
                    .display_name
                    .as_deref()
                    .or(template.publisher.name.as_deref())
                    .unwrap_or(""),
                template.publisher.npub
            );
            state.gallery_list.matches(&haystack)
        })
        .collect()
}

fn gallery_total(state: &NewWorkloadViewState) -> usize {
    match &state.gallery {
        Some(TemplateGallery::Ok { templates, .. }) => templates.len(),
        _ => 0,
    }
}

/// Selects the Template at `address` in the gallery — the "select the new
/// Template" half of TOON_Network#138's publish flow, `main.rs`'s own
/// mirror of `views::workloads::select_workload`. Called after a fresh
/// `GET /api/templates` read that should now carry it.
pub fn select_template(state: &mut NewWorkloadViewState, address: &str) -> bool {
    if !state.gallery_list.filter.is_empty() {
        state.gallery_list.filter.clear();
        state.gallery_list.filtering = false;
    }
    match gallery_rows(state)
        .iter()
        .position(|template| template.address == address)
    {
        Some(index) => {
            state.gallery_list.selected = index;
            true
        }
        None => false,
    }
}

fn gallery_handle_key(state: &mut NewWorkloadViewState, key: KeyEvent) -> Option<Command> {
    let rows_len = gallery_rows(state).len();
    match state.gallery_list.handle_key(key, rows_len) {
        ListOutcome::Handled => return Some(Command::None),
        ListOutcome::Open(index) => {
            let chosen = gallery_rows(state)
                .get(index)
                .map(|template| (*template).clone());
            if let Some(template) = chosen {
                match &template.availability {
                    TemplateAvailability::Unavailable { reason } => {
                        state.status = Some(format!("Not offered: {reason}"));
                    }
                    TemplateAvailability::Available { .. } => {
                        state.form = FormFields::new(&template);
                        state.template = Some(template);
                        state.expansion = None;
                        state.expanded_with = None;
                        state.expand_error = None;
                        state.status = None;
                        state.stage = Stage::Form;
                    }
                }
            }
            return Some(Command::None);
        }
        ListOutcome::Ignored => {}
    }
    match key.code {
        KeyCode::Char('r') => Some(Command::RefreshTemplates),
        // TOON_Network#138: "Publish a Template" — opens on top of the
        // Gallery, the same overlay shape `confirm`/`channel_confirm` give
        // the Preflight stage below.
        KeyCode::Char('p') => {
            state.publish = Some(TemplatePublishState::new());
            Some(Command::None)
        }
        _ => None,
    }
}

/* -------------------------------------------------------------------------- */
/* Form                                                                       */
/* -------------------------------------------------------------------------- */

/// Whether the Template open in the Form stage asks for an SSH key at all
/// (TOON_Network#138) — `true` with no Template chosen yet, so nothing below
/// hides a field before there is anything to judge it by.
fn template_offers_ssh(state: &NewWorkloadViewState) -> bool {
    state
        .template
        .as_ref()
        .is_none_or(|template| template.ssh_offered)
}

fn form_targets(state: &NewWorkloadViewState) -> Vec<FormTarget> {
    let mut out: Vec<FormTarget> = (0..state.form.env_names.len())
        .map(FormTarget::Env)
        .collect();
    if template_offers_ssh(state) {
        out.push(FormTarget::Ssh);
    }
    out.push(FormTarget::Volume);
    out.push(FormTarget::Preview);
    out
}

fn form_field_mut(state: &mut NewWorkloadViewState, target: FormTarget) -> Option<&mut TextField> {
    match target {
        FormTarget::Env(index) => state.form.env_fields.get_mut(index),
        FormTarget::Ssh => Some(&mut state.form.ssh),
        FormTarget::Volume => Some(&mut state.form.volume),
        FormTarget::Preview => None,
    }
}

/// Routes a paste to the Form stage's currently focused field
/// (TOON_Network#138) — the same `form_targets`/`form.cursor`/
/// `form_field_mut` seam [`form_handle_key`] uses. A no-op on every other
/// stage, or while the Form stage's field is not being edited, or while a
/// spawn confirm is open — "a paste while no field is editing is ignored."
pub fn handle_paste(state: &mut NewWorkloadViewState, text: &str) {
    if let Some(publish) = &mut state.publish {
        template_publish::handle_paste(publish, text);
        return;
    }
    if state.confirm.is_some() || state.stage != Stage::Form || !state.form.editing {
        return;
    }
    let targets = form_targets(state);
    let Some(target) = targets.get(state.form.cursor).copied() else {
        return;
    };
    if let Some(field) = form_field_mut(state, target) {
        field.insert_str(text);
    }
}

/// What `y` offers on the New workload view (TOON_Network#138): the chosen
/// Template's image content address (§8.1's registry entry `address`, the
/// same one `SpawnContentImage.registry_entry` names once expanded) —
/// nothing before a Template is chosen (the Gallery stage) or when its image
/// could not be resolved ([`TemplateAvailability::Unavailable`]).
pub fn copyables(state: &NewWorkloadViewState) -> Vec<(String, String)> {
    let Some(template) = &state.template else {
        return Vec::new();
    };
    match &template.availability {
        TemplateAvailability::Available {
            entry: Some(entry), ..
        } => vec![("Image content address".to_string(), entry.address.clone())],
        _ => Vec::new(),
    }
}

fn form_handle_key(state: &mut NewWorkloadViewState, key: KeyEvent) -> Option<Command> {
    let targets = form_targets(state);
    if targets.is_empty() {
        return Some(Command::None);
    }
    if state.form.cursor >= targets.len() {
        state.form.cursor = targets.len() - 1;
    }

    if state.form.editing {
        match key.code {
            KeyCode::Enter | KeyCode::Esc => state.form.editing = false,
            // TOON_Network#138: Ctrl+V reads the system clipboard
            // (`wl-paste`, off the UI thread) instead of typing a `v` —
            // same rule every other field-editing mode in this crate
            // follows.
            KeyCode::Char('v') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                return Some(Command::RequestClipboardPaste);
            }
            _ => {
                let target = targets[state.form.cursor];
                if let Some(field) = form_field_mut(state, target) {
                    field.handle_key(key);
                }
            }
        }
        return Some(Command::None);
    }

    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            state.form.cursor = state.form.cursor.saturating_sub(1);
            Some(Command::None)
        }
        KeyCode::Down | KeyCode::Char('j') => {
            state.form.cursor = (state.form.cursor + 1).min(targets.len() - 1);
            Some(Command::None)
        }
        KeyCode::Backspace => {
            state.stage = Stage::Gallery;
            Some(Command::None)
        }
        KeyCode::Enter => {
            let target = targets[state.form.cursor];
            Some(form_activate(state, target))
        }
        _ => None,
    }
}

fn form_activate(state: &mut NewWorkloadViewState, target: FormTarget) -> Command {
    match target {
        FormTarget::Env(_) | FormTarget::Ssh | FormTarget::Volume => {
            state.form.editing = true;
            Command::None
        }
        FormTarget::Preview => match validate_form(state) {
            Some((env, ssh_public_key, volume_gb)) => {
                let Some(template) = state.template.as_ref() else {
                    return Command::None;
                };
                state.expanding = true;
                state.expand_error = None;
                let request = ExpandTemplateRequest {
                    template: template.address.clone(),
                    env: if env.is_empty() { None } else { Some(env) },
                    ssh_public_key,
                    volume_gb,
                };
                state.expanded_with = Some(request.clone());
                Command::ExpandTemplate(request)
            }
            None => Command::None,
        },
    }
}

/// Validates the form and, on success, hands back what
/// `POST /api/templates/expand` needs. Every problem found is pushed to
/// `state.form.errors` (cleared first), beside the field it is about — this
/// ticket's own acceptance criterion — and `None` comes back the moment
/// there is at least one, so "Preview the spawn" never sends a request that
/// is missing what the daemon would refuse anyway.
fn validate_form(
    state: &mut NewWorkloadViewState,
) -> Option<(BTreeMap<String, String>, String, Option<i64>)> {
    state.form.errors.clear();
    let mut ok = true;

    // Only a Template that offers SSH asks for a key at all (TOON_Network#138):
    // §6.2 still requires ONE on the wire, but the daemon substitutes its own
    // placeholder for a Template that says it has none — this form is not
    // where that decision is made, and does not pretend otherwise by asking.
    let offers_ssh = template_offers_ssh(state);
    if offers_ssh && state.form.ssh.is_empty() {
        state.form.errors.push((
            FormTarget::Ssh,
            "Required — no password is ever issued for a workload (spec §6.2).".to_string(),
        ));
        ok = false;
    }

    let mut volume_gb = None;
    if !state.form.volume.is_empty() {
        match state.form.volume.value().trim().parse::<i64>() {
            Ok(value) if value >= 0 => volume_gb = Some(value),
            _ => {
                state.form.errors.push((
                    FormTarget::Volume,
                    "Must be a whole number of GB.".to_string(),
                ));
                ok = false;
            }
        }
    }

    if !ok {
        return None;
    }

    let mut env = BTreeMap::new();
    for (name, field) in state
        .form
        .env_names
        .iter()
        .zip(state.form.env_fields.iter())
    {
        let value = field.value();
        if !value.is_empty() {
            env.insert(name.clone(), value.to_string());
        }
    }

    let ssh_public_key = if offers_ssh {
        state.form.ssh.value().to_string()
    } else {
        String::new()
    };
    Some((env, ssh_public_key, volume_gb))
}

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

fn listing_handle_key(state: &mut NewWorkloadViewState, key: KeyEvent) -> Option<Command> {
    if key.code == KeyCode::Backspace {
        state.stage = Stage::Form;
        return Some(Command::None);
    }
    match state.picker.handle_key(key) {
        PickerEvent::Chosen => {
            state.stage = Stage::Standbys;
            refresh_standby_candidates(state);
            Some(Command::None)
        }
        PickerEvent::Moved => Some(Command::None),
        PickerEvent::None => None,
    }
}

/* -------------------------------------------------------------------------- */
/* Standbys                                                                   */
/* -------------------------------------------------------------------------- */

/// Rebuilds the Standbys picker's candidates: every provider that is not the
/// chosen primary, not already added, and sells at least one tier with a
/// `standbyPrice` — mirrors `others`/`tiers` in `workloads-view.tsx`'s own
/// `Standbys` component. Each candidate provider is given a filtered COPY of
/// its own listings (the standby-priced ones only), so the picker never
/// offers a tier that sells no Warm Standby at all.
fn refresh_standby_candidates(state: &mut NewWorkloadViewState) {
    let Some((primary, _)) = state.picker.selected_listing() else {
        state.standby_picker.set_providers(Vec::new());
        return;
    };
    let primary_pubkey = primary.pubkey.clone();
    let candidates: Vec<ProviderView> = state
        .all_providers
        .iter()
        .filter(|provider| provider.pubkey != primary_pubkey)
        .filter(|provider| {
            !state
                .standbys
                .iter()
                .any(|member| member.provider_pubkey == provider.pubkey)
        })
        .filter_map(|provider| {
            let listings: Vec<ListingView> = provider
                .listings
                .iter()
                .filter(|listing| listing.standby_price.is_some())
                .cloned()
                .collect();
            if listings.is_empty() {
                None
            } else {
                Some(ProviderView {
                    listings,
                    ..provider.clone()
                })
            }
        })
        .collect();
    state.standby_picker.set_providers(candidates);
}

fn standbys_handle_key(state: &mut NewWorkloadViewState, key: KeyEvent) -> Option<Command> {
    match key.code {
        KeyCode::Backspace => {
            state.stage = Stage::Listing;
            return Some(Command::None);
        }
        KeyCode::Char('d') => {
            state.standbys.pop();
            refresh_standby_candidates(state);
            return Some(Command::None);
        }
        KeyCode::Char('n') => {
            state.stage = Stage::Preflight;
            return Some(start_preflight(state));
        }
        _ => {}
    }
    match state.standby_picker.handle_key(key) {
        PickerEvent::Chosen => {
            if let Some((provider, listing)) = state.standby_picker.selected_listing() {
                state.standbys.push(StandbyMember {
                    provider_pubkey: provider.pubkey.clone(),
                    provider_label: provider.profile.ilp_address.clone(),
                    listing_name: listing.name.clone(),
                    listing_label: format!("{} v{}", listing.name, listing.version),
                });
            }
            refresh_standby_candidates(state);
            Some(Command::None)
        }
        PickerEvent::Moved => Some(Command::None),
        PickerEvent::None => None,
    }
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

fn spawn_image_request(image: &SpawnContentImage) -> SpawnImageRequest {
    SpawnImageRequest {
        reference: image.reference.clone(),
        digest: image.digest.clone(),
        registry_entry: image
            .registry_entry
            .as_ref()
            .map(|entry| RegistryEntryRequest {
                address: entry.address.clone(),
                relay: entry.relay.clone(),
            }),
    }
}

/// Builds the primary spawn's body straight from the Template's expansion
/// (image, env, ports, volume, SSH key — spec §6.2) and the Listing chosen
/// in [`Stage::Listing`]. Never assembled from typed fields the way the
/// generic Workloads spawn form's are.
fn build_spawn_request(state: &NewWorkloadViewState) -> Option<SpawnRequestBody> {
    let expansion = state.expansion.as_ref()?;
    let template = state.template.as_ref()?;
    let (provider, listing) = state.picker.selected_listing()?;
    Some(spawn_request_from_expansion(
        expansion,
        &template.address,
        &provider.pubkey,
        &listing.name,
        state.local_only,
    ))
}

/// The spawn body for one Template's expansion and one chosen Listing — what
/// [`build_spawn_request`] sends once the form, the expansion and the picker
/// all have an answer. Public so the smoke (`tests/smoke.rs`,
/// TOON_Network#149) spawns with exactly this body rather than a copy of it.
pub fn spawn_request_from_expansion(
    expansion: &ExpandedTemplate,
    template_address: &str,
    provider_pubkey: &str,
    listing_name: &str,
    local_only: bool,
) -> SpawnRequestBody {
    SpawnRequestBody {
        provider: provider_pubkey.to_string(),
        listing: listing_name.to_string(),
        image: spawn_image_request(&expansion.spawn.image),
        env: if expansion.spawn.env.is_empty() {
            None
        } else {
            Some(expansion.spawn.env.clone())
        },
        ports: if expansion.spawn.ports.is_empty() {
            None
        } else {
            Some(
                expansion
                    .spawn
                    .ports
                    .iter()
                    .map(|port| SpawnPortRequest {
                        container_port: port.container_port,
                        protocol: Some(port.protocol.clone()),
                    })
                    .collect(),
            )
        },
        ssh_public_key: expansion.spawn.ssh_public_key.clone(),
        volume_gb: expansion.spawn.volume_gb,
        entrypoint: expansion.spawn.entrypoint.clone(),
        args: expansion.spawn.args.clone(),
        template: Some(template_address.to_string()),
        local_only: if local_only { Some(true) } else { None },
        chain: None,
    }
}

/// What the confirmed spawn sends: the Template, the settings its expansion
/// was asked for, and the chosen Listing — `None` until all three exist. The
/// preflight before it prices [`build_spawn_request`]'s body, which is the
/// same content: the daemon expands the Template again from these settings.
fn build_template_spawn_request(state: &NewWorkloadViewState) -> Option<TemplateSpawnRequestBody> {
    state.expansion.as_ref()?;
    let settings = state.expanded_with.as_ref()?;
    let (provider, listing) = state.picker.selected_listing()?;
    Some(template_spawn_request(
        settings,
        &provider.pubkey,
        listing,
        state.local_only,
    ))
}

/// `POST /api/templates/spawn`'s body for one expansion's settings and one
/// Listing. Public so the smoke (`tests/smoke.rs`, TOON_Network#149) spawns
/// with exactly this body.
pub fn template_spawn_request(
    settings: &ExpandTemplateRequest,
    provider_pubkey: &str,
    listing: &ListingView,
    local_only: bool,
) -> TemplateSpawnRequestBody {
    TemplateSpawnRequestBody {
        template: settings.template.clone(),
        env: settings.env.clone(),
        ssh_public_key: settings.ssh_public_key.clone(),
        volume_gb: settings.volume_gb,
        provider: provider_pubkey.to_string(),
        listing: listing.name.clone(),
        listing_version: listing.version,
        local_only: if local_only { Some(true) } else { None },
    }
}

/// `None` when no Warm Standby has been added — the caller falls back to
/// [`build_spawn_request`] alone, an ordinary spawn (spec §7: a set of one
/// is not a Standby Set).
fn build_standby_set_request(state: &NewWorkloadViewState) -> Option<StandbySetRequestBody> {
    if state.standbys.is_empty() {
        return None;
    }
    let base = build_spawn_request(state)?;
    Some(StandbySetRequestBody {
        base,
        standbys: state
            .standbys
            .iter()
            .map(|member| StandbyMemberRequest {
                provider: member.provider_pubkey.clone(),
                listing: member.listing_name.clone(),
                listing_version: None,
                chain: None,
            })
            .collect(),
    })
}

/// Sends whichever preflight applies and marks it loading. Called both when
/// the Standbys stage is left (`n`) and whenever `L` re-prices with
/// `local_only` flipped.
fn start_preflight(state: &mut NewWorkloadViewState) -> Command {
    state.preflight_error = None;
    if let Some(body) = build_standby_set_request(state) {
        state.preflight_loading = true;
        return Command::PreflightStandbySet(body);
    }
    match build_spawn_request(state) {
        Some(body) => {
            state.preflight_loading = true;
            Command::PreflightSpawn(body)
        }
        None => {
            state.preflight_error =
                Some("Nothing to preflight yet — go back and finish the form.".to_string());
            Command::None
        }
    }
}

fn preflight_ok(state: &NewWorkloadViewState) -> bool {
    if let Some(set) = &state.set_preflight {
        return set.ok;
    }
    state
        .preflight
        .as_ref()
        .is_some_and(|preflight| preflight.ok)
}

fn preflight_confirm_lines(state: &NewWorkloadViewState) -> Vec<String> {
    if let Some(set) = &state.set_preflight {
        let mut lines = vec![format!(
            "One workload id, {} member(s), one Root Secret.",
            set.members.len()
        )];
        lines.push(match &set.cost {
            Some(cost) => format!("{cost} base units for the first interval at every member."),
            None => "Not every member quoted a price, so the full cost is unknown.".to_string(),
        });
        lines.push(
            "A refused request is billed the same as an accepted one (ADR 0003).".to_string(),
        );
        lines
    } else if let Some(preflight) = &state.preflight {
        let mut lines = Vec::new();
        if let Some(listing) = &preflight.listing {
            lines.push(format!(
                "{} \u{b5}USDC for {} s.",
                listing.price, listing.lease_interval_seconds
            ));
        }
        lines.push(
            "A refused request is billed the same as an accepted one (ADR 0003).".to_string(),
        );
        lines
    } else {
        vec!["Nothing priced yet.".to_string()]
    }
}

/// The connector a spawn WOULD pay at, when the preflight already says there
/// is no bound channel there — read off `PreflightView::payment` alone,
/// structurally (`channel_id` absent), never by matching `problems`' prose
/// (`lease.ts`'s `#payment` sets `channelId` if and only if
/// `findChannelBinding` found one). `None` on any other problem, and `None`
/// once a fresh preflight comes back with a channel — so `o` only ever does
/// anything on exactly this one problem.
fn missing_channel_connector(state: &NewWorkloadViewState) -> Option<String> {
    let payment = state.preflight.as_ref()?.payment.as_ref()?;
    if payment.channel_id.is_none() {
        Some(payment.connector_url.clone())
    } else {
        None
    }
}

/// Which of a connector's own chains to offer opening: the one the
/// preflight's `payment.chain` named, if it did and that chain answers
/// `canOpen`, else the first the connector says can be opened at all. The
/// daemon's own "no channel" case does not currently name a chain (every
/// settlement it checked failed to find a binding, so there is no single one
/// to prefer) — this still checks first, both because a later daemon change
/// could start naming one and because it is what the ticket's acceptance
/// criterion asks for.
fn choose_open_chain<'a>(
    preflight: Option<&PreflightView>,
    funding: &'a FundingStatus,
) -> Option<&'a ChainFundingView> {
    let named = preflight
        .and_then(|preflight| preflight.payment.as_ref())
        .and_then(|payment| payment.chain.as_deref());
    if let Some(named) = named {
        if let Some(chain) = funding
            .chains
            .iter()
            .find(|chain| chain.chain == named && chain.can_open)
        {
            return Some(chain);
        }
    }
    funding.chains.iter().find(|chain| chain.can_open)
}

/// Builds and shows the "open a channel with this connector" confirmation,
/// once `connector_funding` has answered and there is a chain to offer.
/// A no-op while one is already open, while the connector no longer has a
/// missing-channel problem (a fresh preflight arrived in the meantime), or
/// while `connector_funding` has nothing openable — `draw_preflight` shows
/// why in each of those cases instead.
fn offer_open_channel_confirm(state: &mut NewWorkloadViewState) {
    if state.channel_confirm.is_some() {
        return;
    }
    let Some(connector) = missing_channel_connector(state) else {
        return;
    };
    let Some(funding) = &state.connector_funding else {
        return;
    };
    let Some(chain) = choose_open_chain(state.preflight.as_ref(), funding) else {
        return;
    };
    let amount_line = match &chain.suggested_deposit {
        Some(amount) => format!(
            "Collateral: {}",
            crate::format::format_chain_amount(chain, amount)
        ),
        None => "Collateral: the connector's own default amount".to_string(),
    };
    let lines = vec![
        format!("Open a payment channel on {} with {connector}", chain.chain),
        amount_line,
        "This locks collateral on chain and pays the chain's own gas for the transaction."
            .to_string(),
    ];
    state.channel_confirm = Some(Confirm::new(
        "Open channel",
        lines,
        OpenChannelPlan {
            chain: chain.chain.clone(),
            connector,
            deposit: chain.suggested_deposit.clone(),
        },
    ));
}

/// Applies `Command::FetchFundingForConnector`'s or
/// `Command::OpenChannelForConnector`'s answer — both are the same
/// `FundingStatus` shape (`api::funding_for_connector`'s doc comment says
/// why), so one function updates `connector_funding` for either. Returns
/// `true` when the chain this wizard is watching (`opening_chain`) has just
/// turned `open` — `main.rs`'s cue to re-run the preflight, since only it
/// knows how to dispatch `PreflightSpawn`/`PreflightStandbySet`.
pub fn apply_connector_funding(
    state: &mut NewWorkloadViewState,
    result: Result<FundingStatus, String>,
) -> bool {
    state.connector_funding_loading = false;
    match result {
        Ok(status) => {
            state.connector_funding_error = None;
            let just_opened = state.opening_chain.as_ref().is_some_and(|chain_id| {
                status
                    .chains
                    .iter()
                    .any(|chain| chain.chain == *chain_id && chain.channel.phase == "open")
            });
            state.connector_funding = Some(status);
            if just_opened {
                state.opening_chain = None;
                state.channel_confirm = None;
                return true;
            }
            offer_open_channel_confirm(state);
            false
        }
        Err(message) => {
            state.connector_funding_error = Some(message);
            false
        }
    }
}

/// True while the chain this wizard asked to open on is still `opening` —
/// the same "poll only while something is happening" gate
/// `views::funds::FundsState::pending` uses for the Funds tab's own funding,
/// extended here to New workload's own connector-scoped read.
fn connector_funding_pending(state: &NewWorkloadViewState) -> bool {
    state.opening_chain.as_ref().is_some_and(|chain_id| {
        state.connector_funding.as_ref().is_some_and(|funding| {
            funding
                .chains
                .iter()
                .any(|chain| chain.chain == *chain_id && chain.channel.phase == "opening")
        })
    })
}

/// The connector to re-read on the next Funds-cadence tick, or `None` when
/// nothing is opening — `main.rs`'s `funding_clock` branch calls this
/// alongside `FundsState::pending`.
pub fn connector_funding_poll(state: &NewWorkloadViewState) -> Option<String> {
    if connector_funding_pending(state) {
        state.connector_funding_url.clone()
    } else {
        None
    }
}

/// Re-sends whichever preflight the wizard is showing — `main.rs` calls this
/// once `apply_connector_funding` reports the watched chain just turned
/// `open`, so the Preflight stage re-checks itself against the daemon rather
/// than trusting the same "no channel" answer it started from.
pub fn retry_preflight(state: &mut NewWorkloadViewState) -> Command {
    start_preflight(state)
}

fn preflight_handle_key(state: &mut NewWorkloadViewState, key: KeyEvent) -> Option<Command> {
    match key.code {
        KeyCode::Backspace => {
            state.stage = Stage::Standbys;
            clear_connector_funding(state);
            Some(Command::None)
        }
        KeyCode::Char('L') => {
            state.local_only = !state.local_only;
            Some(start_preflight(state))
        }
        KeyCode::Char('o') => {
            let Some(connector) = missing_channel_connector(state) else {
                return Some(Command::None);
            };
            state.connector_funding_url = Some(connector.clone());
            state.connector_funding = None;
            state.connector_funding_error = None;
            state.connector_funding_loading = true;
            state.channel_confirm = None;
            Some(Command::FetchFundingForConnector(connector))
        }
        KeyCode::Char('s') => {
            if state.spawning || !preflight_ok(state) {
                return Some(Command::None);
            }
            let action = match build_standby_set_request(state) {
                Some(body) => SpawnAction::StandbySet(Box::new(body)),
                None => match build_template_spawn_request(state) {
                    Some(body) => SpawnAction::Spawn(body),
                    None => return Some(Command::None),
                },
            };
            let lines = preflight_confirm_lines(state);
            state.confirm = Some(Confirm::new("Spawn", lines, action));
            Some(Command::None)
        }
        _ => None,
    }
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

/// Returns the current stage's row hits — the Gallery's Template list or a
/// picker's Listing rows — what a mouse click selects (ADR 0028: "mouse
/// clicks select tabs and rows"). Form and Preflight have no row list of
/// their own, and a confirm open covers whatever hits the stage underneath
/// it would have had, the same rule every other popup here follows.
pub fn draw(
    frame: &mut Frame,
    area: Rect,
    state: &NewWorkloadViewState,
    now_ms: i64,
) -> Vec<(u16, usize)> {
    let hits = match state.stage {
        Stage::Gallery => draw_gallery(frame, area, state),
        Stage::Form => {
            draw_form(frame, area, state);
            Vec::new()
        }
        Stage::Listing => draw_listing(frame, area, state, now_ms),
        Stage::Standbys => draw_standbys(frame, area, state, now_ms),
        Stage::Preflight => {
            draw_preflight(frame, area, state);
            Vec::new()
        }
    };
    if let Some(publish) = &state.publish {
        template_publish::draw(frame, area, publish);
        return Vec::new();
    }
    if let Some(confirm) = &state.channel_confirm {
        crate::widgets::confirm::draw(frame, area, confirm);
        return Vec::new();
    }
    if let Some(confirm) = &state.confirm {
        crate::widgets::confirm::draw(frame, area, confirm);
        return Vec::new();
    }
    hits
}

fn label_span(text: &str) -> Span<'static> {
    Span::styled(
        text.to_string(),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    )
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

fn push_error(lines: &mut Vec<Line<'static>>, errors: &[(FormTarget, String)], target: FormTarget) {
    if let Some((_, message)) = errors.iter().find(|(candidate, _)| *candidate == target) {
        lines.push(error_line(message));
    }
}

fn draw_gallery(frame: &mut Frame, area: Rect, state: &NewWorkloadViewState) -> Vec<(u16, usize)> {
    let rows = gallery_rows(state);
    let title = format!(
        " Templates{} ",
        state
            .gallery_list
            .title_suffix(rows.len(), gallery_total(state))
    );
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    match &state.gallery {
        None => {
            let text = if state.loading_gallery {
                "Reading relays\u{2026}"
            } else if let Some(err) = &state.gallery_error {
                err.as_str()
            } else {
                "Nothing read yet."
            };
            frame.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), inner);
            return Vec::new();
        }
        Some(TemplateGallery::Unconfigured { reason }) => {
            frame.render_widget(
                Paragraph::new(reason.as_str()).wrap(Wrap { trim: false }),
                inner,
            );
            return Vec::new();
        }
        Some(TemplateGallery::Ok { .. }) => {}
    }

    if rows.is_empty() {
        frame.render_widget(
            Paragraph::new("No Template has been published on this network yet.")
                .wrap(Wrap { trim: false }),
            inner,
        );
        return Vec::new();
    }

    let mut lines: Vec<Line> = rows
        .iter()
        .enumerate()
        .map(|(index, template)| template_line(template, index == state.gallery_list.selected))
        .collect();
    if let Some(status) = &state.status {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            status.clone(),
            Style::default().fg(Color::DarkGray),
        )));
    }
    frame.render_widget(Paragraph::new(lines), inner);

    (0..rows.len())
        .map(|index| inner.y + index as u16)
        .take_while(|row| *row < inner.y + inner.height)
        .zip(0..rows.len())
        .collect()
}

fn template_line(template: &TemplateView, selected: bool) -> Line<'static> {
    let available = matches!(
        template.availability,
        TemplateAvailability::Available { .. }
    );
    let marker = if available {
        "available"
    } else {
        "unavailable"
    };
    let style = if selected {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else if available {
        Style::default()
    } else {
        Style::default().fg(Color::DarkGray)
    };
    let publisher = template
        .publisher
        .display_name
        .clone()
        .or_else(|| template.publisher.name.clone())
        .unwrap_or_else(|| template.publisher.npub.clone());
    Line::from(Span::styled(
        format!("{} \u{2014} {publisher} ({marker})", template.name),
        style,
    ))
}

fn draw_form(frame: &mut Frame, area: Rect, state: &NewWorkloadViewState) {
    let title = match &state.template {
        Some(template) => format!(" {} ", template.name),
        None => " Template form ".to_string(),
    };
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let targets = form_targets(state);
    let mut lines: Vec<Line> = Vec::new();

    if let Some(template) = &state.template {
        if !template.env_fixed.is_empty() {
            lines.push(Line::from(Span::styled(
                "Fixed by the publisher:",
                Style::default().fg(Color::DarkGray),
            )));
            for (name, value) in &template.env_fixed {
                lines.push(Line::from(Span::styled(
                    format!("  {name}={value}"),
                    Style::default().fg(Color::DarkGray),
                )));
            }
            lines.push(Line::raw(""));
        }
    }

    for (index, name) in state.form.env_names.iter().enumerate() {
        let target = FormTarget::Env(index);
        let focused = targets.get(state.form.cursor) == Some(&target);
        lines.push(Line::from(vec![
            label_span(&format!("{name}: ")),
            state.form.env_fields[index].value_span(focused),
        ]));
        push_error(&mut lines, &state.form.errors, target);
    }

    if template_offers_ssh(state) {
        let ssh_focused = targets.get(state.form.cursor) == Some(&FormTarget::Ssh);
        lines.push(state.form.ssh.line(ssh_focused));
        push_error(&mut lines, &state.form.errors, FormTarget::Ssh);
    } else if let Some(template) = &state.template {
        lines.push(Line::from(Span::styled(
            format!(
                "{} does not offer SSH, so no key is asked for.",
                template.name
            ),
            Style::default().fg(Color::DarkGray),
        )));
    }

    let volume_focused = targets.get(state.form.cursor) == Some(&FormTarget::Volume);
    lines.push(state.form.volume.line(volume_focused));
    push_error(&mut lines, &state.form.errors, FormTarget::Volume);

    lines.push(Line::raw(""));
    let preview_focused = targets.get(state.form.cursor) == Some(&FormTarget::Preview);
    lines.push(button_line(
        if state.expanding {
            "Expanding\u{2026}"
        } else {
            "Preview the spawn"
        },
        preview_focused,
    ));
    if let Some(err) = &state.expand_error {
        lines.push(error_line(err));
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_listing(
    frame: &mut Frame,
    area: Rect,
    state: &NewWorkloadViewState,
    now_ms: i64,
) -> Vec<(u16, usize)> {
    let block = Block::default()
        .title(" Choose a Listing ")
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if let Some(reason) = &state.directory_error {
        frame.render_widget(
            Paragraph::new(reason.as_str()).wrap(Wrap { trim: false }),
            inner,
        );
        return Vec::new();
    }
    if state.picker.is_empty() {
        frame.render_widget(
            Paragraph::new("No providers loaded yet. Open the Directory view first.")
                .wrap(Wrap { trim: false }),
            inner,
        );
        return Vec::new();
    }
    state.picker.draw(frame, inner, now_ms)
}

fn draw_standbys(
    frame: &mut Frame,
    area: Rect,
    state: &NewWorkloadViewState,
    now_ms: i64,
) -> Vec<(u16, usize)> {
    let added_height = (state.standbys.len() as u16 + 2).max(3);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(added_height), Constraint::Min(3)])
        .split(area);

    let added_block = Block::default()
        .title(" Warm Standbys added ")
        .borders(Borders::ALL);
    let added_inner = added_block.inner(rows[0]);
    frame.render_widget(added_block, rows[0]);
    let added_lines: Vec<Line> = if state.standbys.is_empty() {
        vec![Line::raw(
            "None yet \u{2014} pick one below, or press n to continue without any.",
        )]
    } else {
        state
            .standbys
            .iter()
            .map(|member| {
                Line::from(format!(
                    "{} \u{2014} {}",
                    member.provider_label, member.listing_label
                ))
            })
            .collect()
    };
    frame.render_widget(Paragraph::new(added_lines), added_inner);

    let picker_block = Block::default()
        .title(" Add a Warm Standby \u{2014} Enter adds, d removes the last, n continues ")
        .borders(Borders::ALL);
    let picker_inner = picker_block.inner(rows[1]);
    frame.render_widget(picker_block, rows[1]);
    if state.standby_picker.is_empty() {
        frame.render_widget(
            Paragraph::new("No other provider sells a Warm Standby tier.")
                .wrap(Wrap { trim: false }),
            picker_inner,
        );
        Vec::new()
    } else {
        state.standby_picker.draw(frame, picker_inner, now_ms)
    }
}

fn draw_preflight(frame: &mut Frame, area: Rect, state: &NewWorkloadViewState) {
    let block = Block::default().title(" Preflight ").borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines: Vec<Line> = vec![
        Line::from(vec![
            label_span("Local only: "),
            Span::raw(if state.local_only { "yes" } else { "no" }),
        ]),
        Line::raw(""),
    ];

    if state.preflight_loading {
        lines.push(Line::raw("Pricing\u{2026}"));
    } else if let Some(set) = &state.set_preflight {
        lines.push(Line::from(format!(
            "One workload id, {} member(s), one Root Secret.",
            set.members.len()
        )));
        lines.push(Line::from(match &set.cost {
            Some(cost) => format!("{cost} base units for the first interval at every member."),
            None => "Not every member quoted a price.".to_string(),
        }));
        for member in &set.members {
            let short: String = member.pubkey.chars().take(12).collect();
            lines.push(Line::from(format!(
                "  {} {short}\u{2026} \u{2014} {}",
                member.role,
                if member.view.ok { "ok" } else { "problem" }
            )));
        }
        for problem in &set.problems {
            lines.push(error_line(problem));
        }
    } else if let Some(preflight) = &state.preflight {
        if let Some(route) = &preflight.route {
            lines.push(Line::from(vec![
                label_span("Route: "),
                Span::raw(route.clone()),
            ]));
        }
        if let Some(listing) = &preflight.listing {
            lines.push(Line::from(format!(
                "{} \u{b5}USDC for {} s.",
                listing.price, listing.lease_interval_seconds
            )));
        }
        for problem in &preflight.problems {
            lines.push(error_line(&format!("Problem: {problem}")));
        }
        if let Some(connector) = missing_channel_connector(state) {
            lines.push(Line::raw(""));
            if state.connector_funding_loading {
                lines.push(Line::from(format!("Reading funds at {connector}\u{2026}")));
            } else if let Some(err) = &state.connector_funding_error {
                lines.push(error_line(err));
            } else if connector_funding_pending(state) {
                lines.push(Line::from(Span::styled(
                    format!("Opening a channel with {connector}\u{2026}"),
                    Style::default().fg(Color::Yellow),
                )));
            } else {
                lines.push(Line::from(Span::styled(
                    format!("o opens a channel with {connector}"),
                    Style::default().add_modifier(Modifier::BOLD),
                )));
            }
        }
    } else if let Some(err) = &state.preflight_error {
        lines.push(error_line(err));
    } else {
        lines.push(Line::raw("Nothing priced yet."));
    }

    if let Some(err) = &state.spawn_error {
        lines.push(Line::raw(""));
        lines.push(error_line(err));
    }
    if let Some(status) = &state.status {
        lines.push(Line::from(Span::styled(
            status.clone(),
            Style::default().fg(Color::DarkGray),
        )));
    }

    lines.push(Line::raw(""));
    let ready = preflight_ok(state) && !state.spawning;
    let button_style = if ready {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Green)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    lines.push(Line::from(Span::styled(
        if state.spawning {
            " Spawning\u{2026} "
        } else {
            " s: spawn (asks for confirmation) "
        },
        button_style,
    )));

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

#[cfg(test)]
mod tests {
    #[test]
    fn p_opens_publish_from_a_later_step_but_types_a_p_in_a_field() {
        let mut state = NewWorkloadViewState {
            stage: Stage::Standbys,
            ..Default::default()
        };
        handle_key(
            &mut state,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE),
        );
        assert!(state.publish.is_some());

        let mut state = NewWorkloadViewState {
            stage: Stage::Form,
            ..Default::default()
        };
        state.form.editing = true;
        handle_key(
            &mut state,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE),
        );
        assert!(state.publish.is_none());
    }

    use super::*;
    use crate::types::{
        ListingResources, LivenessView, PreflightListingView, PreflightPayment, PreflightVault,
        ProviderProfileView, PublisherView, RelayWriteTargets, SpawnContent, SpawnContentPort,
        TemplateImage, TemplatePort, TemplateResources,
    };
    use crossterm::event::KeyModifiers;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::collections::BTreeMap;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn publisher() -> PublisherView {
        PublisherView {
            pubkey: "a".repeat(64),
            npub: "npub1testpublisheraddress".to_string(),
            name: Some("acme".to_string()),
            display_name: Some("Acme".to_string()),
            picture: None,
            nip05: None,
        }
    }

    fn available_template(name: &str) -> TemplateView {
        let mut env_fixed = BTreeMap::new();
        env_fixed.insert("MODE".to_string(), "production".to_string());
        TemplateView {
            name: name.to_string(),
            address: format!("30436:{}:{name}", publisher().pubkey),
            publisher: publisher(),
            version: 1,
            image: TemplateImage {
                digest: "sha256:aa".repeat(8),
                registry_entry: None,
            },
            ports: vec![TemplatePort {
                container_port: 8080,
                protocol: "tcp".to_string(),
            }],
            data_path: None,
            env_fixed,
            env_tenant: vec!["MODE".to_string(), "SITE_TITLE".to_string()],
            min_resources: Some(TemplateResources {
                cpu_millicores: 500,
                memory_mb: 512,
                storage_gb: 5,
                gpu: None,
            }),
            ssh_offered: true,
            availability: TemplateAvailability::Available {
                checked: "1 image entry".to_string(),
                entry: None,
                blob_record: None,
            },
            warnings: Vec::new(),
            published_at: "2026-09-24T00:00:00.000Z".to_string(),
            event_id: "e".repeat(64),
        }
    }

    fn unavailable_template(name: &str) -> TemplateView {
        let mut template = available_template(name);
        template.availability = TemplateAvailability::Unavailable {
            reason: "no relay carries this image".to_string(),
        };
        template
    }

    fn gallery(templates: Vec<TemplateView>) -> TemplateGallery {
        TemplateGallery::Ok {
            relays: crate::types::TemplateRelays {
                seed: vec!["wss://relay.test".to_string()],
                read: Vec::new(),
            },
            templates,
            rejected: Vec::new(),
            rejected_events: 0,
            read_at: "2026-09-24T00:00:00.000Z".to_string(),
        }
    }

    fn provider(pubkey: &str, with_standby: bool) -> ProviderView {
        ProviderView {
            pubkey: pubkey.to_string(),
            profile: ProviderProfileView {
                ilp_address: "g.toon.provider".to_string(),
                connector_url: "https://provider.example/ilp".to_string(),
                connector_seal_key: "0x04aa".to_string(),
                relays: Vec::new(),
                settlement: Vec::new(),
                isolation: "shared-kernel".to_string(),
                hidden: false,
                host: None,
                liveness_cadence_seconds: None,
                published_at: "2026-09-24T00:00:00.000Z".to_string(),
                event_id: "f".repeat(64),
            },
            liveness: LivenessView {
                state: "live".to_string(),
                published_at: None,
                expires_at: None,
                seconds_until_expiry: None,
                cadence_seconds: None,
            },
            listings: vec![ListingView {
                name: "basic".to_string(),
                address: format!("30432:{pubkey}:basic"),
                version: 1,
                resources: ListingResources {
                    cpu_millicores: 1000,
                    memory_mb: 1024,
                    storage_gb: 10,
                    gpu: None,
                },
                arch: "amd64".to_string(),
                isolation: "shared-kernel".to_string(),
                hidden: false,
                lease_interval_seconds: 3600,
                price: 1000,
                standby_price: if with_standby { Some(200) } else { None },
                capabilities: Vec::new(),
                unspecified_capabilities: Vec::new(),
                geohash: None,
                published_at: "2026-09-24T00:00:00.000Z".to_string(),
                event_id: "e".repeat(64),
                available: None,
            }],
            relays_read: Vec::new(),
            superseded_listings: 0,
            rejected_listings: Vec::new(),
        }
    }

    fn settings(template: &TemplateView) -> ExpandTemplateRequest {
        ExpandTemplateRequest {
            template: template.address.clone(),
            env: Some(
                [("GREETING".to_string(), "hello".to_string())]
                    .into_iter()
                    .collect(),
            ),
            ssh_public_key: "ssh-ed25519 AAAA test".to_string(),
            volume_gb: Some(2),
        }
    }

    fn expansion(template: &TemplateView) -> ExpandedTemplate {
        ExpandedTemplate {
            template: template.address.clone(),
            spawn: SpawnContent {
                workload_id: "w".repeat(64),
                image: SpawnContentImage {
                    digest: template.image.digest.clone(),
                    reference: Some("traefik/whoami".to_string()),
                    registry_entry: None,
                },
                env: BTreeMap::from([("MODE".to_string(), "production".to_string())]),
                ports: vec![SpawnContentPort {
                    container_port: 8080,
                    protocol: "tcp".to_string(),
                }],
                volume_gb: None,
                ssh_public_key: "ssh-ed25519 AAAA".to_string(),
                entrypoint: None,
                args: None,
                standby_set: None,
                template: Some(template.address.clone()),
            },
            ssh_offered: template.ssh_offered,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn opening_an_available_template_moves_to_the_form_stage() {
        let mut state = NewWorkloadViewState::new();
        state.gallery = Some(gallery(vec![available_template("static-site")]));
        let command = gallery_handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(command, Some(Command::None));
        assert_eq!(state.stage, Stage::Form);
        assert!(state.template.is_some());
        assert_eq!(state.form.env_names, vec!["SITE_TITLE".to_string()]);
    }

    #[test]
    fn opening_an_unavailable_template_stays_on_the_gallery() {
        let mut state = NewWorkloadViewState::new();
        state.gallery = Some(gallery(vec![unavailable_template("broken")]));
        gallery_handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(state.stage, Stage::Gallery);
        assert!(state.status.unwrap().contains("Not offered"));
    }

    #[test]
    fn r_refreshes_the_gallery() {
        let mut state = NewWorkloadViewState::new();
        assert_eq!(
            gallery_handle_key(&mut state, key(KeyCode::Char('r'))),
            Some(Command::RefreshTemplates)
        );
    }

    // -- paste routing (TOON_Network#138) -------------------------------

    #[test]
    fn paste_lands_in_the_focused_form_field_while_editing() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Form;
        state.template = Some(available_template("static-site"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        // The SSH field, per `form_targets`: every env field, then Ssh,
        // Volume, Preview.
        state.form.cursor = state.form.env_names.len();
        form_handle_key(&mut state, key(KeyCode::Enter));
        assert!(state.form.editing);

        handle_paste(&mut state, "ssh-ed25519 AAAApasted\n");
        assert_eq!(state.form.ssh.value(), "ssh-ed25519 AAAApasted");
    }

    #[test]
    fn paste_is_ignored_on_the_gallery_stage() {
        let mut state = NewWorkloadViewState::new();
        assert_eq!(state.stage, Stage::Gallery);
        handle_paste(&mut state, "not typed anywhere");
        // Nothing to assert against but that this does not panic and that
        // no field exists to have received it — the Form stage's own field
        // is the only place a paste could land, and it is not even built
        // yet on the Gallery stage.
    }

    #[test]
    fn ctrl_v_while_editing_the_form_asks_for_a_clipboard_paste_instead_of_typing_v() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(available_template("static-site"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        state.form.cursor = state.form.env_names.len();
        form_handle_key(&mut state, key(KeyCode::Enter));
        assert!(state.form.editing);

        let command = form_handle_key(
            &mut state,
            KeyEvent::new(KeyCode::Char('v'), KeyModifiers::CONTROL),
        );
        assert_eq!(command, Some(Command::RequestClipboardPaste));
        assert!(state.form.ssh.is_empty(), "Ctrl+V must not type a 'v'");
    }

    // -- copyables (TOON_Network#138) ------------------------------------

    #[test]
    fn copyables_is_empty_before_a_template_is_chosen() {
        let state = NewWorkloadViewState::new();
        assert_eq!(copyables(&state), Vec::new());
    }

    #[test]
    fn copyables_offers_the_chosen_templates_image_content_address() {
        let mut state = NewWorkloadViewState::new();
        let mut template = available_template("static-site");
        template.availability = TemplateAvailability::Available {
            checked: "1 image entry".to_string(),
            entry: Some(crate::types::TemplateImageEntry {
                address: "30433:pk:static-site-image".to_string(),
                canonical_name: "static-site".to_string(),
                blobs: vec![],
            }),
            blob_record: None,
        };
        state.template = Some(template);
        assert_eq!(
            copyables(&state),
            vec![(
                "Image content address".to_string(),
                "30433:pk:static-site-image".to_string()
            )]
        );
    }

    #[test]
    fn copyables_is_empty_when_the_image_could_not_be_resolved() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(unavailable_template("static-site"));
        assert_eq!(copyables(&state), Vec::new());
    }

    #[test]
    fn preview_with_no_ssh_key_reports_a_validation_error_beside_the_field() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(available_template("static-site"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        state.form.cursor = form_targets(&state).len() - 1; // Preview
        let command = form_handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(command, Some(Command::None));
        assert!(state
            .form
            .errors
            .iter()
            .any(|(target, _)| *target == FormTarget::Ssh));
        assert!(!state.expanding);
    }

    #[test]
    fn preview_with_a_non_numeric_volume_reports_a_validation_error() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(available_template("static-site"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        for c in "ssh-ed25519 AAAA".chars() {
            state.form.ssh.handle_key(key(KeyCode::Char(c)));
        }
        for c in "lots".chars() {
            state.form.volume.handle_key(key(KeyCode::Char(c)));
        }
        state.form.cursor = form_targets(&state).len() - 1;
        form_handle_key(&mut state, key(KeyCode::Enter));
        assert!(state
            .form
            .errors
            .iter()
            .any(|(target, _)| *target == FormTarget::Volume));
    }

    #[test]
    fn a_valid_form_sends_expand_template() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(available_template("static-site"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        for c in "ssh-ed25519 AAAA".chars() {
            state.form.ssh.handle_key(key(KeyCode::Char(c)));
        }
        state.form.cursor = form_targets(&state).len() - 1;
        let command = form_handle_key(&mut state, key(KeyCode::Enter));
        match command {
            Some(Command::ExpandTemplate(request)) => {
                assert_eq!(request.ssh_public_key, "ssh-ed25519 AAAA");
                assert!(request.template.contains("static-site"));
            }
            other => panic!("expected ExpandTemplate, got {other:?}"),
        }
        assert!(state.expanding);
        assert!(state.form.errors.is_empty());
    }

    /* -------------------------------------------------------------------- */
    /* A Template that does not offer SSH (TOON_Network#138)                 */
    /* -------------------------------------------------------------------- */

    fn no_ssh_template(name: &str) -> TemplateView {
        let mut template = available_template(name);
        template.ssh_offered = false;
        template
    }

    #[test]
    fn the_form_asks_for_no_ssh_key_when_the_template_does_not_offer_it() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(no_ssh_template("smoke-http"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        assert!(!form_targets(&state).contains(&FormTarget::Ssh));
    }

    #[test]
    fn preview_sends_no_key_and_no_error_when_the_template_does_not_offer_ssh() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(no_ssh_template("smoke-http"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        // The last target is still "Preview" — SSH was never in the list.
        state.form.cursor = form_targets(&state).len() - 1;
        let command = form_handle_key(&mut state, key(KeyCode::Enter));
        match command {
            Some(Command::ExpandTemplate(request)) => {
                assert_eq!(request.ssh_public_key, "");
            }
            other => panic!("expected ExpandTemplate, got {other:?}"),
        }
        assert!(state.form.errors.is_empty());
        assert!(state.expanding);
    }

    #[test]
    fn choosing_a_listing_moves_to_standbys_and_seeds_its_candidates() {
        let mut state = NewWorkloadViewState::new();
        state.all_providers = vec![
            provider(&"1".repeat(64), true),
            provider(&"2".repeat(64), true),
        ];
        state.picker.set_providers(state.all_providers.clone());
        let command = listing_handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(command, Some(Command::None));
        assert_eq!(state.stage, Stage::Standbys);
        // The primary itself must not be offered as its own standby.
        assert!(!state.standby_picker.is_empty());
    }

    #[test]
    fn adding_and_removing_a_standby() {
        let mut state = NewWorkloadViewState::new();
        state.all_providers = vec![
            provider(&"1".repeat(64), true),
            provider(&"2".repeat(64), true),
        ];
        state.picker.set_providers(state.all_providers.clone());
        listing_handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(state.standbys.len(), 0);

        standbys_handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(state.standbys.len(), 1);

        standbys_handle_key(&mut state, key(KeyCode::Char('d')));
        assert_eq!(state.standbys.len(), 0);
    }

    #[test]
    fn continuing_with_no_standbys_preflights_a_plain_spawn() {
        let mut state = NewWorkloadViewState::new();
        let template = available_template("static-site");
        state.expansion = Some(expansion(&template));
        state.expanded_with = Some(settings(&template));
        state.template = Some(template);
        state.all_providers = vec![provider(&"1".repeat(64), false)];
        state.picker.set_providers(state.all_providers.clone());
        listing_handle_key(&mut state, key(KeyCode::Enter));

        let command = standbys_handle_key(&mut state, key(KeyCode::Char('n')));
        assert_eq!(state.stage, Stage::Preflight);
        match command {
            Some(Command::PreflightSpawn(body)) => {
                assert_eq!(body.provider, "1".repeat(64));
                assert_eq!(body.ssh_public_key, "ssh-ed25519 AAAA");
            }
            other => panic!("expected PreflightSpawn, got {other:?}"),
        }
    }

    #[test]
    fn continuing_with_a_standby_preflights_a_standby_set() {
        let mut state = NewWorkloadViewState::new();
        let template = available_template("static-site");
        state.expansion = Some(expansion(&template));
        state.expanded_with = Some(settings(&template));
        state.template = Some(template);
        state.all_providers = vec![
            provider(&"1".repeat(64), true),
            provider(&"2".repeat(64), true),
        ];
        state.picker.set_providers(state.all_providers.clone());
        listing_handle_key(&mut state, key(KeyCode::Enter));
        standbys_handle_key(&mut state, key(KeyCode::Enter)); // add one

        let command = standbys_handle_key(&mut state, key(KeyCode::Char('n')));
        match command {
            Some(Command::PreflightStandbySet(body)) => {
                assert_eq!(body.standbys.len(), 1);
            }
            other => panic!("expected PreflightStandbySet, got {other:?}"),
        }
    }

    fn ready_preflight() -> PreflightView {
        PreflightView {
            ok: true,
            problems: Vec::new(),
            provider: None,
            listing: Some(PreflightListingView {
                name: "basic".to_string(),
                version: 1,
                lease_interval_seconds: 3600,
                price: 1000,
                capabilities: Vec::new(),
            }),
            route: Some("g.toon.provider.basic.v1.spawn".to_string()),
            payment: None,
            vault: PreflightVault {
                local_only: false,
                writes: RelayWriteTargets {
                    relays: Vec::new(),
                    plan: Vec::new(),
                    destination: None,
                    pay_at: None,
                    price: None,
                    total_price: None,
                    ready: true,
                    blocked_by: None,
                },
            },
        }
    }

    #[test]
    fn s_does_nothing_until_the_preflight_is_ok() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        let command = preflight_handle_key(&mut state, key(KeyCode::Char('s')));
        assert_eq!(command, Some(Command::None));
        assert!(state.confirm.is_none());
    }

    #[test]
    fn s_opens_a_confirmation_once_the_preflight_is_ok() {
        let mut state = NewWorkloadViewState::new();
        let template = available_template("static-site");
        state.expansion = Some(expansion(&template));
        state.expanded_with = Some(settings(&template));
        state.template = Some(template);
        state.all_providers = vec![provider(&"1".repeat(64), false)];
        state.picker.set_providers(state.all_providers.clone());
        state.stage = Stage::Preflight;
        state.preflight = Some(ready_preflight());

        preflight_handle_key(&mut state, key(KeyCode::Char('s')));
        assert!(state.confirm.is_some());

        // A single Enter (no typed "yes") must not confirm — the same rule
        // every other spending action in this crate follows. Goes through
        // the top-level dispatcher, which is what actually routes a key to
        // the open `Confirm` (`preflight_handle_key` alone never sees it).
        let command = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(command, Some(Command::None));
        assert!(state.spawn_error.is_none());
        assert!(!state.spawning);
    }

    #[test]
    fn typing_yes_then_enter_confirms_and_spawns() {
        let mut state = NewWorkloadViewState::new();
        let template = available_template("static-site");
        state.expansion = Some(expansion(&template));
        state.expanded_with = Some(settings(&template));
        state.template = Some(template);
        state.all_providers = vec![provider(&"1".repeat(64), false)];
        state.picker.set_providers(state.all_providers.clone());
        state.stage = Stage::Preflight;
        state.preflight = Some(ready_preflight());

        preflight_handle_key(&mut state, key(KeyCode::Char('s')));
        for c in "yes".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        let command = handle_key(&mut state, key(KeyCode::Enter));
        match command {
            Some(Command::SpawnFromTemplate(body)) => assert_eq!(body.provider, "1".repeat(64)),
            other => panic!("expected SpawnFromTemplate, got {other:?}"),
        }
        assert!(state.spawning);
    }

    /// TOON_Network#149: a spawn from a Template went to `POST
    /// /api/leases/spawn`, which has no `template` field — so the lease's
    /// vault record never named the Template it came from, and a recovered
    /// lease could not say either. The confirmed spawn now names the Template,
    /// the settings its expansion was asked for and the Listing's version,
    /// which is what `POST /api/templates/spawn` buys with.
    #[test]
    fn a_confirmed_spawn_names_its_template_its_settings_and_the_listing_version() {
        let mut state = NewWorkloadViewState::new();
        let template = available_template("static-site");
        let asked = settings(&template);
        state.expansion = Some(expansion(&template));
        state.expanded_with = Some(asked.clone());
        state.template = Some(template.clone());
        state.all_providers = vec![provider(&"1".repeat(64), false)];
        state.picker.set_providers(state.all_providers.clone());
        state.stage = Stage::Preflight;
        state.preflight = Some(ready_preflight());
        let (_, listing) = state
            .picker
            .selected_listing()
            .expect("a listing is selected");
        let listing = listing.clone();

        preflight_handle_key(&mut state, key(KeyCode::Char('s')));
        for c in "yes".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        match handle_key(&mut state, key(KeyCode::Enter)) {
            Some(Command::SpawnFromTemplate(body)) => {
                assert_eq!(body.template, template.address);
                assert_eq!(body.listing, listing.name);
                assert_eq!(body.listing_version, listing.version);
                assert_eq!(body.env, asked.env);
                assert_eq!(body.ssh_public_key, asked.ssh_public_key);
                assert_eq!(body.volume_gb, asked.volume_gb);
                assert_eq!(body.local_only, None);
            }
            other => panic!("expected SpawnFromTemplate, got {other:?}"),
        }
    }

    #[test]
    fn l_reset_toggles_local_only_and_reprices() {
        let mut state = NewWorkloadViewState::new();
        let template = available_template("static-site");
        state.expansion = Some(expansion(&template));
        state.expanded_with = Some(settings(&template));
        state.template = Some(template);
        state.all_providers = vec![provider(&"1".repeat(64), false)];
        state.picker.set_providers(state.all_providers.clone());
        state.stage = Stage::Preflight;
        assert!(!state.local_only);
        let command = preflight_handle_key(&mut state, key(KeyCode::Char('L')));
        assert!(state.local_only);
        assert!(matches!(command, Some(Command::PreflightSpawn(_))));
    }

    // -- "Open a channel with this connector" (TOON_Network#138) -----------

    fn preflight_missing_channel(chain: Option<&str>) -> PreflightView {
        let mut preflight = ready_preflight();
        preflight.ok = false;
        preflight.problems = vec![
            "No payment channel with the connector at https://provider.example/ilp.".to_string(),
        ];
        preflight.payment = Some(PreflightPayment {
            connector_url: "https://provider.example/ilp".to_string(),
            via: "provider-connector".to_string(),
            reason: "no route carries it".to_string(),
            chain: chain.map(str::to_string),
            channel_id: None,
            route_price: None,
            over_anon: None,
            rpc_over_anon: None,
        });
        preflight
    }

    fn open_chain(chain: &str, can_open: bool) -> ChainFundingView {
        use crate::types::{Amount, BalanceView, ChainAddress, GasView, RpcRef, TokenRef};
        ChainFundingView {
            chain: chain.to_string(),
            kind: "evm".to_string(),
            counterparty: "0xsettlement".to_string(),
            token: TokenRef {
                address: "0xusdc".to_string(),
                decimals: 6,
            },
            deposit: ChainAddress {
                address: "0xdeposit".to_string(),
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
                    decimals: Some(6),
                    symbol: Some("USDC".to_string()),
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
            channel: crate::types::ChannelView {
                phase: "none".to_string(),
                channel_id: None,
                deposit: None,
                spent: None,
                available: None,
                nonce: None,
                opened_at: None,
                started_at: None,
                tx_hash: None,
                reason: None,
                out_of_gas: None,
                watermark_uncertain: None,
            },
            can_open,
            blocked_by: None,
            suggested_deposit: Some("1000000".to_string()),
        }
    }

    fn connector_funding(chains: Vec<ChainFundingView>) -> FundingStatus {
        use crate::types::{CustodyView, FundingProfileRef};
        FundingStatus {
            state: "ready".to_string(),
            profile: FundingProfileRef {
                id: "sandbox".to_string(),
                label: "Local sandbox".to_string(),
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
    fn missing_channel_connector_is_none_when_the_preflight_is_ok() {
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(ready_preflight());
        assert_eq!(missing_channel_connector(&state), None);
    }

    #[test]
    fn missing_channel_connector_reads_the_payment_field_not_the_problem_text() {
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(preflight_missing_channel(None));
        assert_eq!(
            missing_channel_connector(&state),
            Some("https://provider.example/ilp".to_string())
        );
    }

    #[test]
    fn missing_channel_connector_is_none_once_a_channel_id_is_present() {
        // The real "ok" fixture (`leases-preflight.json`): `payment` is set,
        // but `channelId` is too — the ordinary, funded case, where `o` must
        // do nothing.
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(real_fixture::<PreflightView>("leases-preflight"));
        assert_eq!(missing_channel_connector(&state), None);
    }

    #[test]
    fn o_does_nothing_when_the_preflight_has_no_missing_channel_problem() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        state.preflight = Some(ready_preflight());
        let command = preflight_handle_key(&mut state, key(KeyCode::Char('o')));
        assert_eq!(command, Some(Command::None));
        assert!(state.connector_funding_url.is_none());
    }

    #[test]
    fn o_reads_funding_scoped_to_the_connector_the_preflight_named() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        state.preflight = Some(preflight_missing_channel(None));
        let command = preflight_handle_key(&mut state, key(KeyCode::Char('o')));
        assert_eq!(
            command,
            Some(Command::FetchFundingForConnector(
                "https://provider.example/ilp".to_string()
            ))
        );
        assert!(state.connector_funding_loading);
        assert_eq!(
            state.connector_funding_url.as_deref(),
            Some("https://provider.example/ilp")
        );
    }

    #[test]
    fn choose_open_chain_prefers_the_chain_the_preflight_named() {
        let preflight = preflight_missing_channel(Some("solana"));
        let funding = connector_funding(vec![
            open_chain("evm:31337", true),
            open_chain("solana", true),
        ]);
        let chosen = choose_open_chain(Some(&preflight), &funding).expect("a chain can open");
        assert_eq!(chosen.chain, "solana");
    }

    #[test]
    fn choose_open_chain_falls_back_to_the_first_openable_chain() {
        // The daemon's real "no channel" answer never names a chain (every
        // settlement it checked failed to find a binding) — this is that
        // case.
        let preflight = preflight_missing_channel(None);
        let funding = connector_funding(vec![
            open_chain("evm:31337", false),
            open_chain("solana", true),
        ]);
        let chosen = choose_open_chain(Some(&preflight), &funding).expect("a chain can open");
        assert_eq!(chosen.chain, "solana");
    }

    #[test]
    fn choose_open_chain_ignores_a_named_chain_that_cannot_open() {
        let preflight = preflight_missing_channel(Some("evm:31337"));
        let funding = connector_funding(vec![
            open_chain("evm:31337", false),
            open_chain("solana", true),
        ]);
        let chosen = choose_open_chain(Some(&preflight), &funding).expect("a chain can open");
        assert_eq!(chosen.chain, "solana");
    }

    #[test]
    fn apply_connector_funding_offers_a_confirmation_naming_the_connector_chain_and_deposit() {
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(preflight_missing_channel(None));
        state.connector_funding_url = Some("https://provider.example/ilp".to_string());
        state.connector_funding_loading = true;

        let just_opened = apply_connector_funding(
            &mut state,
            Ok(connector_funding(vec![open_chain("evm:31337", true)])),
        );
        assert!(!just_opened);
        assert!(!state.connector_funding_loading);
        let confirm = state.channel_confirm.as_ref().expect("a confirm is shown");
        assert!(confirm
            .lines
            .iter()
            .any(|line| line.contains("https://provider.example/ilp")));
        assert!(confirm.lines.iter().any(|line| line.contains("evm:31337")));
        assert!(confirm.lines.iter().any(|line| line.contains("USDC")));
    }

    #[test]
    fn apply_connector_funding_offers_nothing_when_no_chain_can_open() {
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(preflight_missing_channel(None));
        state.connector_funding_url = Some("https://provider.example/ilp".to_string());

        apply_connector_funding(
            &mut state,
            Ok(connector_funding(vec![open_chain("evm:31337", false)])),
        );
        assert!(state.channel_confirm.is_none());
    }

    #[test]
    fn apply_connector_funding_records_an_error() {
        let mut state = NewWorkloadViewState::new();
        state.connector_funding_loading = true;
        apply_connector_funding(&mut state, Err("connector did not answer".to_string()));
        assert_eq!(
            state.connector_funding_error.as_deref(),
            Some("connector did not answer")
        );
        assert!(!state.connector_funding_loading);
    }

    #[test]
    fn confirming_yes_then_enter_issues_open_channel_for_connector_and_not_a_single_keypress() {
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(preflight_missing_channel(None));
        state.connector_funding_url = Some("https://provider.example/ilp".to_string());
        apply_connector_funding(
            &mut state,
            Ok(connector_funding(vec![open_chain("evm:31337", true)])),
        );
        assert!(state.channel_confirm.is_some());

        // Enter alone must not confirm.
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Enter)),
            Some(Command::None)
        );
        assert!(state.channel_confirm.is_some());

        for c in "yes".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        let command = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(
            command,
            Some(Command::OpenChannelForConnector {
                chain: "evm:31337".to_string(),
                deposit: Some("1000000".to_string()),
                connector: "https://provider.example/ilp".to_string(),
            })
        );
        assert!(state.channel_confirm.is_none());
        assert_eq!(state.opening_chain.as_deref(), Some("evm:31337"));
    }

    #[test]
    fn esc_cancels_the_channel_confirmation_without_issuing_a_command() {
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(preflight_missing_channel(None));
        state.connector_funding_url = Some("https://provider.example/ilp".to_string());
        apply_connector_funding(
            &mut state,
            Ok(connector_funding(vec![open_chain("evm:31337", true)])),
        );
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Esc)),
            Some(Command::None)
        );
        assert!(state.channel_confirm.is_none());
    }

    #[test]
    fn apply_connector_funding_reports_just_opened_once_the_watched_chain_turns_open() {
        let mut state = NewWorkloadViewState::new();
        state.opening_chain = Some("evm:31337".to_string());
        state.connector_funding = Some(connector_funding(vec![{
            let mut chain = open_chain("evm:31337", true);
            chain.channel.phase = "opening".to_string();
            chain
        }]));
        state.channel_confirm = Some(Confirm::new(
            "Open channel",
            vec![],
            OpenChannelPlan {
                chain: "evm:31337".to_string(),
                connector: "https://provider.example/ilp".to_string(),
                deposit: None,
            },
        ));

        let just_opened = apply_connector_funding(
            &mut state,
            Ok(connector_funding(vec![{
                let mut chain = open_chain("evm:31337", true);
                chain.channel.phase = "open".to_string();
                chain
            }])),
        );
        assert!(just_opened);
        assert!(state.opening_chain.is_none());
        assert!(state.channel_confirm.is_none());
    }

    #[test]
    fn connector_funding_poll_is_none_until_something_is_opening() {
        let mut state = NewWorkloadViewState::new();
        assert_eq!(connector_funding_poll(&state), None);

        state.opening_chain = Some("evm:31337".to_string());
        state.connector_funding_url = Some("https://provider.example/ilp".to_string());
        state.connector_funding = Some(connector_funding(vec![{
            let mut chain = open_chain("evm:31337", true);
            chain.channel.phase = "opening".to_string();
            chain
        }]));
        assert_eq!(
            connector_funding_poll(&state),
            Some("https://provider.example/ilp".to_string())
        );

        // Turns `open`: no longer pending, nothing left to poll for.
        state.connector_funding = Some(connector_funding(vec![{
            let mut chain = open_chain("evm:31337", true);
            chain.channel.phase = "open".to_string();
            chain
        }]));
        assert_eq!(connector_funding_poll(&state), None);
    }

    #[test]
    fn retry_preflight_reissues_the_plain_spawn_preflight() {
        let mut state = NewWorkloadViewState::new();
        let template = available_template("static-site");
        state.expansion = Some(expansion(&template));
        state.expanded_with = Some(settings(&template));
        state.template = Some(template);
        state.all_providers = vec![provider(&"1".repeat(64), false)];
        state.picker.set_providers(state.all_providers.clone());

        match retry_preflight(&mut state) {
            Command::PreflightSpawn(body) => assert_eq!(body.provider, "1".repeat(64)),
            other => panic!("expected PreflightSpawn, got {other:?}"),
        }
        assert!(state.preflight_loading);
    }

    #[test]
    fn backspace_off_the_preflight_stage_clears_the_connector_funding_state() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        state.preflight = Some(preflight_missing_channel(None));
        state.connector_funding_url = Some("https://provider.example/ilp".to_string());
        state.connector_funding = Some(connector_funding(vec![open_chain("evm:31337", true)]));

        preflight_handle_key(&mut state, key(KeyCode::Backspace));
        assert_eq!(state.stage, Stage::Standbys);
        assert!(state.connector_funding_url.is_none());
        assert!(state.connector_funding.is_none());
    }

    #[test]
    fn draws_the_open_channel_hint_and_the_confirmation_without_panicking() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        state.preflight = Some(preflight_missing_channel(None));
        render(&state);

        state.connector_funding_url = Some("https://provider.example/ilp".to_string());
        apply_connector_funding(
            &mut state,
            Ok(connector_funding(vec![open_chain("evm:31337", true)])),
        );
        assert!(state.channel_confirm.is_some());
        let hits = {
            let backend = TestBackend::new(120, 30);
            let mut terminal = Terminal::new(backend).unwrap();
            let mut hits = Vec::new();
            terminal
                .draw(|frame| {
                    hits = draw(frame, frame.area(), &state, 0);
                })
                .unwrap();
            hits
        };
        assert!(hits.is_empty(), "a confirm popup covers every row hit");
    }

    #[test]
    fn renders_the_real_no_channel_preflight_fixture_without_panicking() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        state.preflight = Some(real_fixture::<PreflightView>("leases-preflight-no-channel"));
        render(&state);
    }

    #[test]
    fn a_real_connector_funding_fixture_offers_an_open_channel_confirmation() {
        let mut state = NewWorkloadViewState::new();
        state.preflight = Some(real_fixture::<PreflightView>("leases-preflight-no-channel"));
        state.connector_funding_url = Some("https://provider.example/ilp".to_string());
        let funding: FundingStatus = real_fixture("funding-connector");
        apply_connector_funding(&mut state, Ok(funding));
        assert!(state.channel_confirm.is_some());
    }

    #[test]
    fn backspace_walks_back_a_stage_at_every_step() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Form;
        state.form = FormFields::new(&available_template("x"));
        form_handle_key(&mut state, key(KeyCode::Backspace));
        assert_eq!(state.stage, Stage::Gallery);

        state.stage = Stage::Listing;
        listing_handle_key(&mut state, key(KeyCode::Backspace));
        assert_eq!(state.stage, Stage::Form);

        state.stage = Stage::Standbys;
        standbys_handle_key(&mut state, key(KeyCode::Backspace));
        assert_eq!(state.stage, Stage::Listing);

        state.stage = Stage::Preflight;
        preflight_handle_key(&mut state, key(KeyCode::Backspace));
        assert_eq!(state.stage, Stage::Standbys);
    }

    #[test]
    fn reset_wizard_returns_to_the_gallery_and_clears_the_form() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        state.template = Some(available_template("static-site"));
        state.standbys.push(StandbyMember {
            provider_pubkey: "1".repeat(64),
            provider_label: "g.toon.provider".to_string(),
            listing_name: "basic".to_string(),
            listing_label: "basic v1".to_string(),
        });
        reset_wizard(&mut state, "Spawned.");
        assert_eq!(state.stage, Stage::Gallery);
        assert!(state.template.is_none());
        assert!(state.standbys.is_empty());
        assert_eq!(state.status.as_deref(), Some("Spawned."));
    }

    fn render(state: &NewWorkloadViewState) -> String {
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw(frame, frame.area(), state, 0);
            })
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

    // ---- mouse row hits (ADR 0028: "mouse clicks select tabs and rows") ---

    #[test]
    fn gallery_draw_hits_index_into_the_template_list() {
        let mut state = NewWorkloadViewState::new();
        state.gallery = Some(gallery(vec![
            available_template("static-site"),
            unavailable_template("broken-image"),
        ]));
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|frame| {
                hits = draw(frame, frame.area(), &state, 0);
            })
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].1, 0);
        assert_eq!(hits[1].1, 1);
    }

    #[test]
    fn listing_stage_draw_hits_come_from_the_embedded_picker() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Listing;
        state.all_providers = vec![
            provider(&"1".repeat(64), true),
            provider(&"2".repeat(64), true),
        ];
        state.picker.set_providers(state.all_providers.clone());
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|frame| {
                hits = draw(frame, frame.area(), &state, 0);
            })
            .unwrap();
        // Two providers, one listing each: two Header rows, two Listing rows.
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn form_and_preflight_stages_have_no_row_hits() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(available_template("static-site"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        state.stage = Stage::Form;
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|frame| {
                hits = draw(frame, frame.area(), &state, 0);
            })
            .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn a_click_on_a_picker_row_only_selects_it_never_chooses() {
        let mut state = NewWorkloadViewState::new();
        state.all_providers = vec![
            provider(&"1".repeat(64), true),
            provider(&"2".repeat(64), true),
        ];
        state.picker.set_providers(state.all_providers.clone());
        state.picker.select(2); // the second provider's Listing row
        assert_eq!(
            state.stage,
            Stage::Gallery,
            "a click never advances the stage"
        );
    }

    #[test]
    fn snapshot_gallery() {
        let mut state = NewWorkloadViewState::new();
        state.gallery = Some(gallery(vec![
            available_template("static-site"),
            unavailable_template("broken-image"),
        ]));
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_form_with_a_validation_error() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(available_template("static-site"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        state.form.cursor = form_targets(&state).len() - 1;
        state.stage = Stage::Form;
        form_handle_key(&mut state, key(KeyCode::Enter)); // no SSH key typed yet
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_form_for_a_template_that_offers_no_ssh() {
        let mut state = NewWorkloadViewState::new();
        state.template = Some(no_ssh_template("smoke-http"));
        state.form = FormFields::new(state.template.as_ref().unwrap());
        state.stage = Stage::Form;
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_preflight() {
        let mut state = NewWorkloadViewState::new();
        state.stage = Stage::Preflight;
        state.preflight = Some(ready_preflight());
        insta::assert_snapshot!(render(&state));
    }

    fn real_fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read fixture {path}: {err}"));
        serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture {path} did not deserialize: {err}"))
    }

    /// The daemon's own real, volatile answers must still render without
    /// panicking — no snapshot assertion here (the addresses and timestamps
    /// differ on every regeneration, see `api-fixtures.testkit.ts`), just
    /// proof this view survives contact with the real shapes
    /// `packages/daemon` produces today, not only the tidy ones made up
    /// above (same rule as `views::health`'s and `views::workloads`' own
    /// tests of this name).
    #[test]
    fn renders_the_real_daemon_fixtures_without_panicking() {
        let mut state = NewWorkloadViewState::new();
        state.gallery = Some(real_fixture::<TemplateGallery>("templates"));
        render(&state);

        state.stage = Stage::Form;
        if let Some(TemplateGallery::Ok { templates, .. }) = &state.gallery {
            if let Some(template) = templates.first() {
                state.form = FormFields::new(template);
                state.template = Some(template.clone());
            }
        }
        render(&state);

        state.stage = Stage::Preflight;
        state.preflight = Some(real_fixture::<PreflightView>("leases-preflight"));
        render(&state);
    }

    #[test]
    fn a_real_expansion_builds_a_real_spawn_request() {
        let mut state = NewWorkloadViewState::new();
        let expansion: ExpandedTemplate = real_fixture("template-expand");
        state.template = Some(available_template("static-site"));
        state.expansion = Some(expansion.clone());
        state.all_providers = vec![provider(&"1".repeat(64), false)];
        state.picker.set_providers(state.all_providers.clone());

        let request = build_spawn_request(&state).expect("a listing is selected");
        assert_eq!(request.image.digest, expansion.spawn.image.digest);
        assert_eq!(request.ssh_public_key, expansion.spawn.ssh_public_key);
        assert_eq!(request.env, Some(expansion.spawn.env));
    }
}
