use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Duration;

use aitrack_core::Core;
use aitrack_core::config::{ConfigLoad, read_config, resolve_machine_id};
use aitrack_core::data::duplicate_machines::find_duplicate_machine_days;
use aitrack_core::data::messages::INIT_HINT;
use aitrack_core::git::remote::{differing_origin, origin_mismatch_message, redact_url};
use aitrack_core::git::{GitError, is_cloned};
use aitrack_core::readers::cursor::auth_state::read_cursor_auth_state;
use aitrack_core::readers::cursor::location::cursor_state_database_path;
use aitrack_core::readers::paths::list_jsonl_files;
use aitrack_core::readers::read::{claude_roots, codex_roots, copilot_roots};
use aitrack_core::store::machine_files::{list_data_files, read_data_file};
use aitrack_core::store::validate::ValidationOptions;
use clap::Args;
use serde::Serialize;
use serde_json::json;

use crate::json::print_json_command;
use aitrack_core::display::style;

const GIT_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Args)]
pub struct DoctorArgs {
    /// run the pricing drift script from a source checkout
    #[arg(long)]
    pub pricing_check: bool,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Ok,
    Warn,
    Fail,
}

#[derive(Serialize)]
struct Check {
    status: Status,
    label: String,
    detail: String,
}

fn check(status: Status, label: &str, detail: impl Into<String>) -> Check {
    Check { status, label: label.to_owned(), detail: detail.into() }
}

/// Padded on the plain text, so every row's label starts in one column.
fn status_label(status: Status) -> String {
    match status {
        Status::Ok => style::green("OK  "),
        Status::Warn => style::yellow("WARN"),
        Status::Fail => style::red("FAIL"),
    }
}

fn joined(paths: &[PathBuf]) -> String {
    paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
}

fn source_check(label: &str, roots: &[PathBuf]) -> Check {
    let existing: Vec<PathBuf> = roots.iter().filter(|r| r.exists()).cloned().collect();
    let mut files = 0;
    for root in &existing {
        match list_jsonl_files(root) {
            Ok(found) => files += found.len(),
            Err(error) => return check(Status::Warn, label, error.to_string()), // One bad row, not a crashed doctor.
        }
    }
    if files > 0 {
        check(Status::Ok, label, format!("{files} JSONL file(s) across {} existing path(s)", existing.len()))
    } else if !existing.is_empty() {
        check(Status::Warn, label, format!("paths exist but no JSONL files were found: {}", joined(&existing)))
    } else {
        check(Status::Warn, label, format!("no source paths found; checked {}", joined(roots)))
    }
}

fn cursor_check(core: &Core) -> Check {
    let label = "Cursor source";
    let Some(db) = cursor_state_database_path(&core.env) else {
        return check(Status::Warn, label, "state.vscdb not found; Cursor usage will be skipped unless configured");
    };
    match read_cursor_auth_state(&db) {
        Ok(auth) if auth.access_token.is_some() => {
            check(Status::Ok, label, format!("auth token found in {}", db.display()))
        }
        Ok(_) => {
            check(Status::Warn, label, format!("state DB found but no access token was present: {}", db.display()))
        }
        Err(error) => check(Status::Warn, label, error),
    }
}

fn pricing_cache_check(core: &Core) -> Check {
    let result = core.pricing().refresh_if_due(core.http.as_ref(), &core.env, core.clock.now(), false);
    let pricing = core.pricing().current();
    let supplement = &pricing.supplement;
    check(
        if result.failed || result.unverified { Status::Warn } else { Status::Ok },
        "Pricing cache",
        format!(
            "{} Claude, {} Codex, {} Cursor — {} (updatedAt {}){}",
            supplement.claude.models.len(),
            supplement.codex.current.len() + supplement.codex.historical.len(),
            supplement.cursor.models.len(),
            result.reason,
            result.updated_at,
            if result.unverified { "; pack has no checksums, content not verified" } else { "" }
        ),
    )
}

/// The aitrack repo is what carries the check.
fn is_aitrack_checkout(directory: &Path) -> bool {
    directory.join("crates/xtask/Cargo.toml").is_file()
}

/// Exit status and output, stderr first.
fn run_command(program: &str, args: &[&str], cwd: Option<&Path>) -> (bool, String) {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    match command.output() {
        Ok(out) => {
            let parts: Vec<String> = [&out.stderr, &out.stdout]
                .iter()
                .map(|b| String::from_utf8_lossy(b).trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect();
            (out.status.success(), parts.join("\n"))
        }
        Err(_) => (false, String::new()),
    }
}

fn pricing_drift_check() -> Check {
    let label = "Pricing drift";
    let cwd = std::env::current_dir().unwrap_or_default();
    // The check exists only in a source checkout; elsewhere cargo would fail confusingly.
    if !is_aitrack_checkout(&cwd) {
        return check(
            Status::Warn,
            label,
            "not an aitrack source checkout; run doctor --pricing-check from the aitrack repo root",
        );
    }
    match run_command("cargo", &["xtask", "pricing-check"], Some(&cwd)) {
        (true, _) => check(Status::Ok, label, "cargo xtask pricing-check passed"),
        (false, output) if !output.is_empty() => {
            check(Status::Warn, label, format!("cargo xtask pricing-check failed: {output}"))
        }
        _ => check(
            Status::Warn,
            label,
            "cargo xtask pricing-check did not pass; run from the aitrack repo root and inspect its output",
        ),
    }
}

fn duplicate_machine_check(core: &Core) -> Check {
    let label = "Machine identities";
    let mut unreadable = Vec::new();
    let mut machines = Vec::new();
    for path in list_data_files(core) {
        match read_data_file(core, &path, ValidationOptions::default()) {
            Some(machine) => machines.push(machine),
            None => unreadable.push(path.file_name().unwrap_or_default().to_string_lossy().into_owned()),
        }
    }
    if !unreadable.is_empty() {
        return check(
            Status::Warn,
            label,
            format!("skipped unreadable machine file(s), left out of every report: {}", unreadable.join(", ")),
        );
    }
    let duplicates = find_duplicate_machine_days(&machines);
    if duplicates.days.is_empty() {
        return check(Status::Ok, label, format!("{} machine(s), no duplicated days", machines.len()));
    }
    check(
        Status::Warn,
        label,
        format!(
            "{} day(s) are recorded identically under multiple machines ({}) — totals are inflated. These are likely one machine synced under several ids; merge them into one data file.",
            duplicates.days.len(),
            duplicates.machines.join(", ")
        ),
    )
}

fn config_check(loaded: &ConfigLoad) -> Check {
    match loaded {
        ConfigLoad::Ok(config) => {
            let repo = redact_url(&config.repo_url);
            let machine = resolve_machine_id(Some(config)).unwrap_or_else(str::to_owned);
            let repo = if repo.is_empty() { "(empty)".to_owned() } else { repo };
            check(Status::Ok, "Config", format!("repoUrl={repo}, machineId={machine}"))
        }
        ConfigLoad::Invalid { reason } => {
            check(Status::Fail, "Config", format!("config file is {reason}; fix it or re-run {INIT_HINT}"))
        }
        ConfigLoad::Missing => check(Status::Warn, "Config", format!("no config found; run {INIT_HINT} for sync")),
    }
}

/// `git` errors carry the command; these details name it in their own words.
fn git_check(
    core: &Core,
    label: &str,
    args: &[&str],
    fail: Status,
    ok: &str,
    failed: impl Fn(&str) -> String,
) -> Check {
    match core.git().with_timeout(Some(GIT_CHECK_TIMEOUT)).run(args) {
        Ok(_) => check(Status::Ok, label, ok),
        Err(GitError::Command { output, .. }) => check(fail, label, failed(&output)),
        Err(error) => check(fail, label, failed(&error.to_string())),
    }
}

fn collect_checks(core: &Core, args: &DoctorArgs) -> Vec<Check> {
    let loaded = read_config(&core.paths.config);
    let mut checks = Vec::new();
    // Not the repo's git runner: the clone may not exist yet.
    let has_git = run_command("git", &["--version"], None).0;
    checks.push(check(
        if has_git { Status::Ok } else { Status::Fail },
        "git",
        if has_git { "available on PATH" } else { "not available on PATH" },
    ));
    checks.push(config_check(&loaded));
    let cloned = is_cloned(core);
    let repo = core.paths.repo.display().to_string();
    checks.push(if cloned {
        check(Status::Ok, "Local repo", repo.clone())
    } else {
        check(Status::Warn, "Local repo", "not cloned; local preview still works")
    });
    if cloned {
        checks.push(duplicate_machine_check(core));
        if let ConfigLoad::Ok(config) = &loaded
            && let Some(origin) = differing_origin(core, &core.git(), &config.repo_url)
        {
            checks.push(check(Status::Warn, "Remote", origin_mismatch_message(&origin, &config.repo_url)));
        }
        if core.git().is_rebase_in_progress() {
            checks.push(check(
                Status::Warn,
                "Rebase",
                format!("an interrupted rebase is in progress in {repo}; the next sync aborts it"),
            ));
        }
    }
    // Independent, so a slow network costs its longest wait rather than the sum.
    let (repo_checks, provider_checks, pricing) = std::thread::scope(|scope| {
        let repo_checks = scope.spawn(|| {
            if !cloned {
                return Vec::new();
            }
            vec![
                git_check(core, "Repo health", &["status", "--short"], Status::Fail, "git status succeeded", |o| {
                    if o.is_empty() {
                        "git status failed in local repo".to_owned()
                    } else {
                        format!("git status failed: {o}")
                    }
                }),
                git_check(
                    core,
                    "Remote push",
                    &["push", "--dry-run"],
                    Status::Warn,
                    "git push --dry-run succeeded",
                    |o| {
                        if o.is_empty() {
                            "git push --dry-run failed; check remote access and branch tracking".to_owned()
                        } else {
                            format!("git push --dry-run failed: {o}")
                        }
                    },
                ),
            ]
        });
        let providers = scope.spawn(|| {
            vec![
                source_check("Claude Code source", &claude_roots(core)),
                source_check("Codex source", &codex_roots(core)),
                source_check("GitHub Copilot source", &copilot_roots(core)),
                cursor_check(core),
            ]
        });
        let pricing = pricing_cache_check(core);
        (repo_checks.join().unwrap_or_default(), providers.join().unwrap_or_default(), pricing)
    });
    checks.extend(repo_checks);
    checks.extend(provider_checks);
    checks.push(pricing);
    if args.pricing_check {
        checks.push(pricing_drift_check());
    }
    checks
}

pub fn run(core: &Core, args: &DoctorArgs) -> ExitCode {
    let checks = collect_checks(core, args);
    let has_failures = checks.iter().any(|c| c.status == Status::Fail);
    if args.json {
        print_json_command("doctor", json!({ "checks": checks, "hasFailures": has_failures }));
    } else {
        core.output.info(&style::bold("aitrack doctor"));
        for c in &checks {
            core.output.info(&format!("{}  {}: {}", status_label(c.status), c.label, c.detail));
        }
    }
    if has_failures { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
