use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Limits the whole download rather than a stall, so a slow link still has to fit inside it.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// The newest release found on GitHub, kept until the user installs it.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
}

impl Updates {
    pub fn version(&self) -> Option<String> {
        self.pending.lock().unwrap().as_ref().map(|update| update.version.clone())
    }

    pub async fn install(&self, app: &AppHandle) -> Result<(), String> {
        let Some(mut update) = self.pending.lock().unwrap().clone() else {
            return Err("No update is available".into());
        };
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
        // Windows never gets here: the installer closes the app and starts the new one.
        app.restart();
    }
}

/// The newer version the latest release offers, if any; the renderer hears of it as an event too,
/// including `null` once a withdrawn release is no longer offered.
pub async fn check(app: &AppHandle) -> Result<Option<String>, String> {
    // A dev build would offer to replace itself with the installed release.
    if cfg!(debug_assertions) {
        return Err("Development builds do not update".into());
    }
    let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(|error| error.to_string())?;
    let found = updater.check().await.map_err(|error| error.to_string())?;
    let version = found.as_ref().map(|update| update.version.clone());
    *app.state::<Updates>().pending.lock().unwrap() = found;
    let _ = app.emit("update", &version);
    Ok(version)
}

/// Checks the latest GitHub release shortly after launch and then every few hours.
pub fn watch(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            // Offline or GitHub unreachable: the next check tries again, nothing to show.
            if let Err(error) = check(&app).await {
                eprintln!("opentrack: update check failed: {error}");
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}
