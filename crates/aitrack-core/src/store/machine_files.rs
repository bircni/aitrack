//! Machine file reading, writing, and management.

use anyhow::Context;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json;

use crate::data::types::MachineFile;
use crate::data::validate::validate_machine_file;
use crate::errors::error_message_any;
use crate::machine_id::{machine_data_filename, machine_id_validation_error, normalize_machine_id};
use crate::paths::{data_dir, pending_data_dir};

/// Path of a machine's JSON file inside a directory.
pub fn machine_file_path(directory: &Path, machine_id: &str) -> anyhow::Result<PathBuf> {
    Ok(directory.join(machine_data_filename(machine_id)?))
}

/// List all .json files in the data directory.
pub fn list_data_files() -> anyhow::Result<Vec<PathBuf>> {
    let dir = data_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| anyhow::anyhow!("Failed to read data directory: {}", error_message_any(&e)))?;

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            anyhow::anyhow!("Failed to read directory entry: {}", error_message_any(&e))
        })?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            files.push(path);
        }
    }

    Ok(files)
}

/// Read and parse a machine file.
pub fn read_data_file(file_path: &Path) -> anyhow::Result<Option<MachineFile>> {
    let raw = fs::read_to_string(file_path)
        .with_context(|| format!("Failed to read {}", file_path.display()))?;

    let machine: MachineFile = serde_json::from_str(&raw)
        .with_context(|| format!("Failed to parse {}", file_path.display()))?;

    validate_machine_file(&machine)?;

    Ok(Some(machine))
}

/// Serialize a machine file with 2-space indentation and trailing newline.
fn serialize_machine_file(machine: &MachineFile) -> anyhow::Result<String> {
    let mut json =
        serde_json::to_string_pretty(machine).context("Failed to serialize machine file")?;

    // Ensure trailing newline
    if !json.ends_with('\n') {
        json.push('\n');
    }

    Ok(json)
}

/// Write a machine file, creating its parent directory if needed.
pub fn write_machine_file(file_path: &Path, machine: &MachineFile) -> anyhow::Result<()> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory {}", parent.display()))?;
    }

    let json = serialize_machine_file(machine)?;

    fs::write(file_path, json)
        .with_context(|| format!("Failed to write {}", file_path.display()))?;

    Ok(())
}

/// Write a machine file to the pending data directory.
pub fn write_pending_machine_file(machine: &MachineFile) -> anyhow::Result<()> {
    let file_path = machine_file_path(&pending_data_dir(), &machine.hostname)?;
    write_machine_file(&file_path, machine)
}

/// List all pending data files with validation.
pub fn list_pending_data_files() -> anyhow::Result<Vec<PathBuf>> {
    let dir = pending_data_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir).with_context(|| "Failed to read pending data directory")?;

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            anyhow::anyhow!("Failed to read directory entry: {}", error_message_any(&e))
        })?;
        let path = entry.path();

        if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
            if !file_name.ends_with(".json") {
                continue;
            }

            let machine_id = &file_name[..file_name.len() - 5]; // Remove .json

            if let Some(error) = machine_id_validation_error(machine_id) {
                eprintln!(
                    "Warning: Skipping staged data file with an invalid name: {} ({})",
                    file_name, error
                );
                continue;
            }

            if machine_id != machine_id.trim() {
                eprintln!(
                    "Warning: Skipping staged data file with an invalid name: {}",
                    file_name
                );
                continue;
            }

            files.push(path);
        }
    }

    Ok(files)
}

/// Adopt pending data files into the target data directory.
pub fn adopt_pending_data_files(target_data_dir: &Path) -> anyhow::Result<usize> {
    let pending = list_pending_data_files()?;
    if pending.is_empty() {
        return Ok(0);
    }

    fs::create_dir_all(target_data_dir).with_context(|| {
        format!(
            "Failed to create target directory {}",
            target_data_dir.display()
        )
    })?;

    let mut copies = Vec::new();
    let mut skipped = Vec::new();

    for source in &pending {
        let filename = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| anyhow::anyhow!("Invalid filename: {}", source.display()))?;

        let machine_id = &filename[..filename.len() - 5]; // Remove .json

        if normalize_machine_id(machine_id)? != machine_id {
            return Err(anyhow::anyhow!(
                "Cannot adopt pending machine file with an invalid name: {}",
                filename
            ));
        }

        let target = machine_file_path(target_data_dir, machine_id)?;

        if target.exists() {
            skipped.push(filename.to_string());
            continue;
        }

        copies.push((source.clone(), target));
    }

    for (source, target) in &copies {
        fs::copy(source, target).with_context(|| {
            format!(
                "Failed to copy {} to {}",
                source.display(),
                target.display()
            )
        })?;

        if let Err(e) = fs::remove_file(source) {
            let _ = fs::remove_file(target);
            return Err(e)
                .with_context(|| format!("Failed to remove source file {}", source.display()));
        }
    }

    if !skipped.is_empty() {
        eprintln!(
            "Warning: Skipped {} staged data file(s) already synced in the repo: {}",
            skipped.len(),
            skipped.join(", ")
        );
        eprintln!(
            "  Kept in {} — delete them once the synced data looks complete.",
            pending_data_dir().display()
        );
    } else {
        let _ = fs::remove_dir_all(pending_data_dir());
    }

    Ok(copies.len())
}

/// Remove a pending machine file.
pub fn remove_pending_machine_file(machine_id: &str) -> anyhow::Result<()> {
    let file_path = machine_file_path(&pending_data_dir(), machine_id)?;
    if file_path.exists() {
        fs::remove_file(&file_path)
            .with_context(|| format!("Failed to remove {}", file_path.display()))?;
    }
    Ok(())
}
