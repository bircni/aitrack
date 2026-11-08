//! The readers against what 4.x made of the same corpus, recorded by `fixtures/readers/generate.ts`.

use std::path::{Path, PathBuf};

use aitrack_core::data::types::{CountsByKey, DayMap, TokenCounts};
use aitrack_core::readers::claude_scan::scan_claude_file;
use aitrack_core::readers::codex_scan::scan_codex_file;
use aitrack_core::readers::jsonl::CHUNK_BYTES;
use aitrack_core::readers::paths::list_unique_source_files;
use aitrack_core::readers::project::ProjectResolver;
use aitrack_core::readers::provider::{
    CachedParse, NoPricing, finish_claude_scan, finish_codex_scan, merge_claude_parsed, merge_codex_parsed,
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
    let clock = Clock::in_zone(zone).unwrap();
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
        claude_parsed.push(finish_claude_scan(scanned, &NoPricing, &NoRemotes));
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
        codex_parsed.push(finish_codex_scan(&scan, &NoPricing, &NoRemotes));
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
