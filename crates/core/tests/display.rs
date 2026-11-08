//! Terminal tables, CSV, heatmap figures, model names and the receipt PDF against 4.x, recorded before
//! 4.x was removed; the PNG is checked for its size and cell colours.

use std::collections::HashSet;
use std::path::Path;

use aitrack_core::data::types::{DayEntry, DayMap, ProviderData, TokenCounts};
use aitrack_core::data::usage_report::{UsageReport, UsageReportProvider, UsageReportRow, UsageReportTotals};
use aitrack_core::day::Day;
use aitrack_core::display::csv::render_usage_report_csv;
use aitrack_core::display::heatmap::intensity::{percentile, token_intensity_level};
use aitrack_core::display::heatmap::layout::resolve_provider_layout;
use aitrack_core::display::heatmap::provider_stats::provider_stats;
use aitrack_core::display::heatmap::stats::{
    build_date_grid, compute_model_stats, format_month_label, format_peak_date, month_labels,
};
use aitrack_core::display::heatmap::view_model::build_provider_section_view_model;
use aitrack_core::display::model_names::display_model_name;
use aitrack_core::display::pdf::render_receipt_pdf_at;
use aitrack_core::display::render_options::RenderOptions;
use aitrack_core::display::style::{BOLD_WHITE, DIM, color_supported};
use aitrack_core::display::tui::{render_tui_at, tui_stats_at};
use aitrack_core::env::Env;
use aitrack_core::js;
use serde_json::Value;

fn expected() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/display/expected.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn today() -> Day {
    Day::parse("2026-03-10").unwrap()
}

fn same(ours: &impl serde::Serialize, theirs: &Value, what: &str) {
    assert_eq!(js::to_string(ours).unwrap(), js::to_string(theirs).unwrap(), "{what}");
}

fn u(v: &Value) -> u64 {
    v.as_u64().unwrap()
}

fn counts(v: &Value) -> TokenCounts {
    TokenCounts {
        input_tokens: u(&v["inputTokens"]),
        output_tokens: u(&v["outputTokens"]),
        cost_usd: v.get("costUSD").and_then(Value::as_f64),
        ..TokenCounts::default()
    }
}

/// Day totals summed from the models in order, as the generator built 4.x's maps.
fn provider_data(raw: &Value) -> ProviderData {
    raw.as_object()
        .unwrap()
        .iter()
        .map(|(provider, days)| {
            let map: DayMap = days
                .as_array()
                .unwrap()
                .iter()
                .map(|day| {
                    let mut entry = DayEntry::default();
                    for (model, value) in day[1].as_object().unwrap() {
                        let c = counts(value);
                        entry.counts.input_tokens += c.input_tokens;
                        entry.counts.output_tokens += c.output_tokens;
                        if let Some(cost) = c.cost_usd {
                            entry.counts.cost_usd = Some(entry.counts.cost_usd.unwrap_or(0.0) + cost);
                        }
                        entry.by_model.insert(model.clone(), c);
                    }
                    (Day::parse(day[0].as_str().unwrap()).unwrap(), entry)
                })
                .collect();
            (provider.clone(), map)
        })
        .collect()
}

fn options(v: &Value) -> RenderOptions {
    RenderOptions {
        dark: v["dark"].as_bool().unwrap_or(false),
        all: v["all"].as_bool().unwrap_or(false),
        year: v["year"].as_i64().map(|y| i16::try_from(y).unwrap()),
    }
}

fn year(v: &Value) -> Option<i16> {
    v.as_i64().map(|y| i16::try_from(y).unwrap())
}

#[test]
fn names_models_as_4x_does() {
    let expected = expected();
    for case in expected["names"].as_array().unwrap() {
        let id = case[0].as_str().unwrap();
        assert_eq!(display_model_name(id, false), case[1].as_str().unwrap(), "{id}");
        assert_eq!(display_model_name(id, true), case[2].as_str().unwrap(), "{id} with effort");
    }
}

#[test]
fn computes_intensity_dates_and_grids_as_4x_does() {
    let expected = expected();
    for case in expected["percentiles"].as_array().unwrap() {
        let values: Vec<u64> = case[0].as_array().unwrap().iter().map(u).collect();
        assert_eq!(percentile(&values, 0.9), u(&case[1]), "{values:?}");
    }
    for case in expected["levels"].as_array().unwrap() {
        assert_eq!(u64::from(token_intensity_level(u(&case[0]), u(&case[1]))), u(&case[2]), "{case}");
    }
    for case in expected["peakDates"].as_array().unwrap() {
        let date = case[0].as_str().unwrap();
        assert_eq!(format_peak_date(Day::parse(date).unwrap()), case[1].as_str().unwrap());
        assert_eq!(format_month_label(&date[..7]), case[2].as_str().unwrap());
    }
    for grid in expected["grids"].as_array().unwrap() {
        let weeks = build_date_grid(year(&grid["year"]), today());
        same(&weeks, &grid["weeks"], &format!("grid {}", grid["year"]));
        same(&month_labels(&weeks), &grid["labels"], &format!("labels {}", grid["year"]));
    }
}

#[test]
fn summarises_providers_and_lays_them_out_as_4x_does() {
    let expected = expected();
    let data = provider_data(&expected["data"]);
    let grid: HashSet<Day> = build_date_grid(None, today()).into_iter().flatten().flatten().collect();
    for (key, theirs) in expected["perProvider"].as_object().unwrap() {
        let days = &data[key];
        same(&provider_stats(days, today()), &theirs["stats"], &format!("{key} stats"));
        same(&compute_model_stats(days, today()), &theirs["models"], &format!("{key} models"));
        let view = build_provider_section_view_model(key, days, |d| grid.contains(d), today());
        same(&view, &theirs["view"], &format!("{key} view"));
        same(
            &build_provider_section_view_model(key, days, |_| true, today()),
            &theirs["viewAll"],
            &format!("{key} all"),
        );
    }
    let option_sets = [
        RenderOptions::default(),
        RenderOptions { all: true, ..RenderOptions::default() },
        RenderOptions { year: Some(2025), ..RenderOptions::default() },
        RenderOptions { dark: true, ..RenderOptions::default() },
        RenderOptions { year: Some(2030), ..RenderOptions::default() },
        RenderOptions { all: true, year: Some(2026), ..RenderOptions::default() },
    ];
    for (i, o) in option_sets.iter().enumerate() {
        same(&resolve_provider_layout(&data, o.all, o.year).keys, &expected["layouts"][i], &format!("layout {o:?}"));
        same(&tui_stats_at(&data, o, today()), &expected["tuiStats"][i], &format!("tui stats {o:?}"));
    }
}

#[test]
fn renders_the_stats_table_as_4x_does() {
    let expected = expected();
    let data = provider_data(&expected["data"]);
    for case in expected["tui"].as_array().unwrap() {
        let color = u(&case["level"]) > 0;
        let text = case["text"].as_str().unwrap();
        let ours = if case["options"]["only"].is_string() {
            let codex = ProviderData::from([("codex".to_owned(), data["codex"].clone())]);
            render_tui_at(&codex, &RenderOptions::default(), today(), color)
        } else {
            render_tui_at(&data, &options(&case["options"]), today(), color)
        };
        assert_eq!(ours, text, "{}", case["options"]);
    }
}

#[test]
fn styles_like_chalk() {
    assert_eq!(DIM.paint("a", true), "\x1b[2ma\x1b[22m");
    assert_eq!(
        BOLD_WHITE.paint("a\x1b[22mb\nc", true),
        "\x1b[1m\x1b[37ma\x1b[22m\x1b[1mb\x1b[39m\x1b[22m\n\x1b[1m\x1b[37mc\x1b[39m\x1b[22m"
    );
    assert_eq!(DIM.paint("", true), "");
    assert_eq!(DIM.paint("a", false), "a");
    let env = |vars: &[(&str, &str)]| Env::new("/", vars.iter().copied());
    for (vars, tty, on) in [
        (&[][..], true, false),
        (&[("TERM", "xterm-256color")][..], true, true),
        (&[("TERM", "xterm-256color")][..], false, false),
        (&[("TERM", "xterm"), ("NO_COLOR", "1")][..], true, false),
        (&[("NO_COLOR", "1"), ("FORCE_COLOR", "1")][..], false, true),
        (&[("FORCE_COLOR", "0"), ("TERM", "xterm")][..], true, false),
        (&[("FORCE_COLOR", "")][..], false, true),
        (&[("TERM", "dumb")][..], true, false),
        (&[("CI", "1"), ("GITHUB_ACTIONS", "1")][..], true, true),
        (&[("CI", "1"), ("TERM", "xterm")][..], true, false),
    ] {
        assert_eq!(color_supported(&env(vars), tty, false), on, "{vars:?} tty={tty}");
    }
}

fn row(v: &Value) -> UsageReportRow {
    UsageReportRow {
        model: v["model"].as_str().unwrap().to_owned(),
        input_tokens: u(&v["inputTokens"]),
        output_tokens: u(&v["outputTokens"]),
        tokens: u(&v["tokens"]),
        cached_input_tokens: u(&v["cachedInputTokens"]),
        has_cached: v["hasCached"].as_bool().unwrap(),
        cost_usd: v["costUSD"].as_f64().unwrap(),
        has_cost: v["hasCost"].as_bool().unwrap(),
        has_unpriced_tokens: v["hasUnpricedTokens"].as_bool().unwrap_or(false),
    }
}

fn report(v: &Value) -> UsageReport {
    let t = &v["totals"];
    UsageReport {
        window_label: v["windowLabel"].as_str().unwrap().to_owned(),
        providers: v["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| UsageReportProvider {
                key: p["key"].as_str().unwrap().to_owned(),
                label: p["label"].as_str().unwrap().to_owned(),
                rows: p["rows"].as_array().unwrap().iter().map(row).collect(),
                subtotal_tokens: u(&p["subtotalTokens"]),
                subtotal_cost_usd: p["subtotalCostUSD"].as_f64().unwrap(),
                subtotal_has_cost: p["subtotalHasCost"].as_bool().unwrap(),
                has_unpriced_tokens: p["hasUnpricedTokens"].as_bool().unwrap_or(false),
            })
            .collect(),
        totals: UsageReportTotals {
            input_tokens: u(&t["inputTokens"]),
            output_tokens: u(&t["outputTokens"]),
            tokens: u(&t["tokens"]),
            cached_input_tokens: u(&t["cachedInputTokens"]),
            has_cached: t["hasCached"].as_bool().unwrap(),
            cost_usd: t["costUSD"].as_f64().unwrap(),
            has_cost: t["hasCost"].as_bool().unwrap(),
            has_unpriced_tokens: t["hasUnpricedTokens"].as_bool().unwrap_or(false),
            unpriced_models: t["unpricedModels"]
                .as_array()
                .map(|m| m.iter().map(|s| s.as_str().unwrap().to_owned()).collect()),
        },
        row_count: usize::try_from(u(&v["rowCount"])).unwrap(),
        project: None,
        timezone_note: None,
    }
}

#[test]
fn writes_csv_as_4x_does() {
    let expected = expected();
    for (i, theirs) in expected["reports"].as_array().unwrap().iter().enumerate() {
        assert_eq!(render_usage_report_csv(&report(theirs)), expected["csv"][i].as_str().unwrap(), "report {i}");
    }
}

/// Text runs as `[x, baseline, face, size, hex]` and rules as their distance from the top edge.
fn pdf_marks(pdf: &[u8]) -> (f64, Vec<Value>, Vec<f64>, String) {
    let text: String = pdf.iter().map(|&b| char::from(b)).collect();
    let height: f64 = text.split("/MediaBox [0 0 360 ").nth(1).unwrap().split(']').next().unwrap().parse().unwrap();
    let stream = text.split(">>\nstream\n").nth(1).unwrap().split("\nendstream").next().unwrap();
    let lines: Vec<&str> = stream.lines().filter(|l| !l.is_empty()).collect();
    let (mut runs, mut rules) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < lines.len() {
        if lines[i] == "BT" {
            let font: Vec<&str> = lines[i + 1].split(' ').collect();
            let at: Vec<f64> = lines[i + 2].split(' ').take(2).map(|n| n.parse().unwrap()).collect();
            let hex = lines[i + 3].trim_start_matches('<').trim_end_matches("> Tj");
            let face = if font[0] == "/F2" { "bold" } else { "regular" };
            let size: f64 = font[1].parse().unwrap();
            runs.push(serde_json::json!([at[0], at[1], face, size, hex]));
            i += 5;
        } else if lines[i].ends_with(" m") {
            let y: f64 = lines[i].split(' ').nth(1).unwrap().parse().unwrap();
            rules.push(height - y);
            i += 4;
        } else {
            panic!("unexpected content line {}", lines[i]);
        }
    }
    let title = text.split("/Title ").nth(1).unwrap().split("\n/CreationDate").next().unwrap().to_owned();
    (height, runs, rules, title)
}

#[test]
fn lays_out_the_receipt_as_4x_does() {
    let expected = expected();
    let generated = "2026-03-10T12:34:56Z".parse::<jiff::Timestamp>().unwrap().to_zoned(jiff::tz::TimeZone::UTC);
    for (i, theirs) in expected["reports"].as_array().unwrap().iter().enumerate() {
        let pdf = render_receipt_pdf_at(&report(theirs), &generated);
        if let Ok(dir) = std::env::var("AITRACK_GOLDEN_DIFF_DIR") {
            std::fs::write(Path::new(&dir).join(format!("receipt-{i}.pdf")), &pdf).unwrap();
        }
        assert!(pdf.starts_with(b"%PDF-1.3\n") && pdf.ends_with(b"%%EOF\n"));
        let (height, runs, rules, title) = pdf_marks(&pdf);
        let golden = &expected["pdf"][i];
        assert_eq!(height.to_string(), golden["height"].to_string(), "height {i}");
        assert_eq!(title, golden["title"].as_str().unwrap(), "title {i}");
        let fragments = golden["fragments"].as_array().unwrap();
        let (their_rules, their_runs): (Vec<&Value>, Vec<&Value>) = fragments.iter().partition(|f| f[0] == "line");
        same(&runs, &Value::Array(their_runs.into_iter().cloned().collect()), &format!("text runs {i}"));
        let their_rules: Vec<f64> = their_rules.iter().map(|r| r[1].as_f64().unwrap()).collect();
        assert_eq!(rules.len(), their_rules.len(), "rules {i}");
        for (ours, theirs) in rules.iter().zip(&their_rules) {
            assert!((ours - theirs).abs() < 1e-4, "rule {ours} vs {theirs} in {i}");
        }
    }
}

#[cfg(feature = "render")]
#[test]
fn draws_the_heatmap_cells_where_4x_does() {
    use aitrack_core::display::render_png::render_to_png_at;

    let expected = expected();
    let data = provider_data(&expected["data"]);
    for case in expected["png"].as_array().unwrap() {
        let png = render_to_png_at(&data, &options(&case["options"]), today());
        if let Ok(dir) = std::env::var("AITRACK_GOLDEN_DIFF_DIR") {
            std::fs::write(Path::new(&dir).join(format!("heatmap-{}.png", case["options"])), &png).unwrap();
        }
        let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let frame = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((u64::from(frame.width), u64::from(frame.height)), (u(&case["width"]), u(&case["height"])));
        for sample in case["samples"].as_array().unwrap() {
            let (x, y) = (u(&sample[0]), u(&sample[1]));
            let at = usize::try_from((y * u64::from(frame.width) + x) * 4).unwrap();
            let rgba: Vec<u64> = pixels[at..at + 4].iter().map(|&b| u64::from(b)).collect();
            let theirs: Vec<u64> = sample[2].as_array().unwrap().iter().map(u).collect();
            assert_eq!(rgba, theirs, "pixel ({x}, {y}) for {}", case["options"]);
        }
    }
}
