//! The user's data repo: running git unattended, pulling, committing and pushing with per-day merges.

pub mod remote;

use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use std::time::Duration;

use crate::Core;
use crate::fs::write_file_atomic;
use crate::machine_id::{machine_data_filename, normalize_machine_id};
use crate::process::{RunError, run, run_interactive};
use crate::store::merge_conflict::merge_conflicted_machine_file;
use crate::time::iso_millis;

const MAX_PUSH_ATTEMPTS: u32 = 3;

/// Starts the subject of a commit that only adds this machine's usage, the one kind a per-day merge cannot undo.
pub const SYNC_COMMIT_PREFIX: &str = "sync: ";

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git was not found on PATH; aitrack needs git to sync.")]
    NotFound,
    #[error("git {args} failed with exit code {status}{detail}", args = .args.join(" "), status = .status.map_or_else(|| "null".to_owned(), |s| s.to_string()), detail = if .output.is_empty() { String::new() } else { format!(": {}", .output) })]
    Command { args: Vec<String>, status: Option<i32>, output: String },
    #[error("git {args} timed out after {ms} ms", args = .args.join(" "))]
    Timeout { args: Vec<String>, ms: u128 },
    #[error("{0}")]
    Other(String),
}

impl GitError {
    fn is_non_fast_forward(&self) -> bool {
        let Self::Command { output, .. } = self else { return false };
        let lower = output.to_lowercase();
        let rejected_after = |line: &str| {
            line.find("[rejected]").is_some_and(|at| {
                let rest = &line[at + "[rejected]".len()..];
                rest.contains("rejected") || rest.contains("stale info")
            })
        };
        lower.contains("non-fast-forward") || lower.contains("fetch first") || lower.lines().any(rejected_after)
    }
}

/// Proof that the repo lock is held; every operation that changes the clone takes one.
pub struct RepoGuard<'a> {
    _lock: MutexGuard<'a, ()>,
    git: Git,
}

impl RepoGuard<'_> {
    #[must_use]
    pub const fn git(&self) -> &Git {
        &self.git
    }
}

impl Core {
    /// Runs `step` once every earlier operation on the data repo has finished, so a sync cannot
    /// interleave with a concurrent pull.
    pub fn with_repo_lock<T>(&self, step: impl FnOnce(&RepoGuard<'_>) -> T) -> T {
        let guard = RepoGuard {
            _lock: self.repo_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
            git: Git::new(self),
        };
        step(&guard)
    }

    pub fn git(&self) -> Git {
        Git::new(self)
    }
}

/// Runs git in the data repo, unattended.
#[derive(Clone, Debug)]
pub struct Git {
    repo: PathBuf,
    env: Vec<(String, String)>,
    pub timeout: Option<Duration>,
}

impl Git {
    fn new(core: &Core) -> Self {
        // Appended, because these variables may already carry the user's config, such as a credential helper.
        let count = core.env.var("GIT_CONFIG_COUNT").and_then(|c| c.parse::<u32>().ok()).unwrap_or(0);
        let env = vec![
            ("GIT_CONFIG_COUNT".to_owned(), (count + 1).to_string()),
            (format!("GIT_CONFIG_KEY_{count}"), "commit.gpgsign".to_owned()),
            (format!("GIT_CONFIG_VALUE_{count}"), "false".to_owned()),
        ];
        Self { repo: core.paths.repo.clone(), env, timeout: None }
    }

    #[must_use]
    pub const fn with_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.timeout = timeout;
        self
    }

    #[must_use]
    pub fn repo(&self) -> &Path {
        &self.repo
    }

    /// `git <args>` in the repo; stdout trimmed. A timed call fails at a credential prompt instead of waiting.
    ///
    /// # Errors
    ///
    /// When the command cannot start, times out or exits unsuccessfully.
    pub fn run(&self, args: &[&str]) -> Result<String, GitError> {
        let mut env = self.env.clone();
        if self.timeout.is_some() {
            env.push(("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()));
            env.push(("GCM_INTERACTIVE".to_owned(), "never".to_owned()));
        }
        let owned = || args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
        match run("git", args, &env, Some(&self.repo), self.timeout) {
            Ok(done) => {
                let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_owned();
                if done.status.success() {
                    Ok(text(&done.stdout))
                } else {
                    let stderr = text(&done.stderr);
                    let output = if stderr.is_empty() { text(&done.stdout) } else { stderr };
                    Err(GitError::Command { args: owned(), status: done.status.code(), output })
                }
            }
            Err(RunError::Timeout) => {
                Err(GitError::Timeout { args: owned(), ms: self.timeout.map_or(0, |t| t.as_millis()) })
            }
            Err(RunError::Spawn(error)) if error.kind() == std::io::ErrorKind::NotFound && self.repo.exists() => {
                Err(GitError::NotFound)
            }
            Err(RunError::Spawn(error)) => Err(GitError::Other(error.to_string())),
        }
    }

    fn untimed(&self) -> Self {
        self.clone().with_timeout(None)
    }

    #[must_use]
    pub fn has_upstream(&self) -> bool {
        self.untimed().run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_ok()
    }

    #[must_use]
    pub fn is_rebase_in_progress(&self) -> bool {
        let git = self.repo.join(".git");
        git.join("rebase-merge").exists() || git.join("rebase-apply").exists()
    }

    /// Best effort: the failure that led here is the one worth reporting.
    pub fn abort_rebase_if_in_progress(&self) {
        if self.is_rebase_in_progress() {
            let _ = self.untimed().run(&["rebase", "--abort"]);
        }
    }

    /// A file as of the last commit, or `None` when it has none.
    #[must_use]
    pub fn read_committed_file(&self, repo_path: &str) -> Option<String> {
        self.untimed().run(&["show", &format!("HEAD:{repo_path}")]).ok()
    }

    /// The URL as stored, which outlives a deleted or corrupt config; `get-url` would apply `insteadOf`.
    #[must_use]
    pub fn clone_origin_url(&self) -> Option<String> {
        self.untimed().run(&["config", "--get", "remote.origin.url"]).ok()
    }

    /// Whether the branch holds commits the remote does not have: a failed push leaves a clean tree behind.
    #[must_use]
    pub fn has_unpushed_commits(&self) -> bool {
        self.has_upstream() && self.untimed().run(&["rev-list", "--count", "@{upstream}..HEAD"]).is_ok_and(|n| n != "0")
    }

    /// Whether this machine's file is modified, renamed or untracked.
    ///
    /// # Errors
    ///
    /// When git fails.
    pub fn has_machine_data_changes(&self, machine_id: &str) -> Result<bool, GitError> {
        let name = machine_data_filename(machine_id).map_err(|e| GitError::Other(e.to_owned()))?;
        let status = self.untimed().run(&["status", "--porcelain", "--", &format!(":(literal)data/{name}")])?;
        Ok(!status.is_empty())
    }
}

/// One side is absent from a modify/delete conflict, which has no merge.
fn conflicted_side(git: &Git, path: &str, stage: u8) -> Option<String> {
    git.untimed().run(&["show", &format!(":{stage}:{path}")]).ok()
}

fn is_machine_file_path(path: &str) -> bool {
    path.strip_prefix("data/")
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(|stem| !stem.is_empty() && !stem.contains('/'))
}

fn resolve_conflict(core: &Core, git: &Git, path: &str) -> Result<(), GitError> {
    let remote = if is_machine_file_path(path) { conflicted_side(git, path, 2) } else { None };
    let local = remote.as_ref().and_then(|_| conflicted_side(git, path, 3));
    let merged = match (&remote, &local) {
        (Some(remote), Some(local)) => merge_conflicted_machine_file(core, path, remote, local),
        _ => None,
    };
    let merged = merged.ok_or_else(|| GitError::Other(format!("{path} cannot be merged automatically")))?;
    write_file_atomic(&git.repo.join(path), &merged, None).map_err(|e| GitError::Other(e.to_string()))?;
    git.untimed().run(&["add", "--", &format!(":(literal){path}")])?;
    Ok(())
}

/// `recompute-costs --replace-local` lowers and drops days on purpose, and a merge would bring them back.
fn assert_stopped_on_sync_commit(git: &Git) -> Result<(), GitError> {
    let subject = git.untimed().run(&["log", "-1", "--format=%s", "REBASE_HEAD"]).unwrap_or_default();
    if subject.starts_with(SYNC_COMMIT_PREFIX) {
        Ok(())
    } else {
        Err(GitError::Other(format!("only sync commits merge per day, and this one is \"{subject}\"")))
    }
}

/// A rebase stops once per conflicting commit, so a branch with several needs several rounds.
fn resolve_rebase_stops(core: &Core, git: &Git, first_stop: GitError) -> Result<(), GitError> {
    let mut stop = first_stop;
    while git.is_rebase_in_progress() {
        let unmerged = git.untimed().run(&["diff", "--name-only", "--diff-filter=U"])?;
        let paths: Vec<&str> = unmerged.lines().filter(|p| !p.is_empty()).collect();
        if paths.is_empty() {
            return Err(stop); // Stopped for something other than a conflict.
        }
        assert_stopped_on_sync_commit(git)?;
        for path in paths {
            resolve_conflict(core, git, path)?;
        }
        if let Err(error) = git.untimed().run(&["-c", "core.editor=true", "rebase", "--continue"]) {
            if !git.is_rebase_in_progress() {
                return Err(error);
            }
            stop = error;
        }
    }
    Ok(())
}

/// Replays local commits on the remote. On failure the branch is as it was, never mid-rebase.
///
/// # Errors
///
/// When git fails or the rebase conflicts.
pub fn rebase_onto_remote(core: &Core, guard: &RepoGuard<'_>, git: &Git, remote: &[&str]) -> Result<(), GitError> {
    let _ = guard;
    let mut args = vec!["pull", "--rebase", "--quiet"];
    args.extend_from_slice(remote);
    let Err(error) = git.run(&args) else { return Ok(()) };
    if !git.is_rebase_in_progress() {
        return Err(error);
    }
    resolve_rebase_stops(core, git, error).map_err(|resolve_error| {
        git.abort_rebase_if_in_progress();
        GitError::Other(format!(
            "Could not merge the unpushed data commits with the remote, so they were kept unpushed: {resolve_error}.\n  If a file is unreadable here, set the passphrase or upgrade aitrack. To drop those commits instead: git -C \"{}\" reset --hard @{{upstream}}",
            git.repo.display()
        ))
    })
}

/// # Errors
///
/// When the push still fails after retrying.
pub fn push_with_retry(core: &Core, guard: &RepoGuard<'_>, git: &Git) -> Result<(), GitError> {
    let upstream = git.has_upstream();
    let branch = if upstream { None } else { Some(git.untimed().run(&["branch", "--show-current"])?) };
    if branch.as_deref() == Some("") {
        return Err(GitError::Other("Cannot push from a detached HEAD without an upstream branch.".into()));
    }
    for attempt in 1..=MAX_PUSH_ATTEMPTS {
        let pushed = if upstream { git.run(&["push"]) } else { git.run(&["push", "-u", "origin", "HEAD"]) };
        match pushed {
            Ok(_) => return Ok(()),
            Err(error) if !error.is_non_fast_forward() || attempt == MAX_PUSH_ATTEMPTS => return Err(error),
            Err(_) => {
                let remote: Vec<&str> = branch.as_deref().map_or_else(Vec::new, |b| vec!["origin", b]);
                rebase_onto_remote(core, guard, git, &remote)?;
            }
        }
    }
    Ok(())
}

/// Commits what is staged under `data/` and pushes it; `false` when nothing was staged.
///
/// # Errors
///
/// When git fails.
pub fn commit_staged_data(core: &Core, guard: &RepoGuard<'_>, git: &Git, message: &str) -> Result<bool, GitError> {
    if git.untimed().run(&["diff", "--cached", "--name-only", "--", "data/"])?.is_empty() {
        return Ok(false);
    }
    git.untimed().run(&["commit", "-m", message])?;
    push_with_retry(core, guard, git)?;
    Ok(true)
}

/// Pushes commits already made locally; `false` when there are none.
///
/// # Errors
///
/// When git fails.
pub fn push_pending_commits(core: &Core, guard: &RepoGuard<'_>, git: &Git) -> Result<bool, GitError> {
    if !git.has_unpushed_commits() {
        return Ok(false);
    }
    push_with_retry(core, guard, git)?;
    Ok(true)
}

/// # Errors
///
/// When the fetch or rebase fails.
pub fn pull(core: &Core, guard: &RepoGuard<'_>, git: &Git) -> Result<(), GitError> {
    git.abort_rebase_if_in_progress(); // A dead process's rebase would fail everything below, on every run.
    let Err(error) = git.run(&["pull", "--ff-only", "--quiet"]) else { return Ok(()) };
    if !matches!(error, GitError::Command { .. }) {
        return Err(error); // A timeout says nothing about an empty remote.
    }
    let heads = git.run(&["ls-remote", "--heads", "origin"]).map_err(|_| error_clone(&error))?;
    if heads.is_empty() {
        return Ok(()); // Empty remote: nothing to pull yet.
    }
    // A failed push leaves the branch diverged once the remote moves on; replay it rather than fail every sync.
    if !git.has_unpushed_commits() {
        return Err(error);
    }
    rebase_onto_remote(core, guard, git, &[])
}

fn error_clone(error: &GitError) -> GitError {
    match error {
        GitError::Command { args, status, output } => {
            GitError::Command { args: args.clone(), status: *status, output: output.clone() }
        }
        other => GitError::Other(other.to_string()),
    }
}

/// Stages exactly `paths` (or all of `data/`), so a dirty or leftover file beside them stays out.
///
/// # Errors
///
/// When git fails.
pub fn commit_data_changes(
    core: &Core,
    guard: &RepoGuard<'_>,
    git: &Git,
    message: &str,
    paths: Option<&[String]>,
) -> Result<bool, GitError> {
    let pathspecs: Vec<String> =
        paths.map_or_else(|| vec!["data/".to_owned()], |p| p.iter().map(|p| format!(":(literal){p}")).collect());
    let mut args = vec!["add", "--"];
    args.extend(pathspecs.iter().map(String::as_str));
    git.untimed().run(&args)?;
    commit_staged_data(core, guard, git, message)
}

/// Stages and pushes this machine's file as a sync commit.
///
/// # Errors
///
/// When git fails.
pub fn commit_and_push(core: &Core, guard: &RepoGuard<'_>, git: &Git, hostname: &str) -> Result<bool, GitError> {
    let machine_id = normalize_machine_id(hostname).map_err(|e| GitError::Other(e.to_owned()))?;
    let name = machine_data_filename(machine_id).map_err(|e| GitError::Other(e.to_owned()))?;
    git.untimed().run(&["add", "--", &format!(":(literal)data/{name}")])?;
    let message = format!("{SYNC_COMMIT_PREFIX}{machine_id} at {}", iso_millis(core.clock.now()));
    commit_staged_data(core, guard, git, &message)
}

pub fn is_cloned(core: &Core) -> bool {
    core.paths.repo.join(".git").exists()
}

/// `git clone` with the terminal attached, so credentials can be asked for.
///
/// # Errors
///
/// When the clone fails.
pub fn clone_repo(url: &str, target: &Path) -> Result<(), GitError> {
    let status = run_interactive("git", &["clone", "--", url, &target.to_string_lossy()])
        .map_err(|e| GitError::Other(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(GitError::Other(format!(
            "git clone failed with exit code {}",
            status.code().map_or_else(|| "null".to_owned(), |c| c.to_string())
        )))
    }
}

/// # Errors
///
/// When the clone cannot be removed.
pub fn remove_local_clone(core: &Core) -> std::io::Result<()> {
    if core.paths.repo.exists() {
        std::fs::remove_dir_all(&core.paths.repo)?;
    }
    Ok(())
}

/// Swaps in a clone of `url` only once it succeeded: the old clone may hold the only copy of unpushed commits.
///
/// # Errors
///
/// When the old clone cannot be removed or the new one cannot be cloned.
pub fn replace_local_clone(core: &Core, url: &str) -> Result<(), GitError> {
    let mut incoming = core.paths.repo.clone().into_os_string();
    incoming.push(".incoming");
    let incoming = PathBuf::from(incoming);
    let _ = std::fs::remove_dir_all(&incoming);
    let result = clone_repo(url, &incoming).and_then(|()| {
        remove_local_clone(core).map_err(|e| GitError::Other(e.to_string()))?;
        std::fs::rename(&incoming, &core.paths.repo).map_err(|e| GitError::Other(e.to_string()))
    });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&incoming);
    }
    result
}
