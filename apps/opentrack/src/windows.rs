//! Windows 11 rounds decorated windows itself; an undecorated one has to ask. Windows 10 has no
//! rounding and rejects the request, which is fine.

use std::ffi::c_void;

use tauri::WebviewWindow;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};

pub fn round_corners(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let preference = DWMWCP_ROUND;
    // SAFETY: the pointer and size describe a live `DWM_WINDOW_CORNER_PREFERENCE` for the whole call.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast::<c_void>(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
}
