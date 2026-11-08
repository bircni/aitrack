//! What the OS applies for a setting: start at login and the global shortcut; plus alerts and links.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::mpsc::Sender;
use std::sync::LazyLock;

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

use crate::app::{Bus, Msg};
use crate::background::latest_worker;

/// Same JSON the 4.x renderer shipped.
static DASHBOARDS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../provider-dashboards.json")).expect("provider-dashboards.json")
});

pub fn open_dashboard(provider: &str) -> Result<(), String> {
    let url = DASHBOARDS.get(provider).ok_or_else(|| format!("No dashboard for {provider}"))?;
    open::that_detached(url).map_err(|error| error.to_string())
}

/// Off the UI thread: macOS delivers notifications through a blocking call.
pub fn notify(title: String, body: String) {
    std::thread::spawn(move || {
        let _ = notify_rust::Notification::new().summary(&title).body(&body).show();
    });
}

/// Why a setting the OS applies did not take; the settings keep what was typed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SettingErrors {
    pub launch_at_login: Option<String>,
    pub global_shortcut: Option<String>,
}

pub struct System {
    hotkeys: Option<GlobalHotKeyManager>,
    registered: Option<HotKey>,
    /// Writes a `LaunchAgent` or registry key off the UI thread, newest choice last; `None` in a dev
    /// build, which registering to start at login would outlive.
    launch_at_login: Option<Sender<bool>>,
}

impl System {
    /// On the main thread: macOS registers hotkeys there.
    pub fn new(bus: &Bus) -> Self {
        #[cfg(target_os = "macos")]
        let _ = notify_rust::set_application("dev.bircni.opentrack");
        let hotkey_bus = bus.clone();
        GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
            if event.state == HotKeyState::Pressed {
                hotkey_bus.send(Msg::Toggle(None));
            }
        }));
        let launch_bus = bus.clone();
        let launch_at_login = (!cfg!(debug_assertions))
            .then(|| latest_worker(move |enabled| launch_bus.send(Msg::LaunchAtLogin(autostart(enabled).err()))));
        Self { hotkeys: GlobalHotKeyManager::new().ok(), registered: None, launch_at_login }
    }

    /// The outcome comes back on the bus.
    pub fn set_launch_at_login(&self, enabled: bool) {
        if let Some(worker) = &self.launch_at_login {
            let _ = worker.send(enabled);
        }
    }

    /// Registers the open/close shortcut, here on the main thread as macOS requires; why it did not take.
    pub fn set_shortcut(&mut self, accelerator: &str) -> Option<String> {
        let manager = self.hotkeys.as_ref()?;
        if let Some(previous) = self.registered.take() {
            let _ = manager.unregister(previous);
        }
        let accelerator = accelerator.trim();
        if accelerator.is_empty() {
            return None;
        }
        let registered = HotKey::from_str(accelerator)
            .map_err(|e| e.to_string())
            .and_then(|hotkey| manager.register(hotkey).map(|()| hotkey).map_err(|e| e.to_string()));
        match registered {
            Ok(hotkey) => {
                self.registered = Some(hotkey);
                None
            }
            Err(error) => Some(error),
        }
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
