//! `cargo xtask updater-manifest`, `homebrew-cask` and `winget-manifest`.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::artifacts::{Installer, UPDATER_PLATFORMS};
use crate::{Result, io, sha256_file};

pub fn version_from_tag(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                char::from(b).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The `latest.json` installed apps poll, with each installer's minisign signature.
pub fn updater_manifest(tag: &str, directory: &Path, repository: &str, pub_date: &str) -> Result<Value> {
    let mut files: Vec<String> = std::fs::read_dir(directory)
        .map_err(io(directory))?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    files.sort();
    let mut platforms = Map::new();
    for (key, installer) in UPDATER_PLATFORMS {
        let suffix = installer.suffix();
        let matches: Vec<&String> = files.iter().filter(|f| f.ends_with(suffix)).collect();
        let [file] = matches.as_slice() else {
            return Err(format!("Expected one *{suffix} in {}, found {}.", directory.display(), matches.len()));
        };
        let sig = format!("{file}.sig");
        if !files.contains(&sig) {
            return Err(format!("{file} has no updater signature."));
        }
        let signature = std::fs::read_to_string(directory.join(&sig)).map_err(|e| e.to_string())?;
        platforms.insert(
            key.into(),
            json!({
                "signature": signature.trim(),
                "url": format!("https://github.com/{repository}/releases/download/{tag}/{}", encode_component(file)),
            }),
        );
    }
    Ok(json!({ "version": version_from_tag(tag), "pub_date": pub_date, "platforms": platforms }))
}

/// The cask published to bircni/homebrew-tap as Casks/opentrack.rb.
pub fn homebrew_cask(version: &str, sha256: &str) -> String {
    format!(
        r#"cask "opentrack" do
  version "{version}"
  sha256 "{sha256}"

  url "https://github.com/bircni/aitrack/releases/download/v#{{version}}/opentrack_#{{version}}_aarch64.dmg"
  name "opentrack"
  desc "Menu bar dashboard for Claude Code, Codex and Cursor limits and spend"
  homepage "https://github.com/bircni/aitrack/blob/main/docs/opentrack.md"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "opentrack.app"

  # Ad hoc signed and not notarized, so Gatekeeper would refuse the quarantined copy.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{{{appdir}}}}/opentrack.app"]
  end

  zap trash: [
    "~/Library/Application Support/dev.bircni.opentrack",
    "~/Library/Caches/dev.bircni.opentrack",
    "~/Library/WebKit/dev.bircni.opentrack",
  ]
end
"#
    )
}

const WINGET_ID: &str = "bircni.opentrack";
const WINGET_SCHEMA: &str = "1.12.0";

fn winget_file(kind: &str, body: &str) -> String {
    format!(
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.{kind}.{WINGET_SCHEMA}.schema.json\n\n{body}ManifestType: {kind}\nManifestVersion: {WINGET_SCHEMA}\n"
    )
}

/// The three files winget-pkgs expects for one version, by file name.
pub fn winget_manifests(version: &str, sha256: &str) -> Vec<(String, String)> {
    let id = format!("PackageIdentifier: {WINGET_ID}\nPackageVersion: {version}\n");
    let sha = sha256.to_uppercase();
    let setup = Installer::Nsis.file_name(version);
    vec![
        (format!("{WINGET_ID}.yaml"), winget_file("version", &format!("{id}DefaultLocale: en-US\n"))),
        (
            format!("{WINGET_ID}.installer.yaml"),
            winget_file(
                "installer",
                &format!(
                    "{id}InstallerLocale: en-US
InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
- silentWithProgress
UpgradeBehavior: install
ProductCode: opentrack
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/bircni/aitrack/releases/download/v{version}/{setup}
  InstallerSha256: {sha}
"
                ),
            ),
        ),
        (
            format!("{WINGET_ID}.locale.en-US.yaml"),
            winget_file(
                "defaultLocale",
                &format!(
                    "{id}PackageLocale: en-US
Publisher: bircni
PublisherUrl: https://github.com/bircni
PublisherSupportUrl: https://github.com/bircni/aitrack/issues
PackageName: opentrack
PackageUrl: https://github.com/bircni/aitrack/blob/main/docs/opentrack.md
License: MIT
LicenseUrl: https://github.com/bircni/aitrack/blob/main/LICENSE
ShortDescription: Live limits, reset times and spend for Claude Code, Codex and Cursor
Description: |-
  A tray dashboard for Claude Code, Codex and Cursor: live session and weekly limits with reset
  times and pacing, plus token usage and estimated cost, including other machines synced through
  an aitrack data repo.
Moniker: aitrack-opentrack
Tags:
- ai
- claude-code
- codex
- cursor
- tray
- usage
ReleaseNotesUrl: https://github.com/bircni/aitrack/releases/tag/v{version}
"
                ),
            ),
        ),
    ]
}

/// Writes the winget manifests under `<out>/manifests/b/bircni/opentrack/<version>` and returns that folder.
pub fn write_winget(tag: &str, installer: &Path, out: &Path) -> Result<PathBuf> {
    let version = version_from_tag(tag);
    let directory = out.join("manifests/b/bircni/opentrack").join(version);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    for (name, body) in winget_manifests(version, &sha256_file(installer)?) {
        std::fs::write(directory.join(name), body).map_err(|e| e.to_string())?;
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in files {
            std::fs::write(dir.path().join(name), body).unwrap();
        }
        dir
    }

    #[test]
    fn points_every_platform_at_its_asset_and_signature() {
        let dir = dir(&[
            ("opentrack.app.tar.gz", ""),
            ("opentrack.app.tar.gz.sig", "mac-signature\n"),
            ("opentrack_3.1.0_aarch64.dmg", ""),
            ("opentrack_3.1.0_x64-setup.exe", ""),
            ("opentrack_3.1.0_x64-setup.exe.sig", "windows-signature\n"),
            ("opentrack_3.1.0_amd64.AppImage", ""),
            ("opentrack_3.1.0_amd64.AppImage.sig", "appimage-signature\n"),
            ("opentrack_3.1.0_amd64.deb", ""),
            ("opentrack_3.1.0_amd64.deb.sig", "deb-signature\n"),
        ]);
        let manifest = updater_manifest("v3.1.0", dir.path(), "bircni/aitrack", "2026-01-01T00:00:00.000Z").unwrap();
        let base = "https://github.com/bircni/aitrack/releases/download/v3.1.0";
        assert_eq!(
            manifest,
            json!({
                "version": "3.1.0",
                "pub_date": "2026-01-01T00:00:00.000Z",
                "platforms": {
                    "darwin-aarch64": { "signature": "mac-signature", "url": format!("{base}/opentrack.app.tar.gz") },
                    "windows-x86_64": { "signature": "windows-signature", "url": format!("{base}/opentrack_3.1.0_x64-setup.exe") },
                    "linux-x86_64": { "signature": "appimage-signature", "url": format!("{base}/opentrack_3.1.0_amd64.AppImage") },
                    "linux-x86_64-deb": { "signature": "deb-signature", "url": format!("{base}/opentrack_3.1.0_amd64.deb") },
                },
            })
        );
        assert_eq!(encode_component("a b+c"), "a%20b%2Bc");
    }

    #[test]
    fn refuses_an_unsigned_installer() {
        let dir = dir(&[
            ("opentrack.app.tar.gz", ""),
            ("opentrack.app.tar.gz.sig", "mac-signature"),
            ("opentrack_3.1.0_x64-setup.exe", ""),
        ]);
        let error = updater_manifest("v3.1.0", dir.path(), "bircni/aitrack", "x").unwrap_err();
        assert_eq!(error, "opentrack_3.1.0_x64-setup.exe has no updater signature.");
    }

    #[test]
    fn pins_the_cask_to_the_disk_image_and_its_checksum() {
        let dir = dir(&[("opentrack_3.1.0_aarch64.dmg", "disk image")]);
        let sha = sha256_file(&dir.path().join("opentrack_3.1.0_aarch64.dmg")).unwrap();
        let cask = homebrew_cask(version_from_tag("v3.1.0"), &sha);
        assert!(cask.contains("version \"3.1.0\""));
        assert!(cask.contains("sha256 \"0bb2f0f3ed953c47d835a7adaefd95afa328e30a5c80fdce417dd12b014ad602\""));
        assert!(cask.contains("v#{version}/opentrack_#{version}_aarch64.dmg"));
        assert!(cask.contains("\"{{appdir}}/opentrack.app\""));
    }

    #[test]
    fn writes_the_winget_manifests_for_an_installer() {
        let dir = dir(&[("opentrack_3.2.0_x64-setup.exe", "installer")]);
        let written = write_winget("v3.2.0", &dir.path().join("opentrack_3.2.0_x64-setup.exe"), dir.path()).unwrap();
        assert_eq!(written, dir.path().join("manifests/b/bircni/opentrack/3.2.0"));
        let mut names: Vec<String> =
            std::fs::read_dir(&written).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(
            names,
            ["bircni.opentrack.installer.yaml", "bircni.opentrack.locale.en-US.yaml", "bircni.opentrack.yaml"]
        );
        let installer = std::fs::read_to_string(written.join("bircni.opentrack.installer.yaml")).unwrap();
        assert!(installer.contains(
            "InstallerUrl: https://github.com/bircni/aitrack/releases/download/v3.2.0/opentrack_3.2.0_x64-setup.exe"
        ));
        assert!(
            installer.contains("InstallerSha256: 9C0D294C05FC1D88D698034609BB81C0C69196327594E4C69D2915C80FD9850C")
        );
        // winget-pkgs already has opentrack.opentrack, an unrelated head tracker.
        let locale = std::fs::read_to_string(written.join("bircni.opentrack.locale.en-US.yaml")).unwrap();
        assert!(locale.contains("Moniker: aitrack-opentrack\n"));
    }
}
