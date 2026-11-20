#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod app;
mod background;
mod cache;
#[cfg(test)]
mod goldens;
mod instance;
mod logs;
#[cfg(target_os = "macos")]
mod macos;
mod pace;
mod panel;
mod platform;
mod position;
mod service;
mod settings;
mod settings_sync;
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

use aitrack_core::output::Level;
use eframe::egui;

use crate::background::{smoke_test_line, Background};
use crate::instance::{claim, data_dir, Request};

/// What the command line asks for.
struct Args {
    /// Keeps a development run, or the installer's smoke test, away from the installed app's data.
    data_dir: Option<PathBuf>,
    /// The installer checks that a packaged build starts and reads its settings, without touching
    /// provider credentials, usage logs or the sync repo.
    smoke_test: bool,
    /// `None` starts in the tray.
    request: Option<Request>,
}

impl Args {
    fn parse() -> Self {
        let args: Vec<String> = std::env::args().collect();
        let has = |flag: &str| args.iter().any(|arg| arg == flag);
        Self {
            data_dir: args.iter().position(|arg| arg == "--data-dir").and_then(|i| args.get(i + 1)).map(PathBuf::from),
            smoke_test: has("--smoke-test"),
            request: has("--settings").then_some(Request::Settings),
        }
    }
}

fn main() -> eframe::Result {
    let args = Args::parse();
    if args.smoke_test {
        let dir = args.data_dir.unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        println!("{}", smoke_test_line(&Background::open(&dir)));
        return Ok(());
    }
    let dir = args.data_dir.unwrap_or_else(data_dir);
    let listener = match claim(&dir, args.request.unwrap_or(Request::Show)) {
        Ok(Some(listener)) => listener,
        Ok(None) => return Ok(()),
        Err(error) => {
            eprintln!("opentrack: {}: {error}", dir.display());
            logs::LogOutput::append(&dir).event(Level::Error, &format!("instance failed: {error}"));
            return Ok(());
        }
    };
    platform::prepare();
    let background = Background::open(&dir);
    background.log().event(Level::Info, &logs::start_line(&dir));
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("opentrack")
            .with_inner_size([ui::WIDTH, ui::INITIAL_HEIGHT])
            .with_resizable(false)
            .with_decorations(false)
            .with_transparent(platform::TRANSPARENT)
            .with_visible(false)
            .with_taskbar(false)
            .with_window_level(egui::WindowLevel::AlwaysOnTop)
            .with_active(false),
        event_loop_builder: Some(Box::new(platform::configure_event_loop)),
        ..Default::default()
    };
    eframe::run_native(
        "opentrack",
        options,
        Box::new(move |cc| Ok(Box::new(app::App::new(cc, background, dir, listener, args.request)))),
    )
}
