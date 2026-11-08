//! Prints the Claude and Codex days for this machine's logs as JSON, costs left out.
//! Used to compare against 4.x on real logs: `cargo run --release -p aitrack-core --example dump_days`.

use aitrack_core::Core;
use aitrack_core::data::types::{CountsByKey, DayMap, TokenCounts};
use aitrack_core::env::Env;
use aitrack_core::output::StdOutput;
use aitrack_core::readers::project::GitProjectResolver;
use aitrack_core::readers::provider::NoPricing;
use aitrack_core::readers::read::{read_claude_days, read_codex_days};
use aitrack_core::time::Clock;
use serde_json::{Value, json};

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
                json!([date.to_string(), {"counts": counts(&day.counts), "byModel": record(Some(&day.by_model)), "byProject": record(day.by_project.as_ref()), "byCwd": record(day.by_cwd.as_ref())}])
            })
            .collect(),
    )
}

fn main() -> std::io::Result<()> {
    let core =
        Core::new(Env::from_process(), Clock::system(), Box::new(StdOutput { quiet: true, info_to_stderr: true }));
    let resolver = GitProjectResolver::default();
    let claude = read_claude_days(&core, &NoPricing, &resolver)?;
    let codex = read_codex_days(&core, &NoPricing, &resolver)?;
    println!("{}", json!({"claudeDays": days(&claude), "codexDays": days(&codex)}));
    Ok(())
}
