use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use crate::data::day_map::Attribution;
use crate::data::project::{NO_REMOTE_PROJECT, normalize_remote_url};
use crate::process::run_with_timeout;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// `owner/repo` of a directory's origin, or `None` when it is gone or has no remote.
pub trait ProjectResolver: Sync {
    fn resolve(&self, cwd: &str) -> Option<String>;
}

/// Asks git once per repository for the life of the resolver.
#[derive(Default)]
pub struct GitProjectResolver {
    known: Mutex<HashMap<String, Option<String>>>,
}

impl ProjectResolver for GitProjectResolver {
    fn resolve(&self, cwd: &str) -> Option<String> {
        let repository = repository_of(cwd).to_owned();
        if let Some(known) = self.known.lock().expect("not poisoned").get(&repository) {
            return known.clone();
        }
        let project = origin_url(&repository).and_then(|url| normalize_remote_url(&url));
        self.known.lock().expect("not poisoned").insert(repository, project.clone());
        project
    }
}

fn origin_url(cwd: &str) -> Option<String> {
    let output = run_with_timeout(
        "git",
        &["-C", cwd, "remote", "get-url", "origin"],
        &[("GIT_TERMINAL_PROMPT", "0")],
        GIT_TIMEOUT,
    )?;
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
    match cwd.and_then(|cwd| resolver.resolve(cwd)) {
        Some(project) => Attribution { project, cwd: None },
        None => Attribution { project: NO_REMOTE_PROJECT.to_owned(), cwd: cwd.map(str::to_owned) },
    }
}

#[cfg(test)]
mod tests {
    use super::repository_of;

    #[test]
    fn maps_agent_worktrees_to_their_repository() {
        assert_eq!(repository_of("/src/app/.claude/worktrees/task-1/sub"), "/src/app");
        assert_eq!(repository_of("C:\\src\\app\\.claude\\worktrees\\t"), "C:\\src\\app");
        assert_eq!(repository_of("/src/app/.claude/worktrees/"), "/src/app/.claude/worktrees/");
        assert_eq!(repository_of("/.claude/worktrees/x"), "/.claude/worktrees/x");
        assert_eq!(repository_of("/src/app"), "/src/app");
    }
}
