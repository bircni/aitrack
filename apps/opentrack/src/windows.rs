//! Windows 11 rounds decorated windows itself; an undecorated one has to ask. Windows 10 has no
//! rounding and rejects the request, which is fine. The work area comes from the monitor info.

use std::ffi::c_void;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::position::Rect;

pub fn round_corners(handle: &impl HasWindowHandle) {
    let Ok(window) = handle.window_handle() else { return };
    let RawWindowHandle::Win32(window) = window.as_raw() else { return };
    let hwnd = HWND(window.hwnd.get() as *mut c_void);
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

/// The work area (no taskbar) of the monitor nearest `point`, in physical pixels.
pub fn work_area(point: Option<(i32, i32)>) -> Option<(Rect, f32)> {
    let (x, y) = point.unwrap_or((0, 0));
    // SAFETY: plain value calls; `info` lives across the call that fills it.
    unsafe {
        let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let work = info.rcWork;
        let rect = Rect { x: work.left, y: work.top, width: work.right - work.left, height: work.bottom - work.top };
        Some((rect, dpi_x as f32 / 96.0))
    }
}
