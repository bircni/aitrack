//! `cargo xtask smoke-bundle`: unpacks each installer the release builds and starts the app inside it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::{Result, root};

fn only_match(directory: &Path, matches: impl Fn(&str) -> bool) -> Result<PathBuf> {
    let found = find(directory, &matches);
    match found.as_slice() {
        [one] => Ok(one.clone()),
        _ => Err(format!("Expected exactly one match in {}, found {}", directory.display(), found.len())),
    }
}

fn find(directory: &Path, matches: &impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else { return Vec::new() };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let relative = path.to_string_lossy().replace('\\', "/");
        if matches(&relative) {
            found.push(path.clone());
        }
        if entry.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) {
            found.extend(find(&path, matches));
        }
    }
    found
}

fn run(program: &str, args: &[&str], cwd: &Path) -> Result<()> {
    let output = Command::new(program).args(args).current_dir(cwd).output().map_err(|e| format!("{program}: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("{program} failed: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

/// The app binaries inside each installer for this OS, plus cleanup for anything mounted.
fn extract_apps(bundle: &Path, version: &str, temporary: &Path) -> Result<(Vec<PathBuf>, Option<PathBuf>)> {
    if cfg!(target_os = "macos") {
        let dmg_name = format!("opentrack_{version}_aarch64.dmg");
        let dmg = only_match(&bundle.join("dmg"), |p| p.ends_with(&format!("/{dmg_name}")))?;
        let mount = temporary.join("volume");
        std::fs::create_dir(&mount).map_err(|e| e.to_string())?;
        let mount_arg = mount.to_string_lossy().into_owned();
        run(
            "hdiutil",
            &["attach", &dmg.to_string_lossy(), "-readonly", "-nobrowse", "-mountpoint", &mount_arg],
            temporary,
        )?;
        let app = only_match(&mount, |p| p.ends_with(".app/Contents/MacOS/opentrack"));
        return app.map(|a| (vec![a], Some(mount)));
    }
    if cfg!(target_os = "linux") {
        let deb = only_match(&bundle.join("deb"), |p| p.ends_with(&format!("/opentrack_{version}_amd64.deb")))?;
        let deb_root = temporary.join("deb");
        run("dpkg-deb", &["-x", &deb.to_string_lossy(), &deb_root.to_string_lossy()], temporary)?;
        let image =
            only_match(&bundle.join("appimage"), |p| p.ends_with(&format!("/opentrack_{version}_amd64.AppImage")))?;
        // Runs only the AppImage runtime, which unpacks to ./squashfs-root without FUSE.
        run(&image.to_string_lossy(), &["--appimage-extract"], temporary)?;
        let from_deb = only_match(&deb_root, |p| p.ends_with("/usr/bin/opentrack"))?;
        let from_image = only_match(&temporary.join("squashfs-root"), |p| p.ends_with("/usr/bin/opentrack"))?;
        return Ok((vec![from_deb, from_image], None));
    }
    let installer = only_match(&bundle.join("nsis"), |p| p.ends_with(&format!("/opentrack_{version}_x64-setup.exe")))?;
    let extracted = temporary.join("installer");
    // Unpacks the installer without registering or launching an installed app.
    run("7z", &["x", &installer.to_string_lossy(), &format!("-o{}", extracted.display()), "-y"], temporary)?;
    Ok((vec![only_match(&extracted, |p| p.ends_with("/opentrack.exe"))?], None))
}

/// Starts the packaged app in its smoke-test mode, which answers before any window or tray exists.
fn check_app(program: &Path, data_dir: &Path) -> Result<()> {
    std::fs::create_dir(data_dir).map_err(|e| e.to_string())?;
    let settings = data_dir.join("settings.json");
    std::fs::write(&settings, r#"{"theme":"dark"}"#).map_err(|e| e.to_string())?;
    let mut child = Command::new(program)
        .args(["--smoke-test", "--data-dir"])
        .arg(data_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", program.display()))?;
    let started = Instant::now();
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if started.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            return Err(format!("{} did not answer within 15 s", program.display()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("Packaged app failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let lines: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .map(serde_json::from_str)
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let [settings_line, state] = lines.as_slice() else {
        return Err("Expected the settings and the state".into());
    };
    let ok = settings_line["id"] == 1
        && settings_line["result"]["theme"] == "dark"
        && state["id"] == 2
        && state["result"]["providers"].as_array().is_some_and(|p| p.len() == 3)
        && state["result"]["refreshing"] == false;
    if !ok {
        return Err(format!("Unexpected smoke-test answer: {lines:?}"));
    }
    let after: Value = serde_json::from_str(&std::fs::read_to_string(&settings).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if after != serde_json::json!({ "theme": "dark" }) {
        return Err("The smoke test changed settings.json".into());
    }
    Ok(())
}

pub fn smoke_bundle(version: &str) -> Result<()> {
    let bundle = root().join("target/release/bundle");
    let temporary = tempfile::tempdir().map_err(|e| e.to_string())?;
    let (apps, mounted) = extract_apps(&bundle, version, temporary.path())?;
    let result = apps
        .iter()
        .enumerate()
        .try_for_each(|(index, app)| check_app(app, &temporary.path().join(format!("data-{index}"))));
    if let Some(mount) = mounted {
        let _ = run("hdiutil", &["detach", &mount.to_string_lossy()], temporary.path());
    }
    result.map(|()| println!("Packaged app started, read isolated settings and reported its state."))
}
