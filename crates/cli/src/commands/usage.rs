use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use aitrack_core::Core;
use aitrack_core::data::budget::{BudgetLevel, BudgetStatus, budget_status};
use aitrack_core::data::usage_periods::UsagePeriod;
use aitrack_core::data::usage_report::{
    ReportContext, ReportOptions, UsageComparisonMetric, UsageComparisonReport, UsageReport, UsageReportTotals,
    build_usage_comparison, build_usage_report, empty_report_message,
};
use aitrack_core::display::format::{fmt, fmt_count, fmt_usd_cost, to_fixed, unpriced_footnote};
use aitrack_core::display::model_names::display_model_name;
use aitrack_core::display::style;
use aitrack_core::display::terminal_table::{Align, Column, render_terminal_table};
use aitrack_core::readers::project::resolve_project_selector;
use clap::{Args, Subcommand};
use serde_json::{Value, json};

use super::args::{PROVIDERS_HELP, Providers, REFRESH_HELP, parse_providers, parse_watch_seconds};
use super::report::{load, not_configured};
use crate::json::print_json_command;
use crate::{Failure, Outcome};

const CLEAR_SCREEN: &str = "\u{1b}[H\u{1b}[2J";

#[derive(Args)]
pub struct UsageArgs {
    #[command(subcommand)]
    pub window: Window,
}

#[derive(Args, Clone)]
pub struct UsageOptions {
    #[arg(long, value_name = "list", help = PROVIDERS_HELP, value_parser = parse_providers)]
    pub providers: Option<Providers>,
    #[arg(long, help = REFRESH_HELP)]
    pub refresh: bool,
    /// compare with the equivalent previous period
    #[arg(long)]
    pub compare: bool,
    /// print a single line (cost · tokens) for status bars and prompts
    #[arg(long)]
    pub short: bool,
    /// only the project (origin remote) of this folder, default the current one; Cursor isn't attributed
    #[arg(long, value_name = "path", num_args = 0..=1, default_missing_value = ".")]
    pub dir: Option<PathBuf>,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
    /// redraw in place every N seconds (default 30, minimum 5); needs a terminal
    #[arg(long, value_name = "seconds", num_args = 0..=1, default_missing_value = "30", value_parser = parse_watch_seconds)]
    pub watch: Option<u64>,
}

#[derive(Subcommand)]
pub enum Window {
    /// Today's usage: provider / tokens / model / price
    Today(UsageOptions),
    /// Yesterday's usage
    Yesterday(UsageOptions),
    /// Usage for a specific date (YYYY-MM-DD)
    Date {
        date: String,
        #[command(flatten)]
        options: UsageOptions,
    },
    /// Usage for a custom date range (YYYY-MM-DD YYYY-MM-DD)
    Range {
        from: String,
        to: String,
        #[command(flatten)]
        options: UsageOptions,
    },
    /// Usage for the current calendar week (Mon–Sun)
    Thisweek(UsageOptions),
    /// Usage for the previous calendar week (Mon–Sun)
    Lastweek(UsageOptions),
    /// Rolling 7-day usage ending today
    Week(UsageOptions),
    /// Usage for the current calendar month
    Thismonth(UsageOptions),
    /// Usage for the previous calendar month
    Lastmonth(UsageOptions),
    /// Rolling 30-day usage ending today
    Month(UsageOptions),
    /// Rolling N-day usage ending today, e.g. last 14
    Last {
        n: String,
        #[command(flatten)]
        options: UsageOptions,
    },
    /// Usage for the current calendar year
    Year(UsageOptions),
    /// All-time usage across every recorded day
    All(UsageOptions),
}

impl Window {
    /// The period, its extra arguments, and the options.
    pub fn parts(&self) -> (UsagePeriod, Vec<String>, &UsageOptions) {
        match self {
            Self::Today(o) => (UsagePeriod::Today, Vec::new(), o),
            Self::Yesterday(o) => (UsagePeriod::Yesterday, Vec::new(), o),
            Self::Date { date, options } => (UsagePeriod::Date, vec![date.clone()], options),
            Self::Range { from, to, options } => (UsagePeriod::Range, vec![from.clone(), to.clone()], options),
            Self::Thisweek(o) => (UsagePeriod::ThisWeek, Vec::new(), o),
            Self::Lastweek(o) => (UsagePeriod::LastWeek, Vec::new(), o),
            Self::Week(o) => (UsagePeriod::Week, Vec::new(), o),
            Self::Thismonth(o) => (UsagePeriod::ThisMonth, Vec::new(), o),
            Self::Lastmonth(o) => (UsagePeriod::LastMonth, Vec::new(), o),
            Self::Month(o) => (UsagePeriod::Month, Vec::new(), o),
            Self::Last { n, options } => (UsagePeriod::Last, vec![n.clone()], options),
            Self::Year(o) => (UsagePeriod::Year, Vec::new(), o),
            Self::All(o) => (UsagePeriod::All, Vec::new(), o),
        }
    }
}

impl UsageArgs {
    pub fn json(&self) -> bool {
        self.window.parts().2.json
    }
}

fn price_cell(has_cost: bool, cost: f64, unpriced: bool) -> String {
    if has_cost {
        format!("{}{}", fmt_usd_cost(cost), if unpriced { " (partial)" } else { "" })
    } else {
        "—".to_owned()
    }
}

fn short_line(totals: &UsageReportTotals) -> String {
    let tokens = format!("{} tokens", fmt_count(totals.tokens));
    if totals.has_cost {
        format!("{} · {tokens}", price_cell(true, totals.cost_usd, totals.has_unpriced_tokens))
    } else {
        tokens
    }
}

fn format_delta(metric: &UsageComparisonMetric, formatter: fn(f64) -> String) -> String {
    if metric.delta == 0.0 {
        return format!("{} (0.0%)", formatter(0.0));
    }
    let sign = if metric.delta > 0.0 { "+" } else { "−" };
    let percent = match metric.percent_change {
        None if metric.current > 0.0 => "new".to_owned(),
        None => "—".to_owned(),
        Some(p) => format!("{}{}%", if p > 0.0 { "+" } else { "" }, to_fixed(p, 1)),
    };
    format!("{sign}{} ({percent})", formatter(metric.delta.abs()))
}

fn render_usage_report(core: &Core, report: &UsageReport) {
    let rows: Vec<Vec<String>> = report
        .providers
        .iter()
        .flat_map(|provider| {
            provider.rows.iter().map(|row| {
                vec![
                    provider.label.clone(),
                    fmt_count(row.tokens),
                    display_model_name(&row.model, true),
                    price_cell(row.has_cost, row.cost_usd, row.has_unpriced_tokens),
                ]
            })
        })
        .collect();
    let totals = &report.totals;
    let footer = vec![
        "TOTAL".to_owned(),
        fmt_count(totals.tokens),
        String::new(),
        price_cell(totals.has_cost, totals.cost_usd, totals.has_unpriced_tokens),
    ];
    let columns = [
        Column { header: "Provider", align: Align::Left },
        Column { header: "Tokens", align: Align::Right },
        Column { header: "Model", align: Align::Left },
        Column { header: "Price", align: Align::Right },
    ];
    core.output.info(&style::bold(&format!("aitrack usage {}", report.window_label)));
    if let Some(project) = &report.project {
        core.output.info(&style::bold(&format!("Project: {}", project.label)));
    }
    core.output.info(&render_terminal_table(&columns, &rows, Some((&footer, style::bold_cyan))));
}

fn render_project_notes(core: &Core, report: Option<&UsageReport>) {
    let Some(project) = report.and_then(|r| r.project.as_ref()) else { return };
    if report.is_some_and(|r| r.row_count == 0) {
        core.output.info(&format!("Project: {}", project.label));
    }
    for note in &project.notes {
        core.output.info(&style::dim(note));
    }
}

fn render_comparison(core: &Core, report: &UsageComparisonReport) {
    let UsageComparisonReport { comparison, current, previous } = report;
    let cost = |t: &UsageReportTotals| if t.has_cost { fmt_usd_cost(t.cost_usd) } else { "—".to_owned() };
    let summary = vec![
        vec![
            "Tokens".to_owned(),
            fmt_count(current.totals.tokens),
            fmt_count(previous.totals.tokens),
            format_delta(&comparison.totals.tokens, fmt),
        ],
        vec![
            "Cost".to_owned(),
            cost(&current.totals),
            cost(&previous.totals),
            if comparison.totals.has_cost {
                format_delta(&comparison.totals.cost_usd, fmt_usd_cost)
            } else {
                "—".to_owned()
            },
        ],
    ];
    core.output.info("");
    core.output.info(&style::bold(&format!("Compared with {}", comparison.previous_window_label)));
    if comparison.totals.has_unpriced_tokens && comparison.totals.has_cost {
        core.output.info("Cost comparison is a partial estimate: some usage is unpriced.");
    }
    let columns = [
        Column { header: "Metric", align: Align::Left },
        Column { header: "Current", align: Align::Right },
        Column { header: "Previous", align: Align::Right },
        Column { header: "Change", align: Align::Right },
    ];
    core.output.info(&render_terminal_table(&columns, &summary, None));

    let movement: Vec<Vec<String>> = comparison
        .models
        .iter()
        .filter(|m| m.tokens.delta != 0.0 || m.cost_usd.delta != 0.0)
        .map(|m| {
            vec![
                m.provider_label.clone(),
                display_model_name(&m.model, true),
                format_delta(&m.tokens, fmt),
                if m.has_cost { format_delta(&m.cost_usd, fmt_usd_cost) } else { "—".to_owned() },
            ]
        })
        .collect();
    if movement.is_empty() {
        core.output.info("\nNo per-model movement.");
        return;
    }
    core.output.info("");
    core.output.info(&style::bold("Per-model movement"));
    let columns = [
        Column { header: "Provider", align: Align::Left },
        Column { header: "Model", align: Align::Left },
        Column { header: "Tokens Δ", align: Align::Right },
        Column { header: "Cost Δ", align: Align::Right },
    ];
    core.output.info(&render_terminal_table(&columns, &movement, None));
}

/// Only for `thismonth`: the rolling 30-day `month` is not a calendar month.
fn resolve_budget(core: &Core, period: UsagePeriod, report: &UsageReport) -> Option<BudgetStatus> {
    if period != UsagePeriod::ThisMonth || !report.totals.has_cost {
        return None;
    }
    let monthly = core.try_load_config()?.budget?.monthly_usd?;
    budget_status(report.totals.cost_usd, monthly)
}

fn render_budget_line(core: &Core, status: &BudgetStatus) {
    let percent = format!("{}%", aitrack_core::quota::pacing::js_round(status.ratio * 100.0));
    let head = format!(
        "Budget: {} of {} this month ({percent})",
        fmt_usd_cost(status.spent_usd),
        fmt_usd_cost(status.budget_usd)
    );
    core.output.info(&match status.level {
        BudgetLevel::Over => style::red(&format!("⚠ {head} — over by {}", fmt_usd_cost(status.over_usd))),
        BudgetLevel::Warn => style::yellow(&format!("⚠ {head} — approaching your limit")),
        BudgetLevel::Ok => style::dim(&head),
    });
}

fn usage_once(core: &Core, options: &UsageOptions, report_options: &ReportOptions) -> Result<(), Failure> {
    let providers = options.providers.as_deref();
    let loaded = load(core, providers, options.refresh, None)?;
    let rates = core.pricing().current();
    let context = ReportContext { pricing: &rates, clock: &core.clock, now: core.clock.now() };
    let (report, comparison) = match &loaded {
        None => (None, None),
        Some(loaded) if options.compare => {
            let comparison = build_usage_comparison(&context, &loaded.zoned, report_options).map_err(Failure::usage)?;
            (Some(comparison.current.clone()), Some(comparison))
        }
        Some(loaded) => {
            (Some(build_usage_report(&context, &loaded.zoned, report_options).map_err(Failure::usage)?), None)
        }
    };
    let budget = report.as_ref().and_then(|r| resolve_budget(core, report_options.period, r));
    let message = || empty_report_message(report.as_ref(), not_configured(core), providers.unwrap_or_default());

    if options.json {
        let mut payload = json!({
            "windowLabel": report.as_ref().map(|r| r.window_label.clone()),
            "providers": report.as_ref().map_or_else(|| json!([]), |r| json!(r.providers)),
            "totals": report.as_ref().map_or_else(|| json!(UsageReportTotals::default()), |r| json!(r.totals)),
            "rowCount": report.as_ref().map_or(0, |r| r.row_count),
        });
        if options.compare {
            payload["comparison"] = comparison.as_ref().map_or(Value::Null, |c| json!(c.comparison));
        }
        if let Some(budget) = &budget {
            payload["budget"] = json!(budget);
        }
        if let Some(note) = report.as_ref().and_then(|r| r.timezone_note.as_ref()) {
            payload["timezoneNote"] = json!(note);
        }
        if let Some(project) = report.as_ref().and_then(|r| r.project.as_ref()) {
            payload["project"] = json!(project);
        }
        if let Some(message) = message() {
            payload["message"] = json!(message);
        }
        print_json_command("usage", payload);
        return Ok(());
    }

    if options.short {
        // An empty window prints nothing so a status bar stays blank.
        if let Some(report) = report.as_ref().filter(|r| r.row_count > 0) {
            core.output.info(&short_line(&report.totals));
        }
        return Ok(());
    }

    let Some(report) = report.as_ref().filter(|r| r.row_count > 0) else {
        if let Some(message) = message() {
            core.output.info(&message);
        }
        render_project_notes(core, report.as_ref());
        return Ok(());
    };
    render_usage_report(core, report);
    if let Some(footnote) = unpriced_footnote(report.totals.unpriced_models.as_deref().unwrap_or_default()) {
        core.output.info(&style::dim(&footnote));
    }
    if let Some(note) = &report.timezone_note {
        core.output.info(&style::dim(note));
    }
    render_project_notes(core, Some(report));
    if let Some(budget) = &budget {
        render_budget_line(core, budget);
        if report.totals.has_unpriced_tokens {
            core.output.info("Budget spend is a partial estimate.");
        }
    }
    if let Some(comparison) = &comparison {
        render_comparison(core, comparison);
    }
    Ok(())
}

pub fn run(core: &Core, args: &UsageArgs) -> Outcome {
    let (period, period_args, options) = args.window.parts();
    if options.watch.is_some() && options.json {
        return Err(Failure::usage("--watch cannot be combined with --json."));
    }
    if options.short && options.json {
        core.output.warn("--short is ignored with --json.");
    } else if options.short && options.compare {
        core.output.warn("--compare is ignored with --short.");
    }
    if options.compare && period == UsagePeriod::All {
        return Err(Failure::usage("--compare needs a finite window; \"all\" has no previous period."));
    }
    let parsed = period.parse_args(&period_args).map_err(Failure::usage)?;
    // Once: resolving spawns git, too much for each --watch tick.
    let project = options
        .dir
        .as_deref()
        .map(resolve_project_selector)
        .transpose()
        .map_err(|e| Failure::usage(format!("--dir: {e}")))?;
    let report_options = ReportOptions { period, args: parsed, project };
    let Some(seconds) = options.watch else {
        usage_once(core, options, &report_options)?;
        return Ok(ExitCode::SUCCESS);
    };
    if !std::io::stdout().is_terminal() {
        return Err(Failure::usage("--watch needs an interactive terminal (stdout is not a TTY)."));
    }
    loop {
        print!("{CLEAR_SCREEN}");
        let _ = std::io::stdout().flush();
        usage_once(core, options, &report_options)?;
        std::thread::sleep(Duration::from_secs(seconds));
    }
}
