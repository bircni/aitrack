//! What differs per OS for the window, behind one set of calls with no-op fallbacks. The tray keeps
//! its own: Linux runs it on a GTK thread, and only macOS has template icons.

use raw_window_handle::HasWindowHandle;
use winit::event_loop::EventLoopBuilder;

use crate::position::Rect;

/// macOS and most Linux desktops put the tray in a bar along the top; Windows' taskbar is at the bottom.
pub const TRAY_ON_TOP: bool = !cfg!(windows);

/// macOS rounds the window by clipping it, which needs a see-through one.
pub const TRANSPARENT: bool = cfg!(target_os = "macos");

/// Linux has no tray click, so its menu opens the popup; the monitors may have changed since.
pub fn before_tray_menu() {
    #[cfg(target_os = "linux")]
    linux::read_work_area();
}

/// Before the event loop: Wayland compositors ignore window positions and block global shortcuts,
/// so Linux runs on XWayland unless asked not to.
pub fn prepare() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("OPENTRACK_WAYLAND").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::remove_var("WAYLAND_DISPLAY");
    }
}

/// A menu-bar app on macOS: no Dock icon and no app menu.
pub fn configure_event_loop(builder: &mut EventLoopBuilder<eframe::UserEvent>) {
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        builder.with_activation_policy(ActivationPolicy::Accessory);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = builder;
}

pub fn round_corners(window: &impl HasWindowHandle) {
    #[cfg(target_os = "macos")]
    crate::macos::round_corners(window);
    #[cfg(windows)]
    crate::windows::round_corners(window);
    #[cfg(target_os = "linux")]
    let _ = window; // Rounding needs a compositor with alpha.
}

/// After a resize; only macOS caches the window's shadow.
pub fn refresh_shadow(window: &impl HasWindowHandle) {
    #[cfg(target_os = "macos")]
    crate::macos::refresh_shadow(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// The kept-open window gets a taskbar button so it can be found behind others; the popup has none.
pub fn show_in_taskbar(window: &impl HasWindowHandle, show: bool) {
    #[cfg(windows)]
    crate::windows::show_in_taskbar(window, show);
    #[cfg(not(windows))]
    let _ = (window, show);
}

/// The work area (no menu bar, Dock, taskbar or panels) of the screen holding `point`, in physical
/// pixels, with that screen's scale.
pub fn work_area(point: Option<(i32, i32)>) -> Option<(Rect, f32)> {
    #[cfg(target_os = "macos")]
    return crate::macos::work_area(point);
    #[cfg(windows)]
    return crate::windows::work_area(point);
    #[cfg(target_os = "linux")]
    {
        let _ = point;
        return *linux::WORK_AREA.lock().unwrap();
    }
}

/// What a physical position is divided by to give winit the logical one it expects. macOS lays all
/// screens out in points, so the target screen's scale applies; elsewhere winit converts back with
/// the scale of the screen the window is on now, which can differ.
pub fn position_scale(target_scale: f32, window_scale: f32) -> f32 {
    if cfg!(target_os = "macos") {
        target_scale
    } else {
        window_scale
    }
}

#[cfg(target_os = "linux")]
pub mod linux {
    use std::sync::Mutex;

    use crate::position::Rect;

    /// Read on GTK's thread, which owns GDK; the window's thread may not call it.
    pub static WORK_AREA: Mutex<Option<(Rect, f32)>> = Mutex::new(None);

    /// The primary monitor's work area, from GTK's thread.
    pub fn read_work_area() {
        let Some(monitor) = gtk::gdk::Display::default().and_then(|display| display.primary_monitor()) else { return };
        let area = monitor.workarea();
        let scale = monitor.scale_factor();
        let rect = Rect {
            x: area.x() * scale,
            y: area.y() * scale,
            width: area.width() * scale,
            height: area.height() * scale,
        };
        #[allow(clippy::cast_precision_loss)]
        let scale = scale as f32;
        *WORK_AREA.lock().unwrap() = Some((rect, scale));
    }
}
