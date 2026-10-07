use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::position::{popup_bounds, Rect};

const WIDTH: f64 = 320.0;
/// A tray click that lands right after a blur-hide is the same click; ignore it.
const BLUR_CLICK_GRACE: Duration = Duration::from_millis(250);

pub struct Panel {
    state: Mutex<PanelState>,
}

struct PanelState {
    floating: bool,
    hidden_by_blur_at: Option<Instant>,
    /// Content height in CSS pixels, as the renderer measured it.
    content_height: f64,
    tray: Option<Rect>,
    deferred_show: Option<&'static str>,
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
        let mut state = self.state.lock().unwrap();
        if state.floating || !window.is_visible().unwrap_or(false) {
            return;
        }
        state.hidden_by_blur_at = Some(Instant::now());
        let _ = window.hide();
    }

    pub fn toggle(&self, window: &WebviewWindow, tray: Option<Rect>) {
        {
            let mut state = self.state.lock().unwrap();
            if tray.is_some() {
                state.tray = tray;
            }
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
                return;
            }
            if state.hidden_by_blur_at.is_some_and(|at| at.elapsed() < BLUR_CLICK_GRACE) {
                return;
            }
        }
        self.show(window, None);
    }

    pub fn show(&self, window: &WebviewWindow, screen: Option<&str>) {
        let place = {
            let state = self.state.lock().unwrap();
            !state.floating || !window.is_visible().unwrap_or(false)
        };
        if place {
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
        let scale = window.scale_factor().unwrap_or(1.0);
        let cap = window
            .current_monitor()
            .ok()
            .flatten()
            .map_or(f64::MAX, |monitor| f64::from(monitor.work_area().size.height) * 0.85);
        let _ = window.set_size(PhysicalSize::new((WIDTH * scale).round(), (height * scale).min(cap).round()));
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
        let area = monitor.work_area();
        let work = Rect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width as i32,
            height: area.size.height as i32,
        };
        // Opened from the menu before any tray click: use the usual tray corner.
        let tray =
            tray.unwrap_or(Rect { x: work.x + work.width - 1, y: work.y + work.height + 1, width: 1, height: 1 });
        let scale = monitor.scale_factor();
        let bounds = popup_bounds(tray, work, (WIDTH * scale).round() as i32, (content_height * scale).round() as i32);
        let _ = window.set_size(PhysicalSize::new(bounds.width as u32, bounds.height as u32));
        let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
    }
}

pub const MAIN_WINDOW: &str = "main";

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}
