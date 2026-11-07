#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod panel;
mod position;
mod sidecar;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
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
use crate::sidecar::{Sidecar, Status};
use crate::updater::Updates;

const TRAY_ID: &str = "main";

#[derive(Default)]
pub struct Shell {
    pub sidecar: Sidecar,
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

/// Settings that live outside the webview: theme, always on top, autostart, shortcut.
fn apply_settings(app: &AppHandle, settings: &Value) {
    let text = |key: &str| settings.get(key).and_then(Value::as_str).unwrap_or_default();
    if let Some(window) = main_window(app) {
        let theme = match text("theme") {
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        };
        let _ = window.set_theme(theme);
        let on_top = settings.get("alwaysOnTop").and_then(Value::as_bool) == Some(true);
        let _ = window.set_always_on_top(on_top);
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

/// What is left of a state once the process working on it is gone.
fn settle(state: &mut Value) {
    for flag in ["refreshing", "syncing"] {
        if let Some(value) = state.get_mut(flag) {
            *value = false.into();
        }
    }
    if let Some(providers) = state.get_mut("providers").and_then(Value::as_array_mut) {
        for provider in providers {
            if let Some(value) = provider.get_mut("refreshing") {
                *value = false.into();
            }
        }
    }
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

fn on_service_status(app: &AppHandle, status: &Status) {
    let _ = app.emit("service-status", status.to_json());
    if *status == Status::Running {
        return;
    }
    // The process that would have finished them is gone, and "Updating…" keeps Refresh disabled.
    let shell = app.state::<Shell>();
    let settled = shell.last_state.lock().unwrap().as_mut().filter(|state| is_busy(state)).map(|state| {
        settle(state);
        state.clone()
    });
    if let Some(state) = settled {
        shell.state_skipped.store(false, Ordering::Relaxed);
        let _ = app.emit("state", &state);
    }
    // The next process sends its own tray update first thing, which restores the tooltip.
    if let (Status::Down(_), Some(tray)) = (status, app.tray_by_id(TRAY_ID)) {
        let _ = tray.set_tooltip(Some("opentrack: the background service stopped"));
    }
}

fn on_sidecar_event(app: &AppHandle, name: &str, data: Value) {
    match name {
        "state" => on_state(app, data),
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
                toggle(tray.app_handle(), Some(tray_rect(&rect)));
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
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
            commands::resize_height,
            commands::hide_window,
            commands::minimize_window,
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
            app.manage(Shell::default());

            build_tray(&handle)?;
            updater::watch(handle.clone());

            // Before the window: on Windows, building it waits for WebView2, which the sidecar need not.
            let program = app.path().resource_dir()?.join("opentrack-sidecar.exe");
            let data_dir = app.path().app_data_dir()?;
            let (events, statuses) = (handle.clone(), handle.clone());
            app.state::<Shell>().sidecar.supervise(
                program,
                data_dir,
                move |name, data| on_sidecar_event(&events, name, data),
                move |status| on_service_status(&statuses, status),
            );

            let config =
                app.config().app.windows.iter().find(|window| window.label == MAIN_WINDOW).ok_or("no main window")?;
            let window = WebviewWindowBuilder::from_config(&handle, config)?.build()?;
            let events = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Focused(false) => events.app_handle().state::<Panel>().on_blur(),
                // Quitting is the tray's job; Alt+F4, the taskbar's Close and the title bar's close only dismiss the window.
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn settling_a_state_ends_everything_a_dead_process_was_doing() {
        let mut state = json!({
            "refreshing": true,
            "syncing": true,
            "updatedAt": "then",
            "providers": [{ "key": "codex", "refreshing": true }],
        });
        assert!(is_busy(&state));
        settle(&mut state);
        assert!(!is_busy(&state));
        assert_eq!(
            state,
            json!({
                "refreshing": false,
                "syncing": false,
                "updatedAt": "then",
                "providers": [{ "key": "codex", "refreshing": false }],
            })
        );
    }
}
