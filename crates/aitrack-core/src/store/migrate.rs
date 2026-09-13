//! Migration runner for renaming machine data files.

use anyhow::Context;
use std::fs;
use std::path::PathBuf;

use crate::git::run_git;
use crate::machine_id::{machine_data_filename, normalize_machine_id};
use crate::paths::{data_dir, local_repo, pending_data_dir};

use super::machine_files::{machine_file_path, read_data_file};

#[derive(Clone)]
struct MachineFileMigration {
    source: PathBuf,
    target: PathBuf,
    source_contents: String,
    contents: String,
    repository_paths: Option<(String, String)>,
}

fn plan_machine_file_migration(
    directory: &PathBuf,
    previous_machine_id: &str,
    next_machine_id: &str,
) -> anyhow::Result<Option<MachineFileMigration>> {
    let source = machine_file_path(directory, previous_machine_id)?;

    if !source.exists() {
        return Ok(None);
    }

    let target = machine_file_path(directory, next_machine_id)?;

    if target.exists() {
        return Err(anyhow::anyhow!(
            "Cannot rename machine \"{}\" to \"{}\": {} already exists.",
            previous_machine_id,
            next_machine_id,
            target.display()
        ));
    }

    let source_contents = fs::read_to_string(&source)
        .with_context(|| format!("Failed to read source file {}", source.display()))?;

    let machine = read_data_file(&source)?.ok_or_else(|| {
        anyhow::anyhow!(
            "Cannot rename machine \"{}\": {} is invalid.",
            previous_machine_id,
            source.display()
        )
    })?;

    // Update hostname in the machine file
    let mut updated_machine = machine;
    updated_machine.hostname = next_machine_id.to_string();

    let contents = serde_json::to_string_pretty(&updated_machine)
        .context("Failed to serialize machine file")?;

    let repository_paths = if directory == &data_dir() {
        Some((
            format!("data/{}", machine_data_filename(previous_machine_id)?),
            format!("data/{}", machine_data_filename(next_machine_id)?),
        ))
    } else {
        None
    };

    Ok(Some(MachineFileMigration {
        source,
        target,
        source_contents,
        contents,
        repository_paths,
    }))
}

fn rollback_machine_file_migration(plan: &MachineFileMigration) -> anyhow::Result<()> {
    use std::io::Write;

    // Write source back
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&plan.source)
        .with_context(|| format!("Failed to restore source file {}", plan.source.display()))?;

    file.write_all(plan.source_contents.as_bytes())
        .with_context(|| format!("Failed to write source file {}", plan.source.display()))?;

    // Remove target
    if let Err(e) = fs::remove_file(&plan.target) {
        let _ = fs::remove_file(&plan.source);
        return Err(e)
            .with_context(|| format!("Failed to remove target file {}", plan.target.display()));
    }

    Ok(())
}

/// Rename this machine's persisted and pending files without overwriting another machine.
pub fn migrate_machine_data_files(previous_id: &str, next_id: &str) -> anyhow::Result<()> {
    let previous_machine_id = normalize_machine_id(previous_id)?;
    let next_machine_id = normalize_machine_id(next_id)?;

    if previous_machine_id == next_machine_id {
        return Ok(());
    }

    let mut plans = Vec::new();

    if let Some(plan) =
        plan_machine_file_migration(&data_dir(), &previous_machine_id, &next_machine_id)?
    {
        plans.push(plan);
    }

    if let Some(plan) =
        plan_machine_file_migration(&pending_data_dir(), &previous_machine_id, &next_machine_id)?
    {
        plans.push(plan);
    }

    let mut completed = Vec::new();

    for plan in &plans {
        use std::io::Write;

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&plan.target)
            .with_context(|| format!("Failed to create target file {}", plan.target.display()))?;

        if let Err(e) = file.write_all(plan.contents.as_bytes()) {
            let _ = fs::remove_file(&plan.target);

            // Rollback completed migrations
            for completed_plan in completed.iter().rev() {
                let _ = rollback_machine_file_migration(completed_plan);
            }

            return Err(e)
                .with_context(|| format!("Failed to write target file {}", plan.target.display()));
        }

        if let Err(e) = fs::remove_file(&plan.source) {
            let _ = fs::remove_file(&plan.target);

            // Rollback completed migrations
            for completed_plan in completed.iter().rev() {
                let _ = rollback_machine_file_migration(completed_plan);
            }

            return Err(e).with_context(|| {
                format!("Failed to remove source file {}", plan.source.display())
            });
        }

        completed.push(plan.clone());
    }

    // Stage git changes
    for plan in &plans {
        if let Some((old_path, new_path)) = &plan.repository_paths {
            let repo_path = local_repo();
            let old_literal = format!(":(literal){}", old_path);
            let new_literal = format!(":(literal){}", new_path);

            if let Err(e) = run_git(
                &repo_path,
                &["add", "--", &old_literal, &new_literal],
                crate::git::GitStdio::Pipe,
            ) {
                // Not a fatal error - the migration succeeded, just staging failed
                eprintln!("Warning: Failed to stage git changes: {}", e);
            }
        }
    }

    Ok(())
}
