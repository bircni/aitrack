/// Rectangles in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

const GAP: i32 = 6;

/// Where the popup goes: centred on the tray icon, on whichever side of it the
/// taskbar leaves room, and always inside the work area.
pub fn popup_bounds(tray: Rect, work: Rect, width: i32, height: i32) -> Rect {
    let height = height.min((f64::from(work.height) * 0.85).floor() as i32);
    let width = width.min(work.width);
    let tray_cx = tray.x + tray.width / 2;
    let tray_cy = tray.y + tray.height / 2;
    let work_bottom = work.y + work.height;
    let work_right = work.x + work.width;

    let mut x = tray_cx - width / 2;
    let y;
    if tray_cy < work.y {
        y = work.y + GAP; // Top bar (macOS, some Linux)
    } else if tray_cy > work_bottom {
        y = work_bottom - height - GAP; // Bottom taskbar
    } else if tray_cx > work_right {
        x = work_right - width - GAP; // Right-hand vertical taskbar
        y = tray_cy - height / 2;
    } else if tray_cx < work.x {
        x = work.x + GAP;
        y = tray_cy - height / 2;
    } else if tray.y + tray.height + height + GAP <= work_bottom {
        y = tray.y + tray.height + GAP; // Tray inside the work area (auto-hide taskbar)
    } else {
        y = tray.y - height - GAP;
    }

    Rect { x: x.clamp(work.x, work_right - width), y: y.clamp(work.y, work_bottom - height), width, height }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect { x: 0, y: 0, width: 1920, height: 1040 };

    fn tray(x: i32, y: i32, size: i32) -> Rect {
        Rect { x, y, width: size, height: size }
    }

    #[test]
    fn sits_above_a_bottom_taskbar_clamped_to_the_edge() {
        assert_eq!(
            popup_bounds(tray(1880, 1045, 24), WORK, 320, 640),
            Rect { x: 1600, y: 394, width: 320, height: 640 }
        );
    }

    #[test]
    fn sits_below_a_top_menu_bar() {
        let work = Rect { y: 25, ..WORK };
        let bounds = popup_bounds(tray(900, 0, 22), work, 320, 640);
        assert_eq!((bounds.x, bounds.y), (751, 31));
    }

    #[test]
    fn handles_side_taskbars_and_a_tray_inside_the_work_area() {
        assert_eq!(popup_bounds(tray(1930, 500, 24), WORK, 320, 640).x, 1594);
        assert_eq!(popup_bounds(tray(-40, 500, 24), WORK, 320, 640).x, 6);
        assert_eq!(popup_bounds(tray(900, 10, 24), WORK, 320, 640).y, 40);
        assert_eq!(popup_bounds(tray(900, 1000, 24), WORK, 320, 640).y, 354);
    }

    #[test]
    fn caps_the_height_at_85_percent_of_the_work_area() {
        let work = Rect { height: 600, ..WORK };
        assert_eq!(popup_bounds(tray(0, 700, 1), work, 320, 640).height, 510);
    }
}
