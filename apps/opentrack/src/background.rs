//! The work behind the popup, on aitrack-core: refreshing, persisting, settings and the tray picture.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, RwLock, RwLockReadGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aitrack_core::data::types::MachineFile;
use aitrack_core::env::Env;
use aitrack_core::output::Level;
use aitrack_core::quota::{fetch_quota, QuotaResult};
use aitrack_core::sync::{sync_data, SyncOptions};
use aitrack_core::time::Clock;
use aitrack_core::Core;
use serde::Serialize;

use crate::alerts::Alert;
use crate::cache::{cache_json, load_cached_state, CachedState};
use crate::logs::LogOutput;
use crate::service::{Deps, QuotaService};
use crate::settings::{normalize_settings, read_json_file, write_settings, Settings};
use crate::settings_sync::reconcile;
use crate::state::AppState;
use crate::tray_icon::{render_tray_icon, summarize_tray, TrayAppearance, TrayChoice, TraySummary};
use crate::usage::{is_usage_not_configured, load_usage_summary, UsageLoadOptions, UsageLoadResult, GIT_TIMEOUT};
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

pub struct LiveDeps {
    core: RwLock<Core>,
    log: LogOutput,
    cache_path: PathBuf,
    settings_path: PathBuf,
    sink: OnceLock<Sink>,
    /// The tray follows these; the service's own copy is behind its lock.
    settings: Mutex<Settings>,
    last_tray: Mutex<Option<(TraySummary, String, bool)>>,
}

/// Moves the core to `clock`'s zone unless a load is using it, which the next call makes up for.
fn follow_zone(core: &RwLock<Core>, clock: Clock) {
    let moved = core.read().unwrap_or_else(PoisonError::into_inner).clock.zone() != clock.zone();
    if moved {
        if let Ok(mut core) = core.try_write() {
            core.clock = clock;
        }
    }
}

impl LiveDeps {
    /// The core in the system's zone as it is now: a machine that travelled counts its days where it is.
    fn core(&self) -> RwLockReadGuard<'_, Core> {
        follow_zone(&self.core, Clock::system());
        self.core.read().unwrap_or_else(PoisonError::into_inner)
    }

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
        let summary = summarize_tray(&self.core().clock, &state.providers, self.now(), choice);
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
        let result = fetch_quota(&self.core(), provider);
        let topic = format!("quota provider={provider}");
        match &result {
            Ok(_) => self.log.status(Level::Info, &topic, "ok"),
            Err(error) => {
                let retry = error.retry_after_seconds.map(|s| format!(" retry_after={s}s")).unwrap_or_default();
                let status = format!("failed kind={:?}{retry}: {}", error.kind, error.message);
                self.log.status(Level::Warn, &topic, &status);
            }
        }
        result
    }

    fn load_usage(&self, options: UsageLoadOptions) -> UsageLoadResult {
        let (pulled, result) = {
            let core = self.core();
            (options.pull && !is_usage_not_configured(&core), load_usage_summary(&core, &options))
        };
        match &result.summary {
            Ok(_) => self.log.status(Level::Info, "usage", "ok"),
            Err(error) => self.log.status(Level::Error, "usage", &format!("failed: {error}")),
        }
        match &result.warning {
            Some(warning) => self.log.status(Level::Warn, "pull", &format!("failed: {warning}")),
            None if pulled => self.log.status(Level::Info, "pull", "ok"),
            None => {}
        }
        result
    }

    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    fn now(&self) -> f64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }

    fn clock(&self) -> Clock {
        self.core().clock.clone()
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
        // The next cycle tries again.
        match aitrack_core::fs::write_file_atomic(&self.cache_path, cache_json(cache), None) {
            Ok(()) => self.log.status(Level::Info, "cache", "ok"),
            Err(error) => self.log.status(Level::Error, "cache", &format!("failed: {error}")),
        }
    }

    fn sync(&self) -> Result<(String, MachineFile), String> {
        let options = SyncOptions { timeout: Some(GIT_TIMEOUT), ..SyncOptions::default() };
        sync_data(&self.core(), options)
            .map(|done| (done.message, done.machine))
            .map_err(|error| error.to_string())
            .inspect_err(|error| self.log.event(Level::Error, &format!("sync failed: {error}")))
    }

    fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        write_settings(&self.settings_path, settings)
            .map_err(|error| error.to_string())
            .inspect_err(|error| self.log.event(Level::Error, &format!("settings-save failed: {error}")))?;
        settings.clone_into(&mut self.settings.locked());
        Ok(())
    }

    fn on_settings(&self, settings: &Settings) {
        self.send(Event::Settings(settings));
    }

    fn sync_settings(&self, settings: &mut Settings, push: bool) -> Result<(), String> {
        let result = reconcile(&self.core(), settings, push);
        match &result {
            Ok(()) => self.log.status(Level::Info, "settings-sync", "ok"),
            Err(error) => self.log.status(Level::Warn, "settings-sync", &format!("failed: {error}")),
        }
        result
    }
}

pub struct Background {
    pub service: QuotaService<LiveDeps>,
}

impl Background {
    /// Reads settings and the cache; touches no credentials, logs or sync repo until `start`.
    pub fn open(data_dir: &Path) -> Arc<Self> {
        let settings_path = data_dir.join("settings.json");
        let cache_path = data_dir.join("cache.json");
        let log = LogOutput::open(data_dir);
        let read = |path: &Path| {
            let value = read_json_file(path);
            if value.is_null() && path.exists() {
                log.event(Level::Warn, &format!("unreadable, starting without it: {}", path.display()));
            }
            value
        };
        let settings = normalize_settings(&read(&settings_path));
        let clock = Clock::system();
        let cached = load_cached_state(&clock, &read(&cache_path));
        let core = Core::new(Env::from_process(), clock, Box::new(log.clone()));
        let deps = LiveDeps {
            core: RwLock::new(core),
            log,
            cache_path,
            settings_path,
            sink: OnceLock::new(),
            settings: Mutex::new(settings.clone()),
            last_tray: Mutex::new(None),
        };
        Arc::new(Self { service: QuotaService::new(deps, settings, Some(cached)) })
    }

    const fn deps(&self) -> &LiveDeps {
        self.service.deps()
    }

    pub const fn log(&self) -> &LogOutput {
        &self.deps().log
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
        let settings = self.service.save_settings(settings)?;
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
pub fn smoke_test_line(background: &Background) -> String {
    let answer = SmokeTest { settings: background.service.settings(), state: background.service.state() };
    aitrack_core::js::stringify(&answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_smoke_test_from_the_data_dir_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"theme":"dark","providers":[{"key":"codex"}]}"#).unwrap();
        let background = Background::open(dir.path());
        let line = smoke_test_line(&background);
        assert!(line.starts_with(r#"{"settings":{"theme":"dark","display":"used""#), "{line}");
        assert!(line.contains(r#""providers":[{"key":"codex","label":"Codex","enabled":true},"#), "{line}");
        assert!(line.contains(r#""state":{"providers":[{"key":"codex","label":"Codex","refreshing":false}"#), "{line}");
        assert!(line.ends_with(r#""refreshing":false,"syncing":false}}"#), "{line}");
        let core = &background.deps().core;
        follow_zone(core, Clock::in_zone("Pacific/Kiritimati").unwrap());
        assert_eq!(core.read().unwrap().clock.zone_name(), "Pacific/Kiritimati");
        std::fs::write(dir.path().join("cache.json"), "{").unwrap();
        Background::open(dir.path());
        let log = std::fs::read_to_string(dir.path().join("opentrack.log")).unwrap();
        assert!(log.contains("Z WARN  unreadable, starting without it: ") && log.ends_with("cache.json\n"), "{log}");
    }
}
