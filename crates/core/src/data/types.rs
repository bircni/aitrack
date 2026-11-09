use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::day::Day;

/// A file without `schemaVersion` is version 1; migrations upgrade older files on read.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Token counts and their estimated cost. Optional fields are omitted, never written as `null`, in the
/// key order machine files use.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TokenCounts {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Uncached input (Claude `input_tokens`, Cursor "Input (w/o Cache Write)").
    pub raw_input_tokens: Option<u64>,
    /// Input that hit a cache, billed at the cache-read rate; older synced data lacks the split.
    pub cached_input_tokens: Option<u64>,
    /// Cache writes at the 5-minute rate; Cursor's "Input (w/ Cache Write)" lands here too.
    pub cache_creation_input_tokens: Option<u64>,
    /// Claude 1-hour cache writes, billed at twice the base input rate.
    pub cache_creation_1h_input_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub has_unpriced_tokens: Option<bool>,
    /// `hasUnpricedTokens` comes before `costUSD`: 4.x appends a cost to an object already flagged,
    /// and a file keeps that order. Written back the same way so a rewrite changes no bytes.
    pub unpriced_before_cost: bool,
}

impl TokenCounts {
    /// Sets the cost as 4.x's assignment does: a cost new to a flagged object goes after the flag.
    pub const fn set_cost(&mut self, cost: f64) {
        if self.cost_usd.is_none() && self.has_unpriced_tokens.is_some() {
            self.unpriced_before_cost = true;
        }
        self.cost_usd = Some(cost);
    }

    /// Drops the unpriced flag, as `delete counts.hasUnpricedTokens` does.
    pub const fn clear_unpriced(&mut self) {
        self.has_unpriced_tokens = None;
        self.unpriced_before_cost = false;
    }
}

impl Serialize for TokenCounts {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("inputTokens", &self.input_tokens)?;
        map.serialize_entry("outputTokens", &self.output_tokens)?;
        for (key, value) in [
            ("rawInputTokens", self.raw_input_tokens),
            ("cachedInputTokens", self.cached_input_tokens),
            ("cacheCreationInputTokens", self.cache_creation_input_tokens),
            ("cacheCreation1hInputTokens", self.cache_creation_1h_input_tokens),
        ] {
            if let Some(value) = value {
                map.serialize_entry(key, &value)?;
            }
        }
        let cost = |map: &mut S::SerializeMap| self.cost_usd.map_or(Ok(()), |c| map.serialize_entry("costUSD", &c));
        let unpriced = |map: &mut S::SerializeMap| {
            self.has_unpriced_tokens.map_or(Ok(()), |u| map.serialize_entry("hasUnpricedTokens", &u))
        };
        if self.unpriced_before_cost {
            unpriced(&mut map)?;
            cost(&mut map)?;
        } else {
            cost(&mut map)?;
            unpriced(&mut map)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for TokenCounts {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;

        impl<'de> serde::de::Visitor<'de> for Fields {
            type Value = TokenCounts;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("token counts")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<TokenCounts, A::Error> {
                let mut counts = TokenCounts::default();
                let (mut input, mut output) = (None, None);
                while let Some(key) = map.next_key::<std::borrow::Cow<'de, str>>()? {
                    match key.as_ref() {
                        "inputTokens" => input = Some(map.next_value()?),
                        "outputTokens" => output = Some(map.next_value()?),
                        "rawInputTokens" => counts.raw_input_tokens = map.next_value()?,
                        "cachedInputTokens" => counts.cached_input_tokens = map.next_value()?,
                        "cacheCreationInputTokens" => counts.cache_creation_input_tokens = map.next_value()?,
                        "cacheCreation1hInputTokens" => counts.cache_creation_1h_input_tokens = map.next_value()?,
                        "costUSD" => counts.cost_usd = map.next_value()?,
                        "hasUnpricedTokens" => {
                            counts.has_unpriced_tokens = map.next_value()?;
                            counts.unpriced_before_cost =
                                counts.cost_usd.is_none() && counts.has_unpriced_tokens.is_some();
                        }
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                counts.input_tokens = input.ok_or_else(|| serde::de::Error::missing_field("inputTokens"))?;
                counts.output_tokens = output.ok_or_else(|| serde::de::Error::missing_field("outputTokens"))?;
                if counts.cost_usd.is_none() {
                    counts.unpriced_before_cost = false;
                }
                Ok(counts)
            }
        }

        deserializer.deserialize_map(Fields)
    }
}

/// Counts keyed by model, `owner/repo` or working directory, in the order they were first seen.
pub type CountsByKey = IndexMap<String, TokenCounts>;

/// One provider's usage on one day, in memory and in the parse cache.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DayEntry {
    pub counts: TokenCounts,
    pub by_model: CountsByKey,
    /// Usage per `owner/repo`; `None` when no message could be attributed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_project: Option<CountsByKey>,
    /// Working directories of usage with no git remote; stays on this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_cwd: Option<CountsByKey>,
}

/// A provider's usage by local calendar day.
pub type DayMap = IndexMap<Day, DayEntry>;

/// Day maps keyed by provider (`claude_code`, `codex`, `cursor`, or one a newer version wrote).
pub type ProviderData = IndexMap<String, DayMap>;

/// One provider's usage on one day, as a machine file stores it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDay {
    pub by_model: CountsByKey,
    pub totals: TokenCounts,
    /// Files synced before projects existed lack it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_project: Option<CountsByKey>,
    /// From this machine's logs only; stripped before a machine file reaches the repo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_cwd: Option<CountsByKey>,
}

/// How the day keys in a machine file were bucketed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DayBucket {
    /// Reserved for a future normalization.
    Utc,
    /// Each machine's own calendar day, in the zone `timezone` names.
    #[default]
    Local,
}

/// A machine file's days: provider days by calendar day.
pub type MachineDays = IndexMap<Day, IndexMap<String, ProviderDay>>;

/// `data/<machineId>.json` in the user's data repo.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineFile {
    pub schema_version: u32,
    pub hostname: String,
    /// IANA zone of the producing machine, or `unknown`.
    pub timezone: String,
    pub day_bucket: DayBucket,
    pub last_updated: String,
    pub days: MachineDays,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js;

    #[test]
    fn writes_token_counts_in_machine_file_key_order_without_nulls() {
        let all = TokenCounts {
            input_tokens: 10,
            output_tokens: 2,
            raw_input_tokens: Some(4),
            cached_input_tokens: Some(5),
            cache_creation_input_tokens: Some(1),
            cache_creation_1h_input_tokens: Some(0),
            cost_usd: Some(0.000_004_5),
            has_unpriced_tokens: Some(true),
            unpriced_before_cost: false,
        };
        assert_eq!(
            js::to_string(&all).unwrap(),
            r#"{"inputTokens":10,"outputTokens":2,"rawInputTokens":4,"cachedInputTokens":5,"cacheCreationInputTokens":1,"cacheCreation1hInputTokens":0,"costUSD":0.0000045,"hasUnpricedTokens":true}"#
        );
        let bare = TokenCounts { input_tokens: 1, output_tokens: 0, ..TokenCounts::default() };
        assert_eq!(js::to_string(&bare).unwrap(), r#"{"inputTokens":1,"outputTokens":0}"#);
        assert_eq!(serde_json::from_str::<TokenCounts>(&js::to_string(&all).unwrap()).unwrap(), all);
        for text in [
            r#"{"inputTokens":1,"outputTokens":0,"hasUnpricedTokens":true,"costUSD":0.5}"#,
            r#"{"inputTokens":1,"outputTokens":0,"costUSD":0.5,"hasUnpricedTokens":true}"#,
        ] {
            assert_eq!(js::to_string(&serde_json::from_str::<TokenCounts>(text).unwrap()).unwrap(), text);
        }
        let mut flagged = TokenCounts { input_tokens: 1, has_unpriced_tokens: Some(true), ..TokenCounts::default() };
        flagged.set_cost(0.5);
        assert_eq!(
            js::to_string(&flagged).unwrap(),
            r#"{"inputTokens":1,"outputTokens":0,"hasUnpricedTokens":true,"costUSD":0.5}"#
        );
    }

    #[test]
    fn round_trips_a_machine_file_with_its_map_order() {
        let text = r#"{"schemaVersion":2,"hostname":"mb","timezone":"Europe/Berlin","dayBucket":"local","lastUpdated":"2026-03-08T10:00:00.000Z","days":{"2026-03-07":{"codex":{"byModel":{"gpt-5":{"inputTokens":1,"outputTokens":1},"gpt-4":{"inputTokens":2,"outputTokens":0}},"totals":{"inputTokens":3,"outputTokens":1,"costUSD":45000}}}}}"#;
        let file: MachineFile = serde_json::from_str(text).unwrap();
        assert_eq!(file.day_bucket, DayBucket::Local);
        assert_eq!(js::to_string(&file).unwrap(), text);
    }
}
