//! The `GET /api/desktop` long poll (TOON_Network#99, spec skeleton item 2).
//!
//! The web UI holds this open so an Omarchy menu entry (`toon-console --view
//! funds`) can switch an already-open window without anybody focusing it by
//! hand — see `packages/ui/src/hooks/use-desktop.ts`. The TUI needs the same
//! "menu asked for a view" half of that contract; it has no CSS to re-theme,
//! since it already draws in the terminal's own colours (ADR 0028), so this
//! module only ever sends view switches, never a theme.
//!
//! `run` is meant to be spawned as its own task and left running for the
//! life of the process. It never panics on a daemon that is down or a poll
//! that failed — same as `use-desktop.ts`, a stale window is not something to
//! interrupt anyone about, so it waits `retry_ms` and tries again.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::app::View;
use crate::client::DaemonClient;
use crate::types::{DesktopView, MenuView};

pub const RETRY_MS: u64 = 5_000;
/// Mirrors `MIN_GAP_MS` in `use-desktop.ts`: a floor under the loop so an
/// old daemon that does not hold the poll (or one that is already behind)
/// cannot turn this into a spin.
pub const MIN_GAP_MS: u64 = 250;

/// Which sidebar view a menu entry means. Mirrors `MENU_TABS` in
/// `console-app.tsx`: the menu speaks in the three things a person goes to
/// the console for, the sidebar in how this window is arranged, and the two
/// are allowed to differ. "New workload" is the New view — where a workload
/// is started from.
pub fn menu_to_view(menu: MenuView) -> View {
    match menu {
        MenuView::Workloads => View::Workloads,
        MenuView::NewWorkload => View::New,
        MenuView::Funds => View::Funds,
    }
}

pub async fn run(client: Arc<DaemonClient>, tx: UnboundedSender<View>, retry_ms: u64) {
    let mut since: Option<i64> = None;
    let mut honoured: Option<String> = None;
    loop {
        let began = std::time::Instant::now();
        let path = match since {
            Some(seq) => format!("/api/desktop?wait=1&since={seq}"),
            None => "/api/desktop".to_string(),
        };
        match client.get::<DesktopView>(&path).await {
            Ok(view) => {
                since = Some(view.seq);
                if let (Some(menu), Some(opened_at)) = (view.open, view.opened_at.clone()) {
                    if honoured.as_ref() != Some(&opened_at) {
                        honoured = Some(opened_at);
                        // A send failure means the app already shut down; the
                        // loop exits on the next iteration's channel check, but
                        // there is nothing more useful to do than stop now.
                        if tx.send(menu_to_view(menu)).is_err() {
                            return;
                        }
                    }
                }
                let elapsed = began.elapsed();
                let floor = Duration::from_millis(MIN_GAP_MS);
                if elapsed < floor {
                    tokio::time::sleep(floor - elapsed).await;
                }
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(retry_ms)).await;
            }
        }
        if tx.is_closed() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_views_map_to_the_sidebar_view_a_person_would_call_them() {
        assert_eq!(menu_to_view(MenuView::Workloads), View::Workloads);
        assert_eq!(menu_to_view(MenuView::NewWorkload), View::New);
        assert_eq!(menu_to_view(MenuView::Funds), View::Funds);
    }
}
