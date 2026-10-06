use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

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
        let Some(update) = self.pending.lock().unwrap().clone() else {
            return Err("No update is available".into());
        };
        update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
        // Windows never gets here: the installer closes the app and starts the new one.
        app.restart();
    }
}

async fn check(app: &AppHandle) {
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    match found {
        Ok(Some(update)) => {
            let _ = app.emit("update", &update.version);
            *app.state::<Updates>().pending.lock().unwrap() = Some(update);
        }
        Ok(None) => {}
        // Offline or GitHub unreachable: the next check tries again, nothing to show.
        Err(error) => eprintln!("opentrack: update check failed: {error}"),
    }
}

/// Checks the latest GitHub release shortly after launch and then every few hours.
pub fn watch(app: AppHandle) {
    // A dev build would offer to replace itself with the installed release.
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}
