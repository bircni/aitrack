#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod background;
mod cache;
mod commands;
#[cfg(test)]
mod goldens;
#[cfg(target_os = "macos")]
mod macos;
mod pace;
mod panel;
mod position;
mod service;
mod settings;
mod state;
mod tray_icon;
mod updater;
mod usage;
#[cfg(windows)]
mod windows;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::background::{smoke_test_lines, Background, Event};
use crate::panel::{main_window, Panel, MAIN_WINDOW};
use crate::position::Rect;
use crate::updater::Updates;

const TRAY_ID: &str = "main";

pub struct Shell {
    pub background: Arc<Background>,
    pub last_state: Mutex<Option<Value>>,
    /// `last_state` is newer than what a hidden window was sent.
    state_skipped: AtomicBool,
    pub last_settings: Mutex<Option<Value>>,
    /// Why a setting the OS applies did not take, keyed like the settings.
    pub setting_errors: Mutex<Map<String, Value>>,
}

fn toggle(app: &AppHandle, tray: Option<Rect>) {
    if let Some(window) = main_window(app) {
        app.state::<Panel>().toggle(&window, tray);
    }
}

fn show(app: &AppHandle, screen: &'static str) {
    let panel = app.state::<Panel>();
    if let Some(window) = panel.window_or_defer(app, screen) {
        panel.show(&window, Some(screen));
    }
}

/// Settings that live outside the webview: theme, keep open, autostart, shortcut.
fn apply_settings(app: &AppHandle, settings: &Value) {
    let text = |key: &str| settings.get(key).and_then(Value::as_str).unwrap_or_default();
    if let Some(window) = main_window(app) {
        let theme = match text("theme") {
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        };
        let _ = window.set_theme(theme);
        let keep_open = settings.get("keepOpen").and_then(Value::as_bool) == Some(true);
        app.state::<Panel>().set_floating(&window, keep_open);
    }
    let mut errors = Map::new();
    // A dev build registering itself to start at login would outlive the checkout.
    if !cfg!(debug_assertions) {
        let autostart = app.autolaunch();
        let result = if settings.get("launchAtLogin").and_then(Value::as_bool) == Some(true) {
            autostart.enable()
        } else {
            autostart.disable()
        };
        if let Err(error) = result {
            errors.insert("launchAtLogin".into(), error.to_string().into());
        }
    }
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let accelerator = text("globalShortcut");
    if !accelerator.is_empty() {
        let registered = shortcuts.on_shortcut(accelerator, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle(app, None);
            }
        });
        // Settings keep what was typed; the error tells the user why it does nothing.
        if let Err(error) = registered {
            errors.insert("globalShortcut".into(), error.to_string().into());
        }
    }
    let _ = app.emit("setting-errors", &errors);
    *app.state::<Shell>().setting_errors.lock().unwrap() = errors;
}

fn is_busy(state: &Value) -> bool {
    ["refreshing", "syncing"].iter().any(|flag| state.get(flag).and_then(Value::as_bool) == Some(true))
}

fn on_state(app: &AppHandle, data: Value) {
    let shell = app.state::<Shell>();
    if shell.last_state.lock().unwrap().as_ref() == Some(&data) {
        return;
    }
    // A refresh pushes several busy states; a hidden page keeps its height from the settled one that ends it.
    let deliver = !is_busy(&data) || main_window(app).is_some_and(|window| window.is_visible().unwrap_or(true));
    if deliver {
        let _ = app.emit("state", &data);
    }
    *shell.last_state.lock().unwrap() = Some(data);
    shell.state_skipped.store(!deliver, Ordering::Relaxed);
}

/// For a window about to show. A busy state skipped just after this is followed by a settled one.
pub fn deliver_skipped_state(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.state_skipped.swap(false, Ordering::Relaxed) {
        let state = shell.last_state.lock().unwrap().clone();
        let _ = app.emit("state", &state);
    }
}

fn on_event(app: &AppHandle, event: Event<'_>) {
    match event {
        Event::State(state) => on_state(app, serde_json::to_value(state).unwrap_or_default()),
        Event::Settings(settings) => {
            let data = serde_json::to_value(settings).unwrap_or_default();
            let _ = app.emit("settings", &data);
            // A save that changes nothing the OS applies needs no reapplying.
            let changed =
                app.state::<Shell>().last_settings.lock().unwrap().replace(data.clone()).as_ref() != Some(&data);
            if changed {
                // After setup, so the window exists; the plugins also expect the main thread.
                let main = app.clone();
                let _ = app.run_on_main_thread(move || apply_settings(&main, &data));
            }
        }
        Event::Alert { title, body } => {
            let _ = app.notification().builder().title(title).body(body).show();
        }
        Event::Tray(image) => {
            let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
            let icon = Image::new_owned(image.rgba, image.size, image.size);
            let _ = tray.set_icon_with_as_template(Some(icon), image.template);
            let _ = tray.set_tooltip(Some(image.tooltip));
        }
    }
}

fn tray_rect(rect: &tauri::Rect) -> Rect {
    // Tray events report physical pixels, so the scale goes unused.
    let position = rect.position.to_physical::<i32>(1.0);
    let size = rect.size.to_physical::<i32>(1.0);
    Rect { x: position.x, y: position.y, width: size.width, height: size.height }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open", true, None::<&str>)?,
            &MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit opentrack", true, None::<&str>)?,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("opentrack")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show(app, "dashboard"),
            "settings" => show(app, "settings"),
            "refresh" => app.state::<Shell>().background.refresh_in_background(true),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left, button_state: MouseButtonState::Up, rect, ..
            } = event
            {
                toggle(tray.app_handle(), Some(tray_rect(&rect)));
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// `--smoke-test --data-dir <dir>`: the installer checks that a packaged build starts and reads its
/// settings, without touching provider credentials, usage logs or the sync repo.
fn smoke_test() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--smoke-test") {
        return false;
    }
    let data_dir = args
        .iter()
        .position(|arg| arg == "--data-dir")
        .and_then(|index| args.get(index + 1))
        .map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
    for line in smoke_test_lines(&Background::open(&data_dir)) {
        println!("{line}");
    }
    true
}

fn main() {
    if smoke_test() {
        return;
    }

    // Wayland compositors ignore window positions and block global shortcuts; XWayland honours both.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app, "dashboard")))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Panel::new())
        .manage(Updates::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::get_settings,
            commands::refresh,
            commands::sync,
            commands::save_settings,
            commands::open_dashboard,
            commands::fit_height,
            commands::hide_window,
            commands::setting_errors,
            commands::service_status,
            commands::app_version,
            commands::check_update,
            commands::available_update,
            commands::install_update,
            commands::quit,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            let background = Background::open(&app.path().app_data_dir()?);
            app.manage(Shell {
                background: Arc::clone(&background),
                last_state: Mutex::default(),
                state_skipped: AtomicBool::default(),
                last_settings: Mutex::default(),
                setting_errors: Mutex::default(),
            });

            build_tray(&handle)?;
            updater::watch(handle.clone());

            let events = handle.clone();
            background.start(move |event| on_event(&events, event));

            let config =
                app.config().app.windows.iter().find(|window| window.label == MAIN_WINDOW).ok_or("no main window")?;
            let window = WebviewWindowBuilder::from_config(&handle, config)?.build()?;
            #[cfg(target_os = "macos")]
            macos::round_corners(&window);
            #[cfg(windows)]
            windows::round_corners(&window);
            let events = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Focused(false) => events.app_handle().state::<Panel>().on_blur(&events),
                // Quitting is the tray's job; Alt+F4 or the taskbar's Close only dismiss the window.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = events.hide();
                }
                _ => {}
            });
            if let Some(screen) = handle.state::<Panel>().take_deferred_show() {
                show(&handle, screen);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("opentrack failed to start");
}
