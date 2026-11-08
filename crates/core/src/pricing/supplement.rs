//! First-party rates: the bundled tables, and the supplement the pricing branch publishes.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::rates::FullRates;
use crate::data::model_id::CLAUDE_FAMILIES;
use crate::time::{Clock, iso_millis};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_create_per_million: f64,
}

impl ClaudePricing {
    #[must_use]
    pub const fn rates(&self) -> FullRates {
        FullRates {
            input_per_million: self.input_per_million,
            output_per_million: self.output_per_million,
            cache_read_per_million: self.cache_read_per_million,
            cache_write_per_million: self.cache_create_per_million,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
}

impl CodexPricing {
    #[must_use]
    pub fn rates(&self) -> FullRates {
        FullRates {
            input_per_million: self.input_per_million,
            output_per_million: self.output_per_million,
            cache_read_per_million: self.input_per_million * super::rates::CACHE_READ_RATE_MULTIPLIER,
            cache_write_per_million: self.input_per_million,
        }
    }
}

/// `pricing` applies to usage dates strictly before `before`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Override<P> {
    pub before: String,
    pub pricing: P,
}

pub type Overrides<P> = IndexMap<String, Vec<Override<P>>>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSupplement {
    pub models: IndexMap<String, ClaudePricing>,
    pub overrides: Overrides<ClaudePricing>,
    pub family_fallback: IndexMap<String, ClaudePricing>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexFallbackRule {
    #[serde(rename = "match")]
    pub pattern: String,
    pub input_per_million: f64,
    pub output_per_million: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSupplement {
    pub current: IndexMap<String, CodexPricing>,
    pub historical: IndexMap<String, CodexPricing>,
    pub overrides: Overrides<CodexPricing>,
    pub family_fallback: Vec<CodexFallbackRule>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorAlias {
    pub pattern: String,
    pub canonical: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorSupplement {
    pub models: IndexMap<String, FullRates>,
    pub fast_multipliers: IndexMap<String, f64>,
    pub aliases: Vec<CursorAlias>,
}

/// Cursor-native rates, aliases, date overrides, historical Codex rows and the Claude cache
/// multipliers catalogs get wrong, as published on the `pricing` branch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplement {
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    pub claude: ClaudeSupplement,
    pub codex: CodexSupplement,
    pub cursor: CursorSupplement,
}

const CLAUDE_TABLE: &str = include_str!("../../pricing-tables/claude.json");
const CODEX_TABLE: &str = include_str!("../../pricing-tables/codex.json");
const CURSOR_TABLE: &str = include_str!("../../pricing-tables/cursor.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeTable {
    updated_at: String,
    #[serde(flatten)]
    rates: ClaudeSupplement,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexTable {
    updated_at: String,
    #[serde(flatten)]
    rates: CodexSupplement,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorTable {
    updated_at: String,
    #[serde(flatten)]
    rates: CursorSupplement,
}

/// The supplement built from the bundled tables; its `updatedAt` is the newest table's.
#[must_use]
pub fn bundled_supplement() -> Supplement {
    let claude: ClaudeTable = bundled(CLAUDE_TABLE);
    let codex: CodexTable = bundled(CODEX_TABLE);
    let cursor: CursorTable = bundled(CURSOR_TABLE);
    let updated =
        bundled_date(&claude.updated_at).max(bundled_date(&codex.updated_at)).max(bundled_date(&cursor.updated_at));
    Supplement {
        updated_at: iso_millis(updated),
        comment: Some("First-party pricing from tables/*.json. Catalogs supply additional models.".to_owned()),
        claude: claude.rates,
        codex: codex.rates,
        cursor: cursor.rates,
    }
}

#[expect(clippy::expect_used, reason = "the tables are compiled in and a test parses each")]
fn bundled<T: serde::de::DeserializeOwned>(table: &str) -> T {
    serde_json::from_str(table).expect("a bundled pricing table parses")
}

#[expect(clippy::expect_used, reason = "the tables are compiled in and a test reads each date")]
fn bundled_date(updated: &str) -> jiff::Timestamp {
    let text = if updated.contains('T') { updated.to_owned() } else { format!("{updated}T00:00:00Z") };
    Clock::system().parse_timestamp(&text).expect("a bundled pricing table carries its date")
}

fn amount(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|x| x.is_finite() && x >= 0.0)
}

fn rates(value: Option<&Value>, fields: &[&str]) -> bool {
    value.and_then(Value::as_object).is_some_and(|row| fields.iter().all(|f| amount(row.get(*f))))
}

fn map(value: Option<&Value>, check: impl Fn(&Value) -> bool) -> bool {
    value.and_then(Value::as_object).is_some_and(|rows| rows.values().all(check))
}

fn is_timestamp(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| Clock::system().parse_timestamp(text).is_some())
}

fn is_pattern(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|p| compile_pattern(p).is_ok())
}

fn overrides(value: Option<&Value>, fields: &[&str]) -> bool {
    map(value, |entries| {
        entries.as_array().is_some_and(|list| {
            list.iter().all(|entry| {
                entry.is_object() && is_timestamp(entry.get("before")) && rates(entry.get("pricing"), fields)
            })
        })
    })
}

const IO: &[&str] = &["inputPerMillion", "outputPerMillion"];
const CLAUDE: &[&str] = &["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheCreatePerMillion"];
const CURSOR: &[&str] = &["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"];

/// A published supplement, validated as 4.x validates it before trusting a single rate.
pub fn parse_supplement(value: &Value) -> Option<Supplement> {
    let (claude, codex, cursor) = (value.get("claude")?, value.get("codex")?, value.get("cursor")?);
    let fallback = claude.get("familyFallback");
    let valid = is_timestamp(value.get("updatedAt"))
        && claude.is_object()
        && codex.is_object()
        && cursor.is_object()
        && map(claude.get("models"), |row| rates(Some(row), CLAUDE))
        && overrides(claude.get("overrides"), CLAUDE)
        && CLAUDE_FAMILIES.iter().all(|family| rates(fallback.and_then(|f| f.get(*family)), CLAUDE))
        && map(codex.get("current"), |row| rates(Some(row), IO))
        && map(codex.get("historical"), |row| rates(Some(row), IO))
        && overrides(codex.get("overrides"), IO)
        && codex.get("familyFallback").and_then(Value::as_array).is_some_and(|rules| {
            rules.iter().all(|rule| rule.is_object() && is_pattern(rule.get("match")) && rates(Some(rule), IO))
        })
        && map(cursor.get("models"), |row| rates(Some(row), CURSOR))
        && map(cursor.get("fastMultipliers"), |m| amount(Some(m)))
        && cursor.get("aliases").and_then(Value::as_array).is_some_and(|aliases| {
            aliases.iter().all(|a| {
                a.is_object() && is_pattern(a.get("pattern")) && a.get("canonical").is_some_and(Value::is_string)
            })
        });
    if !valid {
        return None;
    }
    serde_json::from_value(value.clone()).ok()
}

/// JS `new RegExp(p, 'u')`, or `'iu'` after a `(?i)` prefix.
///
/// # Errors
///
/// When the pattern is not a valid regular expression.
pub fn compile_pattern(pattern: &str) -> Result<regex_lite::Regex, regex_lite::Error> {
    pattern.strip_prefix("(?i)").map_or_else(
        || regex_lite::Regex::new(pattern),
        |rest| regex_lite::RegexBuilder::new(rest).case_insensitive(true).build(),
    )
}

#[cfg(test)]
mod tests {
    use super::bundled_supplement;

    #[test]
    fn every_bundled_table_parses_and_dates_the_supplement() {
        assert_eq!(bundled_supplement().updated_at, "2026-09-29T00:00:00.000Z");
    }
}
