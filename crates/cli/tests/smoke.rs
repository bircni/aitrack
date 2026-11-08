use assert_cmd::Command;
use serde_json::Value;

/// `aitrack` in an empty home, with nothing from the developer's machine.
fn aitrack(home: &std::path::Path) -> Command {
    let mut command = Command::cargo_bin("aitrack").unwrap();
    command.env_clear().env("HOME", home).env("PATH", std::env::var_os("PATH").unwrap()).env("NO_COLOR", "1");
    command.env("CURSOR_STATE_DB_PATH", home.join("none.vscdb")).env("AITRACK_NO_PRICING_REFRESH", "1");
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
