//! The Docs view (TOON_Network#102, #148).
//!
//! A terminal mirror of `packages/ui/src/app/docs-view.tsx`: a reading list
//! of the console's documentation, and — once one is opened — that page
//! rendered as Markdown (`crate::markdown`), with the same two facts the web
//! view leads with: **which source** answered (a published NIP-23 article,
//! or the Markdown this console shipped with — `docs-view.tsx`'s own comment
//! calls this "exactly the sort of thing a person needs told while they are
//! following instructions about money") and, when the relays could not be
//! read, **why** the bundle is showing instead. [`DocsViewState::page`] is
//! what switches between the two modes: `None` is the list, `Some` is a
//! page.
//!
//! A terminal has no mouse-hover link and no text cursor to be "near", so
//! opening a link is a two-key gesture rather than a click: `n`/`N` cycle
//! which of the article's links is focused (drawn inverted, distinctly from
//! the rest), and `o` opens that one with `xdg-open`. [`handle_key`] owns the
//! state, tried by `app::handle_key` before the global keymap (TOON_Network#138's
//! code review: "every view exposes `fn handle_key`, `None` falls through").

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::markdown;
use crate::types::{DocSummary, DocsIndex, DocsPage};

/// How many lines `PageUp`/`PageDown` scroll an open article — arbitrary,
/// but big enough that a page key visibly moves a full screen's worth on a
/// typical terminal height.
const DOCS_PAGE_SCROLL: u16 = 10;

/// The Docs view's own state (TOON_Network#148): the reading list, an open
/// article (`page.is_some()` is what puts the view into "reading" mode), and
/// where the cursor/scroll/focused-link is in whichever mode is showing.
/// Kept as one field on `App`, the same way every other view's state is.
#[derive(Default)]
pub struct DocsViewState {
    pub index: Option<DocsIndex>,
    pub page: Option<DocsPage>,
    /// Set while a Docs fetch is in flight.
    pub loading: bool,
    /// `GET /api/docs` failed. Shown in the reading list.
    pub error: Option<String>,
    /// Reused for two failures that never happen at once, since only one is
    /// ever showable at a time: `GET /api/docs/<d>` failed (shown in the
    /// reading list, mirroring `use-docs.ts`'s `openError`), or `xdg-open`
    /// failed on a focused link (shown over the open article instead).
    pub open_error: Option<String>,
    /// Which row of the reading list `j`/`k` has selected.
    pub selected: usize,
    /// How far `j`/`k`/`PageUp`/`PageDown` have scrolled the open article.
    pub scroll: u16,
    /// The open article's links, in reading order — just the hrefs, so `o`
    /// can open one without re-parsing the Markdown on every keypress. Set
    /// alongside `page` and cleared when it closes.
    pub link_hrefs: Vec<String>,
    /// Which of `link_hrefs` `n`/`N` has focused; `o` opens this one.
    pub link_index: usize,
}

impl DocsViewState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Every key while the Docs view is active, tried before the global keymap
/// (`app::handle_key`). `None` means this view has no opinion about the key
/// — `1`-`7`, `Tab`, `?`, `q`, ... — and the global keymap gets it next.
///
/// The reading list (no article open) and an open article claim different
/// keys for `j`/`k` (move the selection vs. scroll), which is why almost
/// every arm here is guarded on [`DocsViewState::page`] rather than the two
/// modes sharing one `j`/`k` arm.
pub fn handle_key(state: &mut DocsViewState, key: KeyEvent) -> Option<Command> {
    match key.code {
        KeyCode::Char('r') | KeyCode::Char('R') => Some(Command::RefreshDocs),
        // Reading list (no article open): `j`/`k` move the selection,
        // `Enter` opens it.
        KeyCode::Char('j') | KeyCode::Down if state.page.is_none() => {
            if let Some(len) = state.index.as_ref().map(|index| index.docs.len()) {
                if len > 0 {
                    state.selected = (state.selected + 1).min(len - 1);
                }
            }
            Some(Command::None)
        }
        KeyCode::Char('k') | KeyCode::Up if state.page.is_none() => {
            state.selected = state.selected.saturating_sub(1);
            Some(Command::None)
        }
        KeyCode::Enter if state.page.is_none() => Some(
            match state
                .index
                .as_ref()
                .and_then(|index| index.docs.get(state.selected))
            {
                Some(doc) => Command::OpenDoc(doc.d.clone()),
                None => Command::None,
            },
        ),
        // An open article: `j`/`k`/`PageUp`/`PageDown` scroll it, `n`/`N`
        // cycle which link is focused, `o` opens the focused one, and
        // `Backspace` goes back to the reading list.
        KeyCode::Char('j') | KeyCode::Down if state.page.is_some() => {
            state.scroll = state.scroll.saturating_add(1);
            Some(Command::None)
        }
        KeyCode::Char('k') | KeyCode::Up if state.page.is_some() => {
            state.scroll = state.scroll.saturating_sub(1);
            Some(Command::None)
        }
        KeyCode::PageDown if state.page.is_some() => {
            state.scroll = state.scroll.saturating_add(DOCS_PAGE_SCROLL);
            Some(Command::None)
        }
        KeyCode::PageUp if state.page.is_some() => {
            state.scroll = state.scroll.saturating_sub(DOCS_PAGE_SCROLL);
            Some(Command::None)
        }
        KeyCode::Char('n') if state.page.is_some() => {
            let len = state.link_hrefs.len();
            if len > 0 {
                state.link_index = (state.link_index + 1) % len;
            }
            Some(Command::None)
        }
        KeyCode::Char('N') if state.page.is_some() => {
            let len = state.link_hrefs.len();
            if len > 0 {
                state.link_index = (state.link_index + len - 1) % len;
            }
            Some(Command::None)
        }
        KeyCode::Char('o') if state.page.is_some() => {
            Some(match state.link_hrefs.get(state.link_index) {
                Some(href) => Command::OpenDocsLink(href.clone()),
                None => Command::None,
            })
        }
        KeyCode::Backspace if state.page.is_some() => {
            state.page = None;
            state.link_hrefs.clear();
            state.link_index = 0;
            state.scroll = 0;
            state.open_error = None;
            Some(Command::None)
        }
        _ => None,
    }
}

/// Returns the reading list's row hits (empty while an article is open —
/// [`draw_article`] has no list of its own to click a row of) — what a
/// mouse click selects (ADR 0028: "mouse clicks select tabs and rows"),
/// matching [`DocsViewState::selected`].
pub fn draw(frame: &mut Frame, area: Rect, state: &DocsViewState) -> Vec<(u16, usize)> {
    match &state.page {
        Some(page) => {
            draw_article(
                frame,
                area,
                &page.doc.title,
                &page.doc.source,
                page.doc.address.as_deref(),
                page.index.fallback.as_deref(),
                &page.doc.markdown,
                state.scroll,
                state.link_index,
                state.open_error.as_deref(),
            );
            Vec::new()
        }
        None => draw_list(
            frame,
            area,
            state.index.as_ref(),
            state.loading,
            state.error.as_deref(),
            state.open_error.as_deref(),
            state.selected,
        ),
    }
}

fn source_badge(source: &str) -> Span<'static> {
    if source == "relays" {
        Span::styled(
            " published ",
            Style::default().fg(Color::Black).bg(Color::Green),
        )
    } else {
        Span::styled(
            " bundled ",
            Style::default().fg(Color::Black).bg(Color::Yellow),
        )
    }
}

fn fallback_lines(fallback: Option<&str>) -> Vec<Line<'static>> {
    match fallback {
        None => vec![],
        Some(note) => vec![
            Line::from(Span::styled(
                note.to_string(),
                Style::default().fg(Color::DarkGray),
            )),
            Line::raw(""),
        ],
    }
}

fn error_lines(label: &str, error: Option<&str>) -> Vec<Line<'static>> {
    match error {
        None => vec![],
        Some(message) => vec![
            Line::from(Span::styled(
                format!("{label}: {message}"),
                Style::default().fg(Color::Red),
            )),
            Line::raw(""),
        ],
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_list(
    frame: &mut Frame,
    area: Rect,
    index: Option<&DocsIndex>,
    loading: bool,
    error: Option<&str>,
    open_error: Option<&str>,
    selected: usize,
) -> Vec<(u16, usize)> {
    let title = if loading {
        " Docs — reading… "
    } else {
        " Docs "
    };
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![Line::from(Span::styled(
        subtitle(index),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC),
    ))];
    lines.push(Line::raw(""));
    lines.extend(error_lines("Could not be read", error));
    lines.extend(error_lines("That page could not be opened", open_error));
    lines.extend(fallback_lines(index.and_then(|i| i.fallback.as_deref())));

    // However many lines came before it, this is where the first doc row
    // will land — the offset every hit below is anchored to.
    let first_row = lines.len();

    let docs_len = match index {
        None => {
            lines.push(Line::from(Span::styled(
                "Reading the documentation…",
                Style::default().fg(Color::DarkGray),
            )));
            0
        }
        Some(index) if index.docs.is_empty() => {
            lines.push(Line::from(Span::styled(
                "No documentation pages.",
                Style::default().fg(Color::DarkGray),
            )));
            0
        }
        Some(index) => {
            for (at, doc) in index.docs.iter().enumerate() {
                lines.push(doc_row(doc, at == selected));
            }
            index.docs.len()
        }
    };

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);

    (0..docs_len)
        .map(|at| inner.y + (first_row + at) as u16)
        .take_while(|row| *row < inner.y + inner.height)
        .zip(0..docs_len)
        .collect()
}

fn subtitle(index: Option<&DocsIndex>) -> String {
    match index.and_then(|i| i.author.as_ref()) {
        Some(author) => {
            let prefix: String = author.npub.chars().take(20).collect();
            format!("Published as NIP-23 articles by {prefix}…")
        }
        None => "The pages this console shipped with.".to_string(),
    }
}

fn doc_row(doc: &DocSummary, selected: bool) -> Line<'static> {
    let marker = if selected { "▶ " } else { "  " };
    let row_style = if selected {
        Style::default().add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    Line::from(vec![
        Span::styled(marker.to_string(), row_style),
        Span::styled(doc.title.clone(), row_style),
        Span::raw("  "),
        source_badge(&doc.source),
        Span::raw("  "),
        Span::styled(doc.summary.clone(), Style::default().fg(Color::DarkGray)),
    ])
}

#[allow(clippy::too_many_arguments)]
fn draw_article(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    source: &str,
    address: Option<&str>,
    fallback: Option<&str>,
    body: &str,
    scroll: u16,
    focused_link: usize,
    open_error: Option<&str>,
) {
    let rendered = markdown::render(body, Some(focused_link));

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(3)])
        .split(area);

    let header = Line::from(vec![
        Span::styled(
            title.to_string(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        source_badge(source),
    ]);
    frame.render_widget(Paragraph::new(header), rows[0]);

    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(rows[1]);
    frame.render_widget(block, rows[1]);

    let mut lines = Vec::new();
    lines.extend(fallback_lines(fallback));
    lines.extend(error_lines("That link could not be opened", open_error));
    lines.extend(rendered.text.lines.clone());
    if !rendered.links.is_empty() {
        lines.push(Line::raw(""));
        let current = rendered
            .links
            .get(focused_link)
            .map(|link| {
                format!(
                    "[{}/{}] {} → {}",
                    focused_link + 1,
                    rendered.links.len(),
                    link.text,
                    link.href
                )
            })
            .unwrap_or_default();
        lines.push(Line::from(Span::styled(
            current,
            Style::default().fg(Color::DarkGray),
        )));
    }
    if let Some(address) = address {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            format!("Published as a NIP-23 article: {address}"),
            Style::default().fg(Color::DarkGray),
        )));
    }

    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        inner,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DocArticle, DocSummary, DocsIndex, DocsPage};
    use crossterm::event::{KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::fs;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn render(state: &DocsViewState) -> String {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw(frame, frame.area(), state);
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

    fn sample_index() -> DocsIndex {
        DocsIndex {
            author: None,
            relays: vec![],
            read: vec![],
            fallback: Some("These are the pages that shipped with this console.".to_string()),
            docs: vec![
                DocSummary {
                    d: "concepts".to_string(),
                    title: "Concepts".to_string(),
                    summary: "The words.".to_string(),
                    order: 1,
                    published_at: "2026-09-23".to_string(),
                    tags: vec!["toon-network".to_string()],
                    source: "bundled".to_string(),
                    address: None,
                    updated_at: None,
                },
                DocSummary {
                    d: "funding".to_string(),
                    title: "Funding".to_string(),
                    summary: "The money.".to_string(),
                    order: 2,
                    published_at: "2026-09-23".to_string(),
                    tags: vec![],
                    source: "bundled".to_string(),
                    address: None,
                    updated_at: None,
                },
            ],
            read_at: "2026-09-24T00:00:00.000Z".to_string(),
        }
    }

    /// A hand-built, DETERMINISTIC article — headings, emphasis, a list, a
    /// fenced code block and two links — for the snapshot below. Not read
    /// from the committed fixture: `readAt` there is regenerated on every
    /// `npm test` run, and an insta snapshot needs the same bytes every time.
    fn sample_page() -> DocsPage {
        DocsPage {
            index: sample_index(),
            doc: DocArticle {
                d: "concepts".to_string(),
                title: "Concepts".to_string(),
                summary: "The words.".to_string(),
                published_at: "2026-09-23".to_string(),
                tags: vec!["toon-network".to_string()],
                markdown: "# Concepts\n\n\
                    A **Provider** sells a *Lease*. See [Funding](funding) or \
                    [Gateways](gateways).\n\n\
                    - one\n- two\n\n\
                    ```bash\necho hi\n```\n"
                    .to_string(),
                source: "bundled".to_string(),
                event_id: None,
                updated_at: None,
                pubkey: None,
                address: None,
            },
        }
    }

    fn real_daemon_fixture() -> DocsPage {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/doc.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read fixture {path}: {err}"));
        serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture {path} did not deserialize as DocsPage: {err}"))
    }

    #[test]
    fn renders_the_sample_article() {
        let mut state = DocsViewState::new();
        state.page = Some(sample_page());
        state.link_hrefs = vec!["funding".to_string(), "gateways".to_string()];
        insta::assert_snapshot!(render(&state));
    }

    /// The daemon's own real article — headings, lists, a fenced code block,
    /// blockquotes and links, all at once — must still render without
    /// panicking. No snapshot assertion: `readAt` differs on every
    /// regeneration.
    #[test]
    fn renders_the_real_daemon_fixture_without_panicking() {
        let mut state = DocsViewState::new();
        state.page = Some(real_daemon_fixture());
        render(&state);
    }

    #[test]
    fn renders_the_reading_list_without_panicking() {
        let mut state = DocsViewState::new();
        state.index = Some(sample_index());
        render(&state);
    }

    // ---- mouse row hits (ADR 0028: "mouse clicks select tabs and rows") ---

    #[test]
    fn draw_hits_index_into_the_reading_list_past_the_subtitle_and_blank_line() {
        let mut state = DocsViewState::new();
        state.index = Some(sample_index());
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|frame| {
                hits = draw(frame, frame.area(), &state);
            })
            .unwrap();
        // sample_index() has two docs, and no error/fallback lines here.
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].1, 0);
        assert_eq!(hits[1].1, 1);
        assert_eq!(hits[1].0, hits[0].0 + 1, "rows are consecutive");
    }

    #[test]
    fn draw_hands_back_no_hits_while_an_article_is_open() {
        let mut state = DocsViewState::new();
        state.page = Some(sample_page());
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|frame| {
                hits = draw(frame, frame.area(), &state);
            })
            .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn clicking_a_row_only_selects_it_and_a_second_click_reselects() {
        let mut state = DocsViewState::new();
        state.index = Some(sample_index());
        assert_eq!(state.selected, 0);
        state.selected = 1;
        assert_eq!(state.selected, 1);
        assert!(state.page.is_none(), "a click never opens the article");
    }

    #[test]
    fn renders_loading_and_error_states_without_panicking() {
        let mut state = DocsViewState::new();
        state.loading = true;
        render(&state);

        state.loading = false;
        state.error = Some("the relays could not be reached".to_string());
        render(&state);

        state.index = Some(sample_index());
        state.open_error = Some("that page could not be opened".to_string());
        render(&state);
    }

    // -- handle_key: matches the old inline arms in app::handle_key ---------

    #[test]
    fn j_and_k_move_the_reading_list_selection_and_enter_opens_it() {
        let mut state = DocsViewState::new();
        state.index = Some(sample_index());
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('j'))),
            Some(Command::None)
        );
        assert_eq!(state.selected, 1);
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Enter)),
            Some(Command::OpenDoc("funding".to_string()))
        );
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('k'))),
            Some(Command::None)
        );
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn r_refreshes_regardless_of_which_mode_is_showing() {
        let mut state = DocsViewState::new();
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('r'))),
            Some(Command::RefreshDocs)
        );
        state.page = Some(sample_page());
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('R'))),
            Some(Command::RefreshDocs)
        );
    }

    #[test]
    fn an_open_article_scrolls_with_j_k_and_page_keys_and_backspace_closes_it() {
        let mut state = DocsViewState::new();
        state.page = Some(sample_page());
        handle_key(&mut state, key(KeyCode::Char('j')));
        assert_eq!(state.scroll, 1);
        handle_key(&mut state, key(KeyCode::PageDown));
        assert_eq!(state.scroll, 1 + DOCS_PAGE_SCROLL);
        handle_key(&mut state, key(KeyCode::Char('k')));
        assert_eq!(state.scroll, DOCS_PAGE_SCROLL);
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Backspace)),
            Some(Command::None)
        );
        assert!(state.page.is_none());
        assert_eq!(state.scroll, 0);
    }

    #[test]
    fn n_and_capital_n_cycle_the_focused_link_and_o_opens_it() {
        let mut state = DocsViewState::new();
        state.page = Some(sample_page());
        state.link_hrefs = vec!["funding".to_string(), "gateways".to_string()];
        handle_key(&mut state, key(KeyCode::Char('n')));
        assert_eq!(state.link_index, 1);
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('o'))),
            Some(Command::OpenDocsLink("gateways".to_string()))
        );
        handle_key(&mut state, key(KeyCode::Char('N')));
        assert_eq!(state.link_index, 0);
    }

    #[test]
    fn keys_this_view_has_no_opinion_about_fall_through() {
        let mut state = DocsViewState::new();
        for code in [
            KeyCode::Char('q'),
            KeyCode::Char('1'),
            KeyCode::Tab,
            KeyCode::Char('?'),
        ] {
            assert_eq!(
                handle_key(&mut state, key(code)),
                None,
                "{code:?} should fall through while showing the reading list"
            );
        }
        state.page = Some(sample_page());
        for code in [
            KeyCode::Char('q'),
            KeyCode::Char('1'),
            KeyCode::Tab,
            KeyCode::Char('?'),
        ] {
            assert_eq!(
                handle_key(&mut state, key(code)),
                None,
                "{code:?} should fall through while an article is open"
            );
        }
    }
}
