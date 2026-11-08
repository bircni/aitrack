use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::data::aggregate::DateFilter;
use aitrack_core::data::empty_state::{usage_empty_message, usage_empty_window_message};
use aitrack_core::data::top_usage::{
    TopSort, top_days, top_models, top_projects, top_provider_key, unpriced_top_models,
};
use aitrack_core::data::types::ProviderData;
use aitrack_core::day::Day;
use aitrack_core::display::format::{fmt, fmt_usd_cost, unpriced_footnote};
use aitrack_core::display::model_names::display_model_name;
use aitrack_core::display::style;
use aitrack_core::display::terminal_table::{Align, Column, render_terminal_table};
use aitrack_core::providers::provider_label;
use clap::{Args, ValueEnum};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use super::args::{
    PROVIDERS_HELP, Providers, REFRESH_HELP, parse_date, parse_positive_int, parse_providers, parse_year,
};
use super::report::{load, not_configured, print_empty_result};
use crate::json::print_json_command;
use crate::{Failure, Outcome};

const PROJECTS_NOTE: &str = "Cursor usage is not attributed to projects and is not counted here.";

#[derive(Clone, Copy, ValueEnum)]
pub enum TopKind {
    Days,
    Models,
    Projects,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum TopSortArg {
    Tokens,
    Cost,
}

#[derive(Args)]
pub struct TopArgs {
    /// what to rank
    #[arg(value_enum, default_value = "days")]
    pub kind: TopKind,
    /// number of items to show
    #[arg(short = 'n', long, value_name = "n", default_value = "10", value_parser = parse_positive_int)]
    pub limit: u64,
    /// sort field
    #[arg(long, value_name = "field", value_enum, default_value = "cost")]
    pub sort: TopSortArg,
    #[arg(long, value_name = "list", help = PROVIDERS_HELP, value_parser = parse_providers)]
    pub providers: Option<Providers>,
    /// only include days from this calendar year
    #[arg(long, value_name = "year", value_parser = parse_year)]
    pub year: Option<u64>,
    /// only include days on or after this date (YYYY-MM-DD)
    #[arg(long, value_name = "date", value_parser = parse_date)]
    pub since: Option<Day>,
    /// only include days on or before this date (YYYY-MM-DD)
    #[arg(long, value_name = "date", value_parser = parse_date)]
    pub until: Option<Day>,
    #[arg(long, help = REFRESH_HELP)]
    pub refresh: bool,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

impl TopKind {
    fn name(self) -> &'static str {
        match self {
            Self::Days => "days",
            Self::Models => "models",
            Self::Projects => "projects",
        }
    }
}

impl TopArgs {
    fn sort(&self) -> (TopSort, &'static str) {
        match self.sort {
            TopSortArg::Tokens => (TopSort::Tokens, "tokens"),
            TopSortArg::Cost => (TopSort::Cost, "cost"),
        }
    }

    fn window_description(&self) -> Option<String> {
        let mut parts = Vec::new();
        if let Some(year) = self.year {
            parts.push(year.to_string());
        }
        if self.since.is_some() || self.until.is_some() {
            let day = |d: Option<Day>| d.map_or_else(|| "…".to_owned(), |d| d.to_string());
            parts.push(format!("{} → {}", day(self.since), day(self.until)));
        }
        (!parts.is_empty()).then(|| parts.join(", "))
    }

    fn envelope(&self) -> Map<String, Value> {
        let day = |d: Option<Day>| d.map_or(Value::Null, |d| Value::from(d.to_string()));
        let Value::Object(map) = json!({
            "kind": self.kind.name(),
            "sort": self.sort().1,
            "limit": self.limit,
            "year": self.year,
            "since": day(self.since),
            "until": day(self.until),
        }) else {
            unreachable!()
        };
        map
    }
}

/// One ranked item: its table cells, then its JSON fields besides `rank`.
struct Item {
    label: String,
    sub: String,
    tokens: u64,
    cost: Option<f64>,
    json: Value,
}

struct View {
    noun: &'static str,
    label_header: &'static str,
    sub_header: &'static str,
    items: Vec<Item>,
    unpriced: Vec<String>,
    notes: Vec<&'static str>,
}

#[allow(clippy::cast_precision_loss)]
fn render_top(core: &Core, args: &TopArgs, view: View) {
    let window = args.window_description();
    let empty = view.items.is_empty().then(|| usage_empty_window_message(window.as_deref()));
    if args.json {
        let mut payload = args.envelope();
        let items = view.items.iter().enumerate().map(|(i, item)| {
            let mut fields = Map::new();
            fields.insert("rank".into(), Value::from(i + 1));
            if let Value::Object(rest) = &item.json {
                fields.extend(rest.clone());
            }
            Value::Object(fields)
        });
        payload.insert("items".into(), Value::Array(items.collect()));
        if !view.unpriced.is_empty() {
            payload.insert("unpricedModels".into(), json!(view.unpriced));
        }
        if !view.notes.is_empty() {
            payload.insert("notes".into(), json!(view.notes));
        }
        if let Some(message) = empty {
            payload.insert("message".into(), json!(message));
        }
        print_json_command("top", Value::Object(payload));
        return;
    }
    if let Some(message) = empty {
        core.output.info(&message);
        return;
    }
    let columns = [
        Column { header: "#", align: Align::Right },
        Column { header: view.label_header, align: Align::Left },
        Column { header: view.sub_header, align: Align::Left },
        Column { header: "Tokens", align: Align::Right },
        Column { header: "Cost", align: Align::Right },
    ];
    let rows: Vec<Vec<String>> = view
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            vec![
                (i + 1).to_string(),
                item.label.clone(),
                item.sub.clone(),
                fmt(item.tokens as f64),
                item.cost.map_or_else(|| "—".to_owned(), fmt_usd_cost),
            ]
        })
        .collect();
    let suffix = window.map_or_else(String::new, |w| format!(" ({w})"));
    core.output.info(&style::bold(&format!("Top {} {} by {}{suffix}", args.limit, view.noun, args.sort().1)));
    core.output.info(&render_terminal_table(&columns, &rows, None));
    if let Some(footnote) = unpriced_footnote(&view.unpriced) {
        core.output.info(&style::dim(&footnote));
    }
    for note in view.notes {
        core.output.info(&style::dim(note));
    }
}

fn top_provider_name(by_provider: &IndexMap<String, u64>) -> String {
    top_provider_key(by_provider).map(|k| provider_label(k).to_owned()).unwrap_or_default()
}

fn view(data: &ProviderData, args: &TopArgs, filter: &DateFilter) -> View {
    let limit = usize::try_from(args.limit).unwrap_or(usize::MAX);
    let sort = args.sort().0;
    match args.kind {
        TopKind::Days => {
            let days = top_days(data, limit, sort, filter);
            View {
                noun: "days",
                label_header: "Date",
                sub_header: "Top provider",
                unpriced: unpriced_top_models(&days, &[]),
                items: days
                    .into_iter()
                    .map(|d| Item {
                        label: d.date.clone(),
                        sub: top_provider_name(&d.by_provider),
                        tokens: d.tokens,
                        cost: d.cost,
                        json: json!({
                            "date": d.date,
                            "tokens": d.tokens,
                            "costUSD": d.cost,
                            "topProvider": top_provider_key(&d.by_provider),
                            "byProvider": d.by_provider,
                        }),
                    })
                    .collect(),
                notes: Vec::new(),
            }
        }
        TopKind::Projects => View {
            noun: "projects",
            label_header: "Project",
            sub_header: "Top provider",
            items: top_projects(data, limit, sort, filter)
                .into_iter()
                .map(|p| Item {
                    label: p.project.clone(),
                    sub: top_provider_name(&p.by_provider),
                    tokens: p.tokens,
                    cost: p.cost,
                    json: json!({
                        "project": p.project,
                        "unattributed": p.unattributed,
                        "tokens": p.tokens,
                        "costUSD": p.cost,
                        "topProvider": top_provider_key(&p.by_provider),
                        "byProvider": p.by_provider,
                    }),
                })
                .collect(),
            unpriced: Vec::new(),
            notes: vec![PROJECTS_NOTE],
        },
        TopKind::Models => {
            let models = top_models(data, limit, sort, filter);
            View {
                noun: "models",
                label_header: "Model",
                sub_header: "Provider",
                unpriced: unpriced_top_models(&[], &models),
                items: models
                    .into_iter()
                    .map(|m| Item {
                        label: display_model_name(&m.model, true),
                        sub: m.provider.clone(),
                        tokens: m.tokens,
                        cost: m.cost,
                        json: json!({
                            "providerKey": m.provider_key,
                            "provider": m.provider,
                            "model": m.model,
                            "tokens": m.tokens,
                            "costUSD": m.cost,
                            "days": m.days,
                        }),
                    })
                    .collect(),
                notes: Vec::new(),
            }
        }
    }
}

pub fn run(core: &Core, args: &TopArgs) -> Outcome {
    if let (Some(since), Some(until)) = (args.since, args.until)
        && since > until
    {
        return Err(Failure::usage(format!("--since \"{since}\" must not be after --until \"{until}\".")));
    }
    let providers = args.providers.as_deref();
    let Some(loaded) = load(core, providers, args.refresh, None)? else {
        let mut payload = args.envelope();
        payload.insert("items".into(), json!([]));
        let message = usage_empty_message(not_configured(core), providers.unwrap_or_default());
        print_empty_result(core, "top", args.json, &message, Value::Object(payload));
        return Ok(ExitCode::SUCCESS);
    };
    let data = &loaded.zoned.provider_data;
    let filter = DateFilter {
        start: args.since,
        end: args.until,
        year: args.year.map(|y| i16::try_from(y).expect("years are at most 9999")),
    };
    let view = view(data, args, &filter);
    render_top(core, args, view);
    Ok(ExitCode::SUCCESS)
}
