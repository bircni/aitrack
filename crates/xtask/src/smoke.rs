//! `cargo xtask smoke-bundle`: unpacks each installer the release builds and starts the app inside it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::artifacts::Installer;
use crate::{Result, cmd, io, root};

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

fn installer(bundle: &Path, kind: Installer, version: &str) -> Result<PathBuf> {
    let name = format!("/{}", kind.file_name(version));
    only_match(&bundle.join(kind.dir()), |p| p.ends_with(&name))
}

/// The app binaries inside each installer for this OS, plus cleanup for anything mounted.
fn extract_apps(bundle: &Path, version: &str, temporary: &Path) -> Result<(Vec<PathBuf>, Option<PathBuf>)> {
    if cfg!(target_os = "macos") {
        let dmg = installer(bundle, Installer::Dmg, version)?;
        let mount = temporary.join("volume");
        std::fs::create_dir_all(&mount).map_err(io(&mount))?;
        let mount_arg = mount.to_string_lossy().into_owned();
        cmd(
            "hdiutil",
            &["attach", &dmg.to_string_lossy(), "-readonly", "-nobrowse", "-mountpoint", &mount_arg],
            Some(temporary),
        )?;
        let app = only_match(&mount, |p| p.ends_with(".app/Contents/MacOS/opentrack"));
        return app.map(|a| (vec![a], Some(mount)));
    }
    if cfg!(target_os = "linux") {
        let deb = installer(bundle, Installer::Deb, version)?;
        let deb_root = temporary.join("deb");
        cmd("dpkg-deb", &["-x", &deb.to_string_lossy(), &deb_root.to_string_lossy()], Some(temporary))?;
        let image = installer(bundle, Installer::AppImage, version)?;
        // Runs only the AppImage runtime, which unpacks to ./squashfs-root without FUSE.
        cmd(&image.to_string_lossy(), &["--appimage-extract"], Some(temporary))?;
        let from_deb = only_match(&deb_root, |p| p.ends_with("/usr/bin/opentrack"))?;
        let from_image = only_match(&temporary.join("squashfs-root"), |p| p.ends_with("/usr/bin/opentrack"))?;
        return Ok((vec![from_deb, from_image], None));
    }
    let setup = installer(bundle, Installer::Nsis, version)?;
    let extracted = temporary.join("installer");
    // Unpacks the installer without registering or launching an installed app.
    cmd("7z", &["x", &setup.to_string_lossy(), &format!("-o{}", extracted.display()), "-y"], Some(temporary))?;
    Ok((vec![only_match(&extracted, |p| p.ends_with("/opentrack.exe"))?], None))
}

/// Starts the packaged app in its smoke-test mode, which answers before any window or tray exists.
fn check_app(program: &Path, data_dir: &Path) -> Result<()> {
    std::fs::create_dir_all(data_dir).map_err(io(data_dir))?;
    let settings = data_dir.join("settings.json");
    std::fs::write(&settings, r#"{"theme":"dark"}"#).map_err(io(&settings))?;
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
    let answer = String::from_utf8_lossy(&output.stdout);
    let started: Value =
        serde_json::from_str(answer.trim()).map_err(|e| format!("The smoke test did not answer in JSON: {e}"))?;
    let ok = started["settings"]["theme"] == "dark"
        && started["state"]["providers"].as_array().is_some_and(|p| p.len() == 3)
        && started["state"]["refreshing"] == false;
    if !ok {
        return Err(format!("Unexpected smoke-test answer: {answer}"));
    }
    let after: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings).map_err(io(&settings))?).map_err(|e| e.to_string())?;
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
        let _ = cmd("hdiutil", &["detach", &mount.to_string_lossy()], Some(temporary.path()));
    }
    result.map(|()| println!("Packaged app started, read isolated settings and reported its state."))
}
