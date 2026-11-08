//! `cargo xtask release`, `version` and `release-notes`.

use std::path::Path;
use std::process::Command;

use aitrack_core::semver::Version;

use crate::{Result, cmd, root};

const BUMPS: [&str; 8] = ["none", "patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"];

/// The one version the CLI, opentrack and the npm packages all carry.
pub fn workspace_version(cargo_toml: &str) -> Result<String> {
    version_line(cargo_toml).map(|(_, version)| version.to_owned())
}

/// The byte range of the `[workspace.package]` version value.
fn version_line(cargo_toml: &str) -> Result<(std::ops::Range<usize>, &str)> {
    let section = cargo_toml.find("[workspace.package]").ok_or("Cargo.toml has no [workspace.package]")?;
    let rest = &cargo_toml[section..];
    let end = rest[1..].find("\n[").map_or(rest.len(), |i| i + 1);
    let line = rest[..end].find("\nversion = \"").ok_or("Cargo.toml has no [workspace.package] version")?;
    let start = section + line + "\nversion = \"".len();
    let len = cargo_toml[start..].find('"').ok_or("unterminated version")?;
    Ok((start..start + len, &cargo_toml[start..start + len]))
}

pub fn set_workspace_version(cargo_toml: &str, version: &str) -> Result<String> {
    let (range, _) = version_line(cargo_toml)?;
    Ok(format!("{}{version}{}", &cargo_toml[..range.start], &cargo_toml[range.end..]))
}

/// npm's `semver.inc`, which `bun pm version` used before.
pub fn bump(current: &str, bump: &str) -> Result<String> {
    if bump == "none" {
        return Ok(current.to_owned());
    }
    if !BUMPS.contains(&bump) {
        return Version::parse(bump)
            .map(|_| bump.to_owned())
            .ok_or_else(|| format!("Invalid bump type: {bump}. Use one of: {}, or a version", BUMPS.join(", ")));
    }
    let Version { core: [major, minor, patch], mut pre } =
        Version::parse(current).ok_or_else(|| format!("Unexpected version: {current}"))?;
    let released = pre.is_empty();
    let core = match bump {
        "major" if !released && minor == 0 && patch == 0 => [major, 0, 0],
        "major" | "premajor" => [major + 1, 0, 0],
        "minor" if !released && patch == 0 => [major, minor, 0],
        "minor" | "preminor" => [major, minor + 1, 0],
        "patch" if !released => [major, minor, patch],
        "patch" | "prepatch" => [major, minor, patch + 1],
        _ if released => [major, minor, patch + 1],
        _ => [major, minor, patch],
    };
    let [a, b, c] = core;
    Ok(match bump {
        "major" | "minor" | "patch" => format!("{a}.{b}.{c}"),
        "prerelease" if !released => {
            match pre.iter().rposition(|p| p.parse::<u64>().is_ok()) {
                Some(i) => pre[i] = (pre[i].parse::<u64>().expect("numeric") + 1).to_string(),
                None => pre.push("0".into()),
            }
            format!("{a}.{b}.{c}-{}", pre.join("."))
        }
        _ => format!("{a}.{b}.{c}-0"),
    })
}

const RELEASE_BRANCH: &str = "main";

/// Linux on every pull request, macOS and Windows on demand: a release waits for all of them.
const RELEASE_WORKFLOWS: [&str; 2] = ["ci.yml", "platforms.yml"];

/// The newest run in `gh run list --json databaseId,createdAt` started at or after `since`.
fn run_started_since(runs: &str, since: &str) -> Option<u64> {
    let runs: serde_json::Value = serde_json::from_str(runs).ok()?;
    runs.as_array()?
        .iter()
        .filter(|run| run["createdAt"].as_str().is_some_and(|at| at >= since))
        .max_by_key(|run| run["createdAt"].as_str().map(str::to_owned))
        .and_then(|run| run["databaseId"].as_u64())
}

/// Runs every release workflow on `head` and waits for them; any failure stops the release untagged.
fn remote_checks(head: &str, dry_run: bool) -> Result<()> {
    let since = jiff::Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string();
    for workflow in RELEASE_WORKFLOWS {
        run("gh", &["workflow", "run", workflow, "--ref", RELEASE_BRANCH], dry_run)?;
    }
    if dry_run {
        println!("[dry-run] wait for {} on {head}", RELEASE_WORKFLOWS.join(" and "));
        return Ok(());
    }
    for workflow in RELEASE_WORKFLOWS {
        let list = ["run", "list", "--workflow", workflow, "--commit", head, "--json", "databaseId,createdAt"];
        let mut id = None;
        for _ in 0..60 {
            id = run_started_since(&cmd("gh", &list, None)?, &since);
            if id.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
        let id = id.ok_or_else(|| format!("{workflow} did not start a run on {head}"))?.to_string();
        run("gh", &["run", "watch", &id, "--exit-status"], false)
            .map_err(|_| format!("{workflow} failed on {head}; nothing was tagged. See: gh run view {id}"))?;
    }
    Ok(())
}

/// Whether git succeeded, with its stdout and stderr: a release check reads failures as answers.
fn git(cwd: Option<&Path>, args: &[&str]) -> (bool, String, String) {
    match aitrack_core::process::run("git", args, &[], cwd, None) {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_owned(),
            String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        ),
        Err(error) => (false, String::new(), error.to_string()),
    }
}

/// Everything that would make this release fail halfway or tag the wrong commit.
pub fn release_problems(tag: &str, remote: &str, cwd: Option<&Path>) -> Vec<String> {
    let expected = RELEASE_BRANCH;
    let mut problems = Vec::new();
    let (_, branch, _) = git(cwd, &["branch", "--show-current"]);
    if branch != expected {
        let branch = if branch.is_empty() { "detached HEAD" } else { &branch };
        problems.push(format!("{tag} is cut from {expected}, but this is {branch}."));
    }
    if !git(cwd, &["status", "--porcelain"]).1.is_empty() {
        problems.push("Working tree is not clean. Commit or stash your changes before releasing.".into());
    }
    if git(cwd, &["rev-parse", "--quiet", "--verify", &format!("refs/tags/{tag}")]).0 {
        problems.push(format!("Tag {tag} already exists locally."));
    }
    let (branch_ref, tag_ref) = (format!("refs/heads/{expected}"), format!("refs/tags/{tag}"));
    let (ok, refs, error) = git(cwd, &["ls-remote", remote, &branch_ref, &tag_ref]); // Unlike fetch, changes nothing here.
    if !ok {
        problems.push(format!("Could not read {remote}: {error}"));
        return problems;
    }
    let refs: Vec<(&str, &str)> = refs.lines().filter_map(|l| l.split_once('\t')).map(|(s, r)| (r, s)).collect();
    if refs.iter().any(|(r, _)| *r == tag_ref) {
        problems.push(format!("Tag {tag} already exists on {remote}."));
    }
    let head = git(cwd, &["rev-parse", "HEAD"]).1;
    if refs.iter().find(|(r, _)| *r == branch_ref).map(|(_, s)| *s) != Some(head.as_str()) {
        problems.push(format!("HEAD is not in sync with {remote}/{expected}."));
    }
    problems
}

fn push_remote(dry_run: bool, cwd: Option<&Path>) -> Result<String> {
    let branch = git(cwd, &["branch", "--show-current"]).1;
    let configured =
        [format!("branch.{branch}.pushRemote"), "remote.pushDefault".to_owned(), format!("branch.{branch}.remote")]
            .iter()
            .map(|key| git(cwd, &["config", "--get", key]))
            .find(|(ok, value, _)| *ok && !value.is_empty())
            .map(|(_, value, _)| value);
    if let Some(remote) = configured {
        return Ok(remote);
    }
    let remotes = git(cwd, &["remote"]).1;
    let remotes: Vec<&str> = remotes.lines().filter(|r| !r.is_empty()).collect();
    if remotes.contains(&"origin") {
        return Ok("origin".into());
    }
    match remotes.as_slice() {
        [only] => Ok((*only).to_owned()),
        _ if dry_run => Ok("<remote>".into()),
        _ => Err("Could not determine push remote. Configure an upstream or remote.pushDefault.".into()),
    }
}

fn run(program: &str, args: &[&str], dry_run: bool) -> Result<()> {
    let pretty = std::iter::once(program).chain(args.iter().copied()).collect::<Vec<_>>().join(" ");
    if dry_run {
        println!("[dry-run] {pretty}");
        return Ok(());
    }
    let status = Command::new(program).args(args).status().map_err(|e| format!("{pretty}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("Command failed: {pretty}")) }
}

/// Bumps the workspace version, writes the changelog, commits, tags and pushes both atomically.
pub fn release(args: &[String]) -> Result<()> {
    let dry_run = args.iter().any(|a| a == "--dry-run");
    let bump_arg = args.iter().find(|a| !a.starts_with("--")).map_or("patch", String::as_str);
    let cargo_toml_path = root().join("Cargo.toml");
    let cargo_toml = std::fs::read_to_string(&cargo_toml_path).map_err(|e| e.to_string())?;
    let remote = push_remote(dry_run, None)?;
    let version = bump(&workspace_version(&cargo_toml)?, bump_arg)?;
    let tag = format!("v{version}");
    let problems = release_problems(&tag, &remote, None);
    if !problems.is_empty() && !dry_run {
        return Err(problems.join("\n"));
    }
    for problem in &problems {
        eprintln!("A real release would stop here: {problem}");
    }
    remote_checks(&git(None, &["rev-parse", "HEAD"]).1, dry_run)?;
    if bump_arg != "none" {
        if dry_run {
            println!("[dry-run] set [workspace.package] version = \"{version}\"");
        } else {
            std::fs::write(&cargo_toml_path, set_workspace_version(&cargo_toml, &version)?)
                .map_err(|e| e.to_string())?;
        }
        run("cargo", &["update", "--workspace"], dry_run)?; // Cargo.lock records each crate's version.
    }
    run("git-cliff", &["--config", ".cliff.toml", "--tag", &tag, "-o", "CHANGELOG.md"], dry_run)?;
    run("git", &["add", "Cargo.toml", "Cargo.lock", "CHANGELOG.md"], dry_run)?;
    run("git", &["commit", "-m", &format!("chore(release): {tag}")], dry_run)?;
    run("git", &["tag", &tag], dry_run)?;
    // Atomic: a release commit without its tag would never publish.
    let branch = format!("HEAD:refs/heads/{RELEASE_BRANCH}");
    run("git", &["push", "--atomic", &remote, &branch, &format!("refs/tags/{tag}")], dry_run)?;
    if dry_run {
        println!("Dry run complete: would release {tag}. No repository files were changed.");
    } else {
        println!("Release complete: {tag}\nnpm and the GitHub release are published by the tag's workflow.");
    }
    Ok(())
}

/// The `## [tag]` section of a git-cliff changelog, without the trailers below the last one.
pub fn release_notes(changelog: &str, tag: &str) -> Result<String> {
    let lines: Vec<&str> = changelog.lines().collect();
    let heading = format!("## [{tag}]");
    let start = lines
        .iter()
        .position(|l| l.starts_with(&heading))
        .ok_or_else(|| format!("Could not find a {tag} section in the changelog."))?;
    let boundary = |l: &&str| l.starts_with("## ") || l.starts_with("<!--") || is_link_definition(l);
    let end = lines[start + 1..].iter().position(boundary).map_or(lines.len(), |i| start + 1 + i);
    let notes = lines[start + 1..end].join("\n");
    let notes = notes.trim();
    if notes.is_empty() {
        return Err(format!("The {tag} changelog section is empty."));
    }
    Ok(format!("{notes}\n"))
}

/// `[label]: ` as git-cliff writes reference links.
fn is_link_definition(line: &str) -> bool {
    line.strip_prefix('[')
        .and_then(|rest| rest.split_once("]:"))
        .is_some_and(|(label, after)| !label.is_empty() && !label.contains(']') && after.starts_with([' ', '\t']))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_only_for_runs_this_release_started() {
        let runs = r#"[{"databaseId":1,"createdAt":"2026-11-08T10:00:00Z"},
            {"databaseId":3,"createdAt":"2026-11-08T12:00:05Z"},{"databaseId":2,"createdAt":"2026-11-08T12:00:01Z"}]"#;
        assert_eq!(run_started_since(runs, "2026-11-08T12:00:00Z"), Some(3));
        assert_eq!(run_started_since(runs, "2026-11-08T13:00:00Z"), None);
        assert_eq!(run_started_since("not json", "2026-11-08T12:00:00Z"), None);
    }

    #[test]
    fn bumps_like_npm() {
        for (current, kind, expected) in [
            ("1.2.3", "patch", "1.2.4"),
            ("1.2.3", "preminor", "1.3.0-0"),
            ("1.2.3-beta.2", "prerelease", "1.2.3-beta.3"),
            ("1.2.3", "none", "1.2.3"),
            ("4.2.0", "5.0.0-beta.1", "5.0.0-beta.1"),
            ("4.2.0", "major", "5.0.0"),
            ("5.0.0-beta.3", "major", "5.0.0"),
        ] {
            assert_eq!(bump(current, kind).unwrap(), expected, "{current} {kind}");
        }
        assert!(bump("1.2.3", "sideways").is_err());
    }

    #[test]
    fn reads_and_writes_only_the_workspace_version() {
        let toml = "[package]\nversion = \"9\"\n\n[workspace.package]\nedition = \"2024\"\nversion = \"4.2.0\"\n\n[x]\nversion = \"1\"\n";
        assert_eq!(workspace_version(toml).unwrap(), "4.2.0");
        assert_eq!(workspace_version(&set_workspace_version(toml, "5.0.0").unwrap()).unwrap(), "5.0.0");
        assert!(set_workspace_version(toml, "5.0.0").unwrap().contains("[package]\nversion = \"9\""));
        assert!(workspace_version(&std::fs::read_to_string(root().join("Cargo.toml")).unwrap()).is_ok());
    }

    #[test]
    fn extracts_one_release_section() {
        for (heading, previous) in [
            ("## [v2.0.0] - 2026-07-24", "## [v1.9.0] - 2026-07-01"),
            ("## [v2.0.0](https://example.com/c) - 2026-07-24", "## [v1.9.0](https://example.com/c) - 2026-07-01"),
        ] {
            let log = format!(
                "# Changelog\n\n{heading}\n\n### Features\n\n- Add release publishing\n\n{previous}\n\n- Older\n"
            );
            assert_eq!(release_notes(&log, "v2.0.0").unwrap(), "### Features\n\n- Add release publishing\n");
        }
        let trailers = "# Changelog\n## [v1.0.0] - 2026-01-01\n### Features\n- First release\n<!-- generated by git-cliff -->\n[v1.0.0]: https://example.com/releases/tag/v1.0.0\n";
        assert_eq!(release_notes(trailers, "v1.0.0").unwrap(), "### Features\n- First release\n");
        assert!(
            release_notes("## [v2.0.0-beta.1]\n### Bug Fixes\n- Fix the preview\n", "v2.0.0-beta.1")
                .unwrap()
                .contains("Fix the preview")
        );
        let missing = release_notes("# Changelog\n\n## [v2.0.0] - 2026-07-24\n\n- Done\n", "v3.0.0").unwrap_err();
        assert!(missing.contains("Could not find a v3.0.0 section"));
        let empty =
            release_notes("## [v2.0.0] - 2026-07-24\n\n## [v1.0.0] - 2026-01-01\n\n- Old\n", "v2.0.0").unwrap_err();
        assert!(empty.contains("v2.0.0 changelog section is empty"));
    }

    mod checkout {
        use super::*;

        fn sh(cwd: &Path, args: &[&str]) {
            let ok = Command::new("git")
                .args(["-c", "user.name=test", "-c", "user.email=test@example.invalid"])
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        }

        fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
            let dir = tempfile::tempdir().unwrap();
            sh(dir.path(), &["init", "--quiet", "--bare", "--initial-branch=main", "remote.git"]);
            sh(dir.path(), &["init", "--quiet", "--initial-branch=main", "checkout"]);
            let checkout = dir.path().join("checkout");
            sh(&checkout, &["remote", "add", "origin", dir.path().join("remote.git").to_str().unwrap()]);
            sh(&checkout, &["commit", "--quiet", "--allow-empty", "-m", "first"]);
            sh(&checkout, &["push", "--quiet", "--set-upstream", "origin", "main"]);
            (dir, checkout)
        }

        fn problems(checkout: &Path) -> Vec<String> {
            release_problems("v1.2.3", "origin", Some(checkout))
        }

        #[test]
        fn passes_a_clean_main_in_sync_with_its_remote() {
            let (_dir, checkout) = setup();
            assert_eq!(problems(&checkout), Vec::<String>::new());
            assert_eq!(push_remote(false, Some(&checkout)).unwrap(), "origin");
        }

        #[test]
        fn rejects_another_branch_a_dirty_tree_and_drift() {
            let (_dir, checkout) = setup();
            sh(&checkout, &["switch", "--quiet", "--create", "feature"]);
            assert_eq!(problems(&checkout), ["v1.2.3 is cut from main, but this is feature."]);
            sh(&checkout, &["switch", "--quiet", "main"]);
            std::fs::write(checkout.join("file"), "x").unwrap();
            assert_eq!(
                problems(&checkout),
                ["Working tree is not clean. Commit or stash your changes before releasing."]
            );
            std::fs::remove_file(checkout.join("file")).unwrap();
            sh(&checkout, &["commit", "--quiet", "--allow-empty", "-m", "unpushed"]);
            assert_eq!(problems(&checkout), ["HEAD is not in sync with origin/main."]);
            sh(&checkout, &["push", "--quiet"]);
            sh(&checkout, &["reset", "--quiet", "--hard", "HEAD~1"]);
            assert_eq!(problems(&checkout), ["HEAD is not in sync with origin/main."]);
        }

        #[test]
        fn rejects_a_tag_that_exists_locally_or_only_on_the_remote() {
            let (_dir, checkout) = setup();
            sh(&checkout, &["tag", "v1.2.3"]);
            assert_eq!(problems(&checkout), ["Tag v1.2.3 already exists locally."]);
            sh(&checkout, &["push", "--quiet", "origin", "v1.2.3"]);
            sh(&checkout, &["tag", "--delete", "v1.2.3"]);
            assert_eq!(problems(&checkout), ["Tag v1.2.3 already exists on origin."]);
        }
    }
}
