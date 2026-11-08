use std::io;
use std::path::Path;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use super::jsonl::{Carry, Filter, for_each_object};
use super::log_values::{is_optional_token_count, log_cwd, log_day, log_model, token_count, tokens_or_zero};
use crate::day::Day;
use crate::js::{Lenient, is_truthy, parse_object};
use crate::time::Clock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionTotals {
    pub date: Day,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
}

/// A session's totals and where it ran.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodexScan {
    pub sessions: Vec<SessionTotals>,
    pub repository_url: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<Value>,
    timestamp: Option<Value>,
    #[serde(default)]
    payload: Lenient<Payload>,
}

#[derive(Deserialize)]
struct Payload {
    #[serde(rename = "type")]
    kind: Option<Value>,
    model: Option<Value>,
    cwd: Option<Value>,
    #[serde(default)]
    git: Lenient<Git>,
    info: Option<Value>,
}

#[derive(Deserialize)]
struct Git {
    repository_url: Option<Value>,
}

#[derive(Clone, Copy, Default)]
struct Usage {
    input: u64,
    output: u64,
    cached: u64,
}

struct Reported {
    input: u64,
    output: u64,
    /// Unset rather than zero: "not reported" must not look like a reset.
    cached: Option<u64>,
}

impl Reported {
    fn usage(&self) -> Usage {
        Usage { input: self.input, output: self.output, cached: self.cached.unwrap_or(0) }
    }
}

/// `None` when any count is malformed: part of a broken record is not worth counting.
fn reported_usage(usage: Option<&Value>) -> Option<Reported> {
    let usage = usage?.as_object()?;
    let (input, output, cached) =
        (usage.get("input_tokens"), usage.get("output_tokens"), usage.get("cached_input_tokens"));
    if ![input, output, cached].into_iter().all(is_optional_token_count) {
        return None;
    }
    Some(Reported {
        input: tokens_or_zero(input),
        output: tokens_or_zero(output),
        cached: cached.and_then(token_count),
    })
}

/// What one `token_count` adds, and the running total after it.
fn usage_since(info: &serde_json::Map<String, Value>, previous: Usage) -> Option<(Usage, Usage)> {
    let total_value = info.get("total_token_usage");
    if !is_truthy(total_value) {
        return reported_usage(info.get("last_token_usage")).map(|last| (last.usage(), previous));
    }
    let current = reported_usage(total_value)?; // The next good total still includes this turn.
    let total =
        Usage { input: current.input, output: current.output, cached: current.cached.unwrap_or(previous.cached) };
    // Only an input or output drop means the cumulative counter compacted.
    if current.input < previous.input || current.output < previous.output {
        let usage = reported_usage(info.get("last_token_usage")).unwrap_or(current).usage();
        return Some((usage, total));
    }
    let usage = Usage {
        input: total.input - previous.input,
        output: total.output - previous.output,
        cached: total.cached.saturating_sub(previous.cached),
    };
    Some((usage, total))
}

pub fn scan_codex_file(path: &Path, clock: &Clock, chunk_bytes: usize) -> io::Result<CodexScan> {
    let holds = |line: &Line| log_day(clock, line.timestamp.as_ref()).is_some();
    // Every line moves the current day; only these types are read for more.
    let filter = Filter {
        needles: &["\"session_meta\"", "\"turn_context\"", "\"token_count\""],
        carry: Some(Carry { needle: "\"timestamp\"", holds: &holds }),
    };
    let mut current_date: Option<Day> = None;
    let mut model = "unknown".to_owned();
    let mut previous = Usage::default();
    let mut results: IndexMap<(Day, String), SessionTotals> = IndexMap::new();
    let mut scan = CodexScan::default();
    for_each_object(path, &filter, chunk_bytes, parse_object::<Line>, |line| {
        let kind = line.kind.as_ref().and_then(Value::as_str);
        let payload = line.payload.get();
        if kind == Some("session_meta") || (kind == Some("turn_context") && scan.cwd.is_none()) {
            let url = payload.and_then(|p| p.git.get()).and_then(|g| g.repository_url.as_ref()).and_then(Value::as_str);
            if let Some(url) = url {
                scan.repository_url.get_or_insert_with(|| url.to_owned());
            }
            if scan.cwd.is_none() {
                scan.cwd = log_cwd(payload.and_then(|p| p.cwd.as_ref())).map(str::to_owned);
            }
        }
        current_date = log_day(clock, line.timestamp.as_ref()).or(current_date);
        if kind == Some("turn_context")
            && let Some(next) = log_model(payload.and_then(|p| p.model.as_ref()))
        {
            next.clone_into(&mut model);
        }
        let is_token_count = payload.and_then(|p| p.kind.as_ref()).and_then(Value::as_str) == Some("token_count");
        if kind != Some("event_msg") || !is_token_count {
            return;
        }
        let info = payload.and_then(|p| p.info.as_ref());
        if !is_truthy(info) {
            return;
        }
        let Some((usage, total)) = info.and_then(Value::as_object).and_then(|info| usage_since(info, previous)) else {
            return;
        };
        previous = total;
        let Some(date) = current_date else { return };
        if usage.input == 0 && usage.output == 0 {
            return;
        }
        let entry = results.entry((date, model.clone())).or_insert_with(|| SessionTotals {
            date,
            model: model.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cached_input_tokens: 0,
        });
        entry.input_tokens += usage.input;
        entry.output_tokens += usage.output;
        entry.cached_input_tokens += usage.cached;
    })?;
    scan.sessions = results.into_values().collect();
    Ok(scan)
}
