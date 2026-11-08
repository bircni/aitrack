use assert_cmd::Command;

#[test]
fn prints_the_workspace_version() {
    let output = Command::cargo_bin("aitrack").unwrap().arg("--version").assert().success();
    let stdout = String::from_utf8(output.get_output().stdout.clone()).unwrap();
    assert_eq!(stdout.trim(), concat!("aitrack ", env!("CARGO_PKG_VERSION")));
}
