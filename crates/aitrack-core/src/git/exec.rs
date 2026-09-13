//! Git command execution with retry and conflict resolution.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::errors::error_message_any;

const MAX_PUSH_ATTEMPTS: u32 = 3;

#[derive(Debug)]
pub struct GitCommandError {
    pub args: Vec<String>,
    pub status: Option<i32>,
    pub output: String,
}

impl std::fmt::Display for GitCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let detail = if self.output.is_empty() {
            String::new()
        } else {
            format!(": {}", self.output)
        };
        write!(
            f,
            "git {} failed with exit code {}{}",
            self.args.join(" "),
            self.status.map_or("None".to_string(), |s| s.to_string()),
            detail
        )
    }
}

impl std::error::Error for GitCommandError {}

pub enum GitStdio {
    Inherit,
    Pipe,
}

pub fn run_git(cwd: &Path, args: &[&str], stdio: GitStdio) -> Result<String, GitCommandError> {
    let args_vec: Vec<String> = args.iter().map(|s| s.to_string()).collect();

    match stdio {
        GitStdio::Pipe => {
            let output = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| GitCommandError {
                    args: args_vec.clone(),
                    status: None,
                    output: error_message_any(&e),
                })?;

            if !output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let output_str = if stderr.is_empty() { stdout } else { stderr };
                return Err(GitCommandError {
                    args: args_vec,
                    status: output.status.code(),
                    output: output_str,
                });
            }

            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        GitStdio::Inherit => {
            let status = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
                .map_err(|e| GitCommandError {
                    args: args_vec.clone(),
                    status: None,
                    output: error_message_any(&e),
                })?;

            if !status.success() {
                return Err(GitCommandError {
                    args: args_vec,
                    status: status.code(),
                    output: String::new(),
                });
            }

            Ok(String::new())
        }
    }
}

pub fn has_upstream(cwd: &Path) -> bool {
    let result = Command::new("git")
        .args([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status();

    result.map(|s| s.success()).unwrap_or(false)
}

fn is_non_fast_forward(error: &GitCommandError) -> bool {
    error.output.contains("non-fast-forward")
        || error.output.contains("fetch first")
        || error.output.contains("[rejected]")
        || error.output.contains("rejected")
        || error.output.contains("stale info")
}

pub struct RetryConflict {
    pub path: String,
    pub contents: String,
}

pub fn is_rebase_in_progress(cwd: &Path) -> bool {
    cwd.join(".git/rebase-merge").exists() || cwd.join(".git/rebase-apply").exists()
}

fn rebase_for_push_retry(
    cwd: &Path,
    conflict: Option<&RetryConflict>,
    branch: Option<&str>,
) -> anyhow::Result<()> {
    let remote_args = if let Some(b) = branch {
        vec!["origin", b]
    } else {
        vec![]
    };

    let mut pull_args = vec!["pull", "--rebase", "--quiet"];
    pull_args.extend(remote_args);

    if let Err(e) = run_git(cwd, &pull_args, GitStdio::Pipe) {
        let conflicts_output = run_git(
            cwd,
            &["diff", "--name-only", "--diff-filter=U"],
            GitStdio::Pipe,
        )
        .unwrap_or_default();

        let conflicts: Vec<&str> = conflicts_output
            .split('\n')
            .filter(|s| !s.is_empty())
            .collect();

        if let Some(conf) = conflict {
            if conflicts.len() == 1 && conflicts[0] == conf.path && is_rebase_in_progress(cwd) {
                let file_path = cwd.join(&conf.path);
                fs::write(&file_path, &conf.contents).map_err(|e| {
                    anyhow::anyhow!("Failed to write conflict file: {}", error_message_any(&e))
                })?;

                run_git(
                    cwd,
                    &["add", "--", &format!(":(literal){}", conf.path)],
                    GitStdio::Pipe,
                )?;

                run_git(
                    cwd,
                    &["-c", "core.editor=true", "rebase", "--continue"],
                    GitStdio::Pipe,
                )?;

                return Ok(());
            }
        }

        if is_rebase_in_progress(cwd) {
            let _ = run_git(cwd, &["rebase", "--abort"], GitStdio::Pipe);
        }

        return Err(anyhow::anyhow!(
            "Concurrent sync detected, but the local commit could not be replayed safely. {}",
            e
        ));
    }

    Ok(())
}

pub fn push_with_retry(cwd: &Path, conflict: Option<&RetryConflict>) -> anyhow::Result<()> {
    let upstream = has_upstream(cwd);
    let branch = if !upstream {
        Some(run_git(cwd, &["branch", "--show-current"], GitStdio::Pipe)?)
    } else {
        None
    };

    if !upstream && branch.as_ref().is_none_or(|b| b.is_empty()) {
        return Err(anyhow::anyhow!(
            "Cannot push from a detached HEAD without an upstream branch."
        ));
    }

    for attempt in 1..=MAX_PUSH_ATTEMPTS {
        let push_args = if upstream {
            vec!["push"]
        } else {
            vec!["push", "-u", "origin", "HEAD"]
        };

        match run_git(cwd, &push_args, GitStdio::Pipe) {
            Ok(_) => return Ok(()),
            Err(e) => {
                if !is_non_fast_forward(&e) || attempt == MAX_PUSH_ATTEMPTS {
                    return Err(e.into());
                }
                rebase_for_push_retry(cwd, conflict, branch.as_deref())?;
            }
        }
    }

    Ok(())
}

pub fn commit_staged_data(
    cwd: &Path,
    message: &str,
    conflict: Option<&RetryConflict>,
) -> anyhow::Result<bool> {
    let staged = run_git(
        cwd,
        &["diff", "--cached", "--name-only", "--", "data/"],
        GitStdio::Pipe,
    )?;

    if staged.is_empty() {
        return Ok(false);
    }

    run_git(cwd, &["commit", "-m", message], GitStdio::Pipe)?;
    push_with_retry(cwd, conflict)?;

    Ok(true)
}
