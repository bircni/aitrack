use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{Map, Value};
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

/// The last state pushed, so the popup opens instantly even mid-refresh.
#[tauri::command]
pub fn get_state(shell: State<'_, Shell>) -> Value {
    if let Some(state) = shell.last_state.lock().unwrap().clone() {
        return state;
    }
    serde_json::to_value(shell.background.service.state()).unwrap_or_default()
}

#[tauri::command]
pub fn get_settings(shell: State<'_, Shell>) -> Value {
    serde_json::to_value(shell.background.service.settings()).unwrap_or_default()
}

/// The service runs in this process, so it is up whenever the renderer can ask.
#[tauri::command]
pub fn service_status() -> Value {
    serde_json::json!({ "state": "running", "message": null })
}

#[tauri::command]
pub fn refresh(shell: State<'_, Shell>) {
    shell.background.refresh_in_background(true);
}

#[tauri::command]
pub fn sync(shell: State<'_, Shell>) {
    shell.background.sync_in_background();
}

#[tauri::command]
pub fn save_settings(shell: State<'_, Shell>, settings: Value) -> Result<Value, String> {
    let saved = shell.background.save_settings(&settings)?;
    Ok(serde_json::to_value(saved).unwrap_or_default())
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
pub fn hide_window(app: AppHandle) {
    if let Some(window) = main_window(&app) {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn setting_errors(shell: State<'_, Shell>) -> Map<String, Value> {
    shell.setting_errors.lock().unwrap().clone()
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
