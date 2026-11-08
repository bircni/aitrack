use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::config::resolve_machine_id;
use aitrack_core::data::empty_state::usage_empty_message;
use aitrack_core::data::stale_sync::is_stale_sync;
use aitrack_core::data::usage_data::{load_reported_machines, machine_usage_totals};
use aitrack_core::display::format::{fmt, fmt_usd_cost};
use aitrack_core::display::style;
use aitrack_core::display::terminal_table::{Align, Column, render_terminal_table};
use aitrack_core::providers::provider_label;
use serde::Serialize;
use serde_json::json;

use super::report::{not_configured, print_empty_result};
use crate::Outcome;
use crate::json::print_json_command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MachineSummary {
    hostname: String,
    timezone: String,
    last_updated: String,
    /// Synced before, but not in the last three days; never true for this machine.
    stale: bool,
    days: u64,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
    providers: Vec<String>,
    first_day: Option<String>,
    last_day: Option<String>,
}

#[allow(clippy::cast_precision_loss)]
pub fn run(core: &Core, json: bool) -> Outcome {
    let machines = load_reported_machines(core)?;
    if machines.is_empty() {
        let message = usage_empty_message(not_configured(core), &[]);
        print_empty_result(core, "machines", json, &message, json!({ "machines": [] }));
        return Ok(ExitCode::SUCCESS);
    }
    let config = core.try_load_config();
    let current = config.as_ref().map(|c| resolve_machine_id(Some(c))).transpose()?;
    let rates = core.pricing().current();
    let now = core.clock.now();
    let mut summaries: Vec<MachineSummary> = machines
        .iter()
        .map(|file| {
            let totals = machine_usage_totals(&rates, file);
            MachineSummary {
                hostname: file.hostname.clone(),
                timezone: file.timezone.clone(),
                last_updated: file.last_updated.clone(),
                stale: current.as_deref() != Some(file.hostname.as_str())
                    && is_stale_sync(&core.clock, &file.last_updated, now),
                days: totals.days,
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                total_tokens: totals.input_tokens + totals.output_tokens,
                cost_usd: totals.cost_usd,
                providers: totals.providers,
                first_day: totals.first_day.map(|d| d.to_string()),
                last_day: totals.last_day.map(|d| d.to_string()),
            }
        })
        .collect();
    summaries.sort_by_key(|s| std::cmp::Reverse(s.total_tokens));

    if json {
        print_json_command("machines", json!({ "machines": summaries }));
        return Ok(ExitCode::SUCCESS);
    }
    let columns = [
        Column { header: "Machine", align: Align::Left },
        Column { header: "Timezone", align: Align::Left },
        Column { header: "Days", align: Align::Right },
        Column { header: "Tokens", align: Align::Right },
        Column { header: "Cost", align: Align::Right },
        Column { header: "Last sync", align: Align::Left },
        Column { header: "Providers", align: Align::Left },
    ];
    let rows: Vec<Vec<String>> = summaries
        .iter()
        .map(|m| {
            let last = if m.last_updated.is_empty() {
                "not synced".to_owned()
            } else {
                format!(
                    "{}{}",
                    m.last_updated.get(..10).unwrap_or(&m.last_updated),
                    if m.stale { " (stale)" } else { "" }
                )
            };
            vec![
                m.hostname.clone(),
                m.timezone.clone(),
                m.days.to_string(),
                fmt(m.total_tokens as f64),
                m.cost_usd.map_or_else(|| "—".to_owned(), fmt_usd_cost),
                last,
                m.providers.iter().map(|p| provider_label(p)).collect::<Vec<_>>().join(", "),
            ]
        })
        .collect();
    core.output.info(&style::bold(&format!("aitrack machines ({})", summaries.len())));
    core.output.info(&render_terminal_table(&columns, &rows, None));
    Ok(ExitCode::SUCCESS)
}
