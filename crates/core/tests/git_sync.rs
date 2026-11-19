//! Sync, recompute and renames against real git: a bare remote and machines with their own clones.
#![expect(clippy::unwrap_used, reason = "fixture helpers: a broken fixture should fail the test outright")]

use std::path::{Path, PathBuf};
use std::process::Command;

use aitrack_core::Core;
use aitrack_core::env::Env;
use aitrack_core::output::{Level, VecOutput};
use aitrack_core::recompute::{RecomputeOptions, recompute_costs};
use aitrack_core::store::migrate::migrate_machine_data_files;
use aitrack_core::sync::{SyncOptions, sync_data};
use aitrack_core::time::Clock;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn remote(root: &Path) -> PathBuf {
    let remote = root.join("remote.git");
    std::fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "--bare", "-q", "-b", "main"]);
    remote
}

struct Machine {
    home: PathBuf,
    logs: PathBuf,
    vars: Vec<(String, String)>,
}

impl Machine {
    fn new(root: &Path, name: &str, remote: &Path, extra: &[(&str, &str)]) -> Self {
        let home = root.join(name);
        let logs = home.join("logs");
        std::fs::create_dir_all(logs.join("claude")).unwrap();
        std::fs::create_dir_all(logs.join("codex")).unwrap();
        let app = home.join(".config/aitrack");
        std::fs::create_dir_all(&app).unwrap();
        let mut config = serde_json::json!({"repoUrl": remote.to_string_lossy(), "machineId": name});
        for (key, value) in extra.iter().filter(|(k, _)| !k.starts_with("AITRACK_")) {
            config[*key] = serde_json::from_str(value).unwrap();
        }
        std::fs::write(app.join("config.json"), config.to_string()).unwrap();
        git(&app, &["clone", "-q", &remote.to_string_lossy(), "repo"]);
        let repo = app.join("repo");
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(&repo, &["config", "user.name", "Test"]);
        let mut vars = vec![
            ("AITRACK_CLAUDE_PROJECTS_DIRS".to_owned(), logs.join("claude").to_string_lossy().into_owned()),
            ("AITRACK_CODEX_SESSION_DIRS".to_owned(), logs.join("codex").to_string_lossy().into_owned()),
            ("AITRACK_NO_PRICING_REFRESH".to_owned(), "1".to_owned()),
            ("AITRACK_NO_CACHE".to_owned(), "1".to_owned()),
        ];
        vars.extend(
            extra.iter().filter(|(k, _)| k.starts_with("AITRACK_")).map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        );
        Self { home, logs, vars }
    }

    fn log_day(&self, file: &str, day: &str, id: &str, tokens: u64) {
        let path = self.logs.join("claude").join(file);
        let line = serde_json::json!({
            "type": "assistant", "timestamp": format!("{day}T10:00:00Z"), "requestId": id,
            "message": {"id": id, "model": "claude-opus-4-1", "usage": {"input_tokens": tokens, "output_tokens": 7}}
        });
        let mut text = std::fs::read_to_string(&path).unwrap_or_default();
        text.push_str(&line.to_string());
        text.push('\n');
        std::fs::write(path, text).unwrap();
    }

    fn log_codex_day(&self, day: &str, tokens: u64) {
        let lines = [
            serde_json::json!({"timestamp": format!("{day}T09:00:00Z"), "type": "turn_context", "payload": {"model": "gpt-5"}}),
            serde_json::json!({
                "timestamp": format!("{day}T09:00:05Z"), "type": "event_msg",
                "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": tokens, "output_tokens": 3}}}
            }),
        ];
        std::fs::write(self.logs.join("codex").join(format!("{day}.jsonl")), lines.map(|l| format!("{l}\n")).concat())
            .unwrap();
    }

    fn core(&self) -> (Core, std::sync::Arc<VecOutput>) {
        self.core_at("2026-03-10T12:00:00Z")
    }

    fn core_at(&self, now: &str) -> (Core, std::sync::Arc<VecOutput>) {
        self.core_in(now, "UTC")
    }

    fn core_in(&self, now: &str, zone: &str) -> (Core, std::sync::Arc<VecOutput>) {
        let output = std::sync::Arc::new(VecOutput::default());
        let clock = Clock::fixed(now.parse().unwrap(), zone).unwrap();
        let core =
            Core::new(Env::new(&self.home, self.vars.clone()), clock, Box::new(Shared(std::sync::Arc::clone(&output))));
        (core, output)
    }

    fn repo(&self) -> PathBuf {
        self.home.join(".config/aitrack/repo")
    }

    fn file(&self, name: &str) -> String {
        std::fs::read_to_string(self.repo().join("data").join(name)).unwrap()
    }
}

struct Shared(std::sync::Arc<VecOutput>);

impl aitrack_core::output::Output for Shared {
    fn info(&self, m: &str) {
        self.0.info(m);
    }
    fn warn(&self, m: &str) {
        self.0.warn(m);
    }
    fn error(&self, m: &str) {
        self.0.error(m);
    }
}

#[test]
fn syncs_once_then_finds_nothing_to_push_and_shares_the_repo_with_another_machine() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote(root.path());
    let a = Machine::new(root.path(), "a", &remote, &[]);
    a.log_day("s.jsonl", "2026-03-08", "m1", 100);
    a.log_day("s.jsonl", "2026-03-09", "m2", 50);

    let (core, output) = a.core();
    let dry = sync_data(&core, SyncOptions { dry_run: true, ..SyncOptions::default() }).unwrap();
    assert_eq!(dry.message, "Dry run: would create data/a.json (2 days). No changes written.");
    assert!(!a.repo().join("data/a.json").exists());

    let first = sync_data(&core, SyncOptions::default()).unwrap();
    assert_eq!((first.message.as_str(), first.pushed, first.days), ("Done! Pushed data/a.json (2 days)", true, 2));
    assert_eq!(git(&remote, &["log", "-1", "--format=%s", "main"]), "sync: a at 2026-03-10T12:00:00.000Z");
    assert!(output.messages().contains(&(Level::Info, "Found: Claude Code (2 days)".to_owned())));
    let again = sync_data(&core, SyncOptions { verify: true, ..SyncOptions::default() }).unwrap();
    assert_eq!((again.message.as_str(), again.pushed), ("No changes to push — data is already up to date.", false));

    let b = Machine::new(root.path(), "b", &remote, &[]);
    b.log_day("s.jsonl", "2026-03-09", "x1", 10);
    assert!(sync_data(&b.core().0, SyncOptions::default()).unwrap().pushed);
    assert!(b.repo().join("data/a.json").exists());
    let after = sync_data(&core, SyncOptions::default()).unwrap();
    assert!(!after.pushed);
    assert!(a.repo().join("data/b.json").exists(), "A pulled B's file");
}

#[test]
fn a_sync_limited_to_some_providers_keeps_the_other_providers_synced_days_untouched() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote(root.path());
    let a = Machine::new(root.path(), "a", &remote, &[("compactAfterDays", "30")]);
    a.log_day("s.jsonl", "2026-01-05", "m0", 40);
    a.log_day("s.jsonl", "2026-03-08", "m1", 100);
    a.log_codex_day("2026-03-08", 10);
    let (core, _) = a.core();
    sync_data(&core, SyncOptions::default()).unwrap();
    let days = |m: &Machine| serde_json::from_str::<serde_json::Value>(&m.file("a.json")).unwrap()["days"].clone();
    let stored = days(&a);
    let claude = |days: &serde_json::Value| {
        let of = |day: &str| serde_json::to_string_pretty(&days[day]["claude_code"]).unwrap();
        ["2026-01-05", "2026-03-08", "2026-03-09"].map(of)
    };

    a.log_day("s.jsonl", "2026-03-08", "m2", 900);
    a.log_day("s.jsonl", "2026-03-09", "m3", 5);
    a.log_codex_day("2026-03-09", 20);
    let codex = ["codex".to_owned()];
    let (moved, _) = a.core_in("2026-03-10T12:00:00Z", "Pacific/Kiritimati"); // Claude's logs now fall a day later.
    let only = SyncOptions { providers: Some(&codex), ..SyncOptions::default() };
    let dry = sync_data(&moved, SyncOptions { dry_run: true, ..only }).unwrap();
    assert_eq!(dry.message, "Dry run: would update data/a.json (3 days). No changes written.");
    let limited = sync_data(&moved, only).unwrap();
    assert_eq!((limited.message.as_str(), limited.pushed), ("Done! Pushed data/a.json (3 days)", true));
    let after = days(&a);
    assert_eq!(claude(&after), claude(&stored), "the provider that was not read keeps its days byte for byte");
    assert_eq!(after["2026-03-08"]["codex"], stored["2026-03-08"]["codex"]);
    assert_eq!(after["2026-03-09"]["codex"]["totals"]["inputTokens"], 20);
    assert!(!sync_data(&moved, only).unwrap().pushed, "nothing to push while only the skipped provider's logs grew");

    let none = SyncOptions { providers: Some(&[]), ..SyncOptions::default() };
    assert_eq!(sync_data(&moved, none).unwrap().message, "No provider selected, so no local data was read.");
    assert_eq!(days(&a), after);

    assert!(sync_data(&core, SyncOptions::default()).unwrap().pushed, "an unlimited sync still reads every provider");
    assert_eq!(days(&a)["2026-03-08"]["claude_code"]["totals"]["inputTokens"], 1000);
}

#[test]
fn encrypts_this_machines_file_when_configured() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote(root.path());
    let a =
        Machine::new(root.path(), "a", &remote, &[("encryptData", "true"), ("AITRACK_ENCRYPTION_PASSPHRASE", "pass")]);
    a.log_day("s.jsonl", "2026-03-08", "m1", 100);
    let (core, _) = a.core();
    assert!(sync_data(&core, SyncOptions::default()).unwrap().pushed);
    assert!(a.file("a.json").contains("\"encrypted\": \"aitrack-aes-256-gcm-scrypt-v1\""));
    assert!(!sync_data(&core, SyncOptions::default()).unwrap().pushed, "an unchanged encrypted file is not rewritten");
}

/// Commits a version of this machine's file the remote does not have, as an offline sync would.
fn commit_unpushed(m: &Machine, subject: &str, day: &str) {
    let mut file: serde_json::Value = serde_json::from_str(&m.file("a.json")).unwrap();
    let days = file["days"].as_object_mut().unwrap();
    let template = days.values().next().unwrap().clone();
    days.insert(day.to_owned(), template);
    std::fs::write(m.repo().join("data/a.json"), serde_json::to_string_pretty(&file).unwrap()).unwrap();
    git(&m.repo(), &["commit", "-qam", subject]);
}

#[test]
fn merges_a_diverged_sync_commit_per_day_but_never_a_recompute_commit() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote(root.path());
    let first = Machine::new(root.path(), "first", &remote, &[("machineId", "\"a\"")]);
    first.log_day("s.jsonl", "2026-03-08", "m1", 100);
    sync_data(&first.core().0, SyncOptions::default()).unwrap();

    let second = Machine::new(root.path(), "second", &remote, &[("machineId", "\"a\"")]);
    commit_unpushed(&second, "sync: a at earlier", "2026-03-01");
    first.log_day("s.jsonl", "2026-03-09", "m2", 70);
    sync_data(&first.core().0, SyncOptions::default()).unwrap();

    second.log_day("s.jsonl", "2026-03-08", "m1", 100);
    let merged = sync_data(&second.core().0, SyncOptions::default()).unwrap();
    assert!(merged.pushed, "{merged:?}");
    let file: serde_json::Value = serde_json::from_str(&second.file("a.json")).unwrap();
    let days: Vec<&String> = file["days"].as_object().unwrap().keys().collect();
    assert_eq!(days, ["2026-03-01", "2026-03-08", "2026-03-09"], "both sides' days survive");
    assert_eq!(git(&second.repo(), &["status", "--porcelain"]), "");

    let third = Machine::new(root.path(), "third", &remote, &[("machineId", "\"a\"")]);
    commit_unpushed(&third, "recompute: refresh costs at earlier", "2026-02-01");
    first.log_day("s.jsonl", "2026-03-10", "m3", 30);
    sync_data(&first.core().0, SyncOptions::default()).unwrap();
    third.log_day("s.jsonl", "2026-03-08", "m1", 100);
    let refused = sync_data(&third.core().0, SyncOptions::default()).unwrap_err();
    assert!(
        refused.0.contains("only sync commits merge per day, and this one is \"recompute: refresh costs at earlier\""),
        "{refused}"
    );
    assert!(!third.repo().join(".git/rebase-merge").exists() && !third.repo().join(".git/rebase-apply").exists());
}

#[test]
fn recompute_restores_a_corrupt_file_from_its_last_commit_and_renames_move_files() {
    let root = tempfile::tempdir().unwrap();
    let remote = remote(root.path());
    let a = Machine::new(root.path(), "a", &remote, &[]);
    a.log_day("s.jsonl", "2026-03-08", "m1", 100);
    let (core, _) = a.core();
    sync_data(&core, SyncOptions::default()).unwrap();
    assert_eq!(recompute_costs(&core, RecomputeOptions::default()).unwrap().changed, 0);

    std::fs::write(a.repo().join("data/a.json"), "{ truncated").unwrap();
    let refused = sync_data(&core, SyncOptions::default()).unwrap_err();
    assert!(refused.0.starts_with("Refusing to overwrite invalid data/a.json"), "{refused}");
    let (later, later_output) = a.core_at("2026-03-10T13:00:00Z");
    let repaired = recompute_costs(&later, RecomputeOptions::default()).unwrap();
    assert_eq!((repaired.changed, repaired.pushed), (1, true));
    assert!(later_output.messages().iter().any(|(_, m)| m == "  Restoring a.json from its last commit."));
    assert!(git(&remote, &["log", "-1", "--format=%s", "main"]).starts_with("recompute: refresh costs at "));

    migrate_machine_data_files(&core, "a", "laptop").unwrap();
    assert!(!a.repo().join("data/a.json").exists());
    assert!(a.file("laptop.json").contains("\"hostname\": \"laptop\""));
    assert!(git(&a.repo(), &["status", "--porcelain"]).contains("R  data/a.json -> data/laptop.json"));
    std::fs::write(a.repo().join("data/other.json"), "{}").unwrap();
    assert!(migrate_machine_data_files(&core, "laptop", "other").unwrap_err().0.contains("already exists"));
}

#[test]
fn replays_a_diverged_shared_settings_commit_with_the_newest_file_winning() {
    use aitrack_core::git::{commit_and_push_shared_settings, pull};
    use aitrack_core::store::shared_settings::{read_shared_settings, write_shared_settings};

    let root = tempfile::tempdir().unwrap();
    let remote = remote(root.path());
    let a = Machine::new(root.path(), "a", &remote, &[]);
    let b = Machine::new(root.path(), "b", &remote, &[]);
    let write = |m: &Machine, at: &str, theme: &str| {
        let settings = serde_json::Map::from_iter([("theme".to_owned(), theme.into())]);
        write_shared_settings(&m.core().0, at.parse().unwrap(), &settings, false).unwrap();
    };
    let share = |m: &Machine, at: &str, theme: &str| {
        write(m, at, theme);
        let (core, _) = m.core();
        core.with_repo_lock(|guard| commit_and_push_shared_settings(&core, guard, guard.git())).unwrap();
        assert_eq!(git(&m.repo(), &["status", "--porcelain"]), "");
        assert_eq!(git(&m.repo(), &["rev-list", "--count", "@{upstream}..HEAD"]), "0");
        read_shared_settings(&core).unwrap().unwrap().settings["theme"].clone()
    };
    assert_eq!(share(&a, "2026-03-10T12:00:00Z", "dark"), "dark");
    assert_eq!(share(&b, "2026-03-10T13:00:00Z", "light"), "light", "the newer local commit wins");
    assert_eq!(share(&a, "2026-03-10T11:00:00Z", "system"), "light", "the older local commit loses");
    assert_eq!(git(&remote, &["log", "--format=%s", "main"]).lines().count(), 2);

    write(&a, "2026-03-10T15:00:00Z", "system"); // Left by a run that died before committing.
    assert_eq!(share(&b, "2026-03-10T14:00:00Z", "dark"), "dark");
    let (core, _) = a.core();
    core.with_repo_lock(|guard| pull(&core, guard, guard.git())).unwrap();
    assert_eq!(read_shared_settings(&core).unwrap().unwrap().settings["theme"], "dark");
}
