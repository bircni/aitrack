use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use aitrack_core::Core;
use aitrack_core::http::Request;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use clap::Args;
use minisign_verify::{PublicKey, Signature};
use serde_json::{Value, json};

use crate::json::print_json_command;
use crate::{Failure, Outcome};

/// The manifest opentrack's own updater reads; prereleases never become "latest".
const MANIFEST_URL: &str = "https://github.com/bircni/aitrack/releases/latest/download/latest.json";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_mins(10);
const APP_NAME: &str = "opentrack.app";
const APPIMAGE_NAME: &str = "opentrack.AppImage";

/// Same key as `plugins.updater.pubkey` in apps/opentrack/tauri.conf.json.
pub const OPENTRACK_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJDMTk5RTc3QkFBMURBQzEKUldUQjJxRzZkNTRadkdJTDNlb0l2NDNBVTVkbzFBSDdnUzl6ZHp6eXJDQWw4SXJpMFR0VVU0TU4K";

#[derive(Args)]
pub struct InstallArgs {
    /// folder for opentrack.app on macOS (default: /Applications) or opentrack.AppImage on Linux (default: ~/.local/bin)
    #[arg(long, value_name = "path")]
    pub dir: Option<PathBuf>,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

struct Release {
    version: String,
    url: String,
    signature: String,
}

/// Tauri's updater target for this machine; only those the release workflow builds.
fn updater_target() -> Result<&'static str, Failure> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-aarch64"),
        ("windows", "x86_64") => Ok("windows-x86_64"),
        ("linux", "x86_64") => Ok("linux-x86_64"),
        (os, arch) => Err(format!(
            "opentrack has no build for {os} {arch}; releases cover Apple Silicon Macs, 64-bit Windows and 64-bit Linux."
        )
        .into()),
    }
}

fn latest_release(core: &Core, target: &str) -> Result<Release, Failure> {
    let response = core.http.send(&Request::get(MANIFEST_URL, MANIFEST_TIMEOUT))?;
    if !response.is_ok() {
        return Err(format!("Could not find the latest opentrack release (HTTP {}).", response.status).into());
    }
    let manifest: Value = serde_json::from_slice(&response.body).unwrap_or_default();
    let asset = &manifest["platforms"][target];
    match (manifest["version"].as_str(), asset["url"].as_str(), asset["signature"].as_str()) {
        (Some(version), Some(url), Some(signature)) => {
            Ok(Release { version: version.to_owned(), url: url.to_owned(), signature: signature.to_owned() })
        }
        _ => Err(format!("The latest opentrack release has no {target} build.").into()),
    }
}

fn download(core: &Core, url: &str) -> Result<Vec<u8>, Failure> {
    let response = core.http.send(&Request::get(url, DOWNLOAD_TIMEOUT))?;
    if !response.is_ok() {
        return Err(format!("Download failed (HTTP {}): {url}", response.status).into());
    }
    Ok(response.body)
}

/// Whether `signature` (a Tauri updater `.sig`: a minisign file in base64) signs `data` with `public_key`.
pub fn verify_minisign(data: &[u8], signature: &str, public_key: &str) -> bool {
    let decode = |text: &str| STANDARD.decode(text.trim()).ok().and_then(|bytes| String::from_utf8(bytes).ok());
    let (Some(key), Some(signature)) = (decode(public_key), decode(signature)) else { return false };
    let (Ok(key), Ok(signature)) = (PublicKey::decode(&key), Signature::decode(&signature)) else { return false };
    key.verify(data, &signature, false).is_ok() // Tauri always signs the prehashed ("ED") form.
}

fn exec(program: &Path, args: &[&str], inherit: bool) -> Result<(), Failure> {
    let mut command = Command::new(program);
    command.args(args);
    if !inherit {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let code = output.status.code().map_or_else(|| "null".to_owned(), |c| c.to_string());
    let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
    Err(format!("{} exited with code {code}{suffix}", program.display()).into())
}

/// Removes the folder on drop, whatever happened inside it.
struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn staging_dir(parent: &Path, prefix: &str) -> Result<Staging, Failure> {
    let suffix: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    let path = parent.join(format!("{prefix}{}-{suffix:x}", std::process::id()));
    std::fs::create_dir(&path)?;
    Ok(Staging(path))
}

/// Unpacks next to the destination so swapping in the new app is a same-volume rename.
fn install_mac_app(archive: &[u8], dir: &Path) -> Result<PathBuf, Failure> {
    let staging = staging_dir(dir, ".opentrack-install-")?;
    let archive_path = staging.0.join("opentrack.app.tar.gz");
    std::fs::write(&archive_path, archive)?;
    exec(Path::new("tar"), &["-xzf", &archive_path.to_string_lossy(), "-C", &staging.0.to_string_lossy()], false)?;
    let destination = dir.join(APP_NAME);
    let previous = staging.0.join("previous.app");
    if destination.exists() {
        std::fs::rename(&destination, &previous)?;
    }
    if let Err(error) = std::fs::rename(staging.0.join(APP_NAME), &destination) {
        if previous.exists() {
            std::fs::rename(&previous, &destination)?;
        }
        return Err(error.into());
    }
    Ok(destination)
}

/// Renamed over the old file, so a running copy keeps its own until it restarts.
fn install_app_image(app_image: &[u8], dir: &Path) -> Result<PathBuf, Failure> {
    let destination = dir.join(APPIMAGE_NAME);
    let staging = dir.join(format!(".{APPIMAGE_NAME}.download"));
    let result = (|| -> std::io::Result<()> {
        std::fs::write(&staging, app_image)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&staging, &destination)
    })();
    let _ = std::fs::remove_file(&staging);
    result?;
    Ok(destination)
}

fn run_windows_installer(installer: &[u8]) -> Result<(), Failure> {
    let staging = staging_dir(&std::env::temp_dir(), "aitrack-opentrack-")?;
    let path = staging.0.join("opentrack-setup.exe");
    std::fs::write(&path, installer)?;
    exec(&path, &[], true)
}

fn report_installed(core: &Core, json: bool, version: &str, path: Option<&Path>, next_step: &str) {
    if json {
        print_json_command(
            "install-opentrack",
            json!({ "version": version, "path": path.map(|p| p.display().to_string()) }),
        );
        return;
    }
    let to = path.map_or_else(String::new, |p| format!(" to {}", p.display()));
    core.output.info(&format!("Installed opentrack {version}{to}."));
    if path.is_some() {
        core.output.info(next_step);
    }
}

pub fn run(core: &Core, args: &InstallArgs) -> Outcome {
    let target = updater_target()?;
    let windows = cfg!(windows);
    if windows && args.dir.is_some() {
        return Err(Failure::usage(
            "--dir applies to macOS and Linux only; the Windows installer chooses its own folder.",
        ));
    }
    let default_dir = if cfg!(target_os = "linux") {
        core.env.home().join(".local").join("bin")
    } else {
        PathBuf::from("/Applications")
    };
    let dir = args.dir.clone().unwrap_or(default_dir);
    if !windows {
        std::fs::create_dir_all(&dir)?; // Before a download that a bad folder would waste.
    }
    let release = latest_release(core, target)?;
    core.output.info(&format!("Downloading opentrack {}...", release.version));
    let file = download(core, &release.url)?;
    if !verify_minisign(&file, &release.signature, OPENTRACK_PUBLIC_KEY) {
        return Err("The download does not match its release signature; nothing was installed.".into());
    }
    let restart = "It updates itself from now on. If it was running, quit and reopen it.";
    if windows {
        core.output.info("Running the opentrack installer...");
        run_windows_installer(&file)?;
        report_installed(core, args.json, &release.version, None, restart);
    } else if cfg!(target_os = "linux") {
        let path = install_app_image(&file, &dir)?;
        let next = "Run it to start opentrack; Settings can launch it at login. It updates itself.";
        report_installed(core, args.json, &release.version, Some(&path), next);
    } else {
        let path = install_mac_app(&file, &dir)?;
        report_installed(core, args.json, &release.version, Some(&path), restart);
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_updater_key_of_the_desktop_app() {
        let conf: Value =
            serde_json::from_str(include_str!("../../../../apps/opentrack/tauri.conf.json")).expect("valid JSON");
        assert_eq!(conf["plugins"]["updater"]["pubkey"], OPENTRACK_PUBLIC_KEY);
    }

    /// `tauri signer sign` output for "hello opentrack\n" with opentrack's release key.
    const SAMPLE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQjJxRzZkNTRadk1IOEN3WUd1QXN6RkZsc2VERms1VFhpSERSM1Y4THYvdzlQakxMR0RGZmxHL2JEaGpVeXgxa1NhMHh4aWI1Qy9SNUp4VEo2UnVYdFRuMXUxMXpvUFFvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxMzEzNjU5CWZpbGU6c2FtcGxlLnR4dApjY2VCV0FvMkpIZGF1eFg1blNMMXV3Q2pFaTZYeGx6K1Z0dmZmdjk2UUxyNHFzWk1RWmtCRWt2L3dleGNsUExwT1dRcjNnbWZVZ01GZjVuK2hvd2dBUT09Cg==";

    #[test]
    fn accepts_a_tauri_signature_and_rejects_altered_files_signatures_and_keys() {
        assert!(verify_minisign(b"hello opentrack\n", SAMPLE_SIGNATURE, OPENTRACK_PUBLIC_KEY));
        assert!(!verify_minisign(b"hello opentrack!\n", SAMPLE_SIGNATURE, OPENTRACK_PUBLIC_KEY));
        assert!(!verify_minisign(b"hello opentrack\n", "garbage", OPENTRACK_PUBLIC_KEY));
        let key = String::from_utf8(STANDARD.decode(OPENTRACK_PUBLIC_KEY).unwrap()).unwrap();
        let other = STANDARD.encode(key.replace("RWTB2qG6", "RWTA2qG6"));
        assert!(!verify_minisign(b"hello opentrack\n", SAMPLE_SIGNATURE, &other));
    }
}
