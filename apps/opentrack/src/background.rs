//! The work behind the popup, on aitrack-core: refreshing, persisting, settings and the tray picture.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aitrack_core::data::types::MachineFile;
use aitrack_core::env::Env;
use aitrack_core::output::Output;
use aitrack_core::quota::{fetch_quota, QuotaResult};
use aitrack_core::sync::{sync_data, SyncOptions};
use aitrack_core::time::Clock;
use aitrack_core::Core;
use serde::Serialize;

use crate::alerts::Alert;
use crate::cache::{cache_json, load_cached_state, CachedState};
use crate::service::{Deps, QuotaService};
use crate::settings::{load_settings, normalize_settings, read_json_file, write_settings, Settings};
use crate::state::AppState;
use crate::tray_icon::{render_tray_icon, summarize_tray, TrayAppearance, TrayChoice, TraySummary};
use crate::usage::{load_usage_summary, UsageLoadOptions, UsageLoadResult, GIT_TIMEOUT};

const TICK: Duration = Duration::from_secs(60);
const TRAY_ICON_SIZE: u32 = 32;

/// What the shell shows: the state, the settings, a notification, or a new tray picture.
pub enum Event<'a> {
    State(&'a AppState),
    Settings(&'a Settings),
    Alert { title: &'a str, body: &'a str },
    Tray(TrayImage),
}

pub struct TrayImage {
    /// Straight RGBA, `size` by `size`.
    pub rgba: Vec<u8>,
    pub size: u32,
    pub tooltip: String,
    /// Let macOS choose the monochrome foreground for its menu-bar appearance.
    pub template: bool,
}

type Sink = Box<dyn Fn(Event<'_>) + Send + Sync>;

/// Warnings from the core, appended to `opentrack.log` in the data dir.
struct LogOutput(Mutex<Option<File>>);

impl LogOutput {
    fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("opentrack.log");
        let _ = std::fs::create_dir_all(data_dir);
        let _ = std::fs::rename(&path, data_dir.join("opentrack.log.1")); // Keep the last run's log.
        Self(Mutex::new(OpenOptions::new().create(true).append(true).open(path).ok()))
    }

    fn write(&self, message: &str) {
        if let Some(file) = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
            let _ = writeln!(file, "{message}");
        }
    }
}

impl Output for LogOutput {
    fn info(&self, message: &str) {
        self.write(message);
    }
    fn warn(&self, message: &str) {
        self.write(message);
    }
    fn error(&self, message: &str) {
        self.write(message);
    }
}

pub struct LiveDeps {
    core: Core,
    cache_path: PathBuf,
    sink: OnceLock<Sink>,
    /// The tray follows these; the service's own copy is behind its lock.
    settings: Mutex<Settings>,
    last_tray: Mutex<Option<(TraySummary, String, bool)>>,
}

impl LiveDeps {
    fn send(&self, event: Event<'_>) {
        if let Some(sink) = self.sink.get() {
            sink(event);
        }
    }

    fn update_tray(&self, state: &AppState) {
        let settings = self.settings.lock().unwrap().clone();
        let choice = TrayChoice {
            provider: &settings.tray_provider,
            window: &settings.tray_window,
            style: &settings.tray_style,
        };
        let summary = summarize_tray(&self.core.clock, &state.providers, self.now(), choice);
        // A repeated state can still mean a new tray setting or a passed reset.
        let key = Some((summary.clone(), settings.tray_style.clone(), settings.tray_colored));
        {
            let mut last = self.last_tray.lock().unwrap();
            if *last == key {
                return;
            }
            *last = key;
        }
        let appearance =
            TrayAppearance { style: settings.tray_style.clone(), colored: settings.tray_colored, bars: summary.bars };
        self.send(Event::Tray(TrayImage {
            rgba: render_tray_icon(TRAY_ICON_SIZE, summary.used_percent, summary.tone, &appearance),
            size: TRAY_ICON_SIZE,
            tooltip: summary.tooltip,
            template: !settings.tray_colored,
        }));
    }
}

impl Deps for LiveDeps {
    fn fetch_quota(&self, provider: &str) -> QuotaResult {
        fetch_quota(&self.core, provider)
    }

    fn load_usage(&self, options: UsageLoadOptions) -> UsageLoadResult {
        load_usage_summary(&self.core, &options)
    }

    #[allow(clippy::cast_precision_loss)]
    fn now(&self) -> f64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }

    fn on_state(&self, state: &AppState) {
        self.send(Event::State(state));
        self.update_tray(state);
    }

    fn on_alert(&self, alert: &Alert) {
        self.send(Event::Alert { title: &alert.title, body: &alert.body });
    }

    fn persist(&self, cache: &CachedState) {
        if let Err(error) = aitrack_core::fs::write_file_atomic(&self.cache_path, &cache_json(cache), None) {
            self.core.output.error(&format!("opentrack: could not write the cache: {error}"));
            // The next cycle tries again.
        }
    }

    fn sync(&self) -> Result<(String, MachineFile), String> {
        let options = SyncOptions { timeout: Some(GIT_TIMEOUT), ..SyncOptions::default() };
        sync_data(&self.core, options).map(|done| (done.message, done.machine)).map_err(|error| error.to_string())
    }
}

pub struct Background {
    pub service: QuotaService<LiveDeps>,
    settings_path: PathBuf,
    /// Saves land in the order they were made, on disk and in the service.
    saving: Mutex<()>,
}

impl Background {
    /// Reads settings and the cache; touches no credentials, logs or sync repo until `start`.
    pub fn open(data_dir: &Path) -> Arc<Self> {
        let settings_path = data_dir.join("settings.json");
        let cache_path = data_dir.join("cache.json");
        let settings = load_settings(&settings_path);
        let clock = Clock::system();
        let cached = load_cached_state(&clock, &read_json_file(&cache_path));
        let core = Core::new(Env::from_process(), clock.clone(), Box::new(LogOutput::open(data_dir)));
        let deps = LiveDeps {
            core,
            cache_path,
            sink: OnceLock::new(),
            settings: Mutex::new(settings.clone()),
            last_tray: Mutex::new(None),
        };
        Arc::new(Self {
            service: QuotaService::new(deps, clock, settings, Some(cached)),
            settings_path,
            saving: Mutex::new(()),
        })
    }

    fn deps(&self) -> &LiveDeps {
        self.service.deps()
    }

    /// Sends the settings, refreshes now and then every minute.
    pub fn start(self: &Arc<Self>, sink: impl Fn(Event<'_>) + Send + Sync + 'static) {
        let _ = self.deps().sink.set(Box::new(sink));
        self.deps().send(Event::Settings(&self.service.settings()));
        let background = Arc::clone(self);
        std::thread::spawn(move || loop {
            let tick = Arc::clone(&background);
            std::thread::spawn(move || tick.service.refresh(false));
            std::thread::sleep(TICK);
        });
    }

    pub fn save_settings(self: &Arc<Self>, input: &serde_json::Value) -> Result<Settings, String> {
        let settings = normalize_settings(input);
        {
            let _order = self.saving.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            write_settings(&self.settings_path, &settings).map_err(|error| error.to_string())?;
            settings.clone_into(&mut self.deps().settings.lock().unwrap());
            self.service.set_settings(settings.clone());
        }
        self.deps().send(Event::Settings(&settings));
        self.refresh_in_background(false);
        Ok(settings)
    }

    /// Progress reaches the shell as state events, so a caller need not wait for a cold parse.
    pub fn refresh_in_background(self: &Arc<Self>, force: bool) {
        let background = Arc::clone(self);
        std::thread::spawn(move || background.service.refresh(force));
    }

    pub fn sync_in_background(self: &Arc<Self>) {
        let background = Arc::clone(self);
        std::thread::spawn(move || background.service.sync());
    }
}

#[derive(Serialize)]
struct Reply<T> {
    id: u64,
    result: T,
}

/// The two lines 4.x's sidecar answered `getSettings` and `getState` with, for the installer smoke test.
pub fn smoke_test_lines(background: &Background) -> [String; 2] {
    let line = |value: serde_json::Result<String>| value.expect("serializes");
    [
        line(aitrack_core::js::to_string(&Reply { id: 1, result: background.service.settings() })),
        line(aitrack_core::js::to_string(&Reply { id: 2, result: background.service.state() })),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_smoke_test_from_the_data_dir_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"theme":"dark","providers":[{"key":"codex"}]}"#).unwrap();
        let [settings, state] = smoke_test_lines(&Background::open(dir.path()));
        assert!(settings.starts_with(r#"{"id":1,"result":{"theme":"dark","display":"used""#), "{settings}");
        assert!(settings.contains(r#""providers":[{"key":"codex","label":"Codex","enabled":true},"#), "{settings}");
        assert!(
            state.starts_with(r#"{"id":2,"result":{"providers":[{"key":"codex","label":"Codex","refreshing":false}"#),
            "{state}"
        );
        assert!(state.ends_with(r#""refreshing":false,"syncing":false}}"#), "{state}");
    }
}
