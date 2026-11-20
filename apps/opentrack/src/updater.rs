//! Checks the latest GitHub release and installs it: the same manifest, key and installers 4.x's
//! Tauri updater used, so either version can update to the next.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aitrack_core::http::UreqClient;
use aitrack_core::output::Level;
use aitrack_core::update::{download_verified, is_newer, latest_release, updater_target, InstallTarget, Release};

use crate::app::{Bus, Msg};
use crate::logs::LogOutput;
use aitrack_core::Locked;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_hours(6);

#[derive(Clone)]
pub struct Updater {
    pending: Arc<Mutex<Option<Release>>>,
    log: LogOutput,
}

impl Updater {
    pub fn new(log: LogOutput) -> Self {
        Self { pending: Arc::default(), log }
    }

    /// Sends the newer version on offer, if any. Only a check the user asked for reports a failure;
    /// a background one that finds the network down just tries again later.
    pub fn check(&self, bus: &Bus, asked: bool) {
        let found = newer_release();
        let status = match &found {
            Ok(Some(newer)) => format!("ok available={}", newer.version),
            Ok(None) => "ok current".into(),
            Err(error) => format!("failed: {error}"),
        };
        self.log.status(if found.is_ok() { Level::Info } else { Level::Warn }, "update-check", &status);
        match found {
            Ok(newer) => {
                let version = newer.as_ref().map(|r| r.version.clone());
                *self.pending.locked() = newer;
                bus.send(Msg::UpdateFound(version));
            }
            Err(error) if asked => bus.send(Msg::UpdateCheckFailed(error)),
            Err(_) => {}
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
        let Some(release) = self.pending.locked().clone() else {
            bus.send(Msg::UpdateInstallFailed("No update is available".into()));
            return;
        };
        let log = self.log.clone();
        std::thread::spawn(move || {
            log.event(Level::Info, &format!("update-install started version={}", release.version));
            if let Err(error) = install_and_relaunch(&release) {
                log.event(Level::Error, &format!("update-install failed: {error}"));
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

fn running_target() -> Result<InstallTarget, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    InstallTarget::running(&exe, std::env::var_os("APPIMAGE").map(PathBuf::from))
}

/// How to get a newer release when this copy cannot install it itself.
pub fn manual_update() -> Option<String> {
    running_target().err()
}

fn install_and_relaunch(release: &Release) -> Result<(), String> {
    let target = running_target()?;
    let file = download_verified(&UreqClient::default(), release)?;
    if let Some(mut relaunch) = target.replace_running(&file)? {
        crate::instance::release(); // So the new copy starts as the only one while this one exits.
        relaunch.spawn().map_err(|e| e.to_string())?;
    }
    std::process::exit(0);
}
