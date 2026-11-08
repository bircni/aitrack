//! Keeps limits and usage fresh on a schedule, backs off on failures and raises alerts.

use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use aitrack_core::data::types::MachineFile;
use aitrack_core::providers::{provider_label, PROVIDERS};
use aitrack_core::quota::{QuotaError, QuotaErrorKind, QuotaResult, QuotaSnapshot};
use aitrack_core::time::{iso_millis, Clock};
use indexmap::IndexMap;

use crate::alerts::{due_alerts, prune_fired, Alert};
use crate::cache::CachedState;
use crate::pace::parse_ms;
use crate::settings::Settings;
use crate::state::{AppState, ProviderState, SyncOutcome};
use crate::usage::{UsageLoadOptions, UsageLoadResult};

pub const REFRESH_INTERVAL_MS: f64 = 5.0 * 60_000.0;
pub const PULL_INTERVAL_MS: f64 = 30.0 * 60_000.0;
pub const FAILURE_BACKOFF_MS: f64 = 60_000.0;

/// How long a failure waits before the next attempt; a retry-after can only lengthen it.
const fn retry_after_failure_ms(kind: QuotaErrorKind) -> f64 {
    match kind {
        QuotaErrorKind::Network
        | QuotaErrorKind::RateLimited
        | QuotaErrorKind::NoCredentials
        | QuotaErrorKind::Expired => FAILURE_BACKOFF_MS,
        QuotaErrorKind::Auth | QuotaErrorKind::InvalidResponse => REFRESH_INTERVAL_MS,
    }
}

/// What the service reaches outside itself for, so tests can stand in for each.
pub trait Deps: Send + Sync {
    fn fetch_quota(&self, provider: &str) -> QuotaResult;
    fn load_usage(&self, options: UsageLoadOptions) -> UsageLoadResult;
    /// Epoch ms.
    fn now(&self) -> f64;
    fn on_state(&self, state: Arc<AppState>);
    fn on_alert(&self, alert: &Alert);
    fn persist(&self, cache: &CachedState);
    /// The one-line outcome and the machine file it built.
    fn sync(&self) -> Result<(String, MachineFile), String>;
}

#[derive(Clone, Debug, Default)]
struct ProviderRuntime {
    refreshing: bool,
    next_attempt_at: f64,
    error: Option<QuotaError>,
}

/// A retry-after the provider stated binds even a click; our own backoff after a bare 429 does not.
fn declared_retry_pending(runtime: Option<&ProviderRuntime>, now: f64) -> bool {
    runtime.is_some_and(|runtime| {
        runtime
            .error
            .as_ref()
            .is_some_and(|e| e.kind == QuotaErrorKind::RateLimited && e.retry_after_seconds.unwrap_or(0) > 0)
            && now < runtime.next_attempt_at
    })
}

fn providers_key(providers: &[String]) -> String {
    let mut sorted = providers.to_vec();
    sorted.sort();
    sorted.join(",")
}

fn iso(ms: f64) -> String {
    iso_millis(aitrack_core::time::from_js_millis(ms).unwrap_or_default())
}

struct Inner {
    settings: Settings,
    cache: CachedState,
    runtime: IndexMap<String, ProviderRuntime>,
    usage_running: bool,
    next_usage_at: f64,
    /// Sorted providers the last usage load read; a change makes usage due so a re-enabled one shows.
    usage_providers: Option<String>,
    /// The providers the last load that finished covered, which is what usage can be called empty for.
    usage_loaded_for: Option<String>,
    next_pull_at: f64,
    usage_error: Option<String>,
    syncing: bool,
    sync_result: Option<SyncOutcome>,
}

impl Inner {
    fn enabled_providers(&self) -> Vec<String> {
        self.settings.enabled_providers()
    }
}

pub struct QuotaService<D: Deps> {
    deps: D,
    clock: Clock,
    inner: Mutex<Inner>,
    /// Signalled when a usage load ends, for a sync waiting to start its own.
    usage_done: Condvar,
    /// States go out in the order they were taken, whichever thread finished last.
    emitting: Mutex<()>,
}

impl<D: Deps> QuotaService<D> {
    pub fn new(deps: D, clock: Clock, settings: Settings, cache: Option<CachedState>) -> Self {
        let cache = cache.unwrap_or_default();
        let now = deps.now();
        let mut runtime = IndexMap::new();
        for descriptor in &PROVIDERS {
            let Some(&until) = cache.rate_limited_until.get(descriptor.key) else { continue };
            if until <= now {
                continue;
            }
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "the value is rounded and bounded to the target range first"
            )]
            let retry_after_seconds = ((until - now) / 1000.0).ceil() as u64;
            let error = QuotaError {
                retry_after_seconds: Some(retry_after_seconds),
                ..QuotaError::new(QuotaErrorKind::RateLimited, "Rate limited; retrying later")
            };
            runtime.insert(
                descriptor.key.to_owned(),
                ProviderRuntime { refreshing: false, next_attempt_at: until, error: Some(error) },
            );
        }
        let inner = Inner {
            settings,
            cache,
            runtime,
            usage_running: false,
            next_usage_at: 0.0,
            usage_providers: None,
            usage_loaded_for: None,
            next_pull_at: 0.0,
            usage_error: None,
            syncing: false,
            sync_result: None,
        };
        Self { deps, clock, inner: Mutex::new(inner), usage_done: Condvar::new(), emitting: Mutex::new(()) }
    }

    pub const fn deps(&self) -> &D {
        &self.deps
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn settings(&self) -> Settings {
        self.lock().settings.clone()
    }

    pub fn set_settings(&self, settings: Settings) {
        {
            let mut inner = self.lock();
            if !settings.pull_synced_data {
                inner.cache.pull_error = None;
            }
            inner.settings = settings;
        }
        self.emit();
    }

    pub fn state(&self) -> AppState {
        let inner = self.lock();
        self.state_of(&inner)
    }

    fn state_of(&self, inner: &Inner) -> AppState {
        let now = self.deps.now();
        let providers: Vec<ProviderState> = inner
            .enabled_providers()
            .into_iter()
            .map(|key| {
                let runtime = inner.runtime.get(&key);
                ProviderState {
                    label: provider_label(&key).to_owned(),
                    quota: inner.cache.quotas.get(&key).cloned(),
                    quota_error: runtime.and_then(|r| r.error.clone()),
                    retry_at: declared_retry_pending(runtime, now)
                        .then(|| runtime.map(|r| r.next_attempt_at))
                        .flatten(),
                    usage: inner.cache.usage.as_ref().and_then(|u| u.providers.get(&key)).cloned(),
                    refreshing: runtime.is_some_and(|r| r.refreshing),
                    key,
                }
            })
            .collect();
        let mut fetched: Vec<String> =
            providers.iter().filter_map(|p| p.quota.as_ref()).map(|q| q.fetched_at.clone()).collect();
        fetched.sort_by(|a, b| {
            parse_ms(&self.clock, a).partial_cmp(&parse_ms(&self.clock, b)).unwrap_or(std::cmp::Ordering::Equal)
        });
        let keys: Vec<String> = providers.iter().map(|p| p.key.clone()).collect();
        let usage_empty = inner.cache.usage.is_some()
            && inner.usage_error.is_none()
            && Some(providers_key(&keys)) == inner.usage_loaded_for
            && providers.iter().all(|p| p.usage.as_ref().map_or(0.0, |u| u.all_time.tokens) == 0.0);
        let usage = inner.cache.usage.as_ref();
        AppState {
            refreshing: inner.usage_running || providers.iter().any(|p| p.refreshing),
            providers,
            machines: usage.and_then(|u| u.machines.clone()),
            account_usage: usage.and_then(|u| u.account.clone()),
            projects: usage.and_then(|u| u.projects.clone()),
            usage_error: inner.usage_error.clone(),
            updated_at: inner.cache.updated_at.clone(),
            usage_updated_at: inner.cache.usage_updated_at.clone(),
            quota_updated_at: fetched.into_iter().next(),
            usage_empty: usage_empty.then_some(true),
            pull_error: inner.cache.pull_error.clone().filter(|_| inner.settings.pull_synced_data),
            syncing: inner.syncing,
            sync_result: inner.sync_result.clone(),
        }
    }

    /// Push this machine's usage like `aitrack sync`, then reload so the totals include it.
    pub fn sync(&self) {
        {
            let mut inner = self.lock();
            if inner.syncing {
                return;
            }
            inner.syncing = true;
        }
        self.emit();
        let local_machine = match self.deps.sync() {
            Ok((message, machine)) => {
                let now = self.deps.now();
                let mut inner = self.lock();
                inner.sync_result = Some(SyncOutcome { ok: true, message });
                inner.next_pull_at = now + PULL_INTERVAL_MS;
                inner.cache.pull_error = None;
                drop(inner);
                Some(machine)
            }
            Err(message) => {
                self.lock().sync_result = Some(SyncOutcome { ok: false, message });
                None
            }
        };
        let providers = {
            let mut inner = self.lock();
            while inner.usage_running {
                inner = self.usage_done.wait(inner).unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            inner.usage_running = true; // Claimed here, so no scheduled load slips in before it.
            inner.enabled_providers()
        };
        std::thread::scope(|scope| {
            scope.spawn(|| self.refresh(false));
            self.run_usage(false, providers, local_machine);
        });
        self.lock().syncing = false;
        self.persist();
    }

    /// Refresh whatever is due. `force` (a user click) skips the schedule but still honours a
    /// retry-after the provider stated, which it would only extend.
    pub fn refresh(&self, force: bool) {
        let now = self.deps.now();
        let (due, usage) = {
            let mut inner = self.lock();
            let providers = inner.enabled_providers();
            let due: Vec<String> = providers
                .iter()
                .filter(|key| {
                    let runtime = inner.runtime.get(*key);
                    if runtime.is_some_and(|r| r.refreshing) || declared_retry_pending(runtime, now) {
                        return false;
                    }
                    force || now >= runtime.map_or(0.0, |r| r.next_attempt_at)
                })
                .cloned()
                .collect();
            let usage_due = !inner.usage_running
                && !inner.syncing
                && (force || now >= inner.next_usage_at || Some(providers_key(&providers)) != inner.usage_providers);
            if due.is_empty() && !usage_due {
                return;
            }
            for key in &due {
                inner.runtime.entry(key.clone()).or_default().refreshing = true;
            }
            if usage_due {
                inner.usage_running = true;
            }
            drop(inner);
            (due, usage_due.then_some(providers))
        };
        std::thread::scope(|scope| {
            for key in &due {
                scope.spawn(move || self.refresh_quota(key));
            }
            if let Some(providers) = usage {
                scope.spawn(move || self.run_usage(force, providers, None));
            }
            self.emit();
        });
        self.persist();
    }

    fn persist(&self) {
        let cache = {
            let mut inner = self.lock();
            let now = self.deps.now();
            inner.cache.fired = prune_fired(&self.clock, &inner.cache.fired, now);
            let limited: IndexMap<String, f64> = inner
                .runtime
                .iter()
                .filter(|(_, r)| r.error.as_ref().is_some_and(|e| e.kind == QuotaErrorKind::RateLimited))
                .map(|(key, r)| (key.clone(), r.next_attempt_at))
                .collect();
            inner.cache.rate_limited_until = limited;
            inner.cache.clone()
        };
        self.deps.persist(&cache);
        self.emit();
    }

    fn refresh_quota(&self, key: &str) {
        let result = self.deps.fetch_quota(key);
        let now = self.deps.now();
        let alerts = {
            let mut inner = self.lock();
            let Inner { runtime, cache, settings, .. } = &mut *inner;
            let runtime = runtime.entry(key.to_owned()).or_default();
            runtime.refreshing = false;
            let alerts = match result {
                Ok(snapshot) => {
                    runtime.error = None;
                    runtime.next_attempt_at = now + REFRESH_INTERVAL_MS;
                    cache.updated_at = Some(iso(now));
                    let alerts =
                        if settings.notifications { self.alerts_for(key, &snapshot, cache, now) } else { vec![] };
                    cache.quotas.insert(key.to_owned(), snapshot);
                    alerts
                }
                Err(error) => {
                    #[expect(
                        clippy::cast_precision_loss,
                        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
                    )]
                    let declared = error.retry_after_seconds.unwrap_or(0) as f64 * 1000.0;
                    runtime.next_attempt_at = now + retry_after_failure_ms(error.kind).max(declared);
                    // A signed-out provider's old numbers would be misleading, not just stale.
                    if error.kind == QuotaErrorKind::NoCredentials {
                        cache.quotas.shift_remove(key);
                    }
                    runtime.error = Some(error);
                    vec![]
                }
            };
            drop(inner);
            alerts
        };
        for alert in &alerts {
            self.deps.on_alert(alert);
        }
        self.emit();
    }

    fn alerts_for(&self, key: &str, snapshot: &QuotaSnapshot, cache: &mut CachedState, now: f64) -> Vec<Alert> {
        let alerts = due_alerts(&self.clock, provider_label(key), snapshot, &cache.fired, now);
        for alert in &alerts {
            cache.fired.insert(alert.key.clone(), alert.resets_at.clone());
        }
        alerts
    }

    /// One usage load; the caller has already marked it running.
    fn run_usage(&self, force: bool, providers: Vec<String>, local_machine: Option<MachineFile>) {
        let now = self.deps.now();
        let pull = {
            let mut inner = self.lock();
            inner.usage_providers = Some(providers_key(&providers));
            inner.settings.pull_synced_data && (force || now >= inner.next_pull_at)
        };
        self.emit();
        let key = providers_key(&providers);
        let result = self.deps.load_usage(UsageLoadOptions { providers, pull, refresh_live: force, local_machine });
        let completed_at = self.deps.now();
        {
            let mut inner = self.lock();
            if pull {
                inner.next_pull_at =
                    completed_at + if result.warning.is_some() { FAILURE_BACKOFF_MS } else { PULL_INTERVAL_MS };
                inner.cache.pull_error = result.warning;
            }
            match result.summary {
                Ok(summary) => {
                    inner.cache.usage = Some(summary);
                    inner.usage_loaded_for = Some(key);
                    inner.usage_error = None;
                    let updated = Some(iso(completed_at));
                    inner.cache.usage_updated_at.clone_from(&updated);
                    inner.cache.updated_at = updated;
                    let failing_pull = inner.cache.pull_error.is_some() && inner.settings.pull_synced_data;
                    inner.next_usage_at =
                        completed_at + if failing_pull { FAILURE_BACKOFF_MS } else { REFRESH_INTERVAL_MS };
                }
                Err(error) => {
                    inner.usage_error = Some(error);
                    inner.next_usage_at = now + FAILURE_BACKOFF_MS;
                }
            }
            inner.usage_running = false;
        }
        self.usage_done.notify_all();
        self.emit(); // Usage shows now rather than with the slowest quota fetch.
    }

    fn emit(&self) {
        let _order = self.emitting.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        self.deps.on_state(Arc::new(self.state()));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;

    use aitrack_core::quota::{QuotaFormat, QuotaWindow};

    use super::*;
    use crate::state::{MachineUsage, PeriodUsage, ProviderUsage, UsageSummary};

    const START: f64 = 1_780_315_200_000.0; // 2026-06-01T12:00:00.000Z

    fn machine() -> MachineFile {
        serde_json::from_str(
            r#"{"schemaVersion":2,"hostname":"host","timezone":"UTC","dayBucket":"local","lastUpdated":"","days":{}}"#,
        )
        .unwrap()
    }

    fn summary() -> UsageSummary {
        UsageSummary {
            machines: Some(
                ["desk", "laptop"]
                    .map(|name| MachineUsage {
                        name: name.into(),
                        timezone: "UTC".into(),
                        last_updated: String::new(),
                        current: name == "desk",
                        providers: IndexMap::new(),
                    })
                    .to_vec(),
            ),
            ..UsageSummary::default()
        }
    }

    fn ok(provider: &str, used_percent: f64, now: f64) -> QuotaSnapshot {
        QuotaSnapshot {
            provider: provider.into(),
            plan: None,
            windows: vec![QuotaWindow {
                id: "session".into(),
                label: "Session".into(),
                used_percent,
                resets_at: Some(iso(now + 3_600_000.0)),
                period_seconds: 18_000.0,
                format: QuotaFormat::Percent,
                used_value: None,
                limit_value: None,
            }],
            values: vec![],
            fetched_at: iso(now),
        }
    }

    fn failure(kind: QuotaErrorKind, message: &str, retry_after_seconds: Option<u64>) -> QuotaResult {
        Err(QuotaError { retry_after_seconds, ..QuotaError::new(kind, message) })
    }

    type QuotaFn = Box<dyn Fn(&str, f64) -> Option<QuotaResult> + Send + Sync>;
    type UsageFn = Box<dyn Fn(&UsageLoadOptions) -> UsageLoadResult + Send + Sync>;
    type SyncFn = Box<dyn Fn() -> Result<(String, MachineFile), String> + Send + Sync>;

    /// The deps every test shares, with the clock and each outside call under the test's control.
    #[derive(Default)]
    struct Fake {
        now: Mutex<f64>,
        quota: Option<QuotaFn>,
        usage: Option<UsageFn>,
        sync: Option<SyncFn>,
        calls: Mutex<Vec<String>>,
        loads: Mutex<Vec<UsageLoadOptions>>,
        states: Mutex<Vec<AppState>>,
        alerts: Mutex<Vec<Alert>>,
        persisted: Mutex<Vec<CachedState>>,
        usage_fails: AtomicBool,
        sync_fails: AtomicBool,
        syncs: AtomicUsize,
    }

    impl Deps for Arc<Fake> {
        fn fetch_quota(&self, provider: &str) -> QuotaResult {
            self.calls.lock().unwrap().push(provider.to_owned());
            let now = self.now();
            self.quota.as_ref().and_then(|f| f(provider, now)).unwrap_or_else(|| Ok(ok(provider, 10.0, now)))
        }
        fn load_usage(&self, options: UsageLoadOptions) -> UsageLoadResult {
            self.loads.lock().unwrap().push(options.clone());
            if let Some(usage) = &self.usage {
                return usage(&options);
            }
            if self.usage_fails.load(Ordering::SeqCst) {
                return UsageLoadResult { summary: Err("disk on fire".into()), warning: None };
            }
            UsageLoadResult { summary: Ok(summary()), warning: None }
        }
        fn now(&self) -> f64 {
            *self.now.lock().unwrap()
        }
        fn on_state(&self, state: Arc<AppState>) {
            self.states.lock().unwrap().push((*state).clone());
        }
        fn on_alert(&self, alert: &Alert) {
            self.alerts.lock().unwrap().push(alert.clone());
        }
        fn persist(&self, cache: &CachedState) {
            self.persisted.lock().unwrap().push(cache.clone());
        }
        fn sync(&self) -> Result<(String, MachineFile), String> {
            self.syncs.fetch_add(1, Ordering::SeqCst);
            if let Some(sync) = &self.sync {
                return sync();
            }
            if self.sync_fails.load(Ordering::SeqCst) {
                return Err("remote: permission denied".into());
            }
            Ok(("Done! Pushed data/host.json (3 days)".into(), machine()))
        }
    }

    impl Fake {
        fn advance(&self, ms: f64) {
            *self.now.lock().unwrap() += ms;
        }
        fn take_calls(&self) -> Vec<String> {
            std::mem::take(&mut *self.calls.lock().unwrap())
        }
        fn pulls(&self) -> Vec<bool> {
            self.loads.lock().unwrap().iter().map(|l| l.pull).collect()
        }
    }

    fn harness_with(
        fake: Fake,
        settings: Settings,
        cache: Option<CachedState>,
    ) -> (Arc<Fake>, QuotaService<Arc<Fake>>) {
        *fake.now.lock().unwrap() = START;
        let fake = Arc::new(fake);
        let service = QuotaService::new(std::sync::Arc::clone(&fake), Clock::in_zone("UTC").unwrap(), settings, cache);
        (fake, service)
    }

    fn harness(fake: Fake) -> (Arc<Fake>, QuotaService<Arc<Fake>>) {
        harness_with(fake, Settings::default(), None)
    }

    fn only(keys: &[&str]) -> Settings {
        let mut settings = Settings { pull_synced_data: false, ..Settings::default() };
        for provider in &mut settings.providers {
            provider.enabled = keys.contains(&provider.key.as_str());
        }
        settings
    }

    fn all() -> Vec<String> {
        ["claude_code", "codex", "cursor"].map(String::from).to_vec()
    }

    #[test]
    fn refreshes_every_enabled_provider_and_the_usage_once() {
        let (fake, service) = harness(Fake::default());
        service.refresh(false);
        let mut calls = fake.take_calls();
        calls.sort();
        assert_eq!(calls, all());
        assert_eq!(fake.pulls(), [true]);
        let state = service.state();
        let quotas: Vec<_> = state.providers.iter().map(|p| p.quota.as_ref().unwrap().provider.clone()).collect();
        assert_eq!(quotas, all());
        assert!(!state.refreshing);
        assert_eq!(state.machines.unwrap().len(), 2);
        assert_eq!(fake.persisted.lock().unwrap().len(), 1);
        assert!(fake.states.lock().unwrap().iter().any(|s| s.refreshing));
    }

    #[test]
    fn shows_finished_usage_without_waiting_for_a_slow_quota() {
        let (release, wait) = mpsc::channel::<()>();
        let wait = Mutex::new(wait);
        let fake = Fake {
            quota: Some(Box::new(move |_, _| {
                let _ = wait.lock().unwrap().recv();
                None
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(fake);
        std::thread::scope(|scope| {
            let release = release; // Dropped on a failed assert, which frees the fetches.
            scope.spawn(|| service.refresh(false));
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let last = fake.states.lock().unwrap().last().cloned();
                if let Some(state) = last.filter(|s| s.machines.is_some()) {
                    assert!(state.refreshing);
                    assert_eq!(state.usage_updated_at.as_deref(), Some("2026-06-01T12:00:00.000Z"));
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "usage never showed");
                std::thread::yield_now();
            }
            for _ in 0..3 {
                release.send(()).unwrap();
            }
        });
    }

    #[test]
    fn waits_for_the_schedule_unless_forced() {
        let (fake, service) = harness(Fake::default());
        service.refresh(false);
        service.refresh(false);
        assert_eq!(fake.calls.lock().unwrap().len(), 3);
        fake.advance(REFRESH_INTERVAL_MS);
        service.refresh(false);
        assert_eq!(fake.calls.lock().unwrap().len(), 6);
        assert_eq!(fake.pulls(), [true, false]);
        service.refresh(true);
        assert_eq!(fake.calls.lock().unwrap().len(), 9);
        assert_eq!(fake.pulls(), [true, false, true]);
        fake.advance(PULL_INTERVAL_MS);
        service.refresh(false);
        assert_eq!(fake.pulls().last(), Some(&true));
    }

    fn failing() -> Fake {
        Fake {
            quota: Some(Box::new(|provider, _| match provider {
                "claude_code" => Some(failure(QuotaErrorKind::Auth, "token rejected", None)),
                "codex" => Some(failure(QuotaErrorKind::RateLimited, "slow down", Some(300))),
                _ => Some(failure(QuotaErrorKind::NoCredentials, "sign in", None)),
            })),
            ..Fake::default()
        }
    }

    #[test]
    fn backs_off_after_failures_and_honours_retry_after_even_when_forced() {
        let (fake, service) = harness(failing());
        service.refresh(false);
        let state = service.state();
        assert_eq!(state.providers[1].quota_error.as_ref().unwrap().kind, QuotaErrorKind::RateLimited);
        assert_eq!(state.providers[1].retry_at, Some(START + 300_000.0));
        assert!(state.providers[2].quota.is_none());
        fake.take_calls();
        service.refresh(true);
        let mut calls = fake.take_calls();
        calls.sort();
        assert_eq!(calls, ["claude_code", "cursor"]);
        fake.advance(FAILURE_BACKOFF_MS);
        service.refresh(false);
        assert_eq!(fake.take_calls(), ["cursor"]);
    }

    #[test]
    fn lets_a_click_retry_a_bare_429_which_only_our_own_backoff_holds_back() {
        let fake = Fake {
            quota: Some(Box::new(|provider, _| {
                (provider == "codex").then(|| failure(QuotaErrorKind::RateLimited, "slow down", None))
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(fake);
        service.refresh(false);
        assert_eq!(service.state().providers[1].retry_at, None);
        fake.take_calls();
        service.refresh(false);
        assert!(fake.take_calls().is_empty());
        service.refresh(true);
        assert!(fake.take_calls().contains(&"codex".to_owned()));
    }

    fn almost_out() -> Fake {
        Fake {
            quota: Some(Box::new(|provider, now| (provider == "claude_code").then(|| Ok(ok(provider, 95.0, now))))),
            ..Fake::default()
        }
    }

    #[test]
    fn alerts_once_per_reset_and_only_when_enabled() {
        let pinned = Fake {
            quota: Some(Box::new(|provider, _| (provider == "claude_code").then(|| Ok(ok(provider, 95.0, START))))),
            ..Fake::default()
        };
        let (fake, service) = harness(pinned);
        service.refresh(false);
        let titles: Vec<String> = fake.alerts.lock().unwrap().iter().map(|a| a.title.clone()).collect();
        assert_eq!(titles, ["Claude Code session almost used up"]);
        service.refresh(true);
        assert_eq!(fake.alerts.lock().unwrap().len(), 1);

        let (quiet, service) =
            harness_with(almost_out(), Settings { notifications: false, ..Settings::default() }, None);
        service.refresh(false);
        assert!(quiet.alerts.lock().unwrap().is_empty());
    }

    #[test]
    fn alerts_for_the_next_window_on_the_first_refresh_after_the_last_one_reset() {
        let (fake, service) = harness(almost_out());
        service.refresh(false);
        fake.advance(3_600_000.0 + 6.0 * 60_000.0);
        service.refresh(false);
        assert_eq!(fake.alerts.lock().unwrap().len(), 2);
    }

    #[test]
    fn reports_usage_failures_skips_disabled_providers_and_reloads_only_when_the_enabled_set_changes() {
        let (fake, service) = harness(Fake::default());
        fake.usage_fails.store(true, Ordering::SeqCst);
        service.set_settings(only(&["claude_code"]));
        service.refresh(false);
        assert_eq!(fake.take_calls(), ["claude_code"]);
        assert_eq!(fake.pulls(), [false]);
        let state = service.state();
        assert_eq!(state.usage_error.as_deref(), Some("disk on fire"));
        assert_eq!(state.providers.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["claude_code"]);

        service.set_settings(Settings { pull_synced_data: false, ..Settings::default() });
        service.refresh(false); // Still inside the failure backoff.
        let read: Vec<Vec<String>> = fake.loads.lock().unwrap().iter().map(|l| l.providers.clone()).collect();
        assert_eq!(read, [vec!["claude_code".to_owned()], all()]);

        let mut reversed = Settings { pull_synced_data: false, ..Settings::default() };
        reversed.providers.reverse();
        service.set_settings(reversed);
        service.refresh(false);
        assert_eq!(fake.loads.lock().unwrap().len(), 2);
    }

    #[test]
    fn keeps_a_retry_after_across_restarts() {
        let limited = Fake {
            quota: Some(Box::new(|provider, _| {
                (provider == "claude_code").then(|| failure(QuotaErrorKind::RateLimited, "slow", Some(600)))
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(limited);
        service.refresh(false);
        let saved = fake.persisted.lock().unwrap().last().cloned().unwrap();
        assert_eq!(saved.rate_limited_until, IndexMap::from([("claude_code".to_owned(), START + 600_000.0)]));

        let (restarted, service) = harness_with(Fake::default(), Settings::default(), Some(saved));
        assert_eq!(service.state().providers[0].quota_error.as_ref().unwrap().kind, QuotaErrorKind::RateLimited);
        service.refresh(true);
        let mut calls = restarted.take_calls();
        calls.sort();
        assert_eq!(calls, ["codex", "cursor"]);
    }

    #[test]
    fn syncs_then_reloads_usage_from_what_the_sync_read_without_pulling_again() {
        let (fake, service) = harness(Fake::default());
        service.sync();
        assert!(fake.states.lock().unwrap().iter().any(|s| s.syncing));
        let state = service.state();
        assert!(!state.syncing);
        assert_eq!(
            state.sync_result,
            Some(SyncOutcome { ok: true, message: "Done! Pushed data/host.json (3 days)".into() })
        );
        assert_eq!(fake.pulls(), [false]);
        assert_eq!(fake.loads.lock().unwrap()[0].local_machine, Some(machine()));

        fake.advance(REFRESH_INTERVAL_MS);
        service.refresh(false);
        service.sync();
        assert_eq!(fake.pulls(), [false, false, false]); // The pull the sync did still counts.
        let reused: Vec<bool> = fake.loads.lock().unwrap().iter().map(|l| l.local_machine.is_some()).collect();
        assert_eq!(reused, [true, false, true]);

        fake.sync_fails.store(true, Ordering::SeqCst);
        service.sync();
        assert_eq!(
            service.state().sync_result,
            Some(SyncOutcome { ok: false, message: "remote: permission denied".into() })
        );
    }

    #[test]
    fn keeps_sync_exclusive_through_the_prior_refresh_and_the_usage_reload() {
        let (finish_earlier, earlier) = mpsc::channel::<()>();
        let (finish_reload, reloaded) = mpsc::channel::<()>();
        let gates = Mutex::new(VecDeque::from([earlier, reloaded]));
        let fake = Fake {
            usage: Some(Box::new(move |_| {
                let gate = gates.lock().unwrap().pop_front().unwrap();
                let _ = gate.recv();
                UsageLoadResult { summary: Ok(summary()), warning: None }
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(fake);
        let loads = || fake.loads.lock().unwrap().len();
        let wait_for = |done: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !done() {
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
        };
        std::thread::scope(|scope| {
            let (finish_earlier, finish_reload) = (finish_earlier, finish_reload); // Dropped on a failed assert, which frees the loads.
            scope.spawn(|| service.refresh(false));
            wait_for(&|| loads() == 1);
            scope.spawn(|| service.sync());
            wait_for(&|| fake.syncs.load(Ordering::SeqCst) == 1);
            service.sync();
            assert_eq!(fake.syncs.load(Ordering::SeqCst), 1);

            finish_earlier.send(()).unwrap();
            wait_for(&|| loads() == 2);
            service.sync();
            assert_eq!(fake.syncs.load(Ordering::SeqCst), 1);
            assert!(service.state().syncing);
            let last = fake.loads.lock().unwrap().last().cloned().unwrap();
            assert_eq!(
                last,
                UsageLoadOptions { providers: all(), pull: false, refresh_live: false, local_machine: Some(machine()) }
            );
            finish_reload.send(()).unwrap();
        });
        let state = service.state();
        assert!(!state.syncing && !state.refreshing);
    }

    #[test]
    fn shows_the_cached_machines_before_any_load() {
        let cache = CachedState { usage: Some(summary()), ..CachedState::default() };
        let (_, service) = harness_with(Fake::default(), Settings::default(), Some(cache));
        assert_eq!(service.state().machines.unwrap().len(), 2);
    }

    #[test]
    fn dates_the_limits_by_their_oldest_fetch_however_fresh_the_usage_is() {
        let fail = Arc::new(AtomicBool::new(false));
        let failing = std::sync::Arc::clone(&fail);
        let fake = Fake {
            quota: Some(Box::new(move |provider, _| {
                (provider == "codex" && failing.load(Ordering::SeqCst))
                    .then(|| failure(QuotaErrorKind::Network, "offline", None))
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(fake);
        assert_eq!(service.state().quota_updated_at, None);
        service.refresh(false);
        fail.store(true, Ordering::SeqCst);
        fake.advance(REFRESH_INTERVAL_MS);
        service.refresh(false);
        let state = service.state();
        assert_eq!(state.usage_updated_at, Some(iso(START + REFRESH_INTERVAL_MS)));
        assert_eq!(state.quota_updated_at, Some(iso(START)));
    }

    #[test]
    fn says_usage_is_empty_only_after_a_load_that_worked_and_found_nothing() {
        let (fake, service) = harness(Fake::default());
        assert_eq!(service.state().usage_empty, None);
        service.refresh(false);
        assert_eq!(service.state().usage_empty, Some(true));
        fake.usage_fails.store(true, Ordering::SeqCst);
        service.refresh(true);
        assert_eq!(service.state().usage_empty, None);

        let period = PeriodUsage { tokens: 1.0, ..PeriodUsage::default() };
        let found = ProviderUsage {
            today: period.clone(),
            yesterday: PeriodUsage::default(),
            last7_days: period.clone(),
            last30_days: period.clone(),
            all_time: period,
            daily: vec![],
        };
        let usage =
            UsageSummary { providers: IndexMap::from([("codex".to_owned(), found)]), ..UsageSummary::default() };
        let cache = CachedState { usage: Some(usage), ..CachedState::default() };
        let (_, used) = harness_with(Fake::default(), Settings::default(), Some(cache));
        assert_eq!(used.state().usage_empty, None);
    }

    #[test]
    fn does_not_call_usage_empty_while_the_load_for_newly_enabled_providers_runs() {
        let (finish, gate) = mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let fake = Fake {
            usage: Some(Box::new(move |_| {
                let _ = gate.lock().unwrap().recv();
                UsageLoadResult { summary: Ok(UsageSummary::default()), warning: None }
            })),
            ..Fake::default()
        };
        let cache = CachedState { usage: Some(UsageSummary::default()), ..CachedState::default() };
        let (fake, service) = harness_with(fake, only(&["codex"]), Some(cache));
        std::thread::scope(|scope| {
            let finish = finish; // Dropped on a failed assert, which frees the load.
            scope.spawn(|| service.refresh(false));
            while fake.loads.lock().unwrap().is_empty() {
                std::thread::yield_now();
            }
            let state = service.state();
            assert!(state.refreshing);
            assert_eq!(state.usage_empty, None);
            finish.send(()).unwrap();
        });
        assert_eq!(service.state().usage_empty, Some(true));
    }

    #[test]
    fn keeps_pull_failures_through_local_reads_retries_after_one_minute_and_restores_the_schedule() {
        let first = AtomicBool::new(true);
        let fake = Fake {
            usage: Some(Box::new(move |_| UsageLoadResult {
                summary: Ok(summary()),
                warning: first.swap(false, Ordering::SeqCst).then(|| "pull failed".to_owned()),
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(fake);
        service.refresh(false);
        assert_eq!(service.state().pull_error.as_deref(), Some("pull failed"));
        fake.sync_fails.store(true, Ordering::SeqCst);
        service.sync();
        assert_eq!(fake.pulls().last(), Some(&false));
        assert_eq!(service.state().pull_error.as_deref(), Some("pull failed"));
        fake.advance(FAILURE_BACKOFF_MS);
        service.refresh(false);
        assert_eq!(fake.pulls().last(), Some(&true));
        assert_eq!(service.state().pull_error, None);
        fake.advance(FAILURE_BACKOFF_MS);
        service.refresh(false);
        assert_eq!(fake.loads.lock().unwrap().len(), 3);
        fake.advance(PULL_INTERVAL_MS);
        service.refresh(false);
        assert_eq!(fake.pulls().last(), Some(&true));
    }

    #[test]
    fn persists_successful_update_times_and_keeps_them_when_reads_and_quotas_fail() {
        let fail = Arc::new(AtomicBool::new(false));
        let failing = std::sync::Arc::clone(&fail);
        let fake = Fake {
            quota: Some(Box::new(move |provider, _| {
                (provider == "claude_code" && failing.load(Ordering::SeqCst))
                    .then(|| failure(QuotaErrorKind::Network, "offline", None))
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(fake);
        service.refresh(false);
        let initial = service.state();
        assert_eq!(initial.usage_updated_at, Some(iso(START)));
        fake.advance(FAILURE_BACKOFF_MS);
        fake.usage_fails.store(true, Ordering::SeqCst);
        fail.store(true, Ordering::SeqCst);
        service.refresh(true);
        let state = service.state();
        assert_eq!(state.usage_updated_at, initial.usage_updated_at);
        let fetched = |s: &AppState| s.providers[0].quota.as_ref().map(|q| q.fetched_at.clone());
        assert_eq!(fetched(&state), fetched(&initial));
        assert_eq!(state.providers[0].quota_error.as_ref().unwrap().message, "offline");
        let cached = fake.persisted.lock().unwrap().last().cloned().unwrap();
        assert_eq!(cached.usage_updated_at, initial.usage_updated_at);
        let (_, restarted) = harness_with(Fake::default(), Settings::default(), Some(cached));
        let restarted = restarted.state();
        assert_eq!(restarted.usage_updated_at, initial.usage_updated_at);
        assert_eq!(restarted.providers[0].quota.as_ref().unwrap().provider, "claude_code");
    }

    #[test]
    fn retains_both_warnings_when_a_pull_and_the_following_local_read_fail() {
        let first = AtomicBool::new(true);
        let fake = Fake {
            usage: Some(Box::new(move |_| {
                if first.swap(false, Ordering::SeqCst) {
                    UsageLoadResult { summary: Err("local read failed".into()), warning: Some("pull failed".into()) }
                } else {
                    UsageLoadResult { summary: Ok(UsageSummary::default()), warning: None }
                }
            })),
            ..Fake::default()
        };
        let (fake, service) = harness(fake);
        service.refresh(false);
        let state = service.state();
        assert_eq!(state.usage_error.as_deref(), Some("local read failed"));
        assert_eq!(state.pull_error.as_deref(), Some("pull failed"));
        assert_eq!(state.usage_updated_at, None);
        fake.advance(FAILURE_BACKOFF_MS);
        service.refresh(false);
        assert_eq!(fake.pulls().last(), Some(&true));
        let state = service.state();
        assert_eq!((state.pull_error, state.usage_error), (None, None));
    }
}
