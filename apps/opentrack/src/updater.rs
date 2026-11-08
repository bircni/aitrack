//! Checks the latest GitHub release and installs it: the same manifest, key and installers 4.x's
//! Tauri updater used, so either version can update to the next.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aitrack_core::http::UreqClient;
use aitrack_core::update::{download_verified, install, is_newer, latest_release, updater_target, Release};

use crate::app::{Bus, Msg};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Tells the next process it was started by an update, so it waits for this one to let go of the lock.
pub const RELAUNCH_ARG: &str = "--relaunch";

#[derive(Clone, Default)]
pub struct Updater {
    pending: Arc<Mutex<Option<Release>>>,
}

impl Updater {
    /// Sends the newer version on offer, if any. Only a check the user asked for reports a failure;
    /// a background one that finds the network down just tries again later.
    pub fn check(&self, bus: &Bus, asked: bool) {
        match newer_release() {
            Ok(newer) => {
                let version = newer.as_ref().map(|r| r.version.clone());
                *self.pending.lock().unwrap() = newer;
                bus.send(Msg::UpdateFound(version));
            }
            Err(error) if asked => bus.send(Msg::UpdateCheckFailed(error)),
            Err(error) => eprintln!("opentrack: update check: {error}"),
        }
    }

    /// Shortly after launch and then every few hours.
    pub fn watch(&self, bus: Bus) {
        let updater = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                updater.check(&bus, false);
                std::thread::sleep(CHECK_INTERVAL);
            }
        });
    }

    /// Downloads, verifies and installs, then restarts into it; the popup hears only of failures.
    pub fn install(&self, bus: Bus) {
        let Some(release) = self.pending.lock().unwrap().clone() else {
            bus.send(Msg::UpdateInstallFailed("No update is available".into()));
            return;
        };
        std::thread::spawn(move || {
            if let Err(error) = install_and_relaunch(&release) {
                bus.send(Msg::UpdateInstallFailed(error));
            }
        });
    }
}

/// A newer release this copy can install itself, or why none is on offer.
fn newer_release() -> Result<Option<Release>, String> {
    if cfg!(debug_assertions) {
        return Err("Development builds do not update".into());
    }
    destination()?;
    let release = latest_release(&UreqClient::default(), updater_target()?)?;
    Ok(is_newer(&release.version, env!("CARGO_PKG_VERSION")).then_some(release))
}

/// What an update replaces: the running bundle on macOS, the running AppImage on Linux; Windows'
/// installer finds its own way. A `.deb` install is left to the package manager.
fn destination() -> Result<Option<PathBuf>, String> {
    if cfg!(windows) {
        return Ok(None);
    }
    if cfg!(target_os = "macos") {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        return app_bundle(&exe).map(Some).ok_or_else(|| "opentrack is not running from an app bundle".into());
    }
    std::env::var_os("APPIMAGE")
        .map(|path| Some(PathBuf::from(path)))
        .ok_or_else(|| "Only the AppImage updates itself; update the .deb with your package manager.".into())
}

fn install_and_relaunch(release: &Release) -> Result<(), String> {
    let destination = destination()?;
    let file = download_verified(&UreqClient::default(), release)?;
    if let Some(installed) = install(&file, destination.as_deref(), true)? {
        let mut command = if cfg!(target_os = "macos") {
            let mut open = std::process::Command::new("open");
            open.arg("-n").arg(&installed).arg("--args");
            open
        } else {
            std::process::Command::new(&installed)
        };
        command.arg(RELAUNCH_ARG).spawn().map_err(|e| e.to_string())?;
    }
    std::process::exit(0);
}

/// `…/opentrack.app` from `…/opentrack.app/Contents/MacOS/opentrack`.
fn app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_the_binary_runs_from() {
        let exe = Path::new("/Applications/opentrack 2.app/Contents/MacOS/opentrack");
        assert_eq!(app_bundle(exe), Some(PathBuf::from("/Applications/opentrack 2.app")));
        assert_eq!(app_bundle(Path::new("/usr/bin/opentrack")), None);
    }
}
