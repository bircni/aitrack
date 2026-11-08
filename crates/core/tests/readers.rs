//! The readers against what 4.x made of the same corpus, recorded by `fixtures/readers/generate.ts`.

use jiff::tz::TimeZoneDatabase;
use std::path::{Path, PathBuf};

use aitrack_core::data::types::{CountsByKey, DayMap, TokenCounts};
use aitrack_core::pricing::ReaderPricing;
use aitrack_core::pricing::store::PricingStore;
use aitrack_core::readers::claude_scan::scan_claude_file;
use aitrack_core::readers::codex_scan::scan_codex_file;
use aitrack_core::readers::jsonl::CHUNK_BYTES;
use aitrack_core::readers::paths::list_unique_source_files;
use aitrack_core::readers::project::ProjectResolver;
use aitrack_core::readers::provider::{
    CachedParse, finish_claude_scan, finish_codex_scan, merge_claude_parsed, merge_codex_parsed,
};
use aitrack_core::time::Clock;
use serde_json::{Value, json};

/// The corpus cwds do not exist, so 4.x's git lookups all failed.
struct NoRemotes;

impl ProjectResolver for NoRemotes {
    fn resolve(&self, _: &str) -> Option<String> {
        None
    }
}

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/readers/corpus")
}

fn relative(file: &Path) -> String {
    file.strip_prefix(corpus()).unwrap().to_string_lossy().replace('\\', "/")
}

fn counts(c: &TokenCounts) -> Value {
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

fn record(r: Option<&CountsByKey>) -> Value {
    r.map_or(Value::Null, |r| Value::Array(r.iter().map(|(k, v)| json!([k, counts(v)])).collect()))
}

fn days(map: &DayMap) -> Value {
    Value::Array(
        map.iter()
            .map(|(date, day)| {
                json!([date.to_string(), {
                    "counts": counts(&day.counts),
                    "byModel": record(Some(&day.by_model)),
                    "byProject": record(day.by_project.as_ref()),
                    "byCwd": record(day.by_cwd.as_ref()),
                }])
            })
            .collect(),
    )
}

fn check_zone(zone: &str, chunk: usize) {
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(corpus().with_file_name("expected").join(format!("{}.json", zone.replace('/', "-"))))
            .unwrap(),
    )
    .unwrap();
    let clock = Clock::with_zone(None, TimeZoneDatabase::bundled().get(zone).unwrap());
    let bundled = PricingStore::bundled();
    let pricing = ReaderPricing { pricing: &bundled, fallbacks: None };
    let claude_files = list_unique_source_files(&[corpus().join("claude")]).unwrap();
    let codex_files = list_unique_source_files(&[corpus().join("codex")]).unwrap();
    assert_eq!(json!(claude_files.iter().map(|f| relative(f)).collect::<Vec<_>>()), expected["claudeFiles"], "{zone}");
    assert_eq!(json!(codex_files.iter().map(|f| relative(f)).collect::<Vec<_>>()), expected["codexFiles"], "{zone}");

    let mut claude_parsed: Vec<CachedParse> = Vec::new();
    for (file, want) in claude_files.iter().zip(expected["claudeScans"].as_array().unwrap()) {
        let scanned = scan_claude_file(file, &clock, chunk).unwrap();
        let got: Vec<Value> = scanned
            .iter()
            .map(|m| json!({"key": m.key, "date": m.date.to_string(), "model": m.model, "counts": counts(&m.counts), "cwd": m.cwd}))
            .collect();
        assert_eq!(json!([relative(file), got]), *want, "{zone} chunk {chunk}");
        claude_parsed.push(finish_claude_scan(scanned, &pricing, &NoRemotes));
    }
    let mut codex_parsed: Vec<CachedParse> = Vec::new();
    for (file, want) in codex_files.iter().zip(expected["codexScans"].as_array().unwrap()) {
        let scan = scan_codex_file(file, &clock, chunk).unwrap();
        let sessions: Vec<Value> = scan
            .sessions
            .iter()
            .map(|s| json!({"dateStr": s.date.to_string(), "model": s.model, "inputTokens": s.input_tokens, "outputTokens": s.output_tokens, "cachedInputTokens": s.cached_input_tokens}))
            .collect();
        let got = json!({"sessions": sessions, "repositoryUrl": scan.repository_url, "cwd": scan.cwd});
        assert_eq!(json!([relative(file), got]), *want, "{zone} chunk {chunk}");
        codex_parsed.push(finish_codex_scan(&scan, &pricing, &NoRemotes));
    }
    assert_eq!(days(&merge_claude_parsed(&claude_parsed)), expected["claudeDays"], "{zone} Claude days");
    assert_eq!(days(&merge_codex_parsed(&codex_parsed)), expected["codexDays"], "{zone} Codex days");
}

#[test]
fn match_4x_in_every_recorded_zone() {
    for zone in ["Pacific/Kiritimati", "UTC", "Pacific/Midway", "Europe/Berlin"] {
        check_zone(zone, CHUNK_BYTES);
    }
}

#[test]
fn match_4x_with_tiny_chunks() {
    for chunk in [97, 1024] {
        check_zone("UTC", chunk);
    }
}

mod pipeline {
    use aitrack_core::Core;
    use aitrack_core::env::Env;
    use aitrack_core::output::VecOutput;
    use aitrack_core::readers::read::{read_claude_days, read_codex_days};

    use super::*;

    fn core(home: &Path, corpus: &Path, extra: &[(&str, &str)]) -> Core {
        let mut vars = vec![
            ("AITRACK_CLAUDE_PROJECTS_DIRS".to_owned(), corpus.join("claude").to_string_lossy().into_owned()),
            ("AITRACK_CODEX_SESSION_DIRS".to_owned(), corpus.join("codex").to_string_lossy().into_owned()),
        ];
        vars.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
        Core::new(Env::new(home, vars), Clock::in_zone("UTC").unwrap(), Box::new(VecOutput::default()))
    }

    fn copy_dir(from: &Path, to: &Path) {
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                std::fs::create_dir_all(&target).unwrap();
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    #[test]
    fn give_the_same_days_cold_from_the_snapshot_and_after_one_file_changes() {
        let expected: Value = serde_json::from_str(
            &std::fs::read_to_string(corpus().with_file_name("expected").join("UTC.json")).unwrap(),
        )
        .unwrap();
        let home = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        copy_dir(&corpus(), logs.path());
        let bundled = PricingStore::bundled();
        let pricing = ReaderPricing { pricing: &bundled, fallbacks: None };
        let read = |core: &Core| {
            (
                days(&read_claude_days(core, &pricing, &NoRemotes).unwrap()),
                days(&read_codex_days(core, &pricing, &NoRemotes).unwrap()),
            )
        };
        let want = (expected["claudeDays"].clone(), expected["codexDays"].clone());

        let cold = core(home.path(), logs.path(), &[]);
        assert_eq!(read(&cold), want, "cold");
        let cache_dir = home.path().join(".config/aitrack/cache");
        let mut cached: Vec<String> = std::fs::read_dir(&cache_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        cached.sort();
        assert_eq!(cached.len(), 4, "{cached:?}"); // A parse cache and a merged snapshot per provider.
        assert_eq!(read(&core(home.path(), logs.path(), &[])), want, "from the snapshot");

        // The resumed session stays cached and repeats keys, so its encoded messages must decode for the merge.
        let other = logs.path().join("claude/proj-a/c-all-new.jsonl");
        let text = std::fs::read_to_string(&other).unwrap();
        std::fs::write(&other, format!("{text}\n")).unwrap();
        assert_eq!(read(&core(home.path(), logs.path(), &[])), want, "one file rescanned");

        let uncached = tempfile::tempdir().unwrap();
        assert_eq!(read(&core(uncached.path(), logs.path(), &[("AITRACK_NO_CACHE", "1")])), want, "no cache");
        assert!(!uncached.path().join(".config").exists());
    }
}
