use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::panel::{main_window, Panel};
use crate::Shell;

const DASHBOARDS: [(&str, &str); 3] = [
    ("claude_code", "https://claude.ai/settings/usage"),
    ("codex", "https://chatgpt.com/codex/settings/usage"),
    ("cursor", "https://www.cursor.com/dashboard"),
];

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
    let Some((_, url)) = DASHBOARDS.iter().find(|(key, _)| *key == provider) else {
        return Err(format!("No dashboard for {provider}"));
    };
    app.opener().open_url(*url, None::<&str>).map_err(|error| error.to_string())
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
pub fn quit(app: AppHandle) {
    app.exit(0);
}
