//! `cargo xtask updater-artifacts <packager-out> <bundle-dir>`: lays cargo-packager's output out the way
//! Tauri's bundler did (`macos/`, `dmg/`, `nsis/`, `appimage/`, `deb/`, the `AppImage` named `_amd64`),
//! archives the app as `.app.tar.gz`, and signs every file the updater downloads with
//! `TAURI_SIGNING_PRIVATE_KEY`, so 4.x's updater and the release scripts read 5.0's releases unchanged.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use minisign::{SecretKey, SecretKeyBox};

use crate::artifacts::Installer;
use crate::pricing::Result;
use crate::{cmd, io};

/// The key as `tauri signer generate` prints it: a minisign secret key file, base64-encoded.
pub fn secret_key(encoded: &str, password: &str) -> Result<SecretKey> {
    let text = STANDARD.decode(encoded.trim()).map_err(|e| format!("TAURI_SIGNING_PRIVATE_KEY is not base64: {e}"))?;
    let text = String::from_utf8(text).map_err(|e| format!("TAURI_SIGNING_PRIVATE_KEY is not text: {e}"))?;
    SecretKeyBox::from_string(&text)
        .and_then(|key| key.into_secret_key(Some(password.to_owned())))
        .map_err(|e| format!("TAURI_SIGNING_PRIVATE_KEY: {e}"))
}

/// A `.sig` as Tauri writes it: the minisign signature file, base64-encoded.
pub fn sign(key: &SecretKey, data: &[u8], file_name: &str, timestamp: i64) -> Result<String> {
    let trusted = format!("timestamp:{timestamp}\tfile:{file_name}");
    let signature =
        minisign::sign(None, key, Cursor::new(data), Some(&trusted), Some("signature from tauri secret key"))
            .map_err(|e| format!("signing {file_name}: {e}"))?;
    Ok(STANDARD.encode(signature.to_string()))
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

fn place(file: &Path, dir: &Path, name: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(dir).map_err(io(dir))?;
    let target = dir.join(name);
    if target.exists() {
        if target.is_dir() {
            std::fs::remove_dir_all(&target).map_err(io(&target))?;
        } else {
            std::fs::remove_file(&target).map_err(io(&target))?;
        }
    }
    std::fs::rename(file, &target).map_err(io(file))?;
    Ok(target)
}

/// `opentrack.app` as the updater fetches it: the bundle at the archive's root.
fn archive_app(app: &Path) -> Result<PathBuf> {
    let name = app.file_name().ok_or("the app has no name")?.to_string_lossy().into_owned();
    let archive = app.with_file_name(format!("{name}.tar.gz"));
    let dir = app.parent().ok_or("the app has no folder")?;
    cmd("tar", &["-czf", &archive.to_string_lossy(), "-C", &dir.to_string_lossy(), &name], None)?;
    Ok(archive)
}

pub fn run(from: &Path, to: &Path) -> Result<()> {
    let key = match std::env::var("TAURI_SIGNING_PRIVATE_KEY") {
        Ok(encoded) if !encoded.trim().is_empty() => {
            let password = std::env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD").unwrap_or_default();
            Some(secret_key(&encoded, &password)?)
        }
        _ => None,
    };
    lay_out(from, to, key.as_ref())
}

fn lay_out(from: &Path, to: &Path, key: Option<&SecretKey>) -> Result<()> {
    let entries = std::fs::read_dir(from).map_err(io(from))?;
    let mut signed = Vec::new();
    for entry in entries {
        let path = entry.map_err(io(from))?.path();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dir = |kind: Installer| to.join(kind.dir());
        if path.extension().is_some_and(|e| e == "app") {
            let app = place(&path, &dir(Installer::AppArchive), &name)?;
            signed.push(archive_app(&app)?);
        } else if has_extension(&path, "dmg") {
            place(&path, &dir(Installer::Dmg), &name)?;
        } else if name.ends_with("-setup.exe") {
            signed.push(place(&path, &dir(Installer::Nsis), &name)?);
        } else if name.ends_with(".AppImage") {
            let renamed = name.replace("_x86_64.AppImage", Installer::AppImage.suffix());
            signed.push(place(&path, &dir(Installer::AppImage), &renamed)?);
        } else if has_extension(&path, "deb") {
            signed.push(place(&path, &dir(Installer::Deb), &name)?);
        }
    }
    let Some(key) = key else {
        println!("TAURI_SIGNING_PRIVATE_KEY is not set; laid out {} updater file(s) unsigned.", signed.len());
        return Ok(());
    };
    let timestamp = jiff::Timestamp::now().as_second();
    for file in &signed {
        let data = std::fs::read(file).map_err(io(file))?;
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let sig = file.with_file_name(format!("{name}.sig"));
        std::fs::write(&sig, sign(key, &data, &name, timestamp)?).map_err(io(&sig))?;
        println!("Signed {}", file.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use aitrack_core::update::verify_minisign;
    use minisign::KeyPair;

    use super::*;

    #[test]
    fn signs_what_the_updater_verifies() {
        let pair = KeyPair::generate_encrypted_keypair(Some("pw".into())).unwrap();
        let secret = STANDARD.encode(pair.sk.to_box(None).unwrap().to_string());
        let public = STANDARD.encode(pair.pk.to_box().unwrap().to_string());
        let key = secret_key(&secret, "pw").unwrap();
        let sig = sign(&key, b"opentrack", "opentrack.app.tar.gz", 1).unwrap();
        assert!(verify_minisign(b"opentrack", &sig, &public));
        assert!(!verify_minisign(b"opentrack!", &sig, &public));
        assert!(secret_key(&secret, "wrong").is_err());
    }

    #[test]
    fn lays_files_out_as_tauri_did_and_names_the_app_image_amd64() {
        let root = tempfile::tempdir().unwrap();
        let (from, to) = (root.path().join("out"), root.path().join("bundle"));
        std::fs::create_dir_all(from.join("opentrack.app/Contents")).unwrap();
        for name in ["opentrack_5.0.0_aarch64.dmg", "opentrack_5.0.0_x64-setup.exe", "opentrack_5.0.0_x86_64.AppImage"]
        {
            std::fs::write(from.join(name), name).unwrap();
        }
        lay_out(&from, &to, None).unwrap();
        for path in [
            "macos/opentrack.app/Contents",
            "macos/opentrack.app.tar.gz",
            "dmg/opentrack_5.0.0_aarch64.dmg",
            "nsis/opentrack_5.0.0_x64-setup.exe",
            "appimage/opentrack_5.0.0_amd64.AppImage",
        ] {
            assert!(to.join(path).exists(), "{path}");
        }
    }
}
