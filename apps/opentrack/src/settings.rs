use std::path::Path;

use aitrack_core::js;
use aitrack_core::providers::{provider_label, PROVIDERS};
use aitrack_core::quota::QuotaSnapshot;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::alerts::AlertRules;
use crate::state::ProviderState;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSetting {
    pub key: String,
    /// Filled in from the provider registry; what is saved is ignored.
    pub label: String,
    pub enabled: bool,
    /// Limit ids left out of the cards, the tray and alerts. Written only when set, like `pinned`,
    /// so an untouched file stays as 4.x wrote it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<String>,
    /// Limit ids shown in the Pinned card, which the tray then follows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned: Vec<String>,
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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            display: "used".into(),
            reset_display: "absolute".into(),
            providers: PROVIDERS
                .iter()
                .map(|p| ProviderSetting {
                    key: p.key.into(),
                    label: p.label.into(),
                    enabled: true,
                    ..ProviderSetting::default()
                })
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
        }
    }
}

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

    fn limits(&self, provider: &str) -> Option<&ProviderSetting> {
        self.providers.iter().find(|p| p.key == provider)
    }

    pub fn is_hidden(&self, provider: &str, limit: &str) -> bool {
        self.limits(provider).is_some_and(|p| p.hidden.iter().any(|id| id == limit))
    }

    pub fn is_pinned(&self, provider: &str, limit: &str) -> bool {
        self.limits(provider).is_some_and(|p| p.pinned.iter().any(|id| id == limit))
    }

    /// Hiding a limit unpins it, and pinning one shows it.
    pub fn set_limit(&mut self, provider: &str, limit: &str, hidden: bool, pinned: bool) {
        let Some(entry) = self.providers.iter_mut().find(|p| p.key == provider) else { return };
        for (list, on) in [(&mut entry.hidden, hidden), (&mut entry.pinned, pinned && !hidden)] {
            list.retain(|id| id != limit);
            if on {
                list.push(limit.to_owned());
            }
        }
    }

    /// The limits alerts are raised for: all but the hidden ones.
    pub fn shown_limits(&self, snapshot: &QuotaSnapshot) -> QuotaSnapshot {
        let mut shown = snapshot.clone();
        shown.windows.retain(|w| !self.is_hidden(&snapshot.provider, &w.id));
        shown
    }

    /// What the tray follows: no hidden limits, and only the pinned ones while any of them is reported.
    pub fn tray_providers(&self, providers: &[ProviderState]) -> Vec<ProviderState> {
        let keep = |pinned_only: bool| -> Vec<ProviderState> {
            providers
                .iter()
                .map(|p| {
                    let mut p = p.clone();
                    if let Some(quota) = &mut p.quota {
                        quota.windows.retain(|w| {
                            !self.is_hidden(&p.key, &w.id) && (!pinned_only || self.is_pinned(&p.key, &w.id))
                        });
                    }
                    p
                })
                .collect()
        };
        let pinned = keep(true);
        if pinned.iter().any(|p| p.quota.as_ref().is_some_and(|q| !q.windows.is_empty())) {
            pinned
        } else {
            keep(false)
        }
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
        let providers = complete_providers(self.providers.clone());
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

/// Each id once, without the ones in `except`.
fn limit_ids(ids: Vec<String>, except: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for id in ids {
        if !kept.contains(&id) && !except.contains(&id) {
            kept.push(id);
        }
    }
    kept
}

/// Known providers once each, in the order given, then any missing ones turned on.
fn complete_providers(entries: impl IntoIterator<Item = ProviderSetting>) -> Vec<ProviderSetting> {
    let mut providers: Vec<ProviderSetting> = Vec::new();
    let mut add = |entry: ProviderSetting| {
        if PROVIDERS.iter().any(|p| p.key == entry.key) && !providers.iter().any(|p| p.key == entry.key) {
            let hidden = limit_ids(entry.hidden, &[]);
            let pinned = limit_ids(entry.pinned, &hidden);
            providers.push(ProviderSetting { label: provider_label(&entry.key).into(), hidden, pinned, ..entry });
        }
    };
    for entry in entries {
        add(entry);
    }
    for descriptor in &PROVIDERS {
        add(ProviderSetting { key: descriptor.key.into(), enabled: true, ..ProviderSetting::default() });
    }
    providers
}

/// Settings from untrusted input (disk): unknown fields are dropped, bad values fall back, and every
/// provider appears exactly once.
pub fn normalize_settings(input: &Value) -> Settings {
    let empty = serde_json::Map::new();
    let raw = input.as_object().unwrap_or(&empty);
    let field = |key: &str| raw.get(key);
    let ids = |value: Option<&Value>| -> Vec<String> {
        value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    };
    let entries = field("providers").and_then(Value::as_array).into_iter().flatten().filter_map(|entry| {
        let entry = entry.as_object()?;
        Some(ProviderSetting {
            key: entry.get("key")?.as_str()?.to_owned(),
            label: String::new(),
            enabled: boolean(entry.get("enabled"), true),
            hidden: ids(entry.get("hidden")),
            pinned: ids(entry.get("pinned")),
        })
    });
    let providers = complete_providers(entries);
    let d = Settings::default();
    // Earlier versions saved the pin as `windowMode` and then as `alwaysOnTop`.
    let legacy_keep_open = field("alwaysOnTop") == Some(&Value::Bool(true))
        || field("windowMode").and_then(Value::as_str) == Some("floating");
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
                { "key": "cursor", "enabled": false },
                { "key": "codex", "hidden": ["weekly", 3, "weekly"], "pinned": ["session", "weekly"] },
                { "key": "cursor" },
                { "key": "bogus" },
                null,
            ],
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
        assert_eq!(
            (settings.providers[1].hidden.as_slice(), settings.providers[1].pinned.as_slice()),
            (&["weekly".to_owned()][..], &["session".to_owned()][..])
        );
        let providers: Vec<(&str, &str, bool)> =
            settings.providers.iter().map(|p| (p.key.as_str(), p.label.as_str(), p.enabled)).collect();
        assert_eq!(
            providers,
            [("cursor", "Cursor", false), ("codex", "Codex", true), ("claude_code", "Claude Code", true)]
        );
    }

    #[test]
    fn normalizes_settings_the_app_built_as_it_does_the_file() {
        let codex = ProviderSetting {
            key: "codex".into(),
            label: "?".into(),
            pinned: vec!["weekly".into(), "weekly".into()],
            ..ProviderSetting::default()
        };
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

    #[test]
    fn hides_and_pins_limits_for_the_tray_and_alerts() {
        use crate::alerts::fixtures::{session_window, snapshot};
        use aitrack_core::quota::QuotaWindow;

        let weekly = QuotaWindow { id: "weekly".into(), ..session_window(40.0, 2.5) };
        let provider = ProviderState {
            key: "claude_code".into(),
            label: "Claude Code".into(),
            quota: Some(snapshot(vec![session_window(90.0, 2.5), weekly])),
            quota_error: None,
            retry_at: None,
            usage: None,
            refreshing: false,
        };
        let ids = |providers: &[ProviderState]| -> Vec<String> {
            providers.iter().flat_map(|p| p.quota.iter().flat_map(|q| &q.windows)).map(|w| w.id.clone()).collect()
        };
        let mut settings = Settings::default();
        assert_eq!(ids(&settings.tray_providers(std::slice::from_ref(&provider))), ["session", "weekly"]);

        settings.set_limit("claude_code", "weekly", false, true);
        assert_eq!(ids(&settings.tray_providers(std::slice::from_ref(&provider))), ["weekly"]);
        settings.set_limit("claude_code", "gone", false, true);
        settings.set_limit("claude_code", "weekly", true, true);
        assert!(settings.is_hidden("claude_code", "weekly") && !settings.is_pinned("claude_code", "weekly"));
        assert_eq!(ids(&settings.tray_providers(std::slice::from_ref(&provider))), ["session"]);
        let shown = settings.shown_limits(provider.quota.as_ref().unwrap());
        assert_eq!(shown.windows.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["session"]);
        assert_eq!(settings.clone().normalized(), settings);
    }
}
