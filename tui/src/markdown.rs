//! Markdown -> ratatui `Text` (TOON_Network#148).
//!
//! A terminal mirror of `packages/ui/src/lib/markdown.ts`, for the same
//! source: a NIP-23 article's body, or the bundled copy. That file turns
//! Markdown into HTML and strips raw HTML on the way in, because the body can
//! have come off a relay. There is no HTML here to strip — a terminal has no
//! script to inject — but the same body is rendered nowhere near as trusted
//! text: headings, emphasis, lists, code blocks and links become `Span`s with
//! a style, never a control sequence built out of the source.
//!
//! A link has no way to show its `href` inline in a terminal cell grid, so
//! [`render`] hands back the two together: the `Text` to draw, and one
//! [`Link`] per link in reading order, each carrying the 0-based line of that
//! `Text` it starts on. A view uses the line to scroll a focused link into
//! frame and the index into `links` to know which one `o` opens.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

/// One link found while rendering, in reading order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub href: String,
    /// The link's visible text, for a status line ("open: <text>").
    pub text: String,
    /// The 0-based line of the `Text` this link's first span landed on.
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rendered {
    pub text: Text<'static>,
    pub links: Vec<Link>,
}

/// One level of list nesting: whether it is ordered, and (if so) the number
/// due on the next item.
struct ListLevel {
    next_ordinal: Option<u64>,
}

/// Markdown -> `Text`.
///
/// `focused_link` is an index into the `links` this same source produces (in
/// reading order, matching `Rendered.links`); that one link's span is drawn
/// inverted rather than merely underlined, so a view can show which link `o`
/// would open. `None` draws every link the same way.
pub fn render(source: &str, focused_link: Option<usize>) -> Rendered {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);

    let mut builder = Builder::new(focused_link);
    for event in Parser::new_ext(source, options) {
        builder.handle(event);
    }
    builder.finish()
}

struct Builder {
    lines: Vec<Line<'static>>,
    current: Vec<Span<'static>>,
    /// Set right after a list item's marker is pushed onto `current` and
    /// cleared by the first thing that follows. Lets a loose list item's
    /// nested `Paragraph` land its text on the marker's own line instead of
    /// flushing a bare bullet and starting a fresh one under it.
    marker_pending: bool,
    /// Prefix applied to every NEW line started while active (blockquote
    /// markers, a list item's continuation indent) — not to a line already
    /// holding a marker, which carries its own.
    indent_stack: Vec<&'static str>,
    lists: Vec<ListLevel>,
    heading_level: Option<HeadingLevel>,
    emphasis: u8,
    strong: u8,
    strikethrough: u8,
    code_block: Option<CodeBlockKind<'static>>,
    active_link: Option<ActiveLink>,
    links: Vec<Link>,
    focused_link: Option<usize>,
}

struct ActiveLink {
    href: String,
    text: String,
    style: Style,
}

impl Builder {
    fn new(focused_link: Option<usize>) -> Self {
        Self {
            lines: Vec::new(),
            current: Vec::new(),
            marker_pending: false,
            indent_stack: Vec::new(),
            lists: Vec::new(),
            heading_level: None,
            emphasis: 0,
            strong: 0,
            strikethrough: 0,
            code_block: None,
            active_link: None,
            links: Vec::new(),
            focused_link,
        }
    }

    fn handle(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.text(&text),
            Event::Code(text) => self.inline_code(&text),
            Event::SoftBreak => self.push_span(Span::raw(" ")),
            Event::HardBreak => self.newline(true),
            Event::Rule => {
                self.newline(false);
                self.lines.push(Line::from(Span::styled(
                    "─".repeat(40),
                    Style::default().fg(Color::DarkGray),
                )));
                self.blank();
            }
            // Raw HTML, footnotes, tables and math are not part of the docs
            // this console ships or publishes (`docs-content.ts`'s front
            // matter has no room for them); anything of that shape renders
            // as nothing rather than as a control sequence built from
            // untrusted source, the same call `markdown.ts` makes for HTML.
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::FootnoteReference(_) | Event::TaskListMarker(_) => {}
            Event::InlineMath(_) | Event::DisplayMath(_) => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                if !self.marker_pending {
                    self.newline(false);
                }
                self.marker_pending = false;
            }
            Tag::Heading { level, .. } => {
                self.newline(false);
                self.heading_level = Some(level);
                let marker = "#".repeat(level as usize);
                self.push_span(Span::styled(format!("{marker} "), heading_style(level)));
            }
            Tag::BlockQuote(_) => {
                self.newline(false);
                self.indent_stack.push("▏ ");
            }
            Tag::CodeBlock(kind) => {
                self.newline(false);
                let label = match &kind {
                    CodeBlockKind::Fenced(lang) if !lang.is_empty() => lang.to_string(),
                    _ => String::new(),
                };
                self.lines.push(Line::from(Span::styled(
                    format!("{}```{label}", self.indent()),
                    Style::default().fg(Color::DarkGray),
                )));
                self.code_block = Some(owned_code_block_kind(&kind));
            }
            Tag::List(start) => {
                self.newline(false);
                self.lists.push(ListLevel {
                    next_ordinal: start,
                });
            }
            Tag::Item => {
                let marker = match self.lists.last_mut() {
                    Some(ListLevel {
                        next_ordinal: Some(ordinal),
                    }) => {
                        let text = format!("{ordinal}. ");
                        *ordinal += 1;
                        text
                    }
                    _ => "• ".to_string(),
                };
                self.push_span(Span::styled(
                    format!("{}{marker}", self.indent()),
                    Style::default().fg(Color::DarkGray),
                ));
                self.indent_stack.push("  ");
                self.marker_pending = true;
            }
            Tag::Emphasis => self.emphasis += 1,
            Tag::Strong => self.strong += 1,
            Tag::Strikethrough => self.strikethrough += 1,
            Tag::Link { dest_url, .. } => {
                let index = self.links.len();
                let focused = self.focused_link == Some(index);
                let style = if focused {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Yellow)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::UNDERLINED)
                };
                self.active_link = Some(ActiveLink {
                    href: dest_url.to_string(),
                    text: String::new(),
                    style,
                });
            }
            // An image's alt text is the only part of it a terminal can show;
            // no docs page uses one today, so this is defensive rather than
            // load-bearing.
            Tag::Image { .. } => {}
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => {
                self.newline(false);
                self.blank();
            }
            TagEnd::Heading(_) => {
                self.newline(false);
                self.blank();
                self.heading_level = None;
            }
            TagEnd::BlockQuote(_) => {
                self.indent_stack.pop();
                self.newline(false);
                self.blank();
            }
            TagEnd::CodeBlock => {
                self.newline(false);
                self.lines.push(Line::from(Span::styled(
                    format!("{}```", self.indent()),
                    Style::default().fg(Color::DarkGray),
                )));
                self.code_block = None;
                self.blank();
            }
            TagEnd::List(_) => {
                self.lists.pop();
                self.newline(false);
                self.blank();
            }
            TagEnd::Item => {
                self.newline(false);
                self.indent_stack.pop();
                self.marker_pending = false;
            }
            TagEnd::Emphasis => self.emphasis = self.emphasis.saturating_sub(1),
            TagEnd::Strong => self.strong = self.strong.saturating_sub(1),
            TagEnd::Strikethrough => self.strikethrough = self.strikethrough.saturating_sub(1),
            TagEnd::Link => {
                if let Some(active) = self.active_link.take() {
                    self.links.push(Link {
                        href: active.href,
                        text: active.text,
                        line: self.lines.len(),
                    });
                }
            }
            _ => {}
        }
    }

    fn text(&mut self, text: &str) {
        if self.code_block.is_some() {
            for (at, line) in text.split('\n').enumerate() {
                if at > 0 {
                    self.newline(true);
                }
                if !line.is_empty() {
                    self.push_span(Span::styled(
                        format!("{}{line}", self.indent()),
                        Style::default().fg(Color::Green),
                    ));
                }
            }
            return;
        }
        if let Some(active) = &mut self.active_link {
            active.text.push_str(text);
            let style = active.style;
            self.push_span(Span::styled(text.to_string(), style));
            return;
        }
        self.push_span(Span::styled(text.to_string(), self.inline_style()));
    }

    fn inline_code(&mut self, text: &str) {
        if let Some(active) = &mut self.active_link {
            active.text.push_str(text);
            let style = active.style;
            self.push_span(Span::styled(text.to_string(), style));
            return;
        }
        let mut style = self.inline_style();
        style = style.fg(Color::Green);
        self.push_span(Span::styled(text.to_string(), style));
    }

    fn inline_style(&self) -> Style {
        if let Some(level) = self.heading_level {
            return heading_style(level);
        }
        let mut style = Style::default();
        if self.strong > 0 {
            style = style.add_modifier(Modifier::BOLD);
        }
        if self.emphasis > 0 {
            style = style.add_modifier(Modifier::ITALIC);
        }
        if self.strikethrough > 0 {
            style = style.add_modifier(Modifier::CROSSED_OUT);
        }
        style
    }

    fn indent(&self) -> String {
        self.indent_stack.concat()
    }

    fn push_span(&mut self, span: Span<'static>) {
        if self.current.is_empty() && !self.marker_pending {
            let prefix = self.indent();
            if !prefix.is_empty() {
                self.current
                    .push(Span::raw(prefix).style(Style::default().fg(Color::DarkGray)));
            }
        }
        self.marker_pending = false;
        self.current.push(span);
    }

    /// Ends the physical line in progress. `force` also pushes an empty line
    /// when nothing was pending — used for `HardBreak` and multi-line code
    /// block text, where a genuinely blank source line means a genuinely
    /// blank rendered one.
    fn newline(&mut self, force: bool) {
        if !self.current.is_empty() {
            self.lines
                .push(Line::from(std::mem::take(&mut self.current)));
        } else if force {
            self.lines.push(Line::default());
        }
    }

    /// A single blank separator line between block elements — never two in a
    /// row, so a page is not all whitespace.
    fn blank(&mut self) {
        self.newline(false);
        if !matches!(self.lines.last(), Some(line) if line.spans.is_empty()) {
            self.lines.push(Line::default());
        }
    }

    fn finish(mut self) -> Rendered {
        self.newline(false);
        while matches!(self.lines.last(), Some(line) if line.spans.is_empty()) {
            self.lines.pop();
        }
        Rendered {
            text: Text::from(self.lines),
            links: self.links,
        }
    }
}

fn heading_style(level: HeadingLevel) -> Style {
    let color = match level {
        HeadingLevel::H1 => Color::Cyan,
        HeadingLevel::H2 => Color::Yellow,
        _ => Color::Magenta,
    };
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}

fn owned_code_block_kind(kind: &CodeBlockKind<'_>) -> CodeBlockKind<'static> {
    match kind {
        CodeBlockKind::Indented => CodeBlockKind::Indented,
        CodeBlockKind::Fenced(lang) => CodeBlockKind::Fenced(lang.to_string().into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(rendered: &Rendered) -> Vec<String> {
        rendered
            .text
            .lines
            .iter()
            .map(|line| line.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    }

    #[test]
    fn a_heading_carries_its_hashes_and_a_style() {
        let rendered = render("# Title\n\nBody.", None);
        assert_eq!(plain(&rendered)[0], "# Title");
        let style = rendered.text.lines[0].spans[0].style;
        assert_eq!(style.fg, Some(Color::Cyan));
        assert!(style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn emphasis_and_strong_set_their_modifiers() {
        let rendered = render("*it* and **strong**", None);
        let spans: Vec<_> = rendered.text.lines[0].spans.clone();
        let italic = spans.iter().find(|s| s.content.as_ref() == "it").unwrap();
        assert!(italic.style.add_modifier.contains(Modifier::ITALIC));
        let strong = spans
            .iter()
            .find(|s| s.content.as_ref() == "strong")
            .unwrap();
        assert!(strong.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn a_bullet_list_gets_one_marker_per_item() {
        let rendered = render("- one\n- two\n- three", None);
        let lines = plain(&rendered);
        assert_eq!(lines, vec!["• one", "• two", "• three"]);
    }

    #[test]
    fn an_ordered_list_counts_up_from_its_start() {
        let rendered = render("3. one\n4. two", None);
        let lines = plain(&rendered);
        assert_eq!(lines, vec!["3. one", "4. two"]);
    }

    #[test]
    fn a_fenced_code_block_keeps_its_language_and_its_lines_verbatim() {
        let rendered = render("```bash\necho hi\necho bye\n```", None);
        let lines = plain(&rendered);
        assert_eq!(lines, vec!["```bash", "echo hi", "echo bye", "```"]);
    }

    #[test]
    fn a_link_is_tracked_with_its_href_text_and_line() {
        let rendered = render("See [Funding](funding) for more.", None);
        assert_eq!(rendered.links.len(), 1);
        let link = &rendered.links[0];
        assert_eq!(link.href, "funding");
        assert_eq!(link.text, "Funding");
        assert_eq!(link.line, 0);
    }

    #[test]
    fn the_focused_link_is_styled_differently_from_the_rest() {
        let source = "[a](a) and [b](b)";
        let unfocused = render(source, None);
        let focused = render(source, Some(1));

        let plain_style = unfocused.text.lines[0].spans[0].style;
        let focused_first = focused.text.lines[0].spans[0].style;
        assert_eq!(plain_style, focused_first, "link 0 unaffected");

        let b_span = focused.text.lines[0]
            .spans
            .iter()
            .find(|s| s.content.as_ref() == "b")
            .unwrap();
        assert_eq!(b_span.style.bg, Some(Color::Yellow));
    }

    #[test]
    fn a_blockquote_is_indented_and_dim() {
        let rendered = render("> a warning\n> across two lines", None);
        let lines = plain(&rendered);
        assert_eq!(lines, vec!["▏ a warning across two lines"]);
    }

    #[test]
    fn multiple_paragraphs_are_separated_by_exactly_one_blank_line() {
        let rendered = render("one\n\ntwo\n\nthree", None);
        let lines = plain(&rendered);
        assert_eq!(lines, vec!["one", "", "two", "", "three"]);
    }

    #[test]
    fn renders_the_first_workload_fixture_without_panicking() {
        let source = include_str!("../../docs/first-workload.md");
        let (_, body) = source.split_once("---\n").unwrap();
        let (_, body) = body.split_once("---\n").unwrap();
        let rendered = render(body, None);
        assert!(!rendered.text.lines.is_empty());
        assert!(rendered.links.len() >= 3, "the page links to its siblings");
    }
}
