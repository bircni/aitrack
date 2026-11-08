//! `aitrack recompute-costs`: reprice every synced machine file, repair this machine's, push what changed.

use std::path::Path;

use serde_json::Value;

use crate::Core;
use crate::data::compact::compact_days;
use crate::data::local_data::{build_machine_data, canonical_days, machine_has_data, merge_persisted_days};
use crate::data::types::{MachineDays, MachineFile};
use crate::error::{Error, Result};
use crate::git::{Git, commit_data_changes};
use crate::machine_id::machine_data_filename;
use crate::pricing::reprice::reprice_machine_days;
use crate::store::encryption::encryption_passphrase;
use crate::store::machine_files::{MachineFileError, list_data_files, write_machine_file};
use crate::store::validate::{Failure, MachineFileCheck, ValidationOptions, check_raw_machine_file};
use crate::sync::run_data_pipeline;
use crate::time::iso_millis;

#[derive(Clone, Copy, Debug, Default)]
pub struct RecomputeOptions {
    /// Rebuild this machine from the local logs, dropping days they no longer cover: the one way past
    /// a file no passphrase can open any more.
    pub replace_local: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecomputeResult {
    /// Machine files rewritten.
    pub changed: usize,
    pub pushed: bool,
}

/// Without costs: per-entry and summed costs differ in the last bits, which is not a change.
#[expect(
    clippy::expect_used,
    reason = "map keys are strings or dates and the output is an in-memory buffer, so serializing cannot fail"
)]
fn tokens_json(days: &MachineDays) -> String {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("costUSD");
                map.values_mut().for_each(strip);
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
    let mut value = serde_json::to_value(days).expect("days serialize");
    strip(&mut value);
    value.to_string()
}

fn name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

struct Local<'a> {
    fresh: &'a MachineFile,
    replace_local: bool,
}

impl Local<'_> {
    fn merged(&self, persisted: Option<&MachineDays>) -> MachineDays {
        merge_persisted_days(persisted, &self.fresh.days)
    }

    fn rebuild(&self) -> Loaded {
        Loaded {
            machine: MachineFile { days: self.merged(None), ..self.fresh.clone() },
            touched: true,
            own_rebuild: true,
        }
    }
}

struct Loaded {
    machine: MachineFile,
    /// The refresh changed it, before any repricing.
    touched: bool,
    /// Rebuilt for this machine, so it takes the compaction setting once repriced.
    own_rebuild: bool,
}

fn check_for_recompute(core: &Core, raw: &str, path: &Path) -> MachineFileCheck {
    let options = ValidationOptions { allow_inconsistent_cost_totals: true };
    let check = check_raw_machine_file(raw, &path.to_string_lossy(), encryption_passphrase(&core.env), options);
    core.report_diagnostics(&check.diagnostics);
    check
}

/// This machine's file could not be read. Only a corrupt one may be rewritten: a newer schema or a
/// file this passphrase cannot open is healthy, and its older days may exist nowhere else.
fn repair_own_file(core: &Core, git: &Git, path: &Path, check: &MachineFileCheck, local: &Local<'_>) -> Option<Loaded> {
    let has_logs = machine_has_data(local.fresh);
    if local.replace_local {
        if check.failure == Some(Failure::FutureSchema) || !has_logs {
            return None;
        }
        core.output.warn(&format!("  Replacing unreadable {} with the local logs, as requested.", name(path)));
        return Some(local.rebuild());
    }
    if check.failure != Some(Failure::Corrupt) {
        core.output.warn(&format!("  Left {} as it is: nothing was lost, it is only unreadable here.", name(path)));
        return None;
    }
    let committed =
        git.read_committed_file(&format!("data/{}", name(path))).map(|raw| check_for_recompute(core, &raw, path));
    if let Some(machine) = committed.as_ref().and_then(|c| c.machine.as_ref()) {
        core.output.warn(&format!("  Restoring {} from its last commit.", name(path)));
        return Some(Loaded {
            machine: MachineFile { days: local.merged(Some(&machine.days)), ..machine.clone() },
            touched: true,
            own_rebuild: true,
        });
    }
    if committed.as_ref().is_some_and(|c| c.failure != Some(Failure::Corrupt)) || !has_logs {
        return None;
    }
    core.output.warn(&format!(
        "  Rebuilding {} from the local logs. Days they no longer cover remain only in the repo's git history.",
        name(path)
    ));
    Some(local.rebuild())
}

fn refresh_own_file(core: &Core, machine: &MachineFile, local: &Local<'_>) -> Loaded {
    if !machine_has_data(local.fresh) {
        if local.replace_local {
            core.output.warn("Refusing to replace this machine from the local logs — they have no usage. The synced file was left as it is.");
        }
        return Loaded { machine: machine.clone(), touched: false, own_rebuild: false };
    }
    // Days the logs no longer reach stay as persisted and are repriced, not dropped.
    let days = local.merged(if local.replace_local { None } else { Some(&machine.days) });
    if local.replace_local {
        let dropped = machine.days.keys().filter(|date| !days.contains_key(*date)).count();
        if dropped > 0 {
            core.output.warn(&format!("Dropping {dropped} synced day(s) the logs no longer cover."));
        }
    }
    let touched = tokens_json(&days) != tokens_json(&canonical_days(&machine.days));
    Loaded { machine: MachineFile { days, ..machine.clone() }, touched, own_rebuild: true }
}

fn report_legacy_skipped(core: &Core, skipped: usize, state: &str) {
    if skipped > 0 {
        core.output.info(&format!(
            "  {skipped} model-day(s) {state} (legacy data without cache breakdown — re-sync from that machine)."
        ));
    }
}

/// Re-reads this machine's logs, reprices every synced machine file, and pushes what changed.
///
/// # Errors
///
/// When the data repo cannot be read, written or pushed.
pub fn recompute_costs(core: &Core, options: RecomputeOptions) -> Result<RecomputeResult> {
    run_data_pipeline(core, true, None, |guard, git, run| {
        let files = list_data_files(core);
        if files.is_empty() {
            core.output.info("No synced data files found.");
            return Ok(RecomputeResult::default());
        }
        let fresh =
            build_machine_data(&run.machine_id, &run.local_maps()?, core.clock.zone_name(), core.clock.now(), false);
        let local = Local { fresh: &fresh, replace_local: options.replace_local };
        let own_name = machine_data_filename(&run.machine_id).map_err(Error::new)?;
        let rates = core.pricing().current();
        let mut pending: Vec<(std::path::PathBuf, MachineFile, bool)> = Vec::new();
        let mut legacy_skipped = 0;
        for path in files {
            let is_current = name(&path) == own_name;
            let check = check_for_recompute(core, &std::fs::read_to_string(&path)?, &path);
            let loaded = if !is_current {
                check.machine.clone().map(|machine| Loaded { machine, touched: false, own_rebuild: false })
            } else if let Some(machine) = &check.machine {
                Some(refresh_own_file(core, machine, &local))
            } else {
                repair_own_file(core, git, &path, &check, &local)
            };
            let Some(mut loaded) = loaded else { continue }; // Another machine's unreadable file: our logs are not its history.
            let repriced = reprice_machine_days(&rates, &mut loaded.machine.days, Some(run.fallbacks));
            legacy_skipped += repriced.legacy_skipped;
            let days = match run.config.compact_after_days {
                Some(after) if loaded.own_rebuild => {
                    compact_days(&rates, &loaded.machine.days, after, core.clock.today())
                }
                _ => loaded.machine.days.clone(),
            };
            let compacted = tokens_json(&days) != tokens_json(&loaded.machine.days);
            if !loaded.touched && !repriced.touched && !compacted {
                continue;
            }
            // Another machine's file keeps its owner's choice, or this would publish encrypted data as plaintext.
            let encrypt = if is_current { run.config.encrypt_data == Some(true) } else { check.encrypted };
            let machine = MachineFile { days, last_updated: iso_millis(core.clock.now()), ..loaded.machine };
            pending.push((path, machine, encrypt));
        }
        let changed = pending.len();
        if changed == 0 {
            core.output.info("Nothing to recompute — costs are already current.");
            report_legacy_skipped(core, legacy_skipped, "skipped");
            return Ok(RecomputeResult::default());
        }
        // Before the first write: a file rewritten and left uncommitted by a stop here would block later pulls.
        if pending.iter().any(|(_, _, encrypt)| *encrypt) && encryption_passphrase(&core.env).is_none() {
            return Err(MachineFileError::MissingPassphrase.into());
        }
        let options = ValidationOptions { allow_inconsistent_cost_totals: true };
        for (path, machine, encrypt) in &pending {
            write_machine_file(core, path, machine, *encrypt, options)?;
        }
        core.output.info(&format!("Recomputed costs in {changed} file(s)."));
        report_legacy_skipped(core, legacy_skipped, "left unchanged");
        let paths: Vec<String> = pending.iter().map(|(path, ..)| format!("data/{}", name(path))).collect();
        let message = format!("recompute: refresh costs at {}", iso_millis(core.clock.now()));
        let pushed = commit_data_changes(core, guard, git, &message, Some(&paths))?;
        if pushed {
            core.output.info("Pushed updated costs.");
        }
        Ok(RecomputeResult { changed, pushed })
    })
}
