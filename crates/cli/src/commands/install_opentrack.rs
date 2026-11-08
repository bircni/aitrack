use std::path::{Path, PathBuf};
use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::update::{InstallTarget, download_verified, latest_release, updater_target};
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
    let updater = updater_target()?;
    let default_dir = InstallTarget::default_dir(core.env.home());
    let target = match (&args.dir, default_dir) {
        (Some(_), None) => {
            return Err(Failure::usage(
                "--dir applies to macOS and Linux only; the Windows installer chooses its own folder.",
            ));
        }
        (dir, default) => {
            default.map_or(InstallTarget::WindowsInstaller, |d| InstallTarget::fresh(dir.as_ref().unwrap_or(&d)))
        }
    };
    if let Some(folder) = target.folder() {
        std::fs::create_dir_all(folder)?; // Before a download that a bad folder would waste.
    }
    let release = latest_release(core.http.as_ref(), updater)?;
    core.output.info(&format!("Downloading opentrack {}...", release.version));
    let file = download_verified(core.http.as_ref(), &release)?;
    if target == InstallTarget::WindowsInstaller {
        core.output.info("Running the opentrack installer...");
    }
    let path = target.install(&file)?;
    let next = match target {
        InstallTarget::AppImage(_) => "Run it to start opentrack; Settings can launch it at login. It updates itself.",
        InstallTarget::MacBundle(_) | InstallTarget::WindowsInstaller => {
            "It updates itself from now on. If it was running, quit and reopen it."
        }
    };
    report_installed(core, args.json, &release.version, path.as_deref(), next);
    Ok(ExitCode::SUCCESS)
}
