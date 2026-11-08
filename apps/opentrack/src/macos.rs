//! A borderless `NSWindow` has square corners; the frame view is clipped to a rounded shape instead,
//! the way native menu-bar panels do it. `AppKit` also knows the work area, which winit does not.
#![expect(unsafe_code, reason = "AppKit is reached through objc2 calls that are unsafe by signature")]

use std::ptr::NonNull;

use objc2::MainThreadMarker;
use objc2_app_kit::{NSColor, NSScreen, NSView, NSWindow};
use objc2_quartz_core::kCACornerCurveContinuous;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use crate::position::Rect;

const RADIUS: f64 = 12.0;

fn ns_window(handle: &impl HasWindowHandle) -> Option<objc2::rc::Retained<NSWindow>> {
    let RawWindowHandle::AppKit(handle) = handle.window_handle().ok()?.as_raw() else { return None };
    let view: NonNull<NSView> = handle.ns_view.cast();
    // SAFETY: winit hands out its own live content view, and this runs on the main thread.
    unsafe { view.as_ref() }.window()
}

pub fn round_corners(handle: &impl HasWindowHandle) {
    let Some(window) = ns_window(handle) else { return };
    window.setOpaque(false);
    window.setBackgroundColor(Some(&NSColor::clearColor()));
    let Some(frame) = window.contentView().and_then(|view| unsafe { view.superview() }) else { return };
    frame.setWantsLayer(true);
    let Some(layer) = frame.layer() else { return };
    layer.setCornerRadius(RADIUS);
    // SAFETY: a constant AppKit exports.
    layer.setCornerCurve(unsafe { kCACornerCurveContinuous });
    layer.setMasksToBounds(true);
}

/// The shadow is cached for the old shape; a resized window keeps a stale one until told.
pub fn refresh_shadow(handle: &impl HasWindowHandle) {
    if let Some(window) = ns_window(handle) {
        window.invalidateShadow();
    }
}

/// The visible frame (no menu bar or Dock) of the screen holding `point`, in top-left physical pixels.
#[expect(clippy::cast_possible_truncation, reason = "the value is rounded and bounded to the target range first")]
pub fn work_area(point: Option<(i32, i32)>) -> Option<(Rect, f32)> {
    let mtm = MainThreadMarker::new()?;
    let screens = NSScreen::screens(mtm);
    let primary_height = screens.firstObject()?.frame().size.height;
    let physical = |rect: objc2_foundation::NSRect, scale: f64| Rect {
        x: (rect.origin.x * scale).round() as i32,
        y: ((primary_height - rect.origin.y - rect.size.height) * scale).round() as i32,
        width: (rect.size.width * scale).round() as i32,
        height: (rect.size.height * scale).round() as i32,
    };
    let chosen = screens
        .iter()
        .find(|screen| {
            let bounds = physical(screen.frame(), screen.backingScaleFactor());
            point.is_some_and(|(x, y)| {
                x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height
            })
        })
        .or_else(|| NSScreen::mainScreen(mtm))?;
    let scale = chosen.backingScaleFactor();
    Some((physical(chosen.visibleFrame(), scale), scale as f32))
}
