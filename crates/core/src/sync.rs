//! `aitrack sync`: this machine's logs over its synced file, committed and pushed.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use indexmap::IndexMap;

use crate::Core;
use crate::config::{Config, load_config, resolve_machine_id};
use crate::data::local_data::{build_machine_data, canonical_days, outgoing_days, ratcheted_provider_days};
use crate::data::messages::REPO_NOT_CLONED_MESSAGE;
use crate::data::types::{DayMap, MachineFile};
use crate::error::{Error, Result};
use crate::git::remote::{differing_origin, origin_mismatch_message};
use crate::git::{Git, RepoGuard, commit_and_push, is_cloned, pull, push_pending_commits};
use crate::js;
use crate::machine_id::machine_data_filename;
use crate::pricing::ReaderPricing;
use crate::pricing::cost::{FallbackCollector, PriceMode, price_model_cost};
use crate::providers::{PROVIDERS, synced_provider_keys};
use crate::readers::project::GitProjectResolver;
use crate::readers::read::{read_claude_days, read_codex_days};
use crate::store::encryption::{ENCRYPTION_PASSPHRASE_ENV, encryption_passphrase};
use crate::store::machine_files::{MachineFileError, remove_pending_machine_file, write_machine_file};
use crate::store::validate::{Failure, ValidationOptions, check_raw_machine_file};

/// The synced providers' days from this machine's logs, keyed by provider.
pub type LocalMaps = IndexMap<String, DayMap>;

/// Reads every synced provider's logs, priced with the current rates.
pub fn read_local_provider_maps(
    core: &Core,
    fallbacks: Option<&FallbackCollector>,
    providers: Option<&[String]>,
) -> Result<LocalMaps> {
    let rates = core.pricing().current();
    let pricing = ReaderPricing { pricing: &rates, fallbacks };
    let resolver = GitProjectResolver::default();
    let wanted = |key: &str| providers.is_none_or(|p| p.iter().any(|k| k == key));
    let mut maps = LocalMaps::new();
    if wanted("claude_code") {
        maps.insert("claude_code".into(), read_claude_days(core, &pricing, &resolver)?);
    }
    if wanted("codex") {
        maps.insert("codex".into(), read_codex_days(core, &pricing, &resolver)?);
    }
    Ok(maps)
}

/// Records family-fallback guesses for models already loaded: cache hits never call the pricer.
pub fn record_pricing_fallbacks(core: &Core, maps: &LocalMaps, fallbacks: &FallbackCollector) {
    let rates = core.pricing().current();
    for provider in synced_provider_keys() {
        for (date, day) in maps.get(provider).into_iter().flatten() {
            let date = date.to_string();
            for (model, counts) in &day.by_model {
                let _ =
                    price_model_cost(&rates, provider, model, counts, Some(&date), PriceMode::Merge, Some(fallbacks));
            }
        }
    }
}

/// Warns about models priced by family fallback; shared by sync and recompute.
pub fn report_fallback_pricing(core: &Core, fallbacks: &FallbackCollector) {
    let ids = fallbacks.drain();
    if !ids.is_empty() {
        core.output.warn(&format!(
            "\nWarning: priced via family fallback (no exact rate yet): {} — costs may be off until aitrack or the pricing pack is updated.",
            ids.join(", ")
        ));
    }
}

/// What a data step gets: the config, this machine, and the logs, read while the pull ran.
pub struct DataRun<'a> {
    pub config: Config,
    pub machine_id: String,
    pub fallbacks: &'a FallbackCollector,
    local: &'a dyn Fn() -> Result<LocalMaps>,
}

impl DataRun<'_> {
    /// The local logs, waiting for the read started before the lock.
    pub fn local_maps(&self) -> Result<LocalMaps> {
        (self.local)()
    }
}

/// Loads the config, checks the clone, then runs `step` under the repo lock (after a pull when asked)
/// while the pricing refresh and the log read run beside it.
pub fn run_data_pipeline<T>(
    core: &Core,
    do_pull: bool,
    timeout: Option<Duration>,
    step: impl FnOnce(&RepoGuard<'_>, &Git, DataRun<'_>) -> Result<T>,
) -> Result<T> {
    let config = load_config(&core.paths.config)?; // Before the refresh, so an unconfigured machine never contacts GitHub.
    if !is_cloned(core) {
        return Err(Error::new(REPO_NOT_CLONED_MESSAGE));
    }
    let git = core.git().with_timeout(timeout);
    if let Some(origin) = differing_origin(core, &git, &config.repo_url) {
        core.output.warn(&origin_mismatch_message(&origin, &config.repo_url));
    }
    let fallbacks = FallbackCollector::default();
    let result = std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            core.pricing().refresh_if_due(core.http.as_ref(), &core.env, core.clock.now(), false);
            let maps = read_local_provider_maps(core, Some(&fallbacks), None)?;
            record_pricing_fallbacks(core, &maps, &fallbacks);
            Ok::<_, Error>(maps)
        });
        let pending = Mutex::new(Some(reader));
        let done: OnceLock<Result<LocalMaps>> = OnceLock::new();
        let local = || {
            done.get_or_init(|| {
                let handle = pending.lock().expect("not poisoned").take().expect("joined once");
                handle.join().unwrap_or_else(|_| Err(Error::new("reading the local logs failed")))
            })
            .clone()
        };
        let outcome = core.with_repo_lock(|guard| {
            if do_pull {
                core.output.info("Pulling latest from remote...");
                pull(core, guard, &git)?;
            }
            let machine_id = resolve_machine_id(Some(&config)).map_err(Error::new)?;
            step(guard, &git, DataRun { config: config.clone(), machine_id, fallbacks: &fallbacks, local: &local })
        });
        let _ = local(); // Settle it on an early exit too.
        outcome
    });
    report_fallback_pricing(core, &fallbacks); // Even when nothing was pushed.
    result
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SyncOptions {
    pub dry_run: bool,
    /// Fail when commits are still waiting to be pushed after the sync.
    pub verify: bool,
    pub timeout: Option<Duration>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyncResult {
    /// Built from the local logs, for a caller that needs it too.
    pub machine: MachineFile,
    /// The outcome in one line, as the CLI logs it.
    pub message: String,
    pub pushed: bool,
    /// Days in the machine file after the run.
    pub days: usize,
}

const NO_CHANGES_MESSAGE: &str = "No changes to push — data is already up to date.";

fn pushed_message(host: &str, days: usize) -> String {
    format!("Done! Pushed data/{host}.json ({days} days)")
}

#[must_use]
pub fn refusal_message(host: &str, failure: Option<Failure>) -> String {
    let filename = machine_data_filename(host).unwrap_or_else(|_| format!("{host}.json"));
    let fix = match failure {
        Some(Failure::Encrypted) => format!("  Set {ENCRYPTION_PASSPHRASE_ENV} to the passphrase the file was encrypted with."),
        Some(Failure::FutureSchema) => "  Upgrade aitrack: a newer version wrote this file.".to_owned(),
        _ => "  Run: npx aitrack recompute-costs   (restores the file's last commit if it is intact; otherwise rebuilds it from the local logs, and days they no longer cover remain only in git history)".to_owned(),
    };
    format!("Refusing to overwrite invalid data/{filename} (see the warning above).\n{fix}")
}

fn read_machine_file_raw(path: &std::path::Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(error) if crate::fs::is_missing_path(&error) => Ok(None),
        Err(error) => Err(error.into()), // Read as empty, it would push the logs over the file.
    }
}

/// A truncated working-tree file reaches here unread when the logs are empty. Costs are recompute's to repair.
fn assert_pushable(core: &Core, host: &str) -> Result<()> {
    let path = core.paths.data.join(machine_data_filename(host).map_err(Error::new)?);
    let Some(raw) = read_machine_file_raw(&path)? else { return Ok(()) }; // A deletion or rename is a legitimate change.
    let options = ValidationOptions { allow_inconsistent_cost_totals: true };
    let check = check_raw_machine_file(&raw, &path.to_string_lossy(), encryption_passphrase(&core.env), options);
    if check.machine.is_some() {
        return Ok(());
    }
    core.report_diagnostics(&check.diagnostics);
    Err(Error::new(refusal_message(host, check.failure)))
}

/// Also commits a rename-only machine id change and pushes a commit whose earlier push failed.
fn push_machine_data(core: &Core, guard: &RepoGuard<'_>, git: &Git, host: &str) -> Result<bool> {
    if git.has_machine_data_changes(host)? {
        assert_pushable(core, host)?;
        if commit_and_push(core, guard, git, host)? {
            return Ok(true);
        }
    }
    Ok(push_pending_commits(core, guard, git)?)
}

pub fn sync_data(core: &Core, options: SyncOptions) -> Result<SyncResult> {
    let result = run_data_pipeline(core, !options.dry_run, options.timeout, |guard, git, run| {
        push_local_usage(core, guard, git, &options, &run)
    })?;
    if options.verify && !options.dry_run && core.git().has_unpushed_commits() {
        return Err(Error::new("Sync finished, but commits are still waiting to be pushed to the remote."));
    }
    Ok(result)
}

fn push_local_usage(
    core: &Core,
    guard: &RepoGuard<'_>,
    git: &Git,
    options: &SyncOptions,
    run: &DataRun<'_>,
) -> Result<SyncResult> {
    let host = run.machine_id.as_str();
    let encrypt = run.config.encrypt_data == Some(true);
    if encrypt && encryption_passphrase(&core.env).is_none() {
        return Err(MachineFileError::MissingPassphrase.into());
    }
    let path = core.paths.data.join(machine_data_filename(host).map_err(Error::new)?);
    core.output.info("Reading local data...");
    let maps = run.local_maps()?;
    let fresh = build_machine_data(host, &maps, core.clock.zone_name(), core.clock.now(), false);
    let done = |message: String, pushed: bool, days: usize| {
        core.output.info(&message);
        Ok(SyncResult { machine: fresh.clone(), message, pushed, days })
    };
    let total_days = maps.values().flat_map(|m| m.keys()).collect::<HashSet<_>>().len();
    if total_days == 0 {
        let pushed = !options.dry_run && push_machine_data(core, guard, git, host)?;
        let labels: Vec<&str> = PROVIDERS.iter().filter(|p| p.synced).map(|p| p.label).collect();
        let message = if pushed {
            format!("Done! Pushed machine data migration for {host}.")
        } else {
            format!("No local data found ({}).", labels.join(" or "))
        };
        return done(message, pushed, 0);
    }
    let found: Vec<String> = PROVIDERS
        .iter()
        .filter(|p| p.synced)
        .filter_map(|p| maps.get(p.key).map(|m| (p.label, m.len())).filter(|(_, n)| *n > 0))
        .map(|(label, n)| format!("{label} ({n} days)"))
        .collect();
    core.output.info(&format!("Found: {}", found.join(", ")));

    let raw = read_machine_file_raw(&path)?;
    let mut existing = None;
    let mut encrypted_now = false;
    if let Some(raw) = &raw {
        let check = check_raw_machine_file(
            raw,
            &path.to_string_lossy(),
            encryption_passphrase(&core.env),
            ValidationOptions::default(),
        );
        core.report_diagnostics(&check.diagnostics);
        // Merging an invalid file as empty would push the loss of its history.
        let machine = check.machine.ok_or_else(|| Error::new(refusal_message(host, check.failure)))?;
        existing = Some(machine.days);
        encrypted_now = check.encrypted;
    }
    let outgoing = outgoing_days(
        &core.pricing().current(),
        existing.as_ref(),
        &fresh.days,
        run.config.compact_after_days,
        core.clock.today(),
    );
    let kept = ratcheted_provider_days(existing.as_ref(), &fresh.days);
    if kept > 0 {
        core.output.info(&format!(
            "Kept {kept} synced day(s) with more tokens than the local logs still show, which is normal once a tool prunes its logs."
        ));
    }
    let synced_days = outgoing.len();
    let normalized_existing = existing.as_ref().map(canonical_days);
    // Usage only: lastUpdated and the schema header alone are not worth a commit.
    let encryption_change = raw.is_some() && encrypted_now != encrypt;
    let unchanged = js::to_string(&normalized_existing).expect("days serialize")
        == js::to_string(&outgoing).expect("days serialize");
    if !encryption_change && unchanged {
        let mut pushed = false;
        if !options.dry_run {
            remove_pending_machine_file(core, host)?;
            pushed = push_machine_data(core, guard, git, host)?;
        }
        return done(
            if pushed { pushed_message(host, synced_days) } else { NO_CHANGES_MESSAGE.to_owned() },
            pushed,
            synced_days,
        );
    }
    if options.dry_run {
        let action = if existing.is_none() { "create" } else { "update" };
        return done(
            format!("Dry run: would {action} data/{host}.json ({synced_days} days). No changes written."),
            false,
            synced_days,
        );
    }
    let outgoing_file = MachineFile { days: outgoing, ..fresh.clone() };
    write_machine_file(core, &path, &outgoing_file, encrypt, ValidationOptions::default())?;
    remove_pending_machine_file(core, host)?;
    let pushed = commit_and_push(core, guard, git, host)?;
    done(if pushed { pushed_message(host, synced_days) } else { NO_CHANGES_MESSAGE.to_owned() }, pushed, synced_days)
}
