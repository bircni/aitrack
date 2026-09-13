//! Core data types for usage tracking.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const CURRENT_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Subset of inputTokens that hit a cache (Codex prompt caching, Anthropic
    /// cache_read). Billed at 10% of base input. When undefined, callers treat
    /// the value as 0 — older synced data lacks this split.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    /// Claude: non-cache input_tokens only. Omitted in legacy synced data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_input_tokens: Option<u64>,
    /// Claude: cache_creation_input_tokens. Omitted in legacy synced data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

impl TokenCounts {
    pub fn new() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cached_input_tokens: None,
            raw_input_tokens: None,
            cache_creation_input_tokens: None,
            cost_usd: None,
        }
    }
}

impl Default for TokenCounts {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayEntry {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub by_model: HashMap<String, TokenCounts>,
}

impl DayEntry {
    pub fn new() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cached_input_tokens: None,
            raw_input_tokens: None,
            cache_creation_input_tokens: None,
            cost_usd: None,
            by_model: HashMap::new(),
        }
    }
}

impl Default for DayEntry {
    fn default() -> Self {
        Self::new()
    }
}

/// Map<dateStr "YYYY-MM-DD", DayEntry>
pub type DayMap = HashMap<String, DayEntry>;

/// { providerKey: DayMap }
pub type ProviderData = HashMap<String, DayMap>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDay {
    pub by_model: HashMap<String, TokenCounts>,
    pub totals: TokenCounts,
}

/// How the day keys in a machine file were bucketed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DayBucket {
    Utc,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineFile {
    /// On-disk schema version.
    pub schema_version: u32,
    pub hostname: String,
    /// IANA zone of the producing machine.
    pub timezone: String,
    /// How the day keys were bucketed. Currently always 'local'.
    pub day_bucket: DayBucket,
    pub last_updated: String,
    pub days: HashMap<String, HashMap<String, ProviderDay>>,
}

impl MachineFile {
    pub fn new(hostname: String, timezone: String) -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            hostname,
            timezone,
            day_bucket: DayBucket::Local,
            last_updated: String::new(),
            days: HashMap::new(),
        }
    }
}
