use std::path::{Path, PathBuf};
use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::update::{download_verified, install, install_name, latest_release, updater_target};
use clap::Args;
use serde_json::json;

use crate::json::print_json_command;
use crate::{Failure, Outcome};

#[derive(Args)]
pub struct InstallArgs {
    /// folder for opentrack.app on macOS (default: /Applications) or opentrack.AppImage on Linux (default: ~/.local/bin)
    #[arg(long, value_name = "path")]
    pub dir: Option<PathBuf>,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

fn report_installed(core: &Core, json: bool, version: &str, path: Option<&Path>, next_step: &str) {
    if json {
        print_json_command(
            "install-opentrack",
            json!({ "version": version, "path": path.map(|p| p.display().to_string()) }),
        );
        return;
    }
    let to = path.map_or_else(String::new, |p| format!(" to {}", p.display()));
    core.output.info(&format!("Installed opentrack {version}{to}."));
    if path.is_some() {
        core.output.info(next_step);
    }
}

pub fn run(core: &Core, args: &InstallArgs) -> Outcome {
    let target = updater_target()?;
    let windows = cfg!(windows);
    if windows && args.dir.is_some() {
        return Err(Failure::usage(
            "--dir applies to macOS and Linux only; the Windows installer chooses its own folder.",
        ));
    }
    let default_dir = if cfg!(target_os = "linux") {
        core.env.home().join(".local").join("bin")
    } else {
        PathBuf::from("/Applications")
    };
    let dir = args.dir.clone().unwrap_or(default_dir);
    if !windows {
        std::fs::create_dir_all(&dir)?; // Before a download that a bad folder would waste.
    }
    let release = latest_release(core.http.as_ref(), target)?;
    core.output.info(&format!("Downloading opentrack {}...", release.version));
    let file = download_verified(core.http.as_ref(), &release)?;
    if windows {
        core.output.info("Running the opentrack installer...");
    }
    let path = install(&file, Some(&dir.join(install_name())), false)?;
    let next = if cfg!(target_os = "linux") {
        "Run it to start opentrack; Settings can launch it at login. It updates itself."
    } else {
        "It updates itself from now on. If it was running, quit and reopen it."
    };
    report_installed(core, args.json, &release.version, path.as_deref(), next);
    Ok(ExitCode::SUCCESS)
}
