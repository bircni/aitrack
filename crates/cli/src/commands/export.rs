use std::path::PathBuf;
use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::data::usage_periods::{USAGE_PERIODS, UsagePeriod};
use aitrack_core::data::usage_report::{ReportContext, ReportOptions, build_usage_report, empty_report_message};
use aitrack_core::display::csv::render_usage_report_csv;
use aitrack_core::display::pdf::render_receipt_pdf;
use aitrack_core::display::style;
use clap::Args;
use serde_json::json;

use super::args::{PROVIDERS_HELP, REFRESH_HELP, parse_providers, warn_stdout_path};
use super::report::{load, not_configured};
use crate::json::print_json_command;
use crate::{Failure, Outcome};

#[derive(Args)]
#[command(after_help = window_help())]
pub struct ExportArgs {
    pub window: Option<String>,
    pub args: Vec<String>,
    /// output path (default: aitrack-receipt.pdf, or .csv with --csv)
    #[arg(short, long, value_name = "path")]
    pub output: Option<PathBuf>,
    /// write a spreadsheet-friendly CSV instead of the PDF receipt
    #[arg(long)]
    pub csv: bool,
    #[arg(long, value_name = "list", help = PROVIDERS_HELP, value_parser = parse_providers)]
    pub providers: Option<Vec<String>>,
    #[arg(long, help = REFRESH_HELP)]
    pub refresh: bool,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

fn window_help() -> String {
    let width = USAGE_PERIODS.iter().map(|d| d.name.chars().count()).max().unwrap_or(0);
    let rows: Vec<String> = USAGE_PERIODS
        .iter()
        .map(|d| format!("  {}{}  {}", d.name, " ".repeat(width - d.name.chars().count()), d.description))
        .collect();
    format!("Windows:\n{}\n\nExample: aitrack export last 14 --csv", rows.join("\n"))
}

fn report_options(args: &ExportArgs) -> Result<ReportOptions, Failure> {
    let key = args.window.as_deref().unwrap_or("month");
    let Some(period) = UsagePeriod::parse(key) else {
        let periods = USAGE_PERIODS.iter().map(|d| d.key).collect::<Vec<_>>().join(", ");
        return Err(Failure::usage(format!("Invalid window: \"{key}\". Expected one of: {periods}.")));
    };
    let parsed = period.parse_args(&args.args).map_err(Failure::usage)?;
    Ok(ReportOptions { period, args: parsed, project: None })
}

pub fn run(core: &Core, args: &ExportArgs) -> Outcome {
    warn_stdout_path(core, args.output.as_deref());
    let options = report_options(args)?;
    let providers = args.providers.as_deref();
    let loaded = load(core, providers, args.refresh, None)?;
    let rates = core.pricing().current();
    let context = ReportContext { pricing: &rates, clock: &core.clock, now: core.clock.now() };
    let report = loaded
        .map(|loaded| build_usage_report(&context, &loaded.zoned, &options))
        .transpose()
        .map_err(Failure::usage)?;
    let format = if args.csv { "csv" } else { "pdf" };
    let Some(report) = report.as_ref().filter(|r| r.row_count > 0) else {
        let message = empty_report_message(report.as_ref(), not_configured(core), providers.unwrap_or_default());
        if args.json {
            let mut payload = json!({
                "path": null,
                "format": format,
                "rowCount": 0,
                "windowLabel": report.as_ref().map(|r| r.window_label.clone()),
            });
            if let Some(message) = message {
                payload["message"] = json!(message);
            }
            print_json_command("export", payload);
        } else if let Some(message) = message {
            core.output.info(&message);
        }
        return Ok(ExitCode::SUCCESS);
    };
    let output = args.output.clone().unwrap_or_else(|| format!("aitrack-receipt.{format}").into());
    let bytes = if args.csv {
        render_usage_report_csv(report).into_bytes()
    } else {
        render_receipt_pdf(report, core.clock.now())
    };
    std::fs::write(&output, bytes)?;
    if args.json {
        print_json_command(
            "export",
            json!({ "path": output.display().to_string(), "format": format, "rowCount": report.row_count, "windowLabel": report.window_label }),
        );
    } else {
        let kind = if args.csv { "CSV" } else { "receipt" };
        core.output.info(&style::bold(&format!("Wrote {kind} for {} → {}", report.window_label, output.display())));
    }
    Ok(ExitCode::SUCCESS)
}
