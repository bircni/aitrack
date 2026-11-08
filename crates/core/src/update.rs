//! opentrack's releases: the manifest its updater and `aitrack install-opentrack` read, the minisign check,
//! and putting a verified build in place.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;

use crate::http::{HttpClient, Request};

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

/// The manifest's platform key for this machine; only those the release workflow builds.
pub fn updater_target() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-aarch64"),
        ("windows", "x86_64") => Ok("windows-x86_64"),
        ("linux", "x86_64") => Ok("linux-x86_64"),
        (os, arch) => Err(format!(
            "opentrack has no build for {os} {arch}; releases cover Apple Silicon Macs, 64-bit Windows and 64-bit Linux."
        )),
    }
}

pub fn parse_manifest(body: &[u8], target: &str) -> Result<Release, String> {
    let manifest: Value = serde_json::from_slice(body).unwrap_or_default();
    let asset = &manifest["platforms"][target];
    match (manifest["version"].as_str(), asset["url"].as_str(), asset["signature"].as_str()) {
        (Some(version), Some(url), Some(signature)) => Ok(Release {
            version: version.trim_start_matches('v').to_owned(),
            url: url.to_owned(),
            signature: signature.to_owned(),
        }),
        _ => Err(format!("The latest opentrack release has no {target} build.")),
    }
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

fn version_parts(version: &str) -> Option<([u64; 3], Option<&str>)> {
    let version = version.trim_start_matches('v');
    let (core, pre) = version.split_once('-').map_or((version, None), |(c, p)| (c, Some(p)));
    let mut numbers = core.split('.').map(|part| part.parse::<u64>().ok());
    let parts = [numbers.next()??, numbers.next()??, numbers.next()??];
    numbers.next().is_none().then_some((parts, pre))
}

/// Semver precedence, enough for release tags: a prerelease sorts before its release.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (Some((a, a_pre)), Some((b, b_pre))) = (version_parts(candidate), version_parts(current)) else {
        return false;
    };
    match a.cmp(&b) {
        std::cmp::Ordering::Equal => match (a_pre, b_pre) {
            (None, Some(_)) => true,
            (Some(a), Some(b)) => a > b,
            _ => false,
        },
        order => order.is_gt(),
    }
}

fn exec(program: &Path, args: &[&str], inherit: bool) -> Result<(), String> {
    let mut command = Command::new(program);
    command.args(args);
    if !inherit {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    let output = command.output().map_err(|e| format!("{}: {e}", program.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let code = output.status.code().map_or_else(|| "null".to_owned(), |c| c.to_string());
    let suffix = if detail.is_empty() { String::new() } else { format!(": {detail}") };
    Err(format!("{} exited with code {code}{suffix}", program.display()))
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
    std::fs::create_dir(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Staging(path))
}

/// Unpacks next to the destination so swapping in the new app is a same-volume rename.
pub fn install_mac_app(archive: &[u8], dir: &Path) -> Result<PathBuf, String> {
    let staging = staging_dir(dir, ".opentrack-install-")?;
    let archive_path = staging.0.join("opentrack.app.tar.gz");
    std::fs::write(&archive_path, archive).map_err(|e| e.to_string())?;
    exec(Path::new("tar"), &["-xzf", &archive_path.to_string_lossy(), "-C", &staging.0.to_string_lossy()], false)?;
    let destination = dir.join(APP_NAME);
    let previous = staging.0.join("previous.app");
    if destination.exists() {
        std::fs::rename(&destination, &previous).map_err(|e| e.to_string())?;
    }
    if let Err(error) = std::fs::rename(staging.0.join(APP_NAME), &destination) {
        if previous.exists() {
            std::fs::rename(&previous, &destination).map_err(|e| e.to_string())?;
        }
        return Err(error.to_string());
    }
    Ok(destination)
}

/// Renamed over the old file, so a running copy keeps its own until it restarts.
pub fn install_app_image(app_image: &[u8], destination: &Path) -> Result<PathBuf, String> {
    let name = destination.file_name().map_or_else(|| APPIMAGE_NAME.into(), |n| n.to_string_lossy().into_owned());
    let staging = destination.with_file_name(format!(".{name}.download"));
    let result = (|| -> std::io::Result<()> {
        std::fs::write(&staging, app_image)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&staging, destination)
    })();
    let _ = std::fs::remove_file(&staging);
    result.map_err(|e| e.to_string())?;
    Ok(destination.to_owned())
}

/// Runs the NSIS installer; `wait` holds until it exits, otherwise it is left to replace this process.
pub fn run_windows_installer(installer: &[u8], args: &[&str], wait: bool) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("opentrack-update-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("opentrack-setup.exe");
    std::fs::write(&path, installer).map_err(|e| e.to_string())?;
    if wait {
        return exec(&path, args, true);
    }
    Command::new(&path).args(args).spawn().map(drop).map_err(|e| e.to_string())
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
        assert!(parse_manifest(body, "windows-x86_64").is_err());
    }

    #[test]
    fn offers_only_a_newer_version() {
        assert!(is_newer("5.0.0", "4.2.1"));
        assert!(is_newer("4.10.0", "4.9.9"));
        assert!(is_newer("5.0.0", "5.0.0-beta.2"));
        assert!(is_newer("5.0.0-beta.2", "5.0.0-beta.1"));
        assert!(!is_newer("5.0.0", "5.0.0"));
        assert!(!is_newer("5.0.0-beta.1", "5.0.0"));
        assert!(!is_newer("4.2.1", "5.0.0"));
        assert!(!is_newer("garbage", "5.0.0"));
    }
}
