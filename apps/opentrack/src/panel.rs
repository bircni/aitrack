//! When the popup hides and shows; the window calls themselves live in `app`.

use std::time::{Duration, Instant};

use crate::position::Rect;

/// A tray click that lands right after a blur-hide is the same click; ignore it.
const BLUR_CLICK_GRACE: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct PanelState {
    /// Kept open: stays on blur and keeps the place the user dragged it to.
    pub floating: bool,
    hidden_by_blur_at: Option<Instant>,
    /// Focus arrives a frame or more after showing; only losing it after that is a blur.
    focused_since_show: bool,
    pub tray: Option<Rect>,
}

#[derive(Debug, PartialEq)]
pub enum ToggleAction {
    Hide,
    Show,
    Ignore,
}

impl PanelState {
    pub fn shown(&mut self) {
        self.focused_since_show = false;
    }

    /// Given the window's focus each frame, whether the popup should hide.
    pub fn blurred(&mut self, visible: bool, focused: bool, now: Instant) -> bool {
        if focused {
            self.focused_since_show = true;
            return false;
        }
        let hide = visible && self.focused_since_show && !self.floating;
        if hide {
            self.focused_since_show = false;
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

    #[test]
    fn hides_only_after_focus_came_and_went() {
        let now = Instant::now();
        let mut popup = PanelState::default();
        popup.shown();
        assert!(!popup.blurred(true, false, now), "not focused yet right after showing");
        assert!(!popup.blurred(true, true, now));
        assert!(popup.blurred(true, false, now));
        assert!(!popup.blurred(true, false, now), "one blur, one hide");
        let mut kept = PanelState { floating: true, ..PanelState::default() };
        assert!(!kept.blurred(true, true, now));
        assert!(!kept.blurred(true, false, now));
    }

    #[test]
    fn a_tray_click_right_after_a_blur_hide_does_not_reopen() {
        let now = Instant::now();
        let tray = Rect { x: 1, y: 2, width: 3, height: 4 };
        let mut popup = PanelState::default();
        popup.blurred(true, true, now);
        popup.blurred(true, false, now);
        assert_eq!(popup.toggle(false, Some(tray), now + BLUR_CLICK_GRACE / 2), ToggleAction::Ignore);
        assert_eq!(popup.tray, Some(tray));
        assert_eq!(popup.toggle(false, None, now + BLUR_CLICK_GRACE), ToggleAction::Show);
        assert_eq!(popup.toggle(true, None, now), ToggleAction::Hide);
    }
}
