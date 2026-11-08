//! Turning one file's scan into the days the cache stores, and merging files into a provider's days.

use std::collections::{HashMap, HashSet};

use super::claude_scan::ScannedClaudeMessage;
use super::codex_scan::CodexScan;
use super::project::{ProjectResolver, attribute_cwd};
use crate::data::day_map::{Attribution, add_model_usage, get_or_create_day, merge_all_day_maps, merge_day_maps};
use crate::data::project::normalize_remote_url;
use crate::data::types::{DayMap, TokenCounts};
use crate::day::Day;

/// Cost estimates for the readers; the pricing tables implement it.
pub trait Pricing: Sync {
    fn claude_cost(&self, model: &str, counts: &TokenCounts, date: Day) -> Option<f64>;
    fn codex_cost(&self, model: &str, input: u64, output: u64, cached: u64, date: Day) -> Option<f64>;
}

/// Prices nothing, so every token is flagged unpriced.
pub struct NoPricing;

impl Pricing for NoPricing {
    fn claude_cost(&self, _: &str, _: &TokenCounts, _: Day) -> Option<f64> {
        None
    }

    fn codex_cost(&self, _: &str, _: u64, _: u64, _: u64, _: Day) -> Option<f64> {
        None
    }
}

/// One priced and attributed Claude message, kept so later files can drop the ones they repeat.
#[derive(Clone, Debug, PartialEq)]
pub struct CachedMessage {
    pub key: Option<String>,
    pub date: Day,
    pub model: String,
    pub counts: TokenCounts,
    pub attribution: Attribution,
}

/// One source file's contribution, computed from its own bytes alone so it can be cached.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CachedParse {
    pub days: DayMap,
    /// Claude message keys in file order; Codex has no cross-file dedup.
    pub keys: Vec<String>,
    pub messages: Vec<CachedMessage>,
}

pub fn finish_claude_scan(
    scanned: Vec<ScannedClaudeMessage>,
    pricing: &dyn Pricing,
    resolver: &dyn ProjectResolver,
) -> CachedParse {
    let mut parse = CachedParse::default();
    let mut attributions: HashMap<Option<String>, Attribution> = HashMap::new();
    for ScannedClaudeMessage { key, date, model, mut counts, cwd } in scanned {
        counts.cost_usd = pricing.claude_cost(&model, &counts, date);
        let attribution =
            attributions.entry(cwd.clone()).or_insert_with(|| attribute_cwd(resolver, cwd.as_deref())).clone();
        if let Some(key) = &key {
            parse.keys.push(key.clone());
        }
        let message = CachedMessage { key, date, model, counts, attribution };
        add_cached_message(&mut parse.days, &message);
        parse.messages.push(message);
    }
    parse
}

fn add_cached_message(days: &mut DayMap, message: &CachedMessage) {
    add_model_usage(get_or_create_day(days, message.date), &message.model, &message.counts, Some(&message.attribution));
}

/// Keep the first file's contribution when resumed transcripts repeat a message.
pub fn merge_claude_parsed(parsed: &[CachedParse]) -> DayMap {
    let mut all = DayMap::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for entry in parsed {
        let mut fresh: Option<HashSet<&str>> = None;
        for (index, key) in entry.keys.iter().enumerate() {
            if seen.insert(key) {
                if let Some(fresh) = &mut fresh {
                    fresh.insert(key);
                }
            } else if fresh.is_none() {
                fresh = Some(entry.keys[..index].iter().map(String::as_str).collect());
            }
        }
        let Some(mut fresh) = fresh else {
            merge_day_maps(&mut all, &entry.days);
            continue;
        };
        for message in &entry.messages {
            if message.key.as_deref().is_none_or(|key| fresh.remove(key)) {
                add_cached_message(&mut all, message);
            }
        }
    }
    all
}

fn attribute_scan(scan: &CodexScan, resolver: &dyn ProjectResolver) -> Attribution {
    match scan.repository_url.as_deref().and_then(normalize_remote_url) {
        Some(project) => Attribution { project, cwd: None },
        None => attribute_cwd(resolver, scan.cwd.as_deref()),
    }
}

pub fn finish_codex_scan(scan: &CodexScan, pricing: &dyn Pricing, resolver: &dyn ProjectResolver) -> CachedParse {
    let mut parse = CachedParse::default();
    if scan.sessions.is_empty() {
        return parse; // No git call for a file without usage.
    }
    let attribution = attribute_scan(scan, resolver);
    for session in &scan.sessions {
        let counts = TokenCounts {
            input_tokens: session.input_tokens,
            output_tokens: session.output_tokens,
            cached_input_tokens: Some(session.cached_input_tokens),
            cost_usd: pricing.codex_cost(
                &session.model,
                session.input_tokens,
                session.output_tokens,
                session.cached_input_tokens,
                session.date,
            ),
            ..TokenCounts::default()
        };
        add_model_usage(get_or_create_day(&mut parse.days, session.date), &session.model, &counts, Some(&attribution));
    }
    parse
}

pub fn merge_codex_parsed(parsed: &[CachedParse]) -> DayMap {
    merge_all_day_maps(parsed.iter().map(|p| &p.days))
}
