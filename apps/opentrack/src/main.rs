#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod panel;
mod position;
mod sidecar;
mod updater;

use std::sync::Mutex;

use base64::Engine as _;
use serde_json::{Map, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::panel::{main_window, Panel, MAIN_WINDOW};
use crate::position::Rect;
use crate::sidecar::Sidecar;
use crate::updater::Updates;

const TRAY_ID: &str = "main";

pub struct Shell {
    pub sidecar: Sidecar,
    pub last_state: Mutex<Option<Value>>,
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

/// Settings that live outside the webview: theme, window mode, autostart, shortcut.
fn apply_settings(app: &AppHandle, settings: &Value) {
    let text = |key: &str| settings.get(key).and_then(Value::as_str).unwrap_or_default();
    if let Some(window) = main_window(app) {
        let theme = match text("theme") {
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        };
        let _ = window.set_theme(theme);
        app.state::<Panel>().set_floating(&window, text("windowMode") == "floating");
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

fn on_sidecar_event(app: &AppHandle, name: &str, data: Value) {
    match name {
        "state" => {
            let _ = app.emit("state", &data);
            *app.state::<Shell>().last_state.lock().unwrap() = Some(data);
        }
        "settings" => {
            let _ = app.emit("settings", &data);
            // A sidecar restart resends the same settings; the OS-side ones need no reapplying.
            let changed =
                app.state::<Shell>().last_settings.lock().unwrap().replace(data.clone()).as_ref() != Some(&data);
            if changed {
                // After setup, so the window exists; the plugins also expect the main thread.
                let main = app.clone();
                let _ = app.run_on_main_thread(move || apply_settings(&main, &data));
            }
        }
        "alert" => {
            let text = |key: &str| data.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let _ = app.notification().builder().title(text("title")).body(text("body")).show();
        }
        "tray" => {
            let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
            let size = data.get("size").and_then(Value::as_u64).unwrap_or(0) as u32;
            let rgba = data
                .get("rgba")
                .and_then(Value::as_str)
                .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok());
            if let Some(rgba) = rgba.filter(|pixels| size > 0 && pixels.len() == (size * size * 4) as usize) {
                let template = data.get("template").and_then(Value::as_bool).unwrap_or(false);
                let _ = tray.set_icon_with_as_template(Some(Image::new_owned(rgba, size, size)), template);
            }
            let tooltip = data.get("tooltip").and_then(Value::as_str);
            let _ = tray.set_tooltip(tooltip);
        }
        _ => {}
    }
}

fn tray_rect(rect: &tauri::Rect, scale: f64) -> Rect {
    let position = rect.position.to_physical::<i32>(scale);
    let size = rect.size.to_physical::<i32>(scale);
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
            "refresh" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app.state::<Shell>().sidecar.request("refresh", Value::Null).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left, button_state: MouseButtonState::Up, rect, ..
            } = event
            {
                let app = tray.app_handle();
                let scale = main_window(app).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
                toggle(app, Some(tray_rect(&rect, scale)));
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
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
            commands::setting_errors,
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
            app.manage(Shell {
                sidecar: Sidecar::default(),
                last_state: Mutex::new(None),
                last_settings: Mutex::new(None),
                setting_errors: Mutex::default(),
            });

            build_tray(&handle)?;
            updater::watch(handle.clone());

            // Before the window: on Windows, building it waits for WebView2, which the sidecar need not.
            let program = app.path().resource_dir()?.join("opentrack-sidecar.exe");
            let data_dir = app.path().app_data_dir()?;
            let events = handle.clone();
            app.state::<Shell>()
                .sidecar
                .supervise(program, data_dir, move |name, data| on_sidecar_event(&events, name, data));

            let config =
                app.config().app.windows.iter().find(|window| window.label == MAIN_WINDOW).ok_or("no main window")?;
            let window = WebviewWindowBuilder::from_config(&handle, config)?.build()?;
            let blurred = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    blurred.app_handle().state::<Panel>().on_blur(&blurred);
                }
            });
            if let Some(screen) = handle.state::<Panel>().take_deferred_show() {
                show(&handle, screen);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("opentrack failed to start");
}
