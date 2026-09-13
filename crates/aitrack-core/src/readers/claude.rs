//! Claude Code reader.

use crate::data::day_map::{add_model_usage, merge_day_maps, try_local_date_string};
use crate::data::model_id::strip_model_alias_suffix;
use crate::data::types::DayMap;
use crate::pricing::claude::estimate_claude_cost_usd;
use crate::pricing::fallback::FallbackCollector;
use crate::readers::cache::CachedParse;
use crate::readers::jsonl::stream_jsonl_objects;
use crate::readers::paths::get_claude_paths;
use crate::readers::pipeline::parse_provider_sources;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Parse one Claude transcript file against a dedup set.
fn parse_jsonl_file(
    file_path: &Path,
    seen: &mut HashSet<String>,
    fallbacks: Option<&mut FallbackCollector>,
) -> anyhow::Result<DayMap> {
    let mut result = DayMap::new();

    for obj in stream_jsonl_objects(file_path)? {
        // Check if type is "assistant"
        let entry_type = obj.get("type").and_then(|v| v.as_str());
        if entry_type != Some("assistant") {
            continue;
        }

        let message = match obj.get("message") {
            Some(Value::Object(m)) => m,
            _ => continue,
        };

        let usage = match message.get("usage") {
            Some(Value::Object(u)) => u,
            _ => continue,
        };

        let output_tokens = usage
            .get("output_tokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        if output_tokens == 0 {
            continue;
        }

        // Build dedup key
        let message_id = message.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let request_id = obj.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
        let key = format!("{}:{}", message_id, request_id);

        if key != ":" && seen.contains(&key) {
            continue;
        }
        if key != ":" {
            seen.insert(key);
        }

        let timestamp = match obj.get("timestamp").and_then(|v| v.as_str()) {
            Some(ts) => ts,
            None => continue,
        };

        let date_string = match try_local_date_string(timestamp) {
            Some(ds) => ds,
            None => continue,
        };

        let model = strip_model_alias_suffix(
            message
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown"),
        );

        let input_tokens = usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_creation = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output_tokens_u64 = output_tokens as u64;

        let total_input = input_tokens + cache_read + cache_creation;

        let claude_usage = crate::pricing::claude::ClaudeMessageUsage {
            input_tokens: Some(input_tokens),
            cache_read_input_tokens: Some(cache_read),
            output_tokens: Some(output_tokens_u64),
            cache_creation_input_tokens: Some(cache_creation),
        };

        let cost_usd = estimate_claude_cost_usd(
            &model,
            &claude_usage,
            Some(&date_string),
            fallbacks.as_deref(),
        );

        let day = result.entry(date_string).or_default();

        add_model_usage(
            day,
            &model,
            &crate::data::types::TokenCounts {
                input_tokens: total_input,
                output_tokens: output_tokens_u64,
                cached_input_tokens: Some(cache_read),
                raw_input_tokens: Some(input_tokens),
                cache_creation_input_tokens: Some(cache_creation),
                cost_usd: Some(cost_usd),
            },
        );
    }

    Ok(result)
}

/// Parse one Claude file in isolation (for caching).
pub fn parse_claude_file(file_path: &Path) -> anyhow::Result<CachedParse> {
    let mut keys = HashSet::new();
    let days = parse_jsonl_file(file_path, &mut keys, None)?;
    Ok(CachedParse {
        days,
        keys: keys.into_iter().collect(),
    })
}

/// Fold per-file parses into one DayMap, re-reading files with colliding keys.
async fn merge_claude_parsed(
    parsed: Vec<CachedParse>,
    files: Vec<PathBuf>,
) -> anyhow::Result<DayMap> {
    let mut all_days = DayMap::new();
    let mut seen_messages = HashSet::new();

    for (index, entry) in parsed.iter().enumerate() {
        let file_path = &files[index];

        // Check if any keys in this file were already seen
        if entry.keys.iter().any(|key| seen_messages.contains(key)) {
            // Re-read this file against the running set
            let fresh_days = parse_jsonl_file(file_path, &mut seen_messages, None)?;
            merge_day_maps(&mut all_days, &fresh_days);
            continue;
        }

        // No collisions, use cached data
        for key in &entry.keys {
            seen_messages.insert(key.clone());
        }
        merge_day_maps(&mut all_days, &entry.days);
    }

    Ok(all_days)
}

pub fn read_claude_data(_fallbacks: Option<&mut FallbackCollector>) -> anyhow::Result<DayMap> {
    let roots = get_claude_paths();
    let result = parse_provider_sources("claude", roots, parse_claude_file)?;

    // Use pollster instead of futures for blocking
    pollster::block_on(merge_claude_parsed(result.parsed, result.files))
}
