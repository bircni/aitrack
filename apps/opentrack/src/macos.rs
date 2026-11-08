//! A borderless NSWindow has square corners; the frame view is clipped to a rounded shape instead,
//! the way native menu-bar panels do it.

use objc2_app_kit::{NSColor, NSWindow};
use objc2_quartz_core::kCACornerCurveContinuous;
use tauri::WebviewWindow;

const RADIUS: f64 = 12.0;

pub fn round_corners(window: &WebviewWindow) {
    let Ok(ptr) = window.ns_window() else { return };
    // SAFETY: Tauri hands out the window's own NSWindow and this runs on the main thread.
    unsafe {
        let ns_window = &*ptr.cast::<NSWindow>();
        ns_window.setOpaque(false);
        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
        let Some(frame) = ns_window.contentView().and_then(|view| view.superview()) else { return };
        frame.setWantsLayer(true);
        let Some(layer) = frame.layer() else { return };
        layer.setCornerRadius(RADIUS);
        layer.setCornerCurve(kCACornerCurveContinuous);
        layer.setMasksToBounds(true);
    }
}

/// The shadow is cached for the old shape; a resized window keeps a stale one until told.
pub fn refresh_shadow(window: &WebviewWindow) {
    let Ok(ptr) = window.ns_window() else { return };
    // SAFETY: as in `round_corners`.
    unsafe { (*ptr.cast::<NSWindow>()).invalidateShadow() };
}
