//! The Docs view (TOON_Network#102, #148).
//!
//! A terminal mirror of `packages/ui/src/app/docs-view.tsx`: a reading list
//! of the console's documentation, and — once one is opened — that page
//! rendered as Markdown (`crate::markdown`), with the same two facts the web
//! view leads with: **which source** answered (a published NIP-23 article,
//! or the Markdown this console shipped with — `docs-view.tsx`'s own comment
//! calls this "exactly the sort of thing a person needs told while they are
//! following instructions about money") and, when the relays could not be
//! read, **why** the bundle is showing instead. `App::docs_page` is what
//! switches between the two modes: `None` is the list, `Some` is a page.
//!
//! A terminal has no mouse-hover link and no text cursor to be "near", so
//! opening a link is a two-key gesture rather than a click: `n`/`N` cycle
//! which of the article's links is focused (drawn inverted, distinctly from
//! the rest), and `o` opens that one with `xdg-open`. `App::handle_key` owns
//! the state; this module only draws it.

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::App;
use crate::markdown;
use crate::types::{DocSummary, DocsIndex};

pub fn draw(frame: &mut Frame, area: Rect, app: &App) {
    match &app.docs_page {
        Some(page) => draw_article(
            frame,
            area,
            &page.doc.title,
            &page.doc.source,
            page.doc.address.as_deref(),
            page.index.fallback.as_deref(),
            &page.doc.markdown,
            app.docs_scroll,
            app.docs_link_index,
            app.docs_open_error.as_deref(),
        ),
        None => draw_list(
            frame,
            area,
            app.docs_index.as_ref(),
            app.loading_docs,
            app.docs_error.as_deref(),
            app.docs_open_error.as_deref(),
            app.docs_selected,
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
) {
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

    match index {
        None => lines.push(Line::from(Span::styled(
            "Reading the documentation…",
            Style::default().fg(Color::DarkGray),
        ))),
        Some(index) if index.docs.is_empty() => lines.push(Line::from(Span::styled(
            "No documentation pages.",
            Style::default().fg(Color::DarkGray),
        ))),
        Some(index) => {
            for (at, doc) in index.docs.iter().enumerate() {
                lines.push(doc_row(doc, at == selected));
            }
        }
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
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
    use crate::app::App;
    use crate::types::{DocArticle, DocSummary, DocsIndex, DocsPage};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::fs;

    fn render(app: &App) -> String {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), app))
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
        let mut app = App::new();
        app.docs_page = Some(sample_page());
        app.docs_link_hrefs = vec!["funding".to_string(), "gateways".to_string()];
        insta::assert_snapshot!(render(&app));
    }

    /// The daemon's own real article — headings, lists, a fenced code block,
    /// blockquotes and links, all at once — must still render without
    /// panicking. No snapshot assertion: `readAt` differs on every
    /// regeneration.
    #[test]
    fn renders_the_real_daemon_fixture_without_panicking() {
        let mut app = App::new();
        app.docs_page = Some(real_daemon_fixture());
        render(&app);
    }

    #[test]
    fn renders_the_reading_list_without_panicking() {
        let mut app = App::new();
        app.docs_index = Some(sample_index());
        render(&app);
    }

    #[test]
    fn renders_loading_and_error_states_without_panicking() {
        let mut app = App::new();
        app.loading_docs = true;
        render(&app);

        app.loading_docs = false;
        app.docs_error = Some("the relays could not be reached".to_string());
        render(&app);

        app.docs_index = Some(sample_index());
        app.docs_open_error = Some("that page could not be opened".to_string());
        render(&app);
    }
}
