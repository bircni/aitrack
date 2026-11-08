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
    /// Changes whenever any cost would; caches with costs baked in are keyed by it.
    fn fingerprint(&self) -> String;
    fn claude_cost(&self, model: &str, counts: &TokenCounts, date: Day) -> Option<f64>;
    fn codex_cost(&self, model: &str, input: u64, output: u64, cached: u64, date: Day) -> Option<f64>;
}

/// Prices nothing, so every token is flagged unpriced.
pub struct NoPricing;

impl Pricing for NoPricing {
    fn fingerprint(&self) -> String {
        "none".to_owned()
    }

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
#[derive(Clone, Debug, Default)]
pub struct CachedParse {
    pub days: DayMap,
    /// Claude message keys in file order; Codex has no cross-file dedup.
    pub keys: Vec<String>,
    /// Claude only. From the cache they stay encoded until a merge needs them.
    pub messages: Option<Messages>,
}

#[derive(Clone, Debug)]
pub enum Messages {
    Decoded(Vec<CachedMessage>),
    Encoded(Box<serde_json::value::RawValue>),
}

impl CachedParse {
    /// The messages, or `None` when there are none or a cached blob is corrupt: the days then count whole.
    pub fn messages(&self) -> Option<std::borrow::Cow<'_, [CachedMessage]>> {
        match self.messages.as_ref()? {
            Messages::Decoded(messages) => Some(std::borrow::Cow::Borrowed(messages)),
            Messages::Encoded(raw) => super::cache::decode_messages(raw, &self.keys).map(std::borrow::Cow::Owned),
        }
    }
}

pub fn finish_claude_scan(
    scanned: Vec<ScannedClaudeMessage>,
    pricing: &dyn Pricing,
    resolver: &dyn ProjectResolver,
) -> CachedParse {
    let mut parse = CachedParse::default();
    let mut messages = Vec::new();
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
        messages.push(message);
    }
    parse.messages = Some(Messages::Decoded(messages));
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
        let messages = fresh.as_ref().and_then(|_| entry.messages());
        let (Some(mut fresh), Some(messages)) = (fresh, messages) else {
            merge_day_maps(&mut all, &entry.days);
            continue;
        };
        for message in messages.iter() {
            if message.key.as_deref().is_none_or(|key| fresh.remove(key)) {
                add_cached_message(&mut all, message);
            }
        }
    }
    all
}

fn attribute_scan(scan: &CodexScan, resolver: &dyn ProjectResolver) -> Attribution {
    scan.repository_url
        .as_deref()
        .and_then(normalize_remote_url)
        .map_or_else(|| attribute_cwd(resolver, scan.cwd.as_deref()), |project| Attribution { project, cwd: None })
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

#[must_use]
pub fn merge_codex_parsed(parsed: &[CachedParse]) -> DayMap {
    merge_all_day_maps(parsed.iter().map(|p| &p.days))
}
