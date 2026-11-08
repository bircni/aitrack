#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod app;
mod background;
mod cache;
#[cfg(test)]
mod goldens;
mod instance;
#[cfg(target_os = "macos")]
mod macos;
mod pace;
mod panel;
mod position;
mod service;
mod settings;
mod state;
mod system;
mod tray;
mod tray_icon;
mod ui;
mod updater;
mod usage;
#[cfg(windows)]
mod windows;

use std::path::PathBuf;

use eframe::egui;

use crate::background::{smoke_test_lines, Background};
use crate::instance::{claim, data_dir, Instance};

/// `--smoke-test --data-dir <dir>`: the installer checks that a packaged build starts and reads its
/// settings, without touching provider credentials, usage logs or the sync repo.
fn smoke_test() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--smoke-test") {
        return false;
    }
    let data_dir = args
        .iter()
        .position(|arg| arg == "--data-dir")
        .and_then(|index| args.get(index + 1))
        .map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
    for line in smoke_test_lines(&Background::open(&data_dir)) {
        println!("{line}");
    }
    true
}

fn main() -> eframe::Result {
    if smoke_test() {
        return Ok(());
    }
    // `--data-dir` keeps a development run away from the installed app's settings and cache.
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .iter()
        .position(|arg| arg == "--data-dir")
        .and_then(|index| args.get(index + 1))
        .map_or_else(data_dir, PathBuf::from);
    let request = if args.iter().any(|arg| arg == "--settings") { "settings" } else { "show" };
    let listener = match claim(&dir, request) {
        Ok(Instance::First { _lock: lock, listener }) => {
            std::mem::forget(lock); // Held until the process exits.
            listener
        }
        Ok(Instance::Second) => return Ok(()),
        Err(error) => {
            eprintln!("opentrack: {}: {error}", dir.display());
            return Ok(());
        }
    };

    // Wayland compositors ignore window positions and block global shortcuts; XWayland honours both.
    #[cfg(target_os = "linux")]
    if std::env::var_os("OPENTRACK_WAYLAND").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::remove_var("WAYLAND_DISPLAY");
    }

    let background = Background::open(&dir);
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("opentrack")
            .with_inner_size([ui::WIDTH, 560.0])
            .with_resizable(false)
            .with_decorations(false)
            .with_transparent(cfg!(target_os = "macos"))
            .with_visible(false)
            .with_taskbar(false)
            .with_window_level(egui::WindowLevel::AlwaysOnTop)
            .with_active(false),
        event_loop_builder: Some(Box::new(|builder| {
            #[cfg(target_os = "macos")]
            {
                use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
                builder.with_activation_policy(ActivationPolicy::Accessory);
            }
            let _ = builder;
        })),
        ..Default::default()
    };
    eframe::run_native("opentrack", options, Box::new(move |cc| Ok(Box::new(app::App::new(cc, background, listener)))))
}
