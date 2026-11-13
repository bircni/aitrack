use std::io;
use std::path::Path;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use super::jsonl::{Filter, for_each_object};
use super::log_values::{is_optional_token_count, log_cwd, log_day, log_model, token_count, tokens_or_zero};
use crate::data::types::TokenCounts;
use crate::day::Day;
use crate::js::{Lenient, parse_object};
use crate::time::Clock;

/// One AI credit is $0.01.
const NANO_AIU_PER_USD: f64 = 1e11;

/// One request, priced by the credits Copilot logged for it.
#[derive(Clone, Debug, PartialEq)]
pub struct ScannedCopilotMessage {
    pub key: Option<String>,
    pub date: Day,
    pub model: String,
    pub counts: TokenCounts,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CopilotScan {
    pub messages: Vec<ScannedCopilotMessage>,
    pub repository_url: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<Value>,
    timestamp: Option<Value>,
    #[serde(default)]
    data: Lenient<Data>,
}

#[derive(Deserialize)]
struct Data {
    #[serde(default)]
    context: Lenient<Context>,
    #[serde(default)]
    usage: Lenient<Usage>,
}

#[derive(Deserialize)]
struct Context {
    cwd: Option<Value>,
    repository: Option<Value>,
    #[serde(rename = "repositoryHost")]
    repository_host: Option<Value>,
}

#[derive(Deserialize)]
struct Usage {
    model: Option<Value>,
    #[serde(rename = "inputTokens")]
    input_tokens: Option<Value>,
    #[serde(rename = "outputTokens")]
    output_tokens: Option<Value>,
    #[serde(rename = "cacheReadTokens")]
    cache_read_tokens: Option<Value>,
    #[serde(rename = "cacheWriteTokens")]
    cache_write_tokens: Option<Value>,
    #[serde(default)]
    accounting: Lenient<Accounting>,
    #[serde(rename = "copilotUsage", default)]
    credits: Lenient<CopilotUsage>,
}

#[derive(Deserialize)]
struct Accounting {
    #[serde(rename = "usageId")]
    usage_id: Option<Value>,
}

#[derive(Deserialize)]
struct CopilotUsage {
    #[serde(rename = "totalNanoAiu")]
    total_nano_aiu: Option<Value>,
}

impl Usage {
    fn counts(&self) -> Option<TokenCounts> {
        let fields = [&self.input_tokens, &self.output_tokens, &self.cache_read_tokens, &self.cache_write_tokens];
        if !fields.into_iter().all(|v| is_optional_token_count(v.as_ref())) {
            return None;
        }
        // `inputTokens` already includes both cache buckets.
        let input = tokens_or_zero(self.input_tokens.as_ref());
        let cached = tokens_or_zero(self.cache_read_tokens.as_ref());
        let written = tokens_or_zero(self.cache_write_tokens.as_ref());
        #[expect(clippy::cast_precision_loss, reason = "credits stay far below 2^53")]
        let cost = self
            .credits
            .get()
            .and_then(|u| u.total_nano_aiu.as_ref())
            .and_then(token_count)
            .map(|nano| nano as f64 / NANO_AIU_PER_USD);
        Some(TokenCounts {
            input_tokens: input,
            output_tokens: tokens_or_zero(self.output_tokens.as_ref()),
            raw_input_tokens: Some(input.saturating_sub(cached + written)),
            cached_input_tokens: Some(cached),
            cache_creation_input_tokens: Some(written),
            cost_usd: cost,
            ..TokenCounts::default()
        })
    }
}

/// A session's requests, from the per-request `session.usage_record` events, keyed by `usageId`.
///
/// # Errors
///
/// When the file cannot be read.
pub fn scan_copilot_file(path: &Path, clock: &Clock, chunk_bytes: usize) -> io::Result<CopilotScan> {
    let filter = Filter { needles: &["\"session.start\"", "\"session.usage_record\""], carry: None };
    let mut scan = CopilotScan::default();
    let mut keyed: IndexMap<String, ScannedCopilotMessage> = IndexMap::new();
    let mut unkeyed = Vec::new();
    for_each_object(path, &filter, chunk_bytes, parse_object::<Line>, |line| {
        let data = line.data.get();
        match line.kind.as_ref().and_then(Value::as_str) {
            Some("session.start") => {
                let Some(context) = data.and_then(|d| d.context.get()) else { return };
                if let Some(repository) = context.repository.as_ref().and_then(Value::as_str) {
                    let host = context.repository_host.as_ref().and_then(Value::as_str).unwrap_or("github.com");
                    scan.repository_url.get_or_insert_with(|| format!("https://{host}/{repository}"));
                }
                if scan.cwd.is_none() {
                    scan.cwd = log_cwd(context.cwd.as_ref()).map(str::to_owned);
                }
            }
            Some("session.usage_record") => {
                let Some(usage) = data.and_then(|d| d.usage.get()) else { return };
                let Some(date) = log_day(clock, line.timestamp.as_ref()) else { return };
                let Some(counts) = usage.counts() else { return };
                if counts.input_tokens == 0 && counts.output_tokens == 0 {
                    return;
                }
                let model = log_model(usage.model.as_ref()).unwrap_or("unknown").to_owned();
                let key = usage.accounting.get().and_then(|a| a.usage_id.as_ref()).and_then(Value::as_str);
                match key.filter(|k| !k.is_empty()) {
                    Some(key) => {
                        let message = ScannedCopilotMessage { key: Some(key.to_owned()), date, model, counts };
                        keyed.entry(key.to_owned()).or_insert(message);
                    }
                    None => unkeyed.push(ScannedCopilotMessage { key: None, date, model, counts }),
                }
            }
            _ => {}
        }
    })?;
    scan.messages = keyed.into_values().chain(unkeyed).collect();
    Ok(scan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(timestamp: &str, id: &str) -> String {
        format!(
            r#"{{"type":"session.usage_record","data":{{"usage":{{"model":"claude-haiku-4.5","inputTokens":24716,"outputTokens":152,"cacheReadTokens":24396,"cacheWriteTokens":315,"accounting":{{"usageId":"{id}"}},"copilotUsage":{{"totalNanoAiu":359835000}}}}}},"timestamp":"{timestamp}"}}"#
        )
    }

    #[test]
    fn reads_usage_records_once_each_on_the_local_day() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let start = r#"{"type":"session.start","data":{"context":{"cwd":"/w/thu","repository":"bircni/THU","repositoryHost":"github.com"}},"timestamp":"2026-11-12T10:00:00.000Z"}"#;
        let lines = [
            start.to_owned(),
            r#"{"type":"tool.execution_complete","data":{"result":"\"session.usage_record\""}}"#.to_owned(),
            record("2026-11-12T10:30:00.000Z", "a"),
            record("2026-11-12T10:30:00.000Z", "a"),
            record("2026-11-12T23:30:00.000Z", "b"),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        let instant = "2026-11-13T00:00:00Z".parse().unwrap();
        for (zone, days) in [
            ("Pacific/Kiritimati", ["2026-11-13", "2026-11-13"]),
            ("UTC", ["2026-11-12", "2026-11-12"]),
            ("Pacific/Midway", ["2026-11-11", "2026-11-12"]),
        ] {
            let scan = scan_copilot_file(&path, &Clock::fixed(instant, zone).unwrap(), 64).unwrap();
            assert_eq!(scan.repository_url.as_deref(), Some("https://github.com/bircni/THU"));
            assert_eq!(scan.cwd.as_deref(), Some("/w/thu"));
            let dates: Vec<String> = scan.messages.iter().map(|m| m.date.to_string()).collect();
            assert_eq!(dates, days, "{zone}");
            let first = &scan.messages[0];
            assert_eq!((first.key.as_deref(), first.model.as_str()), (Some("a"), "claude-haiku-4.5"));
            assert_eq!(
                first.counts,
                TokenCounts {
                    input_tokens: 24716,
                    output_tokens: 152,
                    raw_input_tokens: Some(5),
                    cached_input_tokens: Some(24396),
                    cache_creation_input_tokens: Some(315),
                    cost_usd: Some(0.003_598_35),
                    ..TokenCounts::default()
                }
            );
        }
    }
}
