//! Git repository operations - clone, pull, push, sync.

pub mod exec;
pub mod repo;

pub use exec::{
    GitCommandError, GitStdio, RetryConflict, commit_staged_data, has_upstream,
    is_rebase_in_progress, push_with_retry, run_git,
};
pub use repo::{
    clone_repo, commit_and_push, commit_data_changes, has_machine_data_changes,
    has_unpushed_commits, is_cloned, pull, push_pending_commits, remove_local_clone,
};

/// Sync data: pull changes and push any pending commits.
pub fn sync_data() -> anyhow::Result<()> {
    if !is_cloned() {
        return Err(anyhow::anyhow!("Repository not cloned. Run init first."));
    }

    pull()?;
    push_pending_commits()?;

    Ok(())
}
