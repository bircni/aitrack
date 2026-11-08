//! What the renderer and cache.json see, in the shapes and key order 4.x's sidecar wrote.

use aitrack_core::quota::{QuotaError, QuotaSnapshot};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub tokens: f64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodUsage {
    pub tokens: f64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_unpriced_tokens: bool,
    pub models: Vec<ModelUsage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub today: PeriodUsage,
    pub yesterday: PeriodUsage,
    pub last7_days: PeriodUsage,
    pub last30_days: PeriodUsage,
    pub all_time: PeriodUsage,
    pub daily: Vec<DailyUsage>,
}

pub type ProviderUsages = IndexMap<String, ProviderUsage>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProviderEntry {
    pub key: String,
    pub label: String,
    pub tokens: f64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_unpriced_tokens: bool,
}

/// `project` is `owner/repo`, `(no remote)`, or `(unattributed)` for what no project explains.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsageEntry {
    pub project: String,
    pub tokens: f64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_unpriced_tokens: bool,
    pub providers: Vec<ProjectProviderEntry>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub unattributed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsages {
    pub today: Vec<ProjectUsageEntry>,
    pub last7_days: Vec<ProjectUsageEntry>,
    pub last30_days: Vec<ProjectUsageEntry>,
    pub all_time: Vec<ProjectUsageEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineUsage {
    pub name: String,
    pub timezone: String,
    /// Empty until the machine first syncs.
    pub last_updated: String,
    /// The machine opentrack runs on.
    pub current: bool,
    pub providers: ProviderUsages,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub providers: ProviderUsages,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<ProjectUsages>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machines: Option<Vec<MachineUsage>>,
    /// Providers read live from the account (Cursor), which no machine's logs hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<ProviderUsages>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderState {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_error: Option<QuotaError>,
    /// Epoch ms a provider-declared retry-after ends; a refresh cannot retry its limits before then.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<ProviderUsage>,
    pub refreshing: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SyncOutcome {
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub providers: Vec<ProviderState>,
    pub refreshing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machines: Option<Vec<MachineUsage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_usage: Option<ProviderUsages>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projects: Option<ProjectUsages>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_updated_at: Option<String>,
    /// Oldest `quota.fetchedAt` of the enabled providers; `updatedAt` also moves on local usage reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota_updated_at: Option<String>,
    /// A usage load finished and found no tokens at all, rather than not having run or having failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_empty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_error: Option<String>,
    pub syncing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_result: Option<SyncOutcome>,
}
