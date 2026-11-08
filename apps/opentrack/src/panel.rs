use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::position::{corner_tray, grown_bounds, popup_bounds, Rect};

const WIDTH: f64 = 320.0;
/// A tray click that lands right after a blur-hide is the same click; ignore it.
const BLUR_CLICK_GRACE: Duration = Duration::from_millis(250);

pub struct Panel {
    state: Mutex<PanelState>,
}

struct PanelState {
    /// Kept open: stays on blur, shows in the taskbar and keeps the place the user dragged it to.
    floating: bool,
    hidden_by_blur_at: Option<Instant>,
    /// Content height in CSS pixels, as the renderer measured it.
    content_height: f64,
    tray: Option<Rect>,
    deferred_show: Option<&'static str>,
}

#[derive(Debug, PartialEq)]
enum ToggleAction {
    Hide,
    Show,
    Ignore,
}

/// Decisions only, fed the window's visibility: a window getter off the main thread waits for it,
/// so holding this lock across one deadlocks against a main-thread event taking the lock.
impl PanelState {
    fn hide_on_blur(&mut self, visible: bool, now: Instant) -> bool {
        let hide = visible && !self.floating;
        if hide {
            self.hidden_by_blur_at = Some(now);
        }
        hide
    }

    fn toggle(&mut self, visible: bool, tray: Option<Rect>, now: Instant) -> ToggleAction {
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

impl Panel {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(PanelState {
                floating: false,
                hidden_by_blur_at: None,
                content_height: 560.0,
                tray: None,
                deferred_show: None,
            }),
        }
    }

    pub fn set_floating(&self, window: &WebviewWindow, floating: bool) {
        self.state.lock().unwrap().floating = floating;
        let _ = window.set_skip_taskbar(!floating);
    }

    pub fn on_blur(&self, window: &WebviewWindow) {
        let visible = window.is_visible().unwrap_or(false);
        let hide = self.state.lock().unwrap().hide_on_blur(visible, Instant::now());
        if hide {
            let _ = window.hide();
        }
    }

    pub fn toggle(&self, window: &WebviewWindow, tray: Option<Rect>) {
        let visible = window.is_visible().unwrap_or(false);
        let action = self.state.lock().unwrap().toggle(visible, tray, Instant::now());
        match action {
            ToggleAction::Hide => {
                let _ = window.hide();
            }
            ToggleAction::Show => self.show(window, None),
            ToggleAction::Ignore => {}
        }
    }

    pub fn show(&self, window: &WebviewWindow, screen: Option<&str>) {
        let visible = window.is_visible().unwrap_or(false);
        let floating = self.state.lock().unwrap().floating;
        crate::deliver_skipped_state(window.app_handle());
        if !floating || !visible {
            self.place(window);
        }
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(screen) = screen {
            let _ = window.emit("screen", screen);
        }
    }

    /// A launch while WebView2 still starts (slow at login) is shown once setup has built the window.
    pub fn window_or_defer(&self, app: &AppHandle, screen: &'static str) -> Option<WebviewWindow> {
        let mut state = self.state.lock().unwrap(); // Held across the lookup so setup's take cannot slip between.
        let window = main_window(app);
        if window.is_none() {
            state.deferred_show = Some(screen);
        }
        window
    }

    pub fn take_deferred_show(&self) -> Option<&'static str> {
        self.state.lock().unwrap().deferred_show.take()
    }

    /// The window takes the height of what is shown; a popup is re-placed at the tray for it.
    pub fn fit(&self, window: &WebviewWindow, height: f64) {
        if !height.is_finite() || height <= 0.0 {
            return;
        }
        let floating = {
            let mut state = self.state.lock().unwrap();
            state.content_height = height.ceil();
            state.floating
        };
        if !floating {
            self.place(window);
            return;
        }
        let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor()) else { return };
        let height = (height * scale).round() as i32;
        let (y, height) = match window.current_monitor().ok().flatten() {
            Some(monitor) => grown_bounds(position.y, height, work_rect(&monitor)),
            None => (position.y, height),
        };
        let _ = window.set_size(PhysicalSize::new((WIDTH * scale).round() as u32, height as u32));
        let _ = window.set_position(PhysicalPosition::new(position.x, y));
        #[cfg(target_os = "macos")]
        crate::macos::refresh_shadow(window);
    }

    fn place(&self, window: &WebviewWindow) {
        let (tray, content_height) = {
            let state = self.state.lock().unwrap();
            (state.tray, state.content_height)
        };
        let monitor = match tray {
            Some(rect) => window.monitor_from_point(f64::from(rect.x), f64::from(rect.y)).ok().flatten(),
            None => None,
        }
        .or_else(|| window.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else { return };
        let work = work_rect(&monitor);
        let tray = tray.unwrap_or_else(|| corner_tray(work, cfg!(target_os = "linux")));
        let scale = monitor.scale_factor();
        let bounds = popup_bounds(tray, work, (WIDTH * scale).round() as i32, (content_height * scale).round() as i32);
        let _ = window.set_size(PhysicalSize::new(bounds.width as u32, bounds.height as u32));
        let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
        #[cfg(target_os = "macos")]
        crate::macos::refresh_shadow(window);
    }
}

fn work_rect(monitor: &tauri::Monitor) -> Rect {
    let area = monitor.work_area();
    Rect { x: area.position.x, y: area.position.y, width: area.size.width as i32, height: area.size.height as i32 }
}

pub const MAIN_WINDOW: &str = "main";

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(floating: bool) -> PanelState {
        PanelState { floating, ..Panel::new().state.into_inner().unwrap() }
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
