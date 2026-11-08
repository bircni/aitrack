//! Checks the latest GitHub release and installs it: the same manifest, key and installers 4.x's
//! Tauri updater used, so either version can update to the next.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aitrack_core::http::UreqClient;
use aitrack_core::update::{
    download_verified, install_app_image, install_mac_app, is_newer, latest_release, run_windows_installer,
    updater_target, Release,
};

use crate::app::{Bus, Msg};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Default)]
pub struct Updater {
    pending: Arc<Mutex<Option<Release>>>,
}

impl Updater {
    /// The newer version on offer, if any; sends it to the popup as well.
    pub fn check(&self, bus: &Bus) {
        let result = if cfg!(debug_assertions) {
            Err("Development builds do not update".to_owned())
        } else {
            updater_target().and_then(|target| latest_release(&UreqClient::default(), target))
        };
        match result {
            Ok(release) => {
                let newer = is_newer(&release.version, env!("CARGO_PKG_VERSION")).then_some(release);
                let version = newer.as_ref().map(|r| r.version.clone());
                *self.pending.lock().unwrap() = newer;
                bus.send(Msg::UpdateFound(version));
            }
            Err(error) => bus.send(Msg::UpdateCheckFailed(error)),
        }
    }

    /// Shortly after launch and then every few hours; offline just means the next check tries again.
    pub fn watch(&self, bus: Bus) {
        if cfg!(debug_assertions) {
            return;
        }
        let updater = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                updater.check(&bus);
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
            if let Err(error) = install(&release) {
                bus.send(Msg::UpdateInstallFailed(error));
            }
        });
    }
}

fn install(release: &Release) -> Result<(), String> {
    let file = download_verified(&UreqClient::default(), release)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if cfg!(windows) {
        // The installer closes this process and starts the new one, as Tauri's passive mode did.
        run_windows_installer(&file, &["/P", "/R"], false)?;
        std::process::exit(0);
    }
    if cfg!(target_os = "macos") {
        let bundle = app_bundle(&exe).ok_or("opentrack is not running from an app bundle")?;
        let dir = bundle.parent().ok_or("opentrack.app has no folder")?;
        let installed = install_mac_app(&file, dir)?;
        std::process::Command::new("open").arg("-n").arg(&installed).spawn().map_err(|e| e.to_string())?;
        std::process::exit(0);
    }
    let app_image = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or("Only the AppImage updates itself; update the .deb with your package manager.")?;
    let installed = install_app_image(&file, &app_image)?;
    std::process::Command::new(&installed).spawn().map_err(|e| e.to_string())?;
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
        let exe = Path::new("/Applications/opentrack.app/Contents/MacOS/opentrack");
        assert_eq!(app_bundle(exe), Some(PathBuf::from("/Applications/opentrack.app")));
        assert_eq!(app_bundle(Path::new("/usr/bin/opentrack")), None);
    }
}
