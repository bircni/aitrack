//! Renaming this machine: its files move without overwriting another machine's, or not at all.

use std::path::PathBuf;

use super::encryption::encryption_passphrase;
use super::machine_files::{is_encryption_enabled, machine_file_path, serialize_machine_file};
use super::validate::{ValidationOptions, check_raw_machine_file};
use crate::Core;
use crate::data::types::MachineFile;
use crate::error::{Error, Result};
use crate::machine_id::{machine_data_filename, normalize_machine_id};

struct Plan {
    source: PathBuf,
    target: PathBuf,
    source_contents: String,
    contents: String,
    repository_paths: Option<(String, String)>,
}

fn plan(core: &Core, dir: &std::path::Path, previous: &str, next: &str) -> Result<Option<Plan>> {
    let source = machine_file_path(dir, previous)?;
    if !source.exists() {
        return Ok(None);
    }
    let target = machine_file_path(dir, next)?;
    if target.exists() {
        return Err(Error::new(format!(
            "Cannot rename machine \"{previous}\" to \"{next}\": {} already exists.",
            target.display()
        )));
    }
    let source_contents = std::fs::read_to_string(&source)?;
    let options = ValidationOptions { allow_inconsistent_cost_totals: true };
    let check =
        check_raw_machine_file(&source_contents, &source.to_string_lossy(), encryption_passphrase(&core.env), options);
    core.report_diagnostics(&check.diagnostics);
    let machine = check
        .machine
        .ok_or_else(|| Error::new(format!("Cannot rename machine \"{previous}\": {} is invalid.", source.display())))?;
    let passphrase = if is_encryption_enabled(core) {
        Some(encryption_passphrase(&core.env).ok_or(super::machine_files::MachineFileError::MissingPassphrase)?)
    } else {
        None
    };
    let contents = serialize_machine_file(&MachineFile { hostname: next.to_owned(), ..machine }, passphrase)?;
    let in_repo = dir == core.paths.data;
    let name = |id: &str| machine_data_filename(id).map_err(Error::new);
    let repository_paths =
        if in_repo { Some((format!("data/{}", name(previous)?), format!("data/{}", name(next)?))) } else { None };
    Ok(Some(Plan { source, target, source_contents, contents, repository_paths }))
}

fn write_new(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)?.write_all(contents.as_bytes())
}

fn rollback(plan: &Plan) -> std::io::Result<()> {
    write_new(&plan.source, &plan.source_contents)?;
    if let Err(error) = std::fs::remove_file(&plan.target) {
        let _ = std::fs::remove_file(&plan.source);
        return Err(error);
    }
    Ok(())
}

/// Renames this machine's synced and staged files; rolls back on a part-way failure.
///
/// # Errors
///
/// When the data files cannot be renamed or committed.
pub fn migrate_machine_data_files(core: &Core, previous_id: &str, next_id: &str) -> Result<()> {
    let previous = normalize_machine_id(previous_id).map_err(Error::new)?;
    let next = normalize_machine_id(next_id).map_err(Error::new)?;
    if previous == next {
        return Ok(());
    }
    let plans: Vec<Plan> =
        [plan(core, &core.paths.data, previous, next)?, plan(core, &core.paths.pending_data, previous, next)?]
            .into_iter()
            .flatten()
            .collect();
    let mut completed: Vec<&Plan> = Vec::new();
    let attempt = (|| -> Result<()> {
        for plan in &plans {
            if let Err(error) =
                write_new(&plan.target, &plan.contents).and_then(|()| std::fs::remove_file(&plan.source))
            {
                let _ = std::fs::remove_file(&plan.target);
                return Err(error.into());
            }
            completed.push(plan);
        }
        let git = core.git();
        for plan in &plans {
            let Some((source, target)) = &plan.repository_paths else { continue };
            let (source, target) = (format!(":(literal){source}"), format!(":(literal){target}"));
            // git add refuses a path it knows nothing of, as with a file adopted but not yet committed.
            let tracked = !git.run(&["ls-files", "--", &source])?.is_empty();
            if tracked {
                git.run(&["add", "--", &source, &target])?
            } else {
                git.run(&["add", "--", &target])?
            };
        }
        Ok(())
    })();
    let Err(error) = attempt else { return Ok(()) };
    let mut rollback_error = None;
    for plan in completed.iter().rev() {
        if let Err(e) = rollback(plan) {
            rollback_error.get_or_insert(e);
        }
    }
    match rollback_error {
        Some(rollback_error) => {
            Err(Error::new(format!("Machine data migration and rollback failed. {error}; {rollback_error}")))
        }
        None => Err(error),
    }
}
