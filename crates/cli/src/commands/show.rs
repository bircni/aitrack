use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};

use aitrack_core::Core;
use aitrack_core::config::resolve_machine_id;
use aitrack_core::data::empty_state::{usage_empty_message, usage_empty_window_message};
use aitrack_core::data::local_data::build_machine_data;
use aitrack_core::data::types::MachineFile;
use aitrack_core::data::usage_report::machine_zones;
use aitrack_core::display::render_png::{RenderOptions, render_to_png};
use aitrack_core::display::tui::{TuiOptions, render_tui, tui_stats};
use aitrack_core::store::machine_files::write_pending_machine_file;
use aitrack_core::sync::read_local_provider_maps;
use clap::Args;
use serde_json::{Value, json};

use super::args::{PROVIDERS_HELP, REFRESH_HELP, parse_providers, parse_year, warn_stdout_path};
use super::report::{load, not_configured, print_empty_result};
use crate::json::print_json_command;
use crate::{Failure, Outcome};

#[derive(Args)]
pub struct ShowArgs {
    /// output file path (default: aitrack.png)
    #[arg(short, long, value_name = "path")]
    pub output: Option<PathBuf>,
    /// dark mode output
    #[arg(long)]
    pub dark: bool,
    #[arg(long, value_name = "list", help = PROVIDERS_HELP, value_parser = parse_providers)]
    pub providers: Option<Vec<String>>,
    /// single merged heatmap across all providers instead of one row per provider
    #[arg(long)]
    pub all: bool,
    /// do not auto-open the generated PNG (useful for scripts / CI)
    #[arg(long)]
    pub no_open: bool,
    /// only include days from this calendar year
    #[arg(long, value_name = "year", value_parser = parse_year)]
    pub year: Option<u64>,
    #[arg(long, help = REFRESH_HELP)]
    pub refresh: bool,
    /// render a stats table in the terminal instead of a PNG
    #[arg(long)]
    pub tui: bool,
    /// print machine-readable JSON (the stats with --tui, else the PNG path)
    #[arg(long)]
    pub json: bool,
}

fn open_file(core: &Core, path: &std::path::Path) {
    let opener = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let spawned =
        Command::new(opener).arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    if let Err(error) = spawned {
        core.output.warn(&format!("Could not run {opener} ({error}). Open the file manually or pass --no-open."));
    }
}

/// Keeps a read-only report working when the staging folder cannot be written.
fn staged_local_machine(core: &Core, machine_id: &str) -> Result<MachineFile, Failure> {
    let maps = read_local_provider_maps(core, None, None)?;
    let local = build_machine_data(machine_id, &maps, core.clock.zone_name(), core.clock.now(), false);
    if let Err(error) = write_pending_machine_file(core, &local) {
        core.output.warn(&format!("Could not stage local usage for a later init: {error}"));
    }
    Ok(local)
}

pub fn run(core: &Core, args: &ShowArgs) -> Outcome {
    warn_stdout_path(core, args.output.as_deref());
    if args.tui && args.output.is_some() {
        core.output.warn("--output is ignored with --tui, which writes no file.");
    }
    let config = core.try_load_config();
    // Staging lets a later `init` adopt usage recorded before the repo was set up.
    let local = if not_configured(core) {
        Some(staged_local_machine(core, &resolve_machine_id(config.as_ref())?)?)
    } else {
        None
    };
    let providers = args.providers.as_deref();
    let loaded = load(core, providers, args.refresh, local)?;
    let year = args.year.map(|y| i16::try_from(y).expect("years are at most 9999"));
    let empty_payload = if args.tui {
        let mut payload = json!({ "mode": "tui" });
        if let Some(year) = args.year {
            payload["year"] = json!(year);
        }
        payload["providers"] = json!([]);
        payload["total"] = Value::Null;
        payload
    } else {
        json!({ "mode": "png", "path": null })
    };
    let empty_message = || match args.year {
        None => usage_empty_message(not_configured(core), providers.unwrap_or_default()),
        Some(year) => usage_empty_window_message(Some(&year.to_string())),
    };
    let Some(loaded) = loaded else {
        print_empty_result(core, "show", args.json, &empty_message(), empty_payload);
        return Ok(ExitCode::SUCCESS);
    };
    let data = &loaded.zoned.provider_data;
    let tui_options = TuiOptions { dark: args.dark, all: args.all, year };
    let stats = tui_stats(data, &tui_options);
    if stats.rows.is_empty() {
        // A PNG here would be blank, and could replace a good one.
        print_empty_result(core, "show", args.json, &empty_message(), empty_payload);
        return Ok(ExitCode::SUCCESS);
    }
    let zones = machine_zones(core.clock.zone_name(), &loaded.zoned.zoned_sources);
    if !zones.is_empty() {
        core.output.info(&format!("Heatmap days are each machine's local dates ({}).", zones.join(", ")));
    }
    if args.tui && args.json {
        let mut payload = json!({ "mode": "tui" });
        if let Some(year) = args.year {
            payload["year"] = json!(year);
        }
        payload["providers"] = json!(stats.rows);
        payload["total"] = json!(stats.footer);
        print_json_command("show", payload);
        return Ok(ExitCode::SUCCESS);
    }
    if args.tui {
        core.output.info(&render_tui(data, &tui_options));
        return Ok(ExitCode::SUCCESS);
    }
    let output = aitrack_core::readers::paths::absolute(args.output.as_deref().unwrap_or("aitrack.png".as_ref()));
    let png = render_to_png(data, &RenderOptions { dark: args.dark, all: args.all, year });
    std::fs::write(&output, png)?;
    if args.json {
        print_json_command("show", json!({ "mode": "png", "path": output.display().to_string() }));
    } else {
        core.output.info(&format!("Saved: {}", output.display()));
    }
    if !args.no_open {
        open_file(core, &output);
    }
    Ok(ExitCode::SUCCESS)
}
