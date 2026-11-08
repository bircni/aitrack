//! The tray icon and its menu. Linux's tray runs on its own GTK loop; elsewhere it lives on the UI thread.

use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::app::{Bus, Msg};
use crate::background::TrayImage;
use crate::position::Rect;
use crate::tray_icon::{render_tray_icon, TrayAppearance};
use crate::ui::Screen;

fn listen(bus: &Bus) {
    let menu_bus = bus.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| match event.id.0.as_str() {
        "open" => menu_bus.send(Msg::Show(Screen::Dashboard)),
        "settings" => menu_bus.send(Msg::Show(Screen::Settings)),
        "refresh" => menu_bus.send(Msg::Refresh),
        "quit" => menu_bus.send(Msg::Quit),
        _ => {}
    }));
    let click_bus = bus.clone();
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event
        {
            #[allow(clippy::cast_possible_truncation)]
            let tray = Rect {
                x: rect.position.x.round() as i32,
                y: rect.position.y.round() as i32,
                width: i32::try_from(rect.size.width).unwrap_or(0),
                height: i32::try_from(rect.size.height).unwrap_or(0),
            };
            click_bus.send(Msg::Toggle(Some(tray)));
        }
    }));
}

fn build() -> Option<TrayIcon> {
    let menu = Menu::new();
    let items = [
        MenuItem::with_id("open", "Open", true, None),
        MenuItem::with_id("refresh", "Refresh", true, None),
        MenuItem::with_id("settings", "Settings…", true, None),
    ];
    for item in &items {
        let _ = menu.append(item);
    }
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&MenuItem::with_id("quit", "Quit opentrack", true, None));
    let appearance = TrayAppearance { style: "icon".into(), colored: false, bars: Vec::new() };
    let rgba = render_tray_icon(32, 0.0, crate::pace::Tone::Neutral, &appearance);
    TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .with_tooltip("opentrack")
        .with_icon_templated(Icon::from_rgba(rgba, 32, 32).ok()?)
        .build()
        .ok()
}

fn apply(tray: &TrayIcon, image: TrayImage) {
    if let Ok(icon) = Icon::from_rgba(image.rgba, image.size, image.size) {
        let _ = if image.template { tray.set_icon_templated(Some(icon)) } else { tray.set_icon(Some(icon)) };
    }
    let _ = tray.set_tooltip(Some(image.tooltip));
}

#[cfg(not(target_os = "linux"))]
pub struct Tray(Option<TrayIcon>);

#[cfg(not(target_os = "linux"))]
impl Tray {
    /// On the main thread, after the event loop started.
    pub fn new(bus: &Bus) -> Self {
        listen(bus);
        Self(build())
    }

    pub fn set(&self, image: TrayImage) {
        if let Some(tray) = &self.0 {
            apply(tray, image);
        }
    }
}

#[cfg(target_os = "linux")]
thread_local! {
    static TRAY: std::cell::RefCell<Option<TrayIcon>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "linux")]
pub struct Tray;

#[cfg(target_os = "linux")]
impl Tray {
    /// AppIndicator needs GTK's loop, which egui's window does not run.
    pub fn new(bus: &Bus) -> Self {
        listen(bus);
        std::thread::spawn(|| {
            if gtk::init().is_err() {
                return;
            }
            TRAY.with(|tray| *tray.borrow_mut() = build());
            gtk::main();
        });
        Self
    }

    pub fn set(&self, image: TrayImage) {
        gtk::glib::MainContext::default().invoke(move || {
            TRAY.with(|tray| {
                if let Some(tray) = tray.borrow().as_ref() {
                    apply(tray, image);
                }
            });
        });
    }
}
