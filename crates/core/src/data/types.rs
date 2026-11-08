use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::day::Day;

/// A file without `schemaVersion` is version 1; migrations upgrade older files on read.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Token counts and their estimated cost. Optional fields are omitted, never written as `null`, in the
/// key order machine files use.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Uncached input (Claude `input_tokens`, Cursor "Input (w/o Cache Write)").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_input_tokens: Option<u64>,
    /// Input that hit a cache, billed at the cache-read rate; older synced data lacks the split.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    /// Cache writes at the 5-minute rate; Cursor's "Input (w/ Cache Write)" lands here too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    /// Claude 1-hour cache writes, billed at twice the base input rate.
    #[serde(rename = "cacheCreation1hInputTokens", default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_1h_input_tokens: Option<u64>,
    #[serde(rename = "costUSD", default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_unpriced_tokens: Option<bool>,
}

/// Counts keyed by model, `owner/repo` or working directory, in the order they were first seen.
pub type CountsByKey = IndexMap<String, TokenCounts>;

/// One provider's usage on one day, in memory.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayEntry {
    pub counts: TokenCounts,
    pub by_model: CountsByKey,
    /// Usage per `owner/repo`; `None` when no message could be attributed.
    pub by_project: Option<CountsByKey>,
    /// Working directories of usage with no git remote; stays on this machine.
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
    pub days: IndexMap<Day, IndexMap<String, ProviderDay>>,
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
        };
        assert_eq!(
            js::to_string(&all).unwrap(),
            r#"{"inputTokens":10,"outputTokens":2,"rawInputTokens":4,"cachedInputTokens":5,"cacheCreationInputTokens":1,"cacheCreation1hInputTokens":0,"costUSD":0.0000045,"hasUnpricedTokens":true}"#
        );
        let bare = TokenCounts { input_tokens: 1, output_tokens: 0, ..TokenCounts::default() };
        assert_eq!(js::to_string(&bare).unwrap(), r#"{"inputTokens":1,"outputTokens":0}"#);
        assert_eq!(serde_json::from_str::<TokenCounts>(&js::to_string(&all).unwrap()).unwrap(), all);
    }

    #[test]
    fn round_trips_a_machine_file_with_its_map_order() {
        let text = r#"{"schemaVersion":2,"hostname":"mb","timezone":"Europe/Berlin","dayBucket":"local","lastUpdated":"2026-03-08T10:00:00.000Z","days":{"2026-03-07":{"codex":{"byModel":{"gpt-5":{"inputTokens":1,"outputTokens":1},"gpt-4":{"inputTokens":2,"outputTokens":0}},"totals":{"inputTokens":3,"outputTokens":1,"costUSD":45000}}}}}"#;
        let file: MachineFile = serde_json::from_str(text).unwrap();
        assert_eq!(file.day_bucket, DayBucket::Local);
        assert_eq!(js::to_string(&file).unwrap(), text);
    }
}
