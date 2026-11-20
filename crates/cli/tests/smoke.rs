#![expect(clippy::unwrap_used, reason = "fixture helpers: a broken fixture should fail the test outright")]
use assert_cmd::Command;
use serde_json::Value;

/// `aitrack` in an empty home, with nothing from the developer's machine.
fn aitrack(home: &std::path::Path) -> Command {
    let mut command = Command::cargo_bin("aitrack").unwrap();
    command.env_clear().env("HOME", home).env("USERPROFILE", home).env("NO_COLOR", "1");
    for kept in ["PATH", "SystemRoot"] {
        if let Some(value) = std::env::var_os(kept) {
            command.env(kept, value);
        }
    }
    command.env("AITRACK_NO_PRICING_REFRESH", "1");
    command.current_dir(home);
    command
}

fn stdout(output: &std::process::Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[test]
fn prints_the_bare_workspace_version() {
    let home = tempfile::tempdir().unwrap();
    let output = aitrack(home.path()).arg("--version").output().unwrap();
    assert_eq!(stdout(&output), concat!(env!("CARGO_PKG_VERSION"), "\n"));
}

#[test]
fn json_failures_print_one_document_and_usage_errors_exit_2() {
    let home = tempfile::tempdir().unwrap();
    for (args, command, code) in [
        (&["nosuch", "--json"][..], "aitrack", 2),
        (&["top", "--sort", "nope", "--json"][..], "top", 2),
        (&["config", "get", "nope", "--json"][..], "config", 2),
    ] {
        let output = aitrack(home.path()).args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(code), "{args:?}");
        let document: Value = serde_json::from_str(&stdout(&output)).unwrap();
        assert_eq!(document["command"], command, "{args:?}");
        assert!(document["error"].as_str().is_some_and(|e| !e.is_empty()), "{args:?}");
    }
    let removed = aitrack(home.path()).args(["show", "--providers", "claude,cursor"]).output().unwrap();
    assert_eq!(removed.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&removed.stderr).contains("Cursor support was removed."));
}

#[test]
fn config_set_writes_what_get_and_list_read_back() {
    let home = tempfile::tempdir().unwrap();
    let set = aitrack(home.path()).args(["config", "set", "budget.monthly", "149.99"]).output().unwrap();
    assert_eq!(stdout(&set), "Set budget.monthly = 149.99\n");
    let saved = std::fs::read_to_string(home.path().join(".config/aitrack/config.json")).unwrap();
    assert_eq!(saved, "{\n  \"repoUrl\": \"\",\n  \"budget\": {\n    \"monthlyUSD\": 149.99\n  }\n}");
    let get = aitrack(home.path()).args(["config", "get", "budget.monthly", "--json"]).output().unwrap();
    assert_eq!(
        stdout(&get),
        "{\n  \"command\": \"config\",\n  \"action\": \"get\",\n  \"key\": \"budget.monthly\",\n  \"value\": 149.99\n}\n"
    );
    let bad = aitrack(home.path()).args(["config", "set", "compactAfterDays", "0"]).output().unwrap();
    assert_eq!(bad.status.code(), Some(2));
}

#[test]
fn reports_read_local_logs_without_a_data_repo() {
    let home = tempfile::tempdir().unwrap();
    let corpus = concat!(env!("CARGO_MANIFEST_DIR"), "/../core/tests/fixtures/readers/corpus/claude/fixture");
    let projects = home.path().join(".claude/projects/fixture");
    std::fs::create_dir_all(&projects).unwrap();
    for entry in std::fs::read_dir(corpus).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), projects.join(entry.file_name())).unwrap();
    }
    let csv = home.path().join("out.csv");
    for (args, command) in [
        (&["usage", "all"][..], "usage"),
        (&["top", "models"][..], "top"),
        (&["show", "--tui"][..], "show"),
        (&["export", "all", "--csv", "-o", csv.to_str().unwrap()][..], "export"),
    ] {
        let output = aitrack(home.path()).args(args).args(["--providers", "claude", "--json"]).output().unwrap();
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        let document: Value = serde_json::from_str(&stdout(&output)).unwrap();
        assert_eq!(document["command"], command, "{args:?}");
    }
    assert!(std::fs::read_to_string(csv).unwrap().lines().count() > 1);
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let identity = ["-c", "user.name=Test", "-c", "user.email="];
    let out = std::process::Command::new("git").args(identity).args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn first_init_leaves_a_synced_file_named_like_this_host_alone() {
    let root = tempfile::tempdir().unwrap();
    let (remote, seed, home) = (root.path().join("remote.git"), root.path().join("seed"), root.path().join("home"));
    for dir in [&remote, &seed, &home] {
        std::fs::create_dir_all(dir).unwrap();
    }
    git(&remote, &["init", "--bare", "-q", "-b", "main"]);
    git(&seed, &["init", "-q", "-b", "main"]);
    let host = aitrack_core::config::resolve_machine_id(None).unwrap();
    let theirs = format!(r#"{{"hostname":"{host}","lastUpdated":"2026-03-10T12:00:00.000Z","days":{{}}}}"#);
    std::fs::create_dir_all(seed.join("data")).unwrap();
    std::fs::write(seed.join("data").join(format!("{host}.json")), &theirs).unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "sync"]);
    git(&seed, &["push", "-q", remote.to_str().unwrap(), "main"]);

    let init = aitrack(&home).args(["init", "--repo", remote.to_str().unwrap(), "--machine", "laptop"]).output();
    assert_eq!(init.unwrap().status.code(), Some(0));
    let data = home.join(".config/aitrack/repo/data");
    assert_eq!(std::fs::read_to_string(data.join(format!("{host}.json"))).unwrap(), theirs);
    assert!(!data.join("laptop.json").exists());
}
