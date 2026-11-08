//! opentrack's releases: the manifest its updater and `aitrack install-opentrack` read, the minisign check,
//! and putting a verified build in place.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;

use crate::fs::write_file_atomic;
use crate::http::{HttpClient, Request};
use crate::process;
use crate::semver::Version;

/// Prereleases never become "latest", so only stable builds are offered.
pub const MANIFEST_URL: &str = "https://github.com/bircni/aitrack/releases/latest/download/latest.json";
/// The release key 4.x's Tauri updater trusts; changing it would strand every installed app.
pub const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJDMTk5RTc3QkFBMURBQzEKUldUQjJxRzZkNTRadkdJTDNlb0l2NDNBVTVkbzFBSDdnUzl6ZHp6eXJDQWw4SXJpMFR0VVU0TU4K";
pub const APP_NAME: &str = "opentrack.app";
pub const APPIMAGE_NAME: &str = "opentrack.AppImage";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Limits the whole download rather than a stall, so a slow link still has to fit inside it.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_mins(20);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub signature: String,
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: HashMap<String, Asset>,
}

#[derive(Deserialize)]
struct Asset {
    url: String,
    signature: String,
}

/// The manifest's platform keys, which the release workflow writes and the updater reads.
pub const MAC_TARGET: &str = "darwin-aarch64";
pub const WINDOWS_TARGET: &str = "windows-x86_64";
pub const LINUX_TARGET: &str = "linux-x86_64";

/// The manifest's platform key for this machine; only those the release workflow builds.
pub fn updater_target() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok(MAC_TARGET),
        ("windows", "x86_64") => Ok(WINDOWS_TARGET),
        ("linux", "x86_64") => Ok(LINUX_TARGET),
        (os, arch) => Err(format!(
            "opentrack has no build for {os} {arch}; releases cover Apple Silicon Macs, 64-bit Windows and 64-bit Linux."
        )),
    }
}

/// Where a verified build goes on this platform.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InstallTarget {
    /// An app bundle, replaced whole.
    MacBundle(PathBuf),
    /// An `AppImage`, renamed over the old one.
    AppImage(PathBuf),
    /// The installer picks its own folder.
    WindowsInstaller,
}

impl InstallTarget {
    /// The folder a fresh install goes to when none is given; Windows' installer has its own.
    #[must_use]
    pub fn default_dir(home: &Path) -> Option<PathBuf> {
        if cfg!(windows) {
            None
        } else if cfg!(target_os = "macos") {
            Some(PathBuf::from("/Applications"))
        } else {
            Some(home.join(".local").join("bin"))
        }
    }

    /// A fresh install into `dir`, which Windows ignores.
    #[must_use]
    pub fn fresh(dir: &Path) -> Self {
        if cfg!(windows) {
            Self::WindowsInstaller
        } else if cfg!(target_os = "macos") {
            Self::MacBundle(dir.join(APP_NAME))
        } else {
            Self::AppImage(dir.join(APPIMAGE_NAME))
        }
    }

    /// The copy running as `exe`, or why it cannot replace itself. `app_image` is `$APPIMAGE`, set
    /// only when Linux runs an `AppImage`; a `.deb` install is left to the package manager.
    pub fn running(exe: &Path, app_image: Option<PathBuf>) -> Result<Self, String> {
        if cfg!(windows) {
            Ok(Self::WindowsInstaller)
        } else if cfg!(target_os = "macos") {
            app_bundle(exe).map(Self::MacBundle).ok_or_else(|| "opentrack is not running from an app bundle".into())
        } else {
            app_image
                .map(Self::AppImage)
                .ok_or_else(|| "Only the AppImage updates itself; update the .deb with your package manager.".into())
        }
    }

    /// The folder the install writes to, to create before a download a bad one would waste.
    #[must_use]
    pub fn folder(&self) -> Option<&Path> {
        match self {
            Self::MacBundle(path) | Self::AppImage(path) => path.parent(),
            Self::WindowsInstaller => None,
        }
    }

    /// Puts a verified build in place and waits for it; the installed path, which Windows' installer
    /// does not report.
    pub fn install(&self, file: &[u8]) -> Result<Option<PathBuf>, String> {
        match self {
            Self::MacBundle(path) => install_mac_app(file, path).map(Some),
            Self::AppImage(path) => install_app_image(file, path).map(Some),
            Self::WindowsInstaller => run_windows_installer(file).map(|()| None),
        }
    }

    /// Replaces the running copy: the command that starts the new one, or `None` when Windows'
    /// installer closes this process and restarts it itself.
    pub fn replace_running(&self, file: &[u8]) -> Result<Option<Command>, String> {
        match self {
            Self::MacBundle(path) => {
                install_mac_app(file, path)?;
                let mut open = Command::new("open");
                open.arg("-n").arg(path);
                Ok(Some(open))
            }
            Self::AppImage(path) => {
                install_app_image(file, path)?;
                Ok(Some(Command::new(path)))
            }
            Self::WindowsInstaller => start_windows_update(file).map(|()| None),
        }
    }
}

/// `…/opentrack.app` from `…/opentrack.app/Contents/MacOS/opentrack`.
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

pub fn parse_manifest(body: &[u8], target: &str) -> Result<Release, String> {
    let mut manifest: Manifest =
        serde_json::from_slice(body).map_err(|e| format!("The latest opentrack release has a bad manifest: {e}"))?;
    let asset = manifest
        .platforms
        .remove(target)
        .ok_or_else(|| format!("The latest opentrack release has no {target} build."))?;
    Ok(Release {
        version: manifest.version.trim_start_matches('v').to_owned(),
        url: asset.url,
        signature: asset.signature,
    })
}

pub fn latest_release(http: &dyn HttpClient, target: &str) -> Result<Release, String> {
    let response = http.send(&Request::get(MANIFEST_URL, MANIFEST_TIMEOUT)).map_err(|e| e.to_string())?;
    if !response.is_ok() {
        return Err(format!("Could not find the latest opentrack release (HTTP {}).", response.status));
    }
    parse_manifest(&response.body, target)
}

/// The release, downloaded and checked against [`PUBLIC_KEY`].
pub fn download_verified(http: &dyn HttpClient, release: &Release) -> Result<Vec<u8>, String> {
    let response = http.send(&Request::get(&release.url, DOWNLOAD_TIMEOUT)).map_err(|e| e.to_string())?;
    if !response.is_ok() {
        return Err(format!("Download failed (HTTP {}): {}", response.status, release.url));
    }
    if !verify_minisign(&response.body, &release.signature, PUBLIC_KEY) {
        return Err("The download does not match its release signature; nothing was installed.".into());
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

/// Whether `candidate` is a later release than `current`, by semver precedence.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |text: &str| Version::parse(text.trim_start_matches('v'));
    matches!((parse(candidate), parse(current)), (Some(a), Some(b)) if a > b)
}

fn exec(program: &str, args: &[&str]) -> Result<(), String> {
    let finished = process::run(program, args, &[], None, None).map_err(|e| format!("{program}: {e}"))?;
    if finished.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&finished.stderr).trim().to_owned();
    let code = finished.status.code().map_or_else(|| "null".to_owned(), |c| c.to_string());
    let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
    Err(format!("{program} exited with code {code}{suffix}"))
}

/// Removes the folder on drop, whatever happened inside it.
struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn staging_dir(parent: &Path, prefix: &str) -> Result<Staging, String> {
    let suffix: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    let path = parent.join(format!("{prefix}{}-{suffix:x}", std::process::id()));
    std::fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Staging(path))
}

/// Unpacks next to the destination so swapping in the new app is a same-volume rename.
fn install_mac_app(archive: &[u8], destination: &Path) -> Result<PathBuf, String> {
    let dir = destination.parent().ok_or("The app bundle has no folder")?;
    let staging = staging_dir(dir, ".opentrack-install-")?;
    let archive_path = staging.0.join("opentrack.app.tar.gz");
    std::fs::write(&archive_path, archive).map_err(|e| e.to_string())?;
    exec("tar", &["-xzf", &archive_path.to_string_lossy(), "-C", &staging.0.to_string_lossy()])?;
    let previous = staging.0.join("previous.app");
    if destination.exists() {
        std::fs::rename(destination, &previous).map_err(|e| e.to_string())?;
    }
    if let Err(error) = std::fs::rename(staging.0.join(APP_NAME), destination) {
        if previous.exists() {
            std::fs::rename(&previous, destination).map_err(|e| e.to_string())?;
        }
        return Err(error.to_string());
    }
    Ok(destination.to_owned())
}

/// Renamed over the old file, so a running copy keeps its own until it restarts.
fn install_app_image(app_image: &[u8], destination: &Path) -> Result<PathBuf, String> {
    write_file_atomic(destination, app_image, Some(0o755)).map_err(|e| format!("{}: {e}", destination.display()))?;
    Ok(destination.to_owned())
}

fn write_installer(dir: &Path, installer: &[u8]) -> Result<PathBuf, String> {
    let path = dir.join("opentrack-setup.exe");
    std::fs::write(&path, installer).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Runs the installer in this console and removes it afterwards.
fn run_windows_installer(installer: &[u8]) -> Result<(), String> {
    let staging = staging_dir(&std::env::temp_dir(), "opentrack-update-")?;
    let path = write_installer(&staging.0, installer)?;
    let status = process::run_interactive(&path.to_string_lossy(), &[]).map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("The opentrack installer exited with {status}")) }
}

/// Its folder stays: the installer still runs from it once this process is gone.
fn start_windows_update(installer: &[u8]) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("opentrack-update-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Passive mode closes this process and starts the new one, as Tauri's updater did.
    Command::new(write_installer(&dir, installer)?).args(["/P", "/R"]).spawn().map(drop).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tauri signer sign` output for "hello opentrack\n" with opentrack's release key.
    const SAMPLE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUQjJxRzZkNTRadk1IOEN3WUd1QXN6RkZsc2VERms1VFhpSERSM1Y4THYvdzlQakxMR0RGZmxHL2JEaGpVeXgxa1NhMHh4aWI1Qy9SNUp4VEo2UnVYdFRuMXUxMXpvUFFvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxMzEzNjU5CWZpbGU6c2FtcGxlLnR4dApjY2VCV0FvMkpIZGF1eFg1blNMMXV3Q2pFaTZYeGx6K1Z0dmZmdjk2UUxyNHFzWk1RWmtCRWt2L3dleGNsUExwT1dRcjNnbWZVZ01GZjVuK2hvd2dBUT09Cg==";

    #[test]
    fn accepts_a_tauri_signature_and_rejects_altered_files_signatures_and_keys() {
        assert!(verify_minisign(b"hello opentrack\n", SAMPLE_SIGNATURE, PUBLIC_KEY));
        assert!(!verify_minisign(b"hello opentrack!\n", SAMPLE_SIGNATURE, PUBLIC_KEY));
        assert!(!verify_minisign(b"hello opentrack\n", "garbage", PUBLIC_KEY));
        let key = String::from_utf8(STANDARD.decode(PUBLIC_KEY).unwrap()).unwrap();
        let other = STANDARD.encode(key.replace("RWTB2qG6", "RWTA2qG6"));
        assert!(!verify_minisign(b"hello opentrack\n", SAMPLE_SIGNATURE, &other));
    }

    #[test]
    fn reads_the_manifest_tauri_writes() {
        let body = br#"{"version":"5.0.0","pub_date":"x","platforms":{"darwin-aarch64":{"signature":"s","url":"u"}}}"#;
        let release = parse_manifest(body, "darwin-aarch64").unwrap();
        assert_eq!(release, Release { version: "5.0.0".into(), url: "u".into(), signature: "s".into() });
        assert!(parse_manifest(body, "windows-x86_64").unwrap_err().contains("no windows-x86_64 build"));
        assert!(parse_manifest(b"<html>", "darwin-aarch64").unwrap_err().contains("bad manifest"));
    }

    #[test]
    fn offers_only_a_newer_version() {
        assert!(is_newer("5.0.0", "4.2.1"));
        assert!(is_newer("4.10.0", "4.9.9"));
        assert!(is_newer("5.0.0", "5.0.0-beta.2"));
        assert!(is_newer("5.0.0-beta.2", "5.0.0-beta.1"));
        assert!(is_newer("5.0.0-beta.10", "5.0.0-beta.9"));
        assert!(!is_newer("5.0.0", "5.0.0"));
        assert!(!is_newer("5.0.0-beta.1", "5.0.0"));
        assert!(!is_newer("4.2.1", "5.0.0"));
        assert!(!is_newer("garbage", "5.0.0"));
    }

    #[test]
    fn finds_the_bundle_the_binary_runs_from() {
        let exe = Path::new("/Applications/opentrack 2.app/Contents/MacOS/opentrack");
        assert_eq!(app_bundle(exe), Some(PathBuf::from("/Applications/opentrack 2.app")));
        assert_eq!(app_bundle(Path::new("/usr/bin/opentrack")), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn leaves_a_deb_install_to_the_package_manager() {
        assert!(InstallTarget::running(Path::new("/usr/bin/opentrack"), None).is_err());
        let app_image = PathBuf::from("/home/me/opentrack.AppImage");
        assert_eq!(
            InstallTarget::running(Path::new("/tmp/.mount/usr/bin/opentrack"), Some(app_image.clone())),
            Ok(InstallTarget::AppImage(app_image))
        );
    }

    #[cfg(unix)]
    #[test]
    fn replaces_the_bundle_it_was_given_whatever_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("src");
        std::fs::create_dir_all(source.join(APP_NAME)).unwrap();
        std::fs::write(source.join(APP_NAME).join("new"), "").unwrap();
        let archive = dir.path().join("a.tar.gz");
        exec("tar", &["-czf", &archive.to_string_lossy(), "-C", &source.to_string_lossy(), APP_NAME]).unwrap();
        let running = dir.path().join("opentrack 2.app");
        std::fs::create_dir(&running).unwrap();
        let installed = install_mac_app(&std::fs::read(&archive).unwrap(), &running).unwrap();
        assert_eq!(installed, running);
        assert!(running.join("new").exists());
        assert!(!dir.path().join(APP_NAME).exists());
    }
}
