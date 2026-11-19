use std::path::Path;

use aitrack_core::js;
use aitrack_core::providers::{provider_label, PROVIDERS};
use aitrack_core::time::iso_millis;
use jiff::{SignedDuration, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::alerts::AlertRules;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSetting {
    pub key: String,
    /// Filled in from the provider registry; what is saved is ignored.
    pub label: String,
    pub enabled: bool,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors settings.json, whose independent on/off keys stay as 4.x wrote them"
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    /// Show quotas as used or as remaining.
    pub display: String,
    pub reset_display: String,
    pub providers: Vec<ProviderSetting>,
    pub launch_at_login: bool,
    /// Accelerator such as `CommandOrControl+Shift+O`, as 4.x saved it; empty for none.
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
    /// Percent left at which a limit counts as almost used up. Written only when changed, like
    /// `alert_unused`, so an untouched file stays as 4.x wrote it.
    #[serde(default = "default_alert_threshold", skip_serializing_if = "is_default_alert_threshold")]
    pub alert_threshold: u32,
    /// Alert when a weekly limit is about to reset mostly unused.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub alert_unused: bool,
    /// Share the settings that mean the same on every machine through the aitrack data repo.
    #[serde(rename = "syncSettings", default, skip_serializing_if = "std::ops::Not::not")]
    pub sync: bool,
    /// When the shared settings last changed here or were taken from the repo, where the newest wins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_at: Option<String>,
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
            alert_threshold: DEFAULT_ALERT_THRESHOLD,
            alert_unused: false,
            sync: false,
            shared_at: None,
        }
    }
}

/// What other machines take over; every other key describes this machine.
const SHARED_KEYS: &[&str] = &[
    "theme",
    "display",
    "resetDisplay",
    "providers",
    "notifications",
    "compact",
    "trayProvider",
    "trayWindow",
    "alertThreshold",
    "alertUnused",
];

const THEMES: &[&str] = &["system", "light", "dark"];
const DISPLAYS: &[&str] = &["used", "left"];
const RESET_DISPLAYS: &[&str] = &["relative", "absolute"];
const TRAY_WINDOWS: &[&str] = &["highest", "session", "weekly"];
const TRAY_STYLES: &[&str] = &["icon", "bars"];
pub const ALERT_THRESHOLDS: &[u32] = &[5, 10, 20, 30];
const DEFAULT_ALERT_THRESHOLD: u32 = 10;

const fn default_alert_threshold() -> u32 {
    DEFAULT_ALERT_THRESHOLD
}

#[expect(clippy::trivially_copy_pass_by_ref, reason = "serde passes the field by reference")]
const fn is_default_alert_threshold(value: &u32) -> bool {
    *value == DEFAULT_ALERT_THRESHOLD
}

fn tray_providers() -> Vec<&'static str> {
    std::iter::once("auto").chain(PROVIDERS.iter().map(|p| p.key)).collect()
}

impl Settings {
    pub fn alert_rules(&self) -> AlertRules {
        AlertRules { almost_out_left: f64::from(self.alert_threshold), unused: self.alert_unused }
    }

    pub fn shared(&self) -> Map<String, Value> {
        let Ok(Value::Object(mut shared)) = serde_json::to_value(self) else { return Map::new() };
        shared.retain(|key, _| SHARED_KEYS.contains(&key.as_str()));
        // A key the shared file lacks keeps this machine's value, so a default cannot be left out.
        shared.insert("alertThreshold".into(), self.alert_threshold.into());
        shared.insert("alertUnused".into(), self.alert_unused.into());
        for provider in shared.get_mut("providers").and_then(Value::as_array_mut).into_iter().flatten() {
            provider.as_object_mut().and_then(|provider| provider.shift_remove("label"));
        }
        shared
    }

    /// These settings with another machine's shared ones over them.
    #[must_use]
    pub fn with_shared(&self, shared: &Map<String, Value>) -> Self {
        let Ok(Value::Object(mut merged)) = serde_json::to_value(self) else { return self.clone() };
        for key in SHARED_KEYS {
            if let Some(value) = shared.get(*key) {
                merged.insert((*key).to_owned(), value.clone());
            }
        }
        normalize_settings(&Value::Object(merged))
    }

    pub fn shared_time(&self) -> Option<Timestamp> {
        self.shared_at.as_deref().and_then(|at| at.parse().ok())
    }

    /// Dates a change to the shared settings made after `previous`, so that it wins over older ones
    /// even when this machine's clock is behind. Without a date, the repo's settings win.
    #[must_use]
    pub fn dated(mut self, previous: &Self, now: Timestamp) -> Self {
        self.shared_at = if !self.sync {
            None
        } else if previous.sync && self.shared() != previous.shared() {
            let after = previous.shared_time().and_then(|at| at.checked_add(SignedDuration::from_millis(1)).ok());
            Some(iso_millis(after.map_or(now, |after| now.max(after))))
        } else {
            previous.shared_at.clone()
        };
        self
    }

    pub fn enabled_providers(&self) -> Vec<String> {
        self.providers.iter().filter(|p| p.enabled).map(|p| p.key.clone()).collect()
    }

    /// [`normalize_settings`]'s rules for settings built in the app rather than read from disk.
    #[must_use]
    pub fn normalized(self) -> Self {
        let d = Self::default();
        let fix = |value: String, allowed: &[&str], fallback: String| {
            if allowed.contains(&value.as_str()) {
                value
            } else {
                fallback
            }
        };
        let providers = complete_providers(self.providers.iter().map(|p| (p.key.as_str(), p.enabled)));
        Self {
            theme: fix(self.theme, THEMES, d.theme),
            display: fix(self.display, DISPLAYS, d.display),
            reset_display: fix(self.reset_display, RESET_DISPLAYS, d.reset_display),
            providers,
            global_shortcut: js::trim(&self.global_shortcut).to_owned(),
            tray_provider: fix(self.tray_provider, &tray_providers(), d.tray_provider),
            tray_window: fix(self.tray_window, TRAY_WINDOWS, d.tray_window),
            tray_style: fix(self.tray_style, TRAY_STYLES, d.tray_style),
            alert_threshold: threshold(Some(self.alert_threshold.into())),
            shared_at: updated_at(self.shared_at.as_deref(), self.sync),
            ..self
        }
    }
}

fn pick(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    value.and_then(Value::as_str).filter(|v| allowed.contains(v)).unwrap_or(fallback).to_owned()
}

fn boolean(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn threshold(value: Option<u64>) -> u32 {
    value
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| ALERT_THRESHOLDS.contains(v))
        .unwrap_or(DEFAULT_ALERT_THRESHOLD)
}

fn updated_at(value: Option<&str>, syncing: bool) -> Option<String> {
    value.filter(|at| syncing && at.parse::<Timestamp>().is_ok()).map(str::to_owned)
}

/// Known providers once each, in the order given, then any missing ones turned on.
fn complete_providers<'a>(entries: impl IntoIterator<Item = (&'a str, bool)>) -> Vec<ProviderSetting> {
    let mut providers: Vec<ProviderSetting> = Vec::new();
    let mut add = |key: &str, enabled: bool| {
        if PROVIDERS.iter().any(|p| p.key == key) && !providers.iter().any(|p| p.key == key) {
            providers.push(ProviderSetting { key: key.into(), label: provider_label(key).into(), enabled });
        }
    };
    for (key, enabled) in entries {
        add(key, enabled);
    }
    for descriptor in &PROVIDERS {
        add(descriptor.key, true);
    }
    providers
}

/// Settings from untrusted input (disk): unknown fields are dropped, bad values fall back, and every
/// provider appears exactly once.
pub fn normalize_settings(input: &Value) -> Settings {
    let empty = serde_json::Map::new();
    let raw = input.as_object().unwrap_or(&empty);
    let field = |key: &str| raw.get(key);
    let entries = field("providers").and_then(Value::as_array).into_iter().flatten().filter_map(|entry| {
        let entry = entry.as_object()?;
        Some((entry.get("key")?.as_str()?, boolean(entry.get("enabled"), true)))
    });
    let providers = complete_providers(entries);
    let d = Settings::default();
    // Earlier versions saved the pin as `windowMode` and then as `alwaysOnTop`.
    let legacy_keep_open = field("alwaysOnTop") == Some(&Value::Bool(true))
        || field("windowMode").and_then(Value::as_str) == Some("floating");
    let sync = boolean(field("syncSettings"), d.sync);
    Settings {
        theme: pick(field("theme"), THEMES, &d.theme),
        display: pick(field("display"), DISPLAYS, &d.display),
        reset_display: pick(field("resetDisplay"), RESET_DISPLAYS, &d.reset_display),
        providers,
        launch_at_login: boolean(field("launchAtLogin"), d.launch_at_login),
        global_shortcut: field("globalShortcut").and_then(Value::as_str).map(js::trim).unwrap_or_default().to_owned(),
        notifications: boolean(field("notifications"), d.notifications),
        keep_open: boolean(field("keepOpen"), legacy_keep_open),
        compact: boolean(field("compact"), d.compact),
        pull_synced_data: boolean(field("pullSyncedData"), d.pull_synced_data),
        tray_provider: pick(field("trayProvider"), &tray_providers(), &d.tray_provider),
        tray_window: pick(field("trayWindow"), TRAY_WINDOWS, &d.tray_window),
        tray_style: pick(field("trayStyle"), TRAY_STYLES, &d.tray_style),
        tray_colored: boolean(field("trayColored"), d.tray_colored),
        alert_threshold: threshold(field("alertThreshold").and_then(Value::as_u64)),
        alert_unused: boolean(field("alertUnused"), d.alert_unused),
        sync,
        shared_at: updated_at(field("sharedAt").and_then(Value::as_str), sync),
    }
}

/// The parsed file, or `Null` when it is missing or not JSON.
pub fn read_json_file(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null)
}

/// `JSON.stringify(value, null, 2)` and a newline, as 4.x wrote it.
pub fn settings_json(settings: &Settings) -> String {
    format!("{}\n", js::stringify_pretty(settings))
}

pub fn write_settings(path: &Path, settings: &Settings) -> std::io::Result<()> {
    aitrack_core::fs::write_file_atomic(path, settings_json(settings), None)
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
                { "key": "codex", "enabled": false },
                { "key": "cursor", "enabled": false },
                { "key": "codex" },
                { "key": "bogus" },
                null,
            ],
            "trayProvider": "cursor",
            "globalShortcut": "  Alt+U ",
            "notifications": "yes",
            "trayStyle": "square",
            "trayColored": "yes",
            "alertThreshold": 7,
            "alertUnused": true,
        }));
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.display, "left");
        assert_eq!(settings.global_shortcut, "Alt+U");
        assert!(settings.notifications && settings.tray_colored && !settings.keep_open);
        assert_eq!(settings.tray_style, "icon");
        assert_eq!((settings.alert_threshold, settings.alert_unused), (10, true));
        assert!(normalize_settings(&json!({ "windowMode": "floating" })).keep_open);
        assert!(!normalize_settings(&json!({ "windowMode": "docked" })).keep_open);
        assert!(normalize_settings(&json!({ "alwaysOnTop": true })).keep_open);
        let providers: Vec<(&str, &str, bool)> =
            settings.providers.iter().map(|p| (p.key.as_str(), p.label.as_str(), p.enabled)).collect();
        assert_eq!(
            providers,
            [("codex", "Codex", false), ("claude_code", "Claude Code", true), ("copilot", "GitHub Copilot", true)]
        );
        assert_eq!(settings.tray_provider, "auto");
    }

    #[test]
    fn normalizes_settings_the_app_built_as_it_does_the_file() {
        let codex = ProviderSetting { key: "codex".into(), label: "?".into(), enabled: false };
        let built = Settings {
            theme: "neon".into(),
            global_shortcut: " Ctrl+K ".into(),
            providers: vec![codex.clone(), ProviderSetting { key: "bogus".into(), ..codex.clone() }, codex],
            tray_window: "monthly".into(),
            alert_threshold: 15,
            ..Settings::default()
        };
        let from_file = normalize_settings(&serde_json::to_value(&built).unwrap());
        assert_eq!(built.normalized(), from_file);
        assert_eq!(from_file.global_shortcut, "Ctrl+K");
    }

    #[test]
    fn shares_what_every_machine_can_use_and_dates_a_change_to_it() {
        let now: Timestamp = "2026-06-01T12:00:00Z".parse().unwrap();
        let desk = Settings { sync: true, keep_open: true, alert_threshold: 30, ..Settings::default() };
        let laptop = Settings {
            sync: true,
            shared_at: Some("2026-06-01T11:00:00.000Z".into()),
            theme: "dark".into(),
            tray_style: "bars".into(),
            launch_at_login: true,
            ..Settings::default()
        };
        let shared = laptop.shared();
        assert_eq!(
            shared.keys().collect::<Vec<_>>(),
            [
                "theme",
                "display",
                "resetDisplay",
                "providers",
                "notifications",
                "compact",
                "trayProvider",
                "trayWindow",
                "alertThreshold",
                "alertUnused"
            ]
        );
        assert_eq!(shared["providers"][0], json!({ "key": "claude_code", "enabled": true }));
        let taken = desk.with_shared(&shared);
        assert_eq!(
            taken,
            Settings { sync: true, keep_open: true, theme: "dark".into(), ..Settings::default() },
            "the shared defaults replace the threshold; this machine's own keys stay"
        );
        let mut newer = shared;
        newer.shift_remove("theme");
        newer.insert("someday".into(), json!(1));
        assert_eq!(taken.with_shared(&newer), taken, "a key the file lacks keeps this machine's value");

        let dated = |settings: Settings, previous: &Settings| settings.dated(previous, now).shared_at;
        assert_eq!(dated(taken, &Settings::default()), None, "turning it on lets the repo win");
        assert_eq!(dated(Settings { keep_open: false, ..laptop.clone() }, &laptop), laptop.shared_at);
        let compact = Settings { compact: true, ..laptop.clone() };
        assert_eq!(dated(compact.clone(), &laptop).as_deref(), Some("2026-06-01T12:00:00.000Z"));
        let ahead = Settings { shared_at: Some("2026-06-02T00:00:00.000Z".into()), ..laptop.clone() };
        assert_eq!(dated(compact.clone(), &ahead).as_deref(), Some("2026-06-02T00:00:00.001Z"));
        assert_eq!(dated(Settings { sync: false, ..compact }, &laptop), None);
        let saved = normalize_settings(&serde_json::to_value(&ahead).unwrap());
        assert_eq!(saved, ahead);
        assert_eq!(normalize_settings(&json!({ "syncSettings": true, "sharedAt": "soon" })).shared_time(), None);
    }

    #[test]
    fn round_trips_through_disk_and_tolerates_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let saved = Settings {
            theme: "dark".into(),
            tray_style: "bars".into(),
            tray_colored: false,
            alert_threshold: 30,
            ..Settings::default()
        };
        write_settings(&path, &saved).unwrap();
        assert_eq!(load_settings(&path), saved);
        std::fs::write(&path, "{").unwrap();
        assert_eq!(load_settings(&path), Settings::default());
    }
}
