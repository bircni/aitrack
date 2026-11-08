//! When the popup hides and shows; the window calls themselves live in `app`.

use std::time::{Duration, Instant};

use crate::position::Rect;

/// A tray click that lands right after a blur-hide is the same click; ignore it.
const BLUR_CLICK_GRACE: Duration = Duration::from_millis(250);

pub struct PanelState {
    /// Kept open: stays on blur and keeps the place the user dragged it to.
    pub floating: bool,
    hidden_by_blur_at: Option<Instant>,
    pub tray: Option<Rect>,
}

#[derive(Debug, PartialEq)]
pub enum ToggleAction {
    Hide,
    Show,
    Ignore,
}

impl PanelState {
    pub fn new() -> Self {
        Self { floating: false, hidden_by_blur_at: None, tray: None }
    }

    pub fn hide_on_blur(&mut self, visible: bool, now: Instant) -> bool {
        let hide = visible && !self.floating;
        if hide {
            self.hidden_by_blur_at = Some(now);
        }
        hide
    }

    pub fn toggle(&mut self, visible: bool, tray: Option<Rect>, now: Instant) -> ToggleAction {
        if tray.is_some() {
            self.tray = tray;
        }
        if visible {
            ToggleAction::Hide
        } else if self.hidden_by_blur_at.is_some_and(|at| now.duration_since(at) < BLUR_CLICK_GRACE) {
            ToggleAction::Ignore
        } else {
            ToggleAction::Show
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(floating: bool) -> PanelState {
        PanelState { floating, ..PanelState::new() }
    }

    #[test]
    fn blur_hides_only_a_visible_popup() {
        let now = Instant::now();
        let mut popup = state(false);
        assert!(!popup.hide_on_blur(false, now));
        assert_eq!(popup.hidden_by_blur_at, None);
        assert!(popup.hide_on_blur(true, now));
        assert_eq!(popup.hidden_by_blur_at, Some(now));
        assert!(!state(true).hide_on_blur(true, now));
    }

    #[test]
    fn a_tray_click_right_after_a_blur_hide_does_not_reopen() {
        let now = Instant::now();
        let tray = Rect { x: 1, y: 2, width: 3, height: 4 };
        let mut popup = state(false);
        popup.hide_on_blur(true, now);
        assert_eq!(popup.toggle(false, Some(tray), now + BLUR_CLICK_GRACE / 2), ToggleAction::Ignore);
        assert_eq!(popup.tray, Some(tray));
        assert_eq!(popup.toggle(false, None, now + BLUR_CLICK_GRACE), ToggleAction::Show);
        assert_eq!(popup.toggle(true, None, now), ToggleAction::Hide);
    }
}
