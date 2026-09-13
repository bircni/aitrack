//! Git repository helpers - cloning, pulling, pushing.

use std::fs;
use std::process::{Command, Stdio};

use crate::errors::error_message_any;
use crate::machine_id::{machine_data_filename, normalize_machine_id};
use crate::paths::local_repo;

use super::exec::{
    GitStdio, RetryConflict, commit_staged_data, has_upstream, is_rebase_in_progress,
    push_with_retry, run_git,
};

/// Whether the local repo has been cloned.
pub fn is_cloned() -> bool {
    local_repo().join(".git").exists()
}

/// Clone the data repository.
pub fn clone_repo(url: &str) -> anyhow::Result<()> {
    let repo_path = local_repo();

    let status = Command::new("git")
        .args(["clone", "--", url])
        .arg(&repo_path)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to execute git clone: {}", error_message_any(&e)))?;

    if !status.success() {
        return Err(anyhow::anyhow!(
            "git clone failed with exit code {}",
            status.code().map_or("None".to_string(), |c| c.to_string())
        ));
    }

    Ok(())
}

/// Remove the local clone directory.
pub fn remove_local_clone() -> anyhow::Result<()> {
    let repo_path = local_repo();
    if repo_path.exists() {
        fs::remove_dir_all(&repo_path).map_err(|e| {
            anyhow::anyhow!("Failed to remove local clone: {}", error_message_any(&e))
        })?;
    }
    Ok(())
}

/// Whether the local branch holds commits the remote does not have yet.
pub fn has_unpushed_commits() -> anyhow::Result<bool> {
    let repo_path = local_repo();

    if !has_upstream(&repo_path) {
        return Ok(false);
    }

    match run_git(
        &repo_path,
        &["rev-list", "--count", "@{upstream}..HEAD"],
        GitStdio::Pipe,
    ) {
        Ok(output) => Ok(output != "0"),
        Err(_) => Ok(false), // No upstream ref or fresh repo
    }
}

/// Push commits that were already made locally.
pub fn push_pending_commits() -> anyhow::Result<bool> {
    if !has_unpushed_commits()? {
        return Ok(false);
    }

    let repo_path = local_repo();
    push_with_retry(&repo_path, None)?;
    Ok(true)
}

/// Pull the latest changes from the remote.
pub fn pull() -> anyhow::Result<()> {
    let repo_path = local_repo();

    let references = run_git(
        &repo_path,
        &["ls-remote", "--heads", "origin"],
        GitStdio::Pipe,
    )?;

    if references.is_empty() {
        return Ok(());
    }

    match run_git(
        &repo_path,
        &["pull", "--ff-only", "--quiet"],
        GitStdio::Inherit,
    ) {
        Ok(_) => Ok(()),
        Err(e) => {
            // Try rebase if we have unpushed commits
            if !has_unpushed_commits()? {
                return Err(e.into());
            }

            match run_git(&repo_path, &["pull", "--rebase", "--quiet"], GitStdio::Pipe) {
                Ok(_) => Ok(()),
                Err(rebase_error) => {
                    if is_rebase_in_progress(&repo_path) {
                        let _ = run_git(&repo_path, &["rebase", "--abort"], GitStdio::Pipe);
                    }
                    Err(rebase_error.into())
                }
            }
        }
    }
}

/// Stage and commit all changes in the data/ directory.
pub fn commit_data_changes(message: &str) -> anyhow::Result<bool> {
    let repo_path = local_repo();
    run_git(&repo_path, &["add", "data/"], GitStdio::Inherit)?;
    commit_staged_data(&repo_path, message, None)
}

/// Commit and push this machine's data file with conflict resolution.
pub fn commit_and_push(hostname: &str) -> anyhow::Result<bool> {
    let machine_id = normalize_machine_id(hostname)?;
    let path = format!("data/{}", machine_data_filename(&machine_id)?);
    let repo_path = local_repo();

    run_git(
        &repo_path,
        &["add", "--", &format!(":(literal){}", path)],
        GitStdio::Pipe,
    )?;

    // Read the file contents for conflict resolution
    let absolute = repo_path.join(&path);
    let conflict = if absolute.exists() {
        let contents = fs::read_to_string(&absolute).map_err(|e| {
            anyhow::anyhow!("Failed to read machine file: {}", error_message_any(&e))
        })?;
        Some(RetryConflict {
            path: path.clone(),
            contents,
        })
    } else {
        None
    };

    let message = format!(
        "sync: {} at {}",
        machine_id,
        chrono::Utc::now().to_rfc3339()
    );
    commit_staged_data(&repo_path, &message, conflict.as_ref())
}

/// Whether this machine's target file is modified, renamed, or untracked.
pub fn has_machine_data_changes(machine_id: &str) -> anyhow::Result<bool> {
    let repo_path = local_repo();
    let file_path = format!(":(literal)data/{}", machine_data_filename(machine_id)?);

    let status = run_git(
        &repo_path,
        &["status", "--porcelain", "--", &file_path],
        GitStdio::Pipe,
    )?;

    Ok(!status.is_empty())
}
