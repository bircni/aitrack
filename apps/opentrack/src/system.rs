//! What the OS applies for a setting: start at login and the global shortcut; plus alerts and links.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::LazyLock;

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use indexmap::IndexMap;

use crate::app::{Bus, Msg};
use crate::settings::Settings;

/// Same JSON the 4.x renderer shipped.
static DASHBOARDS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../provider-dashboards.json")).expect("provider-dashboards.json")
});

pub fn open_dashboard(provider: &str) -> Result<(), String> {
    let url = DASHBOARDS.get(provider).ok_or_else(|| format!("No dashboard for {provider}"))?;
    open::that_detached(url).map_err(|error| error.to_string())
}

pub fn notify(title: &str, body: &str) {
    let _ = notify_rust::Notification::new().summary(title).body(body).show();
}

pub struct System {
    hotkeys: Option<GlobalHotKeyManager>,
    registered: Option<HotKey>,
}

impl System {
    /// On the main thread: macOS registers hotkeys there.
    pub fn new(bus: &Bus) -> Self {
        #[cfg(target_os = "macos")]
        let _ = notify_rust::set_application("dev.bircni.opentrack");
        let bus = bus.clone();
        GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
            if event.state == HotKeyState::Pressed {
                bus.send(Msg::Toggle(None));
            }
        }));
        Self { hotkeys: GlobalHotKeyManager::new().ok(), registered: None }
    }

    /// Why a setting did not take, keyed like the settings; the settings keep what was typed.
    pub fn apply(&mut self, settings: &Settings) -> IndexMap<String, String> {
        let mut errors = IndexMap::new();
        // A dev build registering itself to start at login would outlive the checkout.
        if !cfg!(debug_assertions) {
            if let Err(error) = autostart(settings.launch_at_login) {
                errors.insert("launchAtLogin".to_owned(), error);
            }
        }
        if let Some(manager) = &self.hotkeys {
            if let Some(previous) = self.registered.take() {
                let _ = manager.unregister(previous);
            }
            let accelerator = settings.global_shortcut.trim();
            if !accelerator.is_empty() {
                match HotKey::from_str(accelerator)
                    .map_err(|e| e.to_string())
                    .and_then(|hotkey| manager.register(hotkey).map(|()| hotkey).map_err(|e| e.to_string()))
                {
                    Ok(hotkey) => self.registered = Some(hotkey),
                    Err(error) => {
                        errors.insert("globalShortcut".to_owned(), error);
                    }
                }
            }
        }
        errors
    }
}

fn autostart(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let launch = auto_launch::AutoLaunchBuilder::new()
        .set_app_name("opentrack")
        .set_app_path(&exe.to_string_lossy())
        .set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent)
        .build()
        .map_err(|e| e.to_string())?;
    let result = if enabled {
        launch.enable()
    } else if launch.is_enabled().unwrap_or(false) {
        launch.disable()
    } else {
        Ok(())
    };
    result.map_err(|e| e.to_string())
}
