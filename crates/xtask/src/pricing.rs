//! The pricing pack the `pricing` branch publishes, built from the tables and the `LiteLLM` and
//! `models.dev` catalogs, in the bytes 4.x wrote.

use std::path::Path;
use std::time::Duration;

use aitrack_core::http::{HttpClient, Request};
use aitrack_core::js::{locale_compare, number_to_string, to_string_pretty};
use aitrack_core::pricing::catalog::{Catalog, ModelRates, find_catalog_rates, parse_compact_catalog};
use aitrack_core::time::{Clock, iso_millis};
use jiff::Timestamp;
use serde_json::{Map, Value, json};

const LITELLM_URL: &str = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_URL: &str = "https://models.dev/api.json";
const MODELS_DEV_PROVIDERS: [&str; 6] = ["anthropic", "openai", "cursor", "xai", "google", "google-vertex"];
/// First-party keys and bare Claude/GPT ids; aggregator markups such as regional Bedrock are dropped.
const LITELLM_PREFIXES: [&str; 10] = [
    "anthropic/",
    "openai/",
    "cursor/",
    "xai/",
    "google/",
    "claude-",
    "gpt-",
    "codex",
    "vercel_ai_gateway/anthropic/",
    "vercel_ai_gateway/openai/",
];
pub const CURSOR_PROVIDERS: [&str; 5] = ["cursor", "xai", "google", "openai", "anthropic"];

pub type Result<T> = std::result::Result<T, String>;

/// `JSON.stringify(value, null, 2)` and a newline, as every pack and table file is written.
pub fn pretty(value: &Value) -> String {
    format!("{}\n", to_string_pretty(value).expect("JSON values serialize"))
}

fn amount(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|x| x.is_finite() && *x >= 0.0)
}

/// `{ i, o, cw, cr, ia?, oa?, cwa?, cra?, fast?, cre?, cwe? }`, rates per million tokens.
fn compact_rates(
    input: f64,
    output: f64,
    cache_write: Option<f64>,
    cache_read: Option<f64>,
    extra: &[(&str, Option<f64>)],
    fast: f64,
) -> Value {
    let mut model = Map::new();
    model.insert("i".into(), json!(input));
    model.insert("o".into(), json!(output));
    model.insert("cw".into(), json!(cache_write.unwrap_or(input)));
    model.insert("cr".into(), json!(cache_read.unwrap_or(input * 0.1)));
    for (key, value) in extra {
        if let Some(value) = value {
            model.insert((*key).into(), json!(value));
        }
    }
    if (fast - 1.0).abs() > f64::EPSILON {
        model.insert("fast".into(), json!(fast));
    }
    if cache_read.is_none() {
        model.insert("cre".into(), json!(false));
    }
    if cache_write.is_none() {
        model.insert("cwe".into(), json!(false));
    }
    Value::Object(model)
}

fn litellm_rates(entry: &Map<String, Value>) -> Option<Value> {
    let per_million = |key: &str| amount(entry.get(key)).map(|x| x * 1e6);
    let (input, output) = (amount(entry.get("input_cost_per_token"))?, amount(entry.get("output_cost_per_token"))?);
    let cache_write = amount(entry.get("cache_creation_input_token_cost"));
    let cache_read = amount(entry.get("cache_read_input_token_cost"));
    let fast = entry.get("provider_specific_entry").and_then(|s| amount(s.get("fast"))).unwrap_or(1.0);
    // Defaults apply per token, then scale, in 4.x's order.
    let mut rates = compact_rates(
        input * 1e6,
        output * 1e6,
        Some(cache_write.unwrap_or(input) * 1e6),
        Some(cache_read.unwrap_or(input * 0.1) * 1e6),
        &[
            ("ia", per_million("input_cost_per_token_above_200k_tokens")),
            ("oa", per_million("output_cost_per_token_above_200k_tokens")),
            ("cwa", per_million("cache_creation_input_token_cost_above_200k_tokens")),
            ("cra", per_million("cache_read_input_token_cost_above_200k_tokens")),
        ],
        fast,
    );
    let model = rates.as_object_mut().expect("an object");
    if cache_read.is_none() {
        model.insert("cre".into(), json!(false));
    }
    if cache_write.is_none() {
        model.insert("cwe".into(), json!(false));
    }
    Some(rates)
}

fn models_dev_rates(cost: &Map<String, Value>) -> Option<Value> {
    let (input, output) = (amount(cost.get("input"))?, amount(cost.get("output"))?);
    if input == 0.0 && output == 0.0 {
        return None;
    }
    Some(compact_rates(input, output, amount(cost.get("cache_write")), amount(cost.get("cache_read")), &[], 1.0))
}

fn keeps_litellm_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    LITELLM_PREFIXES.iter().any(|p| key.starts_with(p))
        || (bytes.len() >= 2 && bytes[0] == b'o' && (b'1'..=b'9').contains(&bytes[1]))
}

/// Models sorted as `localeCompare` sorts them, under the time they were read.
fn compact_catalog(models: Vec<(String, Value)>, retrieved_at: &str, feed: &str) -> Result<Value> {
    let mut deduped: Vec<(String, Value)> = Vec::with_capacity(models.len());
    for (key, rates) in models {
        match deduped.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = rates,
            None => deduped.push((key, rates)),
        }
    }
    if deduped.is_empty() {
        return Err(format!("{feed} feed produced no usable entries"));
    }
    deduped.sort_by(|(a, _), (b, _)| locale_compare(a, b));
    Ok(json!({ "retrievedAt": retrieved_at, "models": Map::from_iter(deduped) }))
}

pub fn compact_litellm(root: &Map<String, Value>, retrieved_at: &str) -> Result<Value> {
    let models = root
        .iter()
        .filter(|(key, _)| *key != "sample_spec" && keeps_litellm_key(key))
        .filter_map(|(key, value)| Some((key.clone(), litellm_rates(value.as_object()?)?)))
        .collect();
    compact_catalog(models, retrieved_at, "LiteLLM")
}

/// Provider-qualified keys only, so a bare alias cannot leak rates past a provider allowlist.
pub fn compact_models_dev(root: &Map<String, Value>, retrieved_at: &str) -> Result<Value> {
    let mut models = Vec::new();
    for provider in MODELS_DEV_PROVIDERS {
        let Some(entries) = root.get(provider).and_then(|p| p.get("models")).and_then(Value::as_object) else {
            continue;
        };
        for (id, value) in entries {
            if let Some(rates) = value.get("cost").and_then(Value::as_object).and_then(models_dev_rates) {
                models.push((format!("{provider}/{id}"), rates));
            }
        }
    }
    compact_catalog(models, retrieved_at, "models.dev")
}

fn fetch_json(http: &dyn HttpClient, url: &str) -> Result<Map<String, Value>> {
    let request = Request::get(url, Duration::from_secs(30)).header("user-agent", "aitrack-pricing");
    let response = http.send(&request).map_err(|e| format!("{url}: {e}"))?;
    if !response.is_ok() {
        return Err(format!("HTTP {} for {url}", response.status));
    }
    match serde_json::from_slice(&response.body) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(format!("invalid pricing catalog for {url}")),
    }
}

/// The two catalogs, compact, as the pack publishes them.
pub fn fetch_catalogs(http: &dyn HttpClient, now: Timestamp) -> Result<(Value, Value)> {
    let (litellm, models_dev) = std::thread::scope(|s| {
        let litellm = s.spawn(|| fetch_json(http, LITELLM_URL));
        let models_dev = fetch_json(http, MODELS_DEV_URL);
        (litellm.join().expect("the fetch does not panic"), models_dev)
    });
    let retrieved_at = iso_millis(now);
    Ok((compact_litellm(&litellm?, &retrieved_at)?, compact_models_dev(&models_dev?, &retrieved_at)?))
}

pub struct Catalogs {
    pub primary: Catalog,
    pub secondary: Catalog,
}

impl Catalogs {
    pub fn from_compact(litellm: &Value, models_dev: &Value) -> Result<Self> {
        let parse = |v: &Value, feed: &str| parse_compact_catalog(v).ok_or_else(|| format!("invalid {feed} catalog"));
        Ok(Self { primary: parse(litellm, "LiteLLM")?, secondary: parse(models_dev, "models.dev")? })
    }

    pub fn rates(&self, model_id: &str, providers: &[&str]) -> Option<ModelRates> {
        find_catalog_rates(&self.primary, model_id, providers)
            .or_else(|| find_catalog_rates(&self.secondary, model_id, providers))
    }
}

pub fn rates_equal(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn field(row: &Value, key: &str) -> f64 {
    row.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `claude.json`, `codex.json` and `cursor.json` as read, key order kept.
pub struct Tables {
    pub claude: Map<String, Value>,
    pub codex: Map<String, Value>,
    pub cursor: Map<String, Value>,
}

impl Tables {
    pub fn read(dir: &Path) -> Result<Self> {
        let read = |name: &str| -> Result<Map<String, Value>> {
            let path = dir.join(format!("{name}.json"));
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            match serde_json::from_str(&text) {
                Ok(Value::Object(map)) => Ok(map),
                _ => Err(format!("{} is not a JSON object", path.display())),
            }
        };
        Ok(Self { claude: read("claude")?, codex: read("codex")?, cursor: read("cursor")? })
    }

    /// The supplement the tables make; its `updatedAt` is the newest table's.
    pub fn supplement(&self) -> Result<Value> {
        let stamp = |table: &Map<String, Value>| {
            let updated = table.get("updatedAt").and_then(Value::as_str).unwrap_or_default();
            let text = if updated.contains('T') { updated.to_owned() } else { format!("{updated}T00:00:00Z") };
            Clock::system().parse_timestamp(&text).ok_or_else(|| format!("table updatedAt {updated:?} is not a date"))
        };
        let newest = stamp(&self.claude)?.max(stamp(&self.codex)?).max(stamp(&self.cursor)?);
        let pick = |table: &Map<String, Value>, keys: &[&str]| {
            Value::Object(
                keys.iter().map(|k| ((*k).to_owned(), table.get(*k).cloned().unwrap_or(Value::Null))).collect(),
            )
        };
        Ok(json!({
            "updatedAt": iso_millis(newest),
            "comment": "First-party pricing from tables/*.json. Catalogs supply additional models.",
            "claude": pick(&self.claude, &["models", "overrides", "familyFallback"]),
            "codex": pick(&self.codex, &["current", "historical", "overrides", "familyFallback"]),
            "cursor": pick(&self.cursor, &["models", "fastMultipliers", "aliases"]),
        }))
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub claude: Vec<String>,
    pub codex: Vec<String>,
}

/// Claude rates and Codex `current` IO from the catalogs. Claude's cache rates follow the input
/// rate's change unless the catalog published them.
pub fn apply_catalog_rates(supplement: &mut Value, catalogs: &Catalogs) -> Changes {
    let mut changes = Changes::default();
    if let Some(models) = supplement.pointer_mut("/claude/models").and_then(Value::as_object_mut) {
        for (id, row) in models.iter_mut() {
            let Some(rates) = catalogs.rates(id, &["anthropic"]) else { continue };
            let (input, output) = (field(row, "inputPerMillion"), field(row, "outputPerMillion"));
            let (create, read) = (field(row, "cacheCreatePerMillion"), field(row, "cacheReadPerMillion"));
            let write_stale = rates.cache_write_explicit && !rates_equal(create, rates.cache_write);
            let read_stale = rates.cache_read_explicit && !rates_equal(read, rates.cache_read);
            if rates_equal(input, rates.input) && rates_equal(output, rates.output) && !write_stale && !read_stale {
                continue;
            }
            let ratio = if input == 0.0 { 1.0 } else { rates.input / input };
            let row = row.as_object_mut().expect("a rate row");
            let create = if rates.cache_write_explicit { rates.cache_write } else { create * ratio };
            let read = if rates.cache_read_explicit { rates.cache_read } else { read * ratio };
            row.insert("cacheCreatePerMillion".into(), json!(create));
            row.insert("cacheReadPerMillion".into(), json!(read));
            row.insert("inputPerMillion".into(), json!(rates.input));
            row.insert("outputPerMillion".into(), json!(rates.output));
            changes.claude.push(id.clone());
        }
    }
    if let Some(current) = supplement.pointer_mut("/codex/current").and_then(Value::as_object_mut) {
        for (id, row) in current.iter_mut() {
            let Some(rates) = catalogs.rates(id, &["openai"]) else { continue };
            if rates_equal(field(row, "inputPerMillion"), rates.input)
                && rates_equal(field(row, "outputPerMillion"), rates.output)
            {
                continue;
            }
            let row = row.as_object_mut().expect("a rate row");
            row.insert("inputPerMillion".into(), json!(rates.input));
            row.insert("outputPerMillion".into(), json!(rates.output));
            changes.codex.push(id.clone());
        }
    }
    changes
}

pub enum Finding {
    Ok,
    Drift { input_ok: bool, output_ok: bool, saw: (f64, f64) },
    Unverified,
}

pub fn summary(row: &Value) -> String {
    format!(
        "${}/${}",
        number_to_string(field(row, "inputPerMillion")),
        number_to_string(field(row, "outputPerMillion"))
    )
}

/// Each row of `table` against the catalogs, in table order.
pub fn compare_table<'a>(
    table: &'a Map<String, Value>,
    providers: &[&str],
    catalogs: &Catalogs,
) -> Vec<(&'a str, &'a Value, Finding)> {
    table
        .iter()
        .map(|(id, row)| {
            let finding = match catalogs.rates(id, providers) {
                None => Finding::Unverified,
                Some(rates) => {
                    let input_ok = rates_equal(field(row, "inputPerMillion"), rates.input);
                    let output_ok = rates_equal(field(row, "outputPerMillion"), rates.output);
                    if input_ok && output_ok {
                        Finding::Ok
                    } else {
                        Finding::Drift { input_ok, output_ok, saw: (rates.input, rates.output) }
                    }
                }
            };
            (id.as_str(), row, finding)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_litellm_as_4x_did() {
        let root = json!({
            "sample_spec": { "input_cost_per_token": 1 },
            "bedrock/eu.claude": { "input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6 },
            "claude-x": { "input_cost_per_token": 3e-6, "output_cost_per_token": 1.5e-5,
                "cache_read_input_token_cost": 3e-7, "provider_specific_entry": { "fast": 6 } },
            "anthropic/claude-x": { "input_cost_per_token": 3e-6, "output_cost_per_token": 1.5e-5,
                "cache_creation_input_token_cost": 3.75e-6, "cache_read_input_token_cost": 3e-7,
                "input_cost_per_token_above_200k_tokens": 6e-6 },
            "o3": { "input_cost_per_token": 2e-6, "output_cost_per_token": 8e-6 }
        });
        let compact = compact_litellm(root.as_object().unwrap(), "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(
            to_string_pretty(&compact["models"]).unwrap(),
            to_string_pretty(&json!({
                "anthropic/claude-x": { "i": 3, "o": 15, "cw": 3.75, "cr": 0.3, "ia": 6 },
                "claude-x": { "i": 3, "o": 15, "cw": 3, "cr": 0.3, "fast": 6, "cwe": false },
                "o3": { "i": 2, "o": 8, "cw": 2, "cr": 0.199_999_999_999_999_98, "cre": false, "cwe": false }
            }))
            .unwrap()
        );
    }

    #[test]
    fn moves_claude_cache_rates_with_the_input_rate_unless_published() {
        let litellm = json!({ "retrievedAt": "2026-01-01T00:00:00.000Z", "models": {
            "anthropic/claude-a": { "i": 6, "o": 30, "cw": 6, "cr": 0.6, "cre": false, "cwe": false },
            "anthropic/claude-b": { "i": 1, "o": 5, "cw": 1.25, "cr": 0.1 },
            "openai/gpt-x": { "i": 2, "o": 8, "cw": 2, "cr": 0.2 }
        }});
        let models_dev = json!({ "retrievedAt": "2026-01-01T00:00:00.000Z", "models": { "x/y": { "i": 1, "o": 1, "cw": 1, "cr": 1 } } });
        let catalogs = Catalogs::from_compact(&litellm, &models_dev).unwrap();
        let mut supplement = json!({
            "claude": { "models": {
                "claude-a": { "inputPerMillion": 3, "outputPerMillion": 15, "cacheReadPerMillion": 0.3, "cacheCreatePerMillion": 3.75 },
                "claude-b": { "inputPerMillion": 1, "outputPerMillion": 5, "cacheReadPerMillion": 0.1, "cacheCreatePerMillion": 1.25 }
            }},
            "codex": { "current": { "gpt-x": { "inputPerMillion": 1.5, "outputPerMillion": 8 } } }
        });
        let changes = apply_catalog_rates(&mut supplement, &catalogs);
        assert_eq!(changes, Changes { claude: vec!["claude-a".into()], codex: vec!["gpt-x".into()] });
        assert_eq!(
            to_string_pretty(&supplement["claude"]["models"]["claude-a"]).unwrap(),
            to_string_pretty(&json!({ "inputPerMillion": 6, "outputPerMillion": 30, "cacheReadPerMillion": 0.6, "cacheCreatePerMillion": 7.5 })).unwrap()
        );
        assert_eq!(supplement["codex"]["current"]["gpt-x"]["inputPerMillion"], json!(2.0));
    }
}
