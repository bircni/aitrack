use std::io;
use std::path::Path;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use super::jsonl::{Carry, Filter, for_each_object};
use super::log_values::{is_optional_token_count, log_cwd, log_day, log_model, tokens_or_zero};
use crate::data::model_id::canonicalize_claude_model_id;
use crate::data::types::TokenCounts;
use crate::day::Day;
use crate::js::{Lenient, parse_object, template_string};
use crate::time::Clock;

/// One counted message, before pricing and project attribution.
#[derive(Clone, Debug, PartialEq)]
pub struct ScannedClaudeMessage {
    pub key: Option<String>,
    pub date: Day,
    pub model: String,
    pub counts: TokenCounts,
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<Value>,
    timestamp: Option<Value>,
    cwd: Option<Value>,
    #[serde(rename = "requestId")]
    request_id: Option<Value>,
    #[serde(default)]
    message: Lenient<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<Value>,
    model: Option<Value>,
    #[serde(default)]
    usage: Lenient<Usage>,
}

#[derive(Deserialize)]
pub struct Usage {
    input_tokens: Option<Value>,
    cache_read_input_tokens: Option<Value>,
    output_tokens: Option<Value>,
    speed: Option<Value>,
    cache_creation_input_tokens: Option<Value>,
    #[serde(default)]
    cache_creation: Lenient<CacheCreation>,
}

#[derive(Deserialize)]
struct CacheCreation {
    ephemeral_5m_input_tokens: Option<Value>,
    ephemeral_1h_input_tokens: Option<Value>,
}

impl Usage {
    fn has_valid_tokens(&self) -> bool {
        let writes = self.cache_creation.get();
        [
            self.input_tokens.as_ref(),
            self.output_tokens.as_ref(),
            self.cache_read_input_tokens.as_ref(),
            self.cache_creation_input_tokens.as_ref(),
            writes.and_then(|w| w.ephemeral_5m_input_tokens.as_ref()),
            writes.and_then(|w| w.ephemeral_1h_input_tokens.as_ref()),
        ]
        .into_iter()
        .all(is_optional_token_count)
    }

    /// Cache writes split into the 5-minute and 1-hour buckets when the transcript splits them.
    fn cache_writes(&self) -> (u64, u64) {
        let writes = self.cache_creation.get();
        let five = tokens_or_zero(writes.and_then(|w| w.ephemeral_5m_input_tokens.as_ref()));
        let hour = tokens_or_zero(writes.and_then(|w| w.ephemeral_1h_input_tokens.as_ref()));
        if five + hour > 0 { (five, hour) } else { (tokens_or_zero(self.cache_creation_input_tokens.as_ref()), 0) }
    }

    #[must_use]
    pub fn counts(&self) -> TokenCounts {
        let (five, hour) = self.cache_writes();
        let raw = tokens_or_zero(self.input_tokens.as_ref());
        let cached = tokens_or_zero(self.cache_read_input_tokens.as_ref());
        TokenCounts {
            input_tokens: raw + cached + five + hour,
            output_tokens: tokens_or_zero(self.output_tokens.as_ref()),
            raw_input_tokens: Some(raw),
            cached_input_tokens: Some(cached),
            cache_creation_input_tokens: Some(five),
            cache_creation_1h_input_tokens: (hour > 0).then_some(hour),
            ..TokenCounts::default()
        }
    }

    fn is_fast(&self) -> bool {
        self.speed.as_ref().and_then(Value::as_str) == Some("fast")
    }
}

const HAIKU_5_5_LONG_PROMPT_TOKENS: u64 = 100_000;

/// The key a message is stored and priced under; a prompt's length counts its cache reads and writes.
#[must_use]
pub fn claude_billed_model(model: &str, fast: bool, counts: &TokenCounts) -> String {
    if fast {
        format!("{model}-fast")
    } else if canonicalize_claude_model_id(model) == "claude-haiku-5-5"
        && counts.input_tokens > HAIKU_5_5_LONG_PROMPT_TOKENS
    {
        format!("{model}-long-context")
    } else {
        model.to_owned()
    }
}

/// Prefer more output, then more input; a later record wins a tie.
const fn is_richer_usage(next: &TokenCounts, current: &TokenCounts) -> bool {
    if next.output_tokens != current.output_tokens {
        return next.output_tokens > current.output_tokens;
    }
    if next.input_tokens != current.input_tokens {
        return next.input_tokens > current.input_tokens;
    }
    true
}

/// Keyed messages first, in first-seen order, then unkeyed ones.
pub fn scan_claude_file(path: &Path, clock: &Clock, chunk_bytes: usize) -> io::Result<Vec<ScannedClaudeMessage>> {
    let holds = |line: &Line| log_cwd(line.cwd.as_ref()).is_some();
    // Only lines with usage are counted; any other line can still move the session's cwd.
    let filter = Filter { needles: &["\"usage\""], carry: Some(Carry { needle: "\"cwd\"", holds: &holds }) };
    let mut chosen: IndexMap<String, ScannedClaudeMessage> = IndexMap::new();
    let mut unkeyed = Vec::new();
    let mut cwd: Option<String> = None;
    for_each_object(path, &filter, chunk_bytes, parse_object::<Line>, |line| {
        if let Some(next) = log_cwd(line.cwd.as_ref()) {
            cwd = Some(next.to_owned());
        }
        if line.kind.as_ref().and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let Some(message) = line.message.get() else { return };
        let Some(usage) = message.usage.get() else { return };
        if !usage.has_valid_tokens() {
            return;
        }
        let Some(date) = log_day(clock, line.timestamp.as_ref()) else { return };
        let counts = usage.counts();
        if counts.input_tokens == 0 && counts.output_tokens == 0 {
            return;
        }
        let model =
            claude_billed_model(log_model(message.model.as_ref()).unwrap_or("unknown"), usage.is_fast(), &counts);
        // No id to dedupe on: count the row. A known id keeps the fullest record in this file.
        let key = format!("{}:{}", template_string(message.id.as_ref()), template_string(line.request_id.as_ref()));
        if key == ":" {
            unkeyed.push(ScannedClaudeMessage { key: None, date, model, counts, cwd: cwd.clone() });
            return;
        }
        let richer = chosen.get(&key).is_none_or(|existing| is_richer_usage(&counts, &existing.counts));
        if richer {
            let message = ScannedClaudeMessage { key: Some(key.clone()), date, model, counts, cwd: cwd.clone() };
            chosen.insert(key, message);
        }
    })?;
    Ok(chosen.into_values().chain(unkeyed).collect())
}
