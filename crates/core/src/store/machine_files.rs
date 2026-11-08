//! Machine files on disk: the repo's `data/`, and the pending spool used while the repo is unavailable.

use std::path::{Path, PathBuf};

use super::encryption::{ENCRYPTION_PASSPHRASE_ENV, encrypt_text, encryption_passphrase};
use super::validate::{ValidationOptions, check_machine_file, check_raw_machine_file};
use crate::Core;
use crate::data::types::MachineFile;
use crate::fs::write_file_atomic;
use crate::js;
use crate::machine_id::{machine_data_filename, machine_id_validation_error};

#[derive(Debug, thiserror::Error)]
pub enum MachineFileError {
    /// aitrack's own validator would reject it: pushed, it would stop this machine's sync.
    #[error("Refusing to write invalid {name}: {reason}. Nothing was written.")]
    Invalid { name: String, reason: String },
    #[error(
        "encryptData is on but {ENCRYPTION_PASSPHRASE_ENV} is not set. Set it to your data repo passphrase, or run: aitrack config set encryptData false"
    )]
    MissingPassphrase,
    #[error("{0}")]
    Name(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Encryption(#[from] super::encryption::NoRandomness),
}

/// # Errors
///
/// When the machine id is not a valid file name.
pub fn machine_file_path(dir: &Path, machine_id: &str) -> Result<PathBuf, MachineFileError> {
    Ok(dir.join(machine_data_filename(machine_id).map_err(MachineFileError::Name)?))
}

pub fn is_encryption_enabled(core: &Core) -> bool {
    core.try_load_config().is_some_and(|config| config.encrypt_data == Some(true))
}

/// `*.json` in the repo's `data/`, in the order Node lists them.
pub fn list_data_files(core: &Core) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(&core.paths.data) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort_by(|a, b| {
        crate::readers::paths::entry_order(a.file_name().unwrap_or_default(), b.file_name().unwrap_or_default())
    });
    files
}

/// A validated machine file, or `None` when it had to be skipped; findings are reported.
pub fn read_data_file(core: &Core, path: &Path, options: ValidationOptions) -> Option<MachineFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    let check = check_raw_machine_file(&raw, &path.to_string_lossy(), encryption_passphrase(&core.env), options);
    core.report_diagnostics(&check.diagnostics);
    check.machine
}

/// The bytes every writer produces, so round trips stay stable.
///
/// # Errors
///
/// When encrypting fails for lack of randomness.
///
/// # Panics
///
/// Never in practice: a machine file always serializes.
#[expect(
    clippy::expect_used,
    reason = "map keys are strings or dates and the output is an in-memory buffer, so serializing cannot fail"
)]
pub fn serialize_machine_file(machine: &MachineFile, passphrase: Option<&str>) -> Result<String, MachineFileError> {
    let json = js::to_string_pretty(machine).expect("a machine file serializes");
    Ok(match passphrase {
        Some(passphrase) => encrypt_text(&json, passphrase)?,
        None => json,
    })
}

/// Atomic, and refused when the result would not validate; replaces a symlink rather than writing through it.
///
/// # Errors
///
/// When the file fails validation or cannot be written.
///
/// # Panics
///
/// Never in practice: a machine file always serializes.
#[expect(
    clippy::expect_used,
    reason = "map keys are strings or dates and the output is an in-memory buffer, so serializing cannot fail and parse back"
)]
pub fn write_machine_file(
    core: &Core,
    path: &Path,
    machine: &MachineFile,
    encrypt: bool,
    options: ValidationOptions,
) -> Result<(), MachineFileError> {
    let json = js::to_string_pretty(machine).expect("a machine file serializes");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("it was just written");
    let check = check_machine_file(&parsed, &path.to_string_lossy(), options);
    if check.machine.is_none() {
        let reason = check.diagnostics.first().map_or_else(
            || "it failed validation".to_owned(),
            |d| match d {
                super::validate::Diagnostic::FileSkipped { reason, .. } => reason.clone(),
                other @ (super::validate::Diagnostic::DayDropped { .. }
                | super::validate::Diagnostic::ProjectsDropped { .. }) => other.to_string(),
            },
        );
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Err(MachineFileError::Invalid { name, reason });
    }
    let contents = if encrypt {
        encrypt_text(&json, encryption_passphrase(&core.env).ok_or(MachineFileError::MissingPassphrase)?)?
    } else {
        json
    };
    write_file_atomic(path, &contents, None)?; // The rename replaces a symlink rather than writing through it.
    Ok(())
}

/// Staging serves a report that must still render, so a bad file only warns.
///
/// # Errors
///
/// When the file fails validation or cannot be written.
pub fn write_pending_machine_file(core: &Core, machine: &MachineFile) -> Result<(), MachineFileError> {
    let path = machine_file_path(&core.paths.pending_data, &machine.hostname)?;
    match write_machine_file(core, &path, machine, is_encryption_enabled(core), ValidationOptions::default()) {
        Err(error @ MachineFileError::Invalid { .. }) => {
            core.output.warn(&error.to_string());
            Ok(())
        }
        other => other,
    }
}

/// Staged files with a name that could only have been written by aitrack.
pub fn list_pending_data_files(core: &Core) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(&core.paths.pending_data) else { return Vec::new() };
    let mut names: Vec<String> =
        entries.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort_by(|a, b| crate::readers::paths::entry_order(std::ffi::OsStr::new(a), std::ffi::OsStr::new(b)));
    let mut files = Vec::new();
    for name in names {
        let Some(machine_id) = name.strip_suffix(".json") else { continue };
        // Checked as read, before a join could resolve a `..\` prefix on Windows.
        let error = machine_id_validation_error(machine_id);
        if error.is_some() || js::trim(machine_id) != machine_id {
            let detail = error.map_or_else(String::new, |e| format!(" ({e})"));
            core.output.warn(&format!("Skipping staged data file with an invalid name: {name}{detail}"));
            continue;
        }
        files.push(core.paths.pending_data.join(name));
    }
    files
}

/// Moves staged files into the repo, keeping any the repo already has a synced copy of.
///
/// # Errors
///
/// When a pending file cannot be moved into the data repo.
///
/// # Panics
///
/// Never: listed files always have a name.
#[expect(clippy::expect_used, reason = "listed machine files always have a file name")]
pub fn adopt_pending_data_files(core: &Core, target: &Path) -> Result<usize, MachineFileError> {
    let pending = list_pending_data_files(core);
    if pending.is_empty() {
        return Ok(0);
    }
    std::fs::create_dir_all(target)?;
    let mut copies = Vec::new();
    let mut skipped = Vec::new();
    for source in pending {
        let name = source.file_name().expect("listed files have names").to_owned();
        let destination = target.join(&name);
        if destination.exists() {
            skipped.push(name.to_string_lossy().into_owned());
        } else {
            copies.push((source, destination));
        }
    }
    for (source, destination) in &copies {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut out = options.open(destination)?;
        std::io::copy(&mut std::fs::File::open(source)?, &mut out)?;
        if let Err(error) = std::fs::remove_file(source) {
            let _ = std::fs::remove_file(destination);
            return Err(error.into());
        }
    }
    if skipped.is_empty() {
        let _ = std::fs::remove_dir_all(&core.paths.pending_data);
    } else {
        core.output.warn(&format!(
            "Skipped {} staged data file(s) already synced in the repo: {}",
            skipped.len(),
            skipped.join(", ")
        ));
        core.output.warn(&format!(
            "  Kept in {} — delete them once the synced data looks complete.",
            core.paths.pending_data.display()
        ));
    }
    Ok(copies.len())
}

/// # Errors
///
/// When the file cannot be removed.
pub fn remove_pending_machine_file(core: &Core, machine_id: &str) -> Result<(), MachineFileError> {
    let path = machine_file_path(&core.paths.pending_data, machine_id)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
