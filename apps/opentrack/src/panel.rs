use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::position::{corner_tray, grown_bounds, popup_bounds, Rect};

const WIDTH: f64 = 320.0;
/// A tray click takes focus from the window first, so a window that lost it just now was in front.
const BLUR_CLICK_GRACE: Duration = Duration::from_millis(250);

pub struct Panel {
    state: Mutex<PanelState>,
}

struct PanelState {
    /// Content height in CSS pixels, as the renderer measured it.
    content_height: f64,
    tray: Option<Rect>,
    deferred_show: Option<&'static str>,
    placed: bool,
    blurred_at: Option<Instant>,
}

/// Decisions only, fed the window's state: a window getter off the main thread waits for it,
/// so holding this lock across one deadlocks against a main-thread event taking the lock.
impl PanelState {
    fn hides_on_toggle(&mut self, shown: bool, focused: bool, tray: Option<Rect>, now: Instant) -> bool {
        if tray.is_some() {
            self.tray = tray;
        }
        let in_front = focused || self.blurred_at.is_some_and(|at| now.duration_since(at) < BLUR_CLICK_GRACE);
        shown && in_front
    }

    /// Only the first show places the window at the tray; after that it stays where the user put it.
    fn take_first_show(&mut self) -> bool {
        !std::mem::replace(&mut self.placed, true)
    }
}

impl Panel {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(PanelState {
                content_height: 560.0,
                tray: None,
                deferred_show: None,
                placed: false,
                blurred_at: None,
            }),
        }
    }

    pub fn on_blur(&self) {
        self.state.lock().unwrap().blurred_at = Some(Instant::now());
    }

    /// A covered or minimised window comes to the front; only one in front hides.
    pub fn toggle(&self, window: &WebviewWindow, tray: Option<Rect>) {
        let shown = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        let hide = self.state.lock().unwrap().hides_on_toggle(shown, focused, tray, Instant::now());
        if hide {
            let _ = window.hide();
        } else {
            self.show(window, None);
        }
    }

    pub fn show(&self, window: &WebviewWindow, screen: Option<&str>) {
        let first = self.state.lock().unwrap().take_first_show();
        crate::deliver_skipped_state(window.app_handle());
        if first {
            self.place(window);
        }
        let _ = window.unminimize();
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

    /// Remembers the content height for the first placement; after that the user's size stays.
    pub fn measure(&self, height: f64) -> Option<f64> {
        let height = (height.is_finite() && height > 0.0).then(|| height.ceil())?;
        self.state.lock().unwrap().content_height = height;
        Some(height)
    }

    /// Fits the height to the content now shown, keeping the user's width and the window on screen.
    pub fn resize(&self, window: &WebviewWindow, height: f64) {
        let Some(height) = self.measure(height) else { return };
        let (Ok(size), Ok(position), Ok(scale)) = (window.inner_size(), window.outer_position(), window.scale_factor())
        else {
            return;
        };
        let height = (height * scale).round() as i32;
        let (y, height) = match window.current_monitor().ok().flatten() {
            Some(monitor) => grown_bounds(position.y, height, work_rect(&monitor)),
            None => (position.y, height),
        };
        let _ = window.set_size(PhysicalSize::new(size.width, height as u32));
        let _ = window.set_position(PhysicalPosition::new(position.x, y));
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

    #[test]
    fn a_toggle_hides_only_a_window_in_front_and_places_it_once() {
        let now = Instant::now();
        let tray = Rect { x: 1, y: 2, width: 3, height: 4 };
        let mut state = Panel::new().state.into_inner().unwrap();
        assert!(!state.hides_on_toggle(false, false, Some(tray), now));
        assert_eq!(state.tray, Some(tray));
        assert!(state.hides_on_toggle(true, true, None, now));
        assert!(!state.hides_on_toggle(true, false, None, now));
        state.blurred_at = Some(now);
        assert!(state.hides_on_toggle(true, false, None, now + BLUR_CLICK_GRACE / 2));
        assert!(!state.hides_on_toggle(true, false, None, now + BLUR_CLICK_GRACE));
        assert!(state.take_first_show());
        assert!(!state.take_first_show());
    }
}
