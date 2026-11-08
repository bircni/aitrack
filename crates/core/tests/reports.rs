//! The loader, reports, comparisons, project breakdowns and rankings against 4.x, recorded by
//! `fixtures/usage/generate.ts` over a data repo of machines in several zones.

use std::path::{Path, PathBuf};

use aitrack_core::Core;
use aitrack_core::data::aggregate::DateFilter;
use aitrack_core::data::budget::budget_status;
use aitrack_core::data::duplicate_machines::find_duplicate_machine_days;
use aitrack_core::data::empty_state::{usage_empty_message, usage_empty_window_message};
use aitrack_core::data::local_data::build_machine_data;
use aitrack_core::data::project_usage::{ProjectSelector, aggregate_projects};
use aitrack_core::data::stale_sync::is_stale_sync;
use aitrack_core::data::top_usage::{
    TopSort, top_days, top_models, top_projects, top_provider_key, unpriced_top_models,
};
use aitrack_core::data::types::{CountsByKey, DayEntry, DayMap, MachineFile, ProviderData, TokenCounts};
use aitrack_core::data::usage_data::{
    ZonedUsageData, load_merged_provider_data, load_persisted_machines, machine_usage_totals,
    merge_persisted_with_local, merge_usage_sources,
};
use aitrack_core::data::usage_periods::{PeriodArgs, UsagePeriod, locale_now_label, parse_positive_integer};
use aitrack_core::data::usage_report::{
    ReportContext, ReportOptions, build_project_breakdown, build_usage_comparison, build_usage_report, machine_zones,
};
use aitrack_core::day::Day;
use aitrack_core::display::format::{fmt, fmt_usd, fmt_usd_cost, to_fixed};
use aitrack_core::env::Env;
use aitrack_core::js;
use aitrack_core::output::VecOutput;
use aitrack_core::pricing::ReaderPricing;
use aitrack_core::pricing::model_pricing::ModelPricing;
use aitrack_core::pricing::store::PricingStore;
use aitrack_core::readers::project::ProjectResolver;
use aitrack_core::readers::read::{read_claude_days, read_codex_days};
use aitrack_core::time::Clock;
use indexmap::IndexMap;
use jiff::Timestamp;
use serde_json::{Value, json};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn expected() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("usage/expected.json")).unwrap()).unwrap()
}

fn now() -> Timestamp {
    "2026-04-05T10:30:00Z".parse().unwrap()
}

/// Ours and the recorded value, both written in their own key order.
fn same(ours: &impl serde::Serialize, theirs: &Value, what: &str) {
    let (ours, theirs) = (js::to_string(ours).unwrap(), js::to_string(theirs).unwrap());
    if ours != theirs
        && let Ok(dir) = std::env::var("AITRACK_GOLDEN_DIFF_DIR")
    {
        std::fs::write(Path::new(&dir).join("ours.json"), &ours).unwrap();
        std::fs::write(Path::new(&dir).join("theirs.json"), &theirs).unwrap();
    }
    assert_eq!(ours, theirs, "{what}");
}

fn counts_json(c: &TokenCounts) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("inputTokens".into(), json!(c.input_tokens));
    out.insert("outputTokens".into(), json!(c.output_tokens));
    for (key, value) in [
        ("rawInputTokens", c.raw_input_tokens),
        ("cachedInputTokens", c.cached_input_tokens),
        ("cacheCreationInputTokens", c.cache_creation_input_tokens),
        ("cacheCreation1hInputTokens", c.cache_creation_1h_input_tokens),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    if let Some(cost) = c.cost_usd {
        out.insert("costUSD".into(), json!(cost));
    }
    if let Some(unpriced) = c.has_unpriced_tokens {
        out.insert("hasUnpricedTokens".into(), json!(unpriced));
    }
    Value::Object(out)
}

fn record_json(r: Option<&CountsByKey>) -> Value {
    r.map_or(Value::Null, |r| Value::Array(r.iter().map(|(k, v)| json!([k, counts_json(v)])).collect()))
}

fn days_json(map: &DayMap) -> Value {
    Value::Array(
        map.iter()
            .map(|(date, day)| {
                json!([date.to_string(), {
                    "counts": counts_json(&day.counts),
                    "byModel": record_json(Some(&day.by_model)),
                    "byProject": record_json(day.by_project.as_ref()),
                    "byCwd": record_json(day.by_cwd.as_ref()),
                }])
            })
            .collect(),
    )
}

fn data_json(data: &ProviderData) -> Value {
    Value::Array(data.iter().map(|(k, m)| json!([k, days_json(m)])).collect())
}

fn days_from(value: &Value) -> DayMap {
    let record = |v: &Value| -> Option<CountsByKey> {
        v.as_array().map(|rows| {
            rows.iter()
                .map(|r| (r[0].as_str().unwrap().to_owned(), serde_json::from_value(r[1].clone()).unwrap()))
                .collect()
        })
    };
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let day = &row[1];
            let entry = DayEntry {
                counts: serde_json::from_value(day["counts"].clone()).unwrap(),
                by_model: record(&day["byModel"]).unwrap(),
                by_project: record(&day["byProject"]),
                by_cwd: record(&day["byCwd"]),
            };
            (Day::parse(row[0].as_str().unwrap()).unwrap(), entry)
        })
        .collect()
}

fn options_from(value: &Value) -> ReportOptions {
    let day = |key: &str| value.get(key).and_then(Value::as_str).map(|d| Day::parse(d).unwrap());
    let project = value.get("project").map(|p| match p["kind"].as_str().unwrap() {
        "project" => ProjectSelector::Project(p["project"].as_str().unwrap().to_owned()),
        _ => ProjectSelector::Dir(PathBuf::from(p["dir"].as_str().unwrap())),
    });
    ReportOptions {
        period: UsagePeriod::parse(value["period"].as_str().unwrap()).unwrap(),
        args: PeriodArgs { from: day("from"), to: day("to"), n: value.get("n").and_then(Value::as_u64) },
        project,
    }
}

fn filter_from(value: &Value) -> DateFilter {
    let day = |key: &str| value.get(key).and_then(Value::as_str).map(|d| Day::parse(d).unwrap());
    DateFilter {
        start: day("start"),
        end: day("end"),
        year: value.get("year").and_then(Value::as_i64).map(|y| i16::try_from(y).unwrap()),
    }
}

fn result<T: serde::Serialize>(outcome: Result<T, String>) -> Value {
    match outcome {
        Ok(value) => serde_json::from_str(&js::to_string(&value).unwrap()).unwrap(),
        Err(error) => json!({ "error": error }),
    }
}

#[test]
fn periods_formatting_and_small_rules_match_4x() {
    let expected = expected();
    let pure = &expected["pure"];
    let clock = Clock::fixed(now(), "Europe/Berlin").unwrap();
    let label = locale_now_label(now(), clock.zone());
    for case in pure["windows"].as_array().unwrap() {
        let today = Day::parse(case["today"].as_str().unwrap()).unwrap();
        let options = options_from(&case["options"]);
        let window = |w: Result<aitrack_core::data::usage_periods::UsageWindow, String>| {
            result(w.map(|w| json!({"start": w.start.to_string(), "end": w.end.to_string(), "label": w.label})))
        };
        same(&window(options.period.window(today, &label, options.args)), &case["current"], &format!("window {case}"));
        let previous = options
            .period
            .window(today, &label, options.args)
            .and_then(|current| options.period.previous(today, &current));
        same(&window(previous), &case["previous"], &format!("previous {case}"));
    }
    for case in pure["parse"].as_array().unwrap() {
        let args: Vec<String> = serde_json::from_value(case["args"].clone()).unwrap();
        let parsed = UsagePeriod::parse(case["period"].as_str().unwrap()).unwrap().parse_args(&args).map(|a| {
            let mut out = serde_json::Map::new();
            if let Some(from) = a.from {
                out.insert("from".into(), json!(from.to_string()));
            }
            if let Some(to) = a.to {
                out.insert("to".into(), json!(to.to_string()));
            }
            if let Some(n) = a.n {
                out.insert("n".into(), json!(n));
            }
            Value::Object(out)
        });
        same(&result(parsed), &case["result"], &format!("parse {case}"));
    }
    for case in pure["ints"].as_array().unwrap() {
        same(&json!(parse_positive_integer(case[0].as_str().unwrap())), &case[1], &format!("int {case}"));
    }
    for case in pure["fmt"].as_array().unwrap() {
        same(&json!(fmt(case[0].as_f64().unwrap())), &case[1], &format!("fmt {case}"));
    }
    for case in pure["usd"].as_array().unwrap() {
        let n = case[0].as_f64();
        same(&json!([n, fmt_usd(n), n.map(fmt_usd_cost)]), case, &format!("usd {case}"));
    }
    for case in pure["fixed"].as_array().unwrap() {
        let digits = usize::try_from(case[1].as_u64().unwrap()).unwrap();
        same(&json!(to_fixed(case[0].as_f64().unwrap(), digits)), &case[2], &format!("toFixed {case}"));
    }
    for case in pure["budget"].as_array().unwrap() {
        same(
            &json!(budget_status(case[0].as_f64().unwrap(), case[1].as_f64().unwrap())),
            &case[2],
            &format!("budget {case}"),
        );
    }
    for case in pure["stale"].as_array().unwrap() {
        same(&json!(is_stale_sync(&clock, case[0].as_str().unwrap(), now())), &case[1], &format!("stale {case}"));
    }
    let messages = [
        usage_empty_message(true, &[]),
        usage_empty_message(false, &[]),
        usage_empty_message(false, &["codex".into(), "cursor".into(), "zzz".into()]),
        usage_empty_window_message(Some("last week")),
        usage_empty_window_message(Some("")),
        usage_empty_window_message(None),
    ];
    same(&messages, &pure["messages"], "empty messages");
    let header = |hostname: &str, days: Value| -> MachineFile {
        serde_json::from_value(json!({"schemaVersion": 2, "hostname": hostname, "timezone": "UTC", "dayBucket": "local", "lastUpdated": "x", "days": days}))
            .unwrap()
    };
    let day = json!({"codex": {"byModel": {"m": {"inputTokens": 1, "outputTokens": 1}}, "totals": {"inputTokens": 1, "outputTokens": 1}}});
    let other = json!({"codex": {"byModel": {"m": {"inputTokens": 2, "outputTokens": 1}}, "totals": {"inputTokens": 2, "outputTokens": 1}}});
    let machines = [
        header("b", json!({"2026-01-02": day, "2026-01-01": day})),
        header("a", json!({"2026-01-02": day, "2026-01-03": other})),
        header("c", json!({"2026-01-01": day, "2026-01-03": day})),
    ];
    same(&find_duplicate_machine_days(&machines), &pure["dupes"], "duplicates");
}

struct NoRemotes;

impl ProjectResolver for NoRemotes {
    fn resolve(&self, _: &str) -> Option<String> {
        None
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn loaded_for(
    zone: &str,
    home: &Path,
    pricing: &ModelPricing,
) -> (Core, MachineFile, ZonedUsageData, Vec<String>, bool) {
    let corpus = fixtures().join("readers/corpus");
    let env = Env::new(
        home,
        [
            ("AITRACK_NO_CACHE", "1".to_owned()),
            ("AITRACK_CLAUDE_PROJECTS_DIRS", corpus.join("claude").to_string_lossy().into_owned()),
            ("AITRACK_CODEX_SESSION_DIRS", corpus.join("codex").to_string_lossy().into_owned()),
        ],
    );
    let core = Core::new(env, Clock::fixed(now(), zone).unwrap(), Box::new(VecOutput::default()));
    let reader_pricing = ReaderPricing { pricing, fallbacks: None };
    let maps = IndexMap::from([
        ("claude_code".to_owned(), read_claude_days(&core, &reader_pricing, &NoRemotes).unwrap()),
        ("codex".to_owned(), read_codex_days(&core, &reader_pricing, &NoRemotes).unwrap()),
    ]);
    let local = build_machine_data("laptop", &maps, zone, now(), true);
    let loaded = load_merged_provider_data(&core, pricing, "laptop", Some(&local), None, ProviderData::new()).unwrap();
    let machine_data = loaded.machine_data.iter().map(|m| m.hostname.clone()).collect();
    (core, local, loaded.zoned, machine_data, loaded.not_configured)
}

#[test]
fn loader_reports_comparisons_and_rankings_match_4x_in_every_zone() {
    let expected = expected();
    let pricing = PricingStore::bundled();
    for zone in ["Europe/Berlin", "Pacific/Kiritimati", "Pacific/Midway"] {
        let recorded = &expected[zone];
        let home = tempfile::tempdir().unwrap();
        copy_dir(&fixtures().join("usage/home"), home.path());
        std::fs::create_dir_all(home.path().join(".config/aitrack/repo/.git")).unwrap();
        let (core, local, loaded, machine_data, not_configured) = loaded_for(zone, home.path(), &pricing);
        let sources: Vec<Value> = loaded
            .zoned_sources
            .iter()
            .map(|s| json!({"hostname": s.hostname, "timezone": s.timezone, "lastUpdated": s.last_updated, "current": s.current}))
            .collect();
        same(
            &json!({"providerData": data_json(&loaded.provider_data), "sources": sources, "machineData": machine_data, "warnedNotConfigured": not_configured}),
            &recorded["loaded"],
            &format!("{zone}: loader"),
        );
        let live = days_from(&recorded["live"]);
        let zoned = merge_usage_sources(
            &pricing,
            loaded.zoned_sources.clone(),
            ProviderData::from([("cursor".to_owned(), live)]),
        );
        same(
            &json!(machine_zones(core.clock.zone_name(), &loaded.zoned_sources)),
            &recorded["zones"],
            &format!("{zone}: zones"),
        );

        let persisted = load_persisted_machines(&core);
        let totals: Vec<Value> = merge_persisted_with_local(&persisted, Some(&local), "laptop.json")
            .iter()
            .map(|m| {
                let t = machine_usage_totals(&pricing, m);
                let mut totals = serde_json::Map::new();
                totals.insert("inputTokens".into(), json!(t.input_tokens));
                totals.insert("outputTokens".into(), json!(t.output_tokens));
                totals.insert("costUSD".into(), json!(t.cost_usd));
                if t.has_unpriced_tokens {
                    totals.insert("hasUnpricedTokens".into(), json!(true));
                }
                totals.insert("days".into(), json!(t.days));
                totals.insert("firstDay".into(), json!(t.first_day.map(|d| d.to_string())));
                totals.insert("lastDay".into(), json!(t.last_day.map(|d| d.to_string())));
                totals.insert("providers".into(), json!(t.providers));
                json!({"hostname": m.hostname, "totals": totals})
            })
            .collect();
        same(&totals, &recorded["machineTotals"], &format!("{zone}: machine totals"));
        same(
            &aggregate_projects(&zoned.provider_data, &DateFilter::default()),
            &recorded["aggregate"],
            &format!("{zone}: projects"),
        );

        let context = ReportContext { pricing: &pricing, clock: &core.clock, now: now() };
        for case in recorded["reports"].as_array().unwrap() {
            let options = options_from(&case["options"]);
            same(
                &result(build_usage_report(&context, &zoned, &options)),
                &case["report"],
                &format!("{zone}: report {}", case["options"]),
            );
            same(
                &result(build_project_breakdown(&context, &zoned, &options)),
                &case["breakdown"],
                &format!("{zone}: breakdown {}", case["options"]),
            );
        }
        for case in recorded["comparisons"].as_array().unwrap() {
            let options = options_from(&case["options"]);
            same(
                &result(build_usage_comparison(&context, &loaded, &options)),
                &case["result"],
                &format!("{zone}: comparison {}", case["options"]),
            );
        }
        for case in recorded["tops"].as_array().unwrap() {
            let filter = filter_from(&case["filter"]);
            let sort = if case["sort"] == "tokens" { TopSort::Tokens } else { TopSort::Cost };
            let limit = usize::try_from(case["limit"].as_u64().unwrap()).unwrap();
            let what = format!("{zone}: top {} {} {}", case["filter"], case["sort"], limit);
            let days = top_days(&zoned.provider_data, limit, sort, &filter);
            let models = top_models(&zoned.provider_data, limit, sort, &filter);
            same(&days, &case["days"], &what);
            same(&models, &case["models"], &what);
            same(&top_projects(&zoned.provider_data, limit, sort, &filter), &case["projects"], &what);
            same(&unpriced_top_models(&days, &models), &case["unpriced"], &what);
            same(
                &days.iter().map(|d| top_provider_key(&d.by_provider)).collect::<Vec<_>>(),
                &case["topProvider"],
                &what,
            );
        }
    }
}
