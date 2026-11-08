//! Machine files against 4.x: validation, the writer, merges, compaction and repricing,
//! recorded by `fixtures/store/generate.ts`.

use std::path::Path;

use aitrack_core::data::compact::compact_days;
use aitrack_core::data::local_data::{
    build_machine_data, canonical_days, merge_persisted_days, outgoing_days, ratcheted_provider_days,
    rebucket_persisted_days,
};
use aitrack_core::data::types::{MachineDays, MachineFile};
use aitrack_core::day::Day;
use aitrack_core::js;
use aitrack_core::pricing::ReaderPricing;
use aitrack_core::pricing::reprice::reprice_machine_days;
use aitrack_core::pricing::store::PricingStore;
use aitrack_core::readers::claude_scan::scan_claude_file;
use aitrack_core::readers::codex_scan::scan_codex_file;
use aitrack_core::readers::jsonl::CHUNK_BYTES;
use aitrack_core::readers::paths::list_unique_source_files;
use aitrack_core::readers::project::ProjectResolver;
use aitrack_core::readers::provider::{finish_claude_scan, finish_codex_scan, merge_claude_parsed, merge_codex_parsed};
use aitrack_core::store::validate::{Diagnostic, Failure, ValidationOptions, check_raw_machine_file};
use aitrack_core::time::Clock;
use indexmap::IndexMap;
use serde_json::{Value, json};

fn expected() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store/expected.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn diagnostic(d: &Diagnostic) -> Value {
    match d {
        Diagnostic::FileSkipped { file, reason } => json!({"kind": "file-skipped", "filePath": file, "reason": reason}),
        Diagnostic::DayDropped { file, date, reason } => {
            json!({"kind": "day-dropped", "filePath": file, "date": date, "reason": reason})
        }
        Diagnostic::ProjectsDropped { file, date, provider, reason } => {
            json!({"kind": "projects-dropped", "filePath": file, "date": date, "providerKey": provider, "reason": reason})
        }
    }
}

#[test]
fn validation_matches_4x() {
    let expected = expected();
    for case in expected["validation"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let options = ValidationOptions { allow_inconsistent_cost_totals: case["allow"].as_bool().unwrap() };
        let check = check_raw_machine_file(
            case["raw"].as_str().unwrap(),
            &format!("data/{name}.json"),
            Some("test pass"),
            options,
        );
        let machine = check.machine.as_ref().map(|m| js::to_string_pretty(m).unwrap());
        assert_eq!(json!(machine), case["machine"], "{name}");
        assert_eq!(
            Value::from(check.diagnostics.iter().map(diagnostic).collect::<Vec<_>>()),
            case["diagnostics"],
            "{name}"
        );
        let failure = check.failure.map(|f| match f {
            Failure::Corrupt => "corrupt",
            Failure::FutureSchema => "future-schema",
            Failure::Encrypted => "encrypted",
        });
        assert_eq!(json!(failure), case["failure"], "{name}");
        assert_eq!(json!(check.encrypted), case["encrypted"], "{name}");
    }
}

struct NoRemotes;

impl ProjectResolver for NoRemotes {
    fn resolve(&self, _: &str) -> Option<String> {
        None
    }
}

#[test]
fn the_writer_builds_the_bytes_4x_builds() {
    let expected = expected();
    let corpus = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/readers/corpus");
    let clock = Clock::in_zone("UTC").unwrap();
    let bundled = PricingStore::bundled();
    let pricing = ReaderPricing { pricing: &bundled, fallbacks: None };
    let claude: Vec<_> = list_unique_source_files(&[corpus.join("claude")])
        .unwrap()
        .iter()
        .map(|f| finish_claude_scan(scan_claude_file(f, &clock, CHUNK_BYTES).unwrap(), &pricing, &NoRemotes))
        .collect();
    let codex: Vec<_> = list_unique_source_files(&[corpus.join("codex")])
        .unwrap()
        .iter()
        .map(|f| finish_codex_scan(&scan_codex_file(f, &clock, CHUNK_BYTES).unwrap(), &pricing, &NoRemotes))
        .collect();
    let maps = IndexMap::from([
        ("claude_code".to_owned(), merge_claude_parsed(&claude)),
        ("codex".to_owned(), merge_codex_parsed(&codex)),
    ]);
    let now = "2026-03-08T10:00:00Z".parse().unwrap();
    for (key, dirs) in [("plain", false), ("withDirs", true)] {
        let built = build_machine_data("mb", &maps, "UTC", now, dirs);
        assert_eq!(js::to_string_pretty(&built).unwrap(), expected["built"][key].as_str().unwrap(), "{key}");
    }
}

fn days(value: &Value) -> MachineDays {
    serde_json::from_value(value.clone()).unwrap()
}

/// The recorded object written back in its own key order, against ours.
fn same(ours: &MachineDays, theirs: &Value, what: &str, case: usize) {
    let (ours, theirs) = (js::to_string(ours).unwrap(), js::to_string(theirs).unwrap());
    if ours != theirs
        && let Ok(dir) = std::env::var("AITRACK_GOLDEN_DIFF_DIR")
    {
        std::fs::write(Path::new(&dir).join("ours.json"), &ours).unwrap();
        std::fs::write(Path::new(&dir).join("theirs.json"), &theirs).unwrap();
    }
    assert_eq!(ours, theirs, "case {case}: {what}");
}

#[test]
fn merges_compaction_and_repricing_match_4x() {
    let expected = expected();
    let pricing = PricingStore::bundled();
    let today = Day::parse("2026-03-15").unwrap();
    for (i, case) in expected["merges"].as_array().unwrap().iter().enumerate() {
        let persisted: Option<MachineFile> = serde_json::from_value(case["persisted"].clone()).unwrap();
        let fresh: MachineFile = serde_json::from_value(case["fresh"].clone()).unwrap();
        let persisted_days = persisted.as_ref().map(|p| &p.days);
        same(&merge_persisted_days(persisted_days, &fresh.days), &case["merged"], "merged", i);
        assert_eq!(
            json!(ratcheted_provider_days(persisted_days, &fresh.days)),
            case["ratcheted"],
            "case {i}: ratcheted"
        );
        if let Some(persisted) = &persisted {
            same(&rebucket_persisted_days(persisted, &fresh), &case["rebucketed"], "rebucketed", i);
        }
        same(&canonical_days(&fresh.days), &case["canonical"], "canonical", i);
        let after = case["compactAfter"].as_u64();
        same(&outgoing_days(&pricing, persisted_days, &fresh.days, after, today), &case["outgoing"], "outgoing", i);
        same(&compact_days(&pricing, &fresh.days, 5, today), &case["compacted"], "compacted", i);
        let mut repriced = persisted.as_ref().map_or_else(|| fresh.days.clone(), |p| p.days.clone());
        let result = reprice_machine_days(&pricing, &mut repriced, None);
        same(&repriced, &case["repriced"], "repriced", i);
        assert_eq!(
            json!({"isTouched": result.touched, "legacySkipped": result.legacy_skipped}),
            case["repriceResult"],
            "case {i}: reprice result"
        );
        let _ = days(&case["merged"]);
    }
}
