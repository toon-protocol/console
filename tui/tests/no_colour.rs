//! ADR 0028: "The TUI draws with no colour of its own: every style is an
//! ANSI colour or a modifier." `Color::Rgb` and `Color::Indexed` are the two
//! ways `ratatui` lets a program pick a colour the terminal's theme cannot
//! override — this test fails the build the moment either shows up anywhere
//! in `tui/src`, so the rule survives a view nobody thought to check by eye.

use std::fs;
use std::path::Path;

#[test]
fn no_source_file_names_an_rgb_or_indexed_colour() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    walk(&src, &mut offenders);
    assert!(
        offenders.is_empty(),
        "found a fixed colour outside the terminal's own ANSI palette:\n{}",
        offenders.join("\n")
    );
}

#[test]
fn the_scan_itself_catches_an_rgb_literal() {
    // A control on the checker above: if this ever stopped catching a real
    // offender (a refactor of `walk`, say), the real test would pass for the
    // wrong reason. This proves it still fires.
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("offender.rs"),
        "let bad = Color::Rgb(255, 0, 0);\n",
    )
    .unwrap();
    let mut offenders = Vec::new();
    walk(dir.path(), &mut offenders);
    assert_eq!(offenders.len(), 1);
}

fn walk(dir: &Path, offenders: &mut Vec<String>) {
    for entry in fs::read_dir(dir).expect("tui/src must exist") {
        let entry = entry.expect("readable dir entry");
        let path = entry.path();
        if path.is_dir() {
            walk(&path, offenders);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            continue;
        }
        let text = fs::read_to_string(&path).expect("readable .rs file");
        for (number, line) in text.lines().enumerate() {
            if line.contains("Color::Rgb") || line.contains("Color::Indexed") {
                offenders.push(format!(
                    "{}:{}: {}",
                    path.display(),
                    number + 1,
                    line.trim()
                ));
            }
        }
    }
}
