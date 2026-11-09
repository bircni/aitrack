use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use crate::Locked;
use crate::data::day_map::Attribution;
use crate::data::project::{NO_REMOTE_PROJECT, normalize_remote_url};
use crate::process::run;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const PREFETCH_THREADS: usize = 16;

/// `owner/repo` of a directory's origin, or `None` when it is gone or has no remote.
pub trait ProjectResolver: Sync {
    fn resolve(&self, cwd: &str) -> Option<String>;

    /// Resolves directories ahead of the `resolve` calls that will ask for them.
    fn prefetch(&self, _cwds: &[&str]) {}
}

/// Asks git once per repository for the life of the resolver.
#[derive(Default)]
pub struct GitProjectResolver {
    known: Mutex<HashMap<String, Option<String>>>,
}

impl ProjectResolver for GitProjectResolver {
    fn resolve(&self, cwd: &str) -> Option<String> {
        let repository = repository_of(cwd).to_owned();
        if let Some(known) = self.known.locked().get(&repository) {
            return known.clone();
        }
        let project = origin_url(&repository).and_then(|url| normalize_remote_url(&url));
        self.known.locked().insert(repository, project.clone());
        project
    }

    /// Git spends most of each call starting up, so asking side by side is what keeps a cold scan fast.
    fn prefetch(&self, cwds: &[&str]) {
        let mut pending: Vec<&str> = Vec::new();
        {
            let known = self.known.locked();
            for repository in cwds.iter().map(|cwd| repository_of(cwd)) {
                if !known.contains_key(repository) && !pending.contains(&repository) {
                    pending.push(repository);
                }
            }
        }
        let next = AtomicUsize::new(0);
        std::thread::scope(|threads| {
            for _ in 0..pending.len().min(PREFETCH_THREADS) {
                threads.spawn(|| {
                    while let Some(cwd) = pending.get(next.fetch_add(1, Ordering::Relaxed)) {
                        self.resolve(cwd);
                    }
                });
            }
        });
    }
}

fn origin_url(cwd: &str) -> Option<String> {
    let env = [("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned())];
    let output = run("git", &["-C", cwd, "remote", "get-url", "origin"], &env, None, Some(GIT_TIMEOUT)).ok()?;
    let url = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !url.is_empty()).then_some(url)
}

/// An agent worktree (`<repo>/.claude/worktrees/<name>`) is gone once its task ends; the repository
/// that created it still answers.
#[must_use]
pub fn repository_of(cwd: &str) -> &str {
    let is_sep = |b: u8| b == b'/' || b == b'\\';
    let bytes = cwd.as_bytes();
    for i in 1..bytes.len() {
        if !is_sep(bytes[i]) {
            continue;
        }
        let rest = &bytes[i + 1..];
        let matches = rest.len() > ".claude/worktrees/".len()
            && rest.starts_with(b".claude")
            && is_sep(rest[7])
            && rest[8..].starts_with(b"worktrees")
            && is_sep(rest[17])
            && !is_sep(rest[18]);
        if matches {
            return &cwd[..i];
        }
    }
    cwd
}

/// The project for a working directory; work without a remote keeps its cwd for `--dir` matching.
pub fn attribute_cwd(resolver: &dyn ProjectResolver, cwd: Option<&str>) -> Attribution {
    cwd.and_then(|cwd| resolver.resolve(cwd)).map_or_else(
        || Attribution { project: NO_REMOTE_PROJECT.to_owned(), cwd: cwd.map(str::to_owned) },
        |project| Attribution { project, cwd: None },
    )
}

/// `realpath` without Windows' `\\?\` prefix, so the result matches the working directories logs record.
fn real_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let real = std::fs::canonicalize(path)?;
    let text = real.to_string_lossy();
    Ok(match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.into(),
        _ => real,
    })
}

/// The project of a directory, or the directory itself when it has no remote.
///
/// # Errors
///
/// With the message to show when the path is not a directory.
pub fn resolve_project_selector(path: &std::path::Path) -> Result<crate::data::project_usage::ProjectSelector, String> {
    use crate::data::project_usage::ProjectSelector;
    let dir = super::paths::absolute(path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path.display()));
    }
    let real = real_path(&dir).map_err(|e| e.to_string())?;
    let project = GitProjectResolver::default().resolve(&real.to_string_lossy());
    Ok(project.map_or(ProjectSelector::Dir(real), ProjectSelector::Project))
}

#[cfg(test)]
mod tests {
    use super::{GitProjectResolver, ProjectResolver, repository_of};

    #[test]
    fn maps_agent_worktrees_to_their_repository() {
        assert_eq!(repository_of("/src/app/.claude/worktrees/task-1/sub"), "/src/app");
        assert_eq!(repository_of("C:\\src\\app\\.claude\\worktrees\\t"), "C:\\src\\app");
        assert_eq!(repository_of("/src/app/.claude/worktrees/"), "/src/app/.claude/worktrees/");
        assert_eq!(repository_of("/.claude/worktrees/x"), "/.claude/worktrees/x");
        assert_eq!(repository_of("/src/app"), "/src/app");
    }

    #[test]
    fn prefetch_resolves_each_repository_once_for_later_lookups() {
        let root = tempfile::tempdir().unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| {
            assert!(std::process::Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
        };
        let (app, plain) = (root.path().join("app"), root.path().join("plain"));
        for dir in [&app, &plain] {
            std::fs::create_dir_all(dir).unwrap();
            git(dir, &["init", "-q"]);
        }
        git(&app, &["remote", "add", "origin", "git@github.com:me/app.git"]);
        let (app, plain) = (app.to_str().unwrap(), plain.to_str().unwrap());
        let worktree = format!("{app}/.claude/worktrees/t");
        let resolver = GitProjectResolver::default();
        resolver.prefetch(&[app, plain, &worktree]);
        let known = resolver.known.lock().unwrap().clone();
        assert_eq!(known.len(), 2);
        assert_eq!(known[app].as_deref(), Some("me/app"));
        assert_eq!(known[plain], None);
    }
}
