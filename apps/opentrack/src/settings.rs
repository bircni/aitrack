use std::path::Path;

use aitrack_core::js;
use aitrack_core::providers::{provider_label, PROVIDERS};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSetting {
    pub key: String,
    /// Filled in from the provider registry; what is saved is ignored.
    pub label: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    /// Show quotas as used or as remaining.
    pub display: String,
    pub reset_display: String,
    pub providers: Vec<ProviderSetting>,
    pub launch_at_login: bool,
    /// Tauri global-shortcut accelerator, empty for none.
    pub global_shortcut: String,
    pub notifications: bool,
    /// Stays open on blur, shows in the taskbar and keeps where it was dragged.
    pub keep_open: bool,
    /// Shows only the session limit of each enabled provider.
    pub compact: bool,
    /// `git pull` the aitrack data repo so other machines' usage stays current.
    pub pull_synced_data: bool,
    /// The provider the tray icon follows; `auto` takes the most used one.
    pub tray_provider: String,
    /// Its window; `highest` takes whichever is most used.
    pub tray_window: String,
    pub tray_style: String,
    pub tray_colored: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            display: "used".into(),
            reset_display: "absolute".into(),
            providers: PROVIDERS
                .iter()
                .map(|p| ProviderSetting { key: p.key.into(), label: p.label.into(), enabled: true })
                .collect(),
            launch_at_login: false,
            global_shortcut: String::new(),
            notifications: true,
            keep_open: false,
            compact: false,
            pull_synced_data: true,
            tray_provider: "auto".into(),
            tray_window: "highest".into(),
            tray_style: "icon".into(),
            tray_colored: true,
        }
    }
}

impl Settings {
    pub fn enabled_providers(&self) -> Vec<String> {
        self.providers.iter().filter(|p| p.enabled).map(|p| p.key.clone()).collect()
    }
}

fn pick(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    value.and_then(Value::as_str).filter(|v| allowed.contains(v)).unwrap_or(fallback).to_owned()
}

fn boolean(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn is_provider_key(key: &str) -> bool {
    PROVIDERS.iter().any(|p| p.key == key)
}

/// Settings from untrusted input (disk or the renderer): unknown fields are dropped, bad values fall
/// back, and every provider appears exactly once.
pub fn normalize_settings(input: &Value) -> Settings {
    let empty = serde_json::Map::new();
    let raw = input.as_object().unwrap_or(&empty);
    let field = |key: &str| raw.get(key);
    let mut providers: Vec<ProviderSetting> = Vec::new();
    for entry in field("providers").and_then(Value::as_array).into_iter().flatten() {
        let Some(entry) = entry.as_object() else { continue };
        let Some(key) = entry.get("key").and_then(Value::as_str).filter(|k| is_provider_key(k)) else { continue };
        if providers.iter().any(|p| p.key == key) {
            continue;
        }
        providers.push(ProviderSetting {
            key: key.into(),
            label: provider_label(key).into(),
            enabled: boolean(entry.get("enabled"), true),
        });
    }
    for descriptor in &PROVIDERS {
        if !providers.iter().any(|p| p.key == descriptor.key) {
            providers.push(ProviderSetting {
                key: descriptor.key.into(),
                label: descriptor.label.into(),
                enabled: true,
            });
        }
    }
    let d = Settings::default();
    let tray_providers: Vec<&str> = std::iter::once("auto").chain(PROVIDERS.iter().map(|p| p.key)).collect();
    // Earlier versions saved the pin as `windowMode` and then as `alwaysOnTop`.
    let legacy_keep_open = field("alwaysOnTop") == Some(&Value::Bool(true))
        || field("windowMode").and_then(Value::as_str) == Some("floating");
    Settings {
        theme: pick(field("theme"), &["system", "light", "dark"], &d.theme),
        display: pick(field("display"), &["used", "left"], &d.display),
        reset_display: pick(field("resetDisplay"), &["relative", "absolute"], &d.reset_display),
        providers,
        launch_at_login: boolean(field("launchAtLogin"), d.launch_at_login),
        global_shortcut: field("globalShortcut").and_then(Value::as_str).map(js::trim).unwrap_or_default().to_owned(),
        notifications: boolean(field("notifications"), d.notifications),
        keep_open: boolean(field("keepOpen"), legacy_keep_open),
        compact: boolean(field("compact"), d.compact),
        pull_synced_data: boolean(field("pullSyncedData"), d.pull_synced_data),
        tray_provider: pick(field("trayProvider"), &tray_providers, &d.tray_provider),
        tray_window: pick(field("trayWindow"), &["highest", "session", "weekly"], &d.tray_window),
        tray_style: pick(field("trayStyle"), &["icon", "bars"], &d.tray_style),
        tray_colored: boolean(field("trayColored"), d.tray_colored),
    }
}

/// The parsed file, or `Null` when it is missing or not JSON.
pub fn read_json_file(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null)
}

/// `JSON.stringify(value, null, 2)` and a newline, as 4.x wrote it.
pub fn settings_json(settings: &Settings) -> String {
    format!("{}\n", js::to_string_pretty(settings).expect("settings serialize"))
}

pub fn write_settings(path: &Path, settings: &Settings) -> std::io::Result<()> {
    aitrack_core::fs::write_file_atomic(path, &settings_json(settings), None)
}

pub fn load_settings(path: &Path) -> Settings {
    normalize_settings(&read_json_file(path))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn fills_defaults_and_drops_bad_values() {
        assert_eq!(normalize_settings(&Value::Null), Settings::default());
        let settings = normalize_settings(&json!({
            "theme": "neon",
            "display": "left",
            "providers": [
                { "key": "cursor", "enabled": false },
                { "key": "codex" },
                { "key": "cursor" },
                { "key": "bogus" },
                null,
            ],
            "globalShortcut": "  Alt+U ",
            "notifications": "yes",
            "trayStyle": "square",
            "trayColored": "yes",
        }));
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.display, "left");
        assert_eq!(settings.global_shortcut, "Alt+U");
        assert!(settings.notifications && settings.tray_colored && !settings.keep_open);
        assert_eq!(settings.tray_style, "icon");
        assert!(normalize_settings(&json!({ "windowMode": "floating" })).keep_open);
        assert!(!normalize_settings(&json!({ "windowMode": "docked" })).keep_open);
        assert!(normalize_settings(&json!({ "alwaysOnTop": true })).keep_open);
        let providers: Vec<(&str, &str, bool)> =
            settings.providers.iter().map(|p| (p.key.as_str(), p.label.as_str(), p.enabled)).collect();
        assert_eq!(
            providers,
            [("cursor", "Cursor", false), ("codex", "Codex", true), ("claude_code", "Claude Code", true)]
        );
    }

    #[test]
    fn round_trips_through_disk_and_tolerates_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let saved =
            Settings { theme: "dark".into(), tray_style: "bars".into(), tray_colored: false, ..Settings::default() };
        write_settings(&path, &saved).unwrap();
        assert_eq!(load_settings(&path), saved);
        std::fs::write(&path, "{").unwrap();
        assert_eq!(load_settings(&path), Settings::default());
    }
}
