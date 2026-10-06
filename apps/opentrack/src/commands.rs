use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::panel::{main_window, Panel};
use crate::updater::Updates;
use crate::Shell;

/// Same JSON the TypeScript UI imports (`apps/opentrack-ui/src/shared/provider-dashboards.json`).
static DASHBOARDS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../opentrack-ui/src/shared/provider-dashboards.json"))
        .expect("provider-dashboards.json")
});

/// The last state the sidecar pushed, so the popup opens instantly even mid-refresh.
#[tauri::command]
pub async fn get_state(shell: State<'_, Shell>) -> Result<Value, String> {
    if let Some(state) = shell.last_state.lock().unwrap().clone() {
        return Ok(state);
    }
    shell.sidecar.request("getState", Value::Null).await
}

#[tauri::command]
pub async fn get_settings(shell: State<'_, Shell>) -> Result<Value, String> {
    if let Some(settings) = shell.last_settings.lock().unwrap().clone() {
        return Ok(settings);
    }
    shell.sidecar.request("getSettings", Value::Null).await
}

#[tauri::command]
pub async fn refresh(shell: State<'_, Shell>) -> Result<(), String> {
    shell.sidecar.request("refresh", Value::Null).await.map(|_| ())
}

#[tauri::command]
pub async fn sync(shell: State<'_, Shell>) -> Result<(), String> {
    shell.sidecar.request("sync", Value::Null).await.map(|_| ())
}

#[tauri::command]
pub async fn save_settings(shell: State<'_, Shell>, settings: Value) -> Result<Value, String> {
    shell.sidecar.request("saveSettings", settings).await
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle, provider: String) -> Result<(), String> {
    let Some(url) = DASHBOARDS.get(&provider) else {
        return Err(format!("No dashboard for {provider}"));
    };
    app.opener().open_url(url, None::<&str>).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn fit_height(app: AppHandle, panel: State<'_, Panel>, height: f64) {
    if let Some(window) = main_window(&app) {
        panel.fit(&window, height);
    }
}

#[tauri::command]
pub fn shortcut_error(shell: State<'_, Shell>) -> Option<String> {
    shell.shortcut_error.lock().unwrap().clone()
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    crate::updater::check(&app).await
}

/// The version a newer release offers, or none while this one is current.
#[tauri::command]
pub fn available_update(updates: State<'_, Updates>) -> Option<String> {
    updates.version()
}

#[tauri::command]
pub async fn install_update(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
    updates.install(&app).await
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}
