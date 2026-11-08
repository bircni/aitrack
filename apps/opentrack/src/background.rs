//! The work behind the popup, on aitrack-core: refreshing, persisting, settings and the tray picture.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
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
use crate::settings::{load_settings, read_json_file, write_settings, Settings};
use crate::state::AppState;
use crate::tray_icon::{render_tray_icon, summarize_tray, TrayAppearance, TrayChoice, TraySummary};
use crate::usage::{load_usage_summary, UsageLoadOptions, UsageLoadResult, GIT_TIMEOUT};
use aitrack_core::Locked;

const TICK: Duration = Duration::from_secs(60);
const TRAY_ICON_SIZE: u32 = 32;

/// What the shell shows: the state, the settings, a notification, or a new tray picture.
pub enum Event<'a> {
    State(Arc<AppState>),
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
        let settings = self.settings.locked().clone();
        let choice = TrayChoice {
            provider: &settings.tray_provider,
            window: &settings.tray_window,
            style: &settings.tray_style,
        };
        let summary = summarize_tray(&self.core.clock, &state.providers, self.now(), choice);
        // A repeated state can still mean a new tray setting or a passed reset.
        let key = Some((summary.clone(), settings.tray_style.clone(), settings.tray_colored));
        {
            let mut last = self.last_tray.locked();
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

    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    fn now(&self) -> f64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }

    /// The popup first; the tray icon may need redrawing.
    fn on_state(&self, state: Arc<AppState>) {
        self.send(Event::State(Arc::clone(&state)));
        self.update_tray(&state);
    }

    fn on_alert(&self, alert: &Alert) {
        self.send(Event::Alert { title: &alert.title, body: &alert.body });
    }

    fn persist(&self, cache: &CachedState) {
        if let Err(error) = aitrack_core::fs::write_file_atomic(&self.cache_path, cache_json(cache), None) {
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
        Arc::new(Self { service: QuotaService::new(deps, clock, settings, Some(cached)), settings_path })
    }

    const fn deps(&self) -> &LiveDeps {
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

    /// Saves numbered settings in order, so an older save never lands last; of a burst only the newest
    /// is written. `on_done` gets its number and the normalized settings, or why they were not saved.
    pub fn saver(
        self: &Arc<Self>,
        on_done: impl Fn(u64, Result<Settings, String>) + Send + 'static,
    ) -> Sender<(u64, Settings)> {
        let background = Arc::clone(self);
        latest_worker(move |(seq, settings)| on_done(seq, background.save_settings(settings)))
    }

    fn save_settings(self: &Arc<Self>, settings: Settings) -> Result<Settings, String> {
        let settings = settings.normalized();
        write_settings(&self.settings_path, &settings).map_err(|error| error.to_string())?;
        settings.clone_into(&mut self.deps().settings.locked());
        self.service.set_settings(settings.clone());
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

/// One thread that handles values in the order sent and, of a burst, only the newest.
pub fn latest_worker<T: Send + 'static>(mut handle: impl FnMut(T) + Send + 'static) -> Sender<T> {
    let (tx, rx) = channel::<T>();
    std::thread::spawn(move || {
        while let Ok(mut value) = rx.recv() {
            while let Ok(newer) = rx.try_recv() {
                value = newer;
            }
            handle(value);
        }
    });
    tx
}

#[derive(Serialize)]
struct SmokeTest {
    settings: Settings,
    state: AppState,
}

/// The settings and state a packaged build starts with, for the installer smoke test.
#[expect(clippy::expect_used, reason = "our own types always serialize to JSON")]
pub fn smoke_test_line(background: &Background) -> String {
    let answer = SmokeTest { settings: background.service.settings(), state: background.service.state() };
    aitrack_core::js::to_string(&answer).expect("serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_smoke_test_from_the_data_dir_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"theme":"dark","providers":[{"key":"codex"}]}"#).unwrap();
        let line = smoke_test_line(&Background::open(dir.path()));
        assert!(line.starts_with(r#"{"settings":{"theme":"dark","display":"used""#), "{line}");
        assert!(line.contains(r#""providers":[{"key":"codex","label":"Codex","enabled":true},"#), "{line}");
        assert!(line.contains(r#""state":{"providers":[{"key":"codex","label":"Codex","refreshing":false}"#), "{line}");
        assert!(line.ends_with(r#""refreshing":false,"syncing":false}}"#), "{line}");
    }
}
