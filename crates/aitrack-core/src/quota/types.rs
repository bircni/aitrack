//! Quota management types and traits.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub limit: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub unit: String, // e.g., "tokens", "requests", "credits"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider_key: String,
    pub provider_label: String,
    pub timestamp: String,
    pub windows: Vec<QuotaWindow>,
    pub metadata: HashMap<String, serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderViewState {
    pub provider_key: String,
    pub provider_label: String,
    pub last_updated: Option<String>,
    pub snapshot: Option<ProviderSnapshot>,
    pub cached: bool,
    pub error: Option<String>,
}

pub trait QuotaProvider: Send + Sync {
    fn provider_key(&self) -> &'static str;
    fn provider_label(&self) -> &'static str;
    fn fetch_quota(&self) -> anyhow::Result<ProviderSnapshot>;
    fn is_available(&self) -> bool;
}

#[derive(Debug, Clone)]
pub struct QuotaRefreshOptions {
    pub force_refresh: bool,
    pub cache_ttl_seconds: u64,
}

impl Default for QuotaRefreshOptions {
    fn default() -> Self {
        Self {
            force_refresh: false,
            cache_ttl_seconds: 300, // 5 minutes
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quota_window() {
        let window = QuotaWindow {
            period_start: Some("2026-01-01".to_string()),
            period_end: Some("2026-01-31".to_string()),
            limit: Some(1000000.0),
            used: Some(500000.0),
            remaining: Some(500000.0),
            unit: "tokens".to_string(),
        };
        assert_eq!(window.unit, "tokens");
    }
}
