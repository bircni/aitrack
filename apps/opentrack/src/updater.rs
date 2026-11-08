//! Checks the latest GitHub release and installs it: the same manifest, key and installers 4.x's
//! Tauri updater used, so either version can update to the next.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aitrack_core::http::UreqClient;
use aitrack_core::update::{download_verified, is_newer, latest_release, updater_target, InstallTarget, Release};

use crate::app::{Bus, Msg};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_hours(6);

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

    /// Shortly after launch and then every few hours; development builds never update.
    pub fn watch(&self, bus: Bus) {
        if cfg!(debug_assertions) {
            return;
        }
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

/// A newer release, whether or not this copy can install it: a `.deb` install still hears of one.
fn newer_release() -> Result<Option<Release>, String> {
    if cfg!(debug_assertions) {
        return Err("Development builds do not update".into());
    }
    let release = latest_release(&UreqClient::default(), updater_target()?)?;
    Ok(is_newer(&release.version, env!("CARGO_PKG_VERSION")).then_some(release))
}

fn install_and_relaunch(release: &Release) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = InstallTarget::running(&exe, std::env::var_os("APPIMAGE").map(PathBuf::from))?;
    let file = download_verified(&UreqClient::default(), release)?;
    if let Some(mut relaunch) = target.replace_running(&file)? {
        crate::instance::release(); // So the new copy starts as the only one while this one exits.
        relaunch.spawn().map_err(|e| e.to_string())?;
    }
    std::process::exit(0);
}
