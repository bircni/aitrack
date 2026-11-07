use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::position::{corner_tray, popup_bounds, Rect};

const WIDTH: f64 = 320.0;

pub struct Panel {
    state: Mutex<PanelState>,
}

struct PanelState {
    /// Content height in CSS pixels, as the renderer measured it.
    content_height: f64,
    tray: Option<Rect>,
    deferred_show: Option<&'static str>,
}

impl Panel {
    pub fn new() -> Self {
        Self { state: Mutex::new(PanelState { content_height: 560.0, tray: None, deferred_show: None }) }
    }

    pub fn toggle(&self, window: &WebviewWindow, tray: Option<Rect>) {
        if tray.is_some() {
            self.state.lock().unwrap().tray = tray;
        }
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            self.show(window, None);
        }
    }

    pub fn show(&self, window: &WebviewWindow, screen: Option<&str>) {
        let visible = window.is_visible().unwrap_or(false);
        crate::deliver_skipped_state(window.app_handle());
        if !visible {
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

    /// Remembers the content height for the next placement; a shown window keeps the user's size.
    pub fn measure(&self, height: f64) -> Option<f64> {
        let height = (height.is_finite() && height > 0.0).then(|| height.ceil())?;
        self.state.lock().unwrap().content_height = height;
        Some(height)
    }

    /// Fits the height to the content now shown, keeping the window's place and the user's width.
    pub fn resize(&self, window: &WebviewWindow, height: f64) {
        let Some(height) = self.measure(height) else { return };
        let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
        let _ = window.set_size(PhysicalSize::new(size.width, (height * scale).round() as u32));
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
        let tray = tray.unwrap_or_else(|| corner_tray(work, cfg!(target_os = "linux")));
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
