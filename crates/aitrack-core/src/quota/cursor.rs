//! Cursor quota provider.

use super::types::{ProviderSnapshot, QuotaProvider, QuotaWindow};
use rusqlite::Connection;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct CursorUsageResponse {
    current_period_usage: Option<u64>,
    limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CursorPlanInfo {
    plan_name: Option<String>,
    credits_limit: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CursorCreditsBalance {
    balance: Option<f64>,
}

pub struct CursorQuotaProvider {
    state_db_path: PathBuf,
}

impl CursorQuotaProvider {
    pub fn new() -> Self {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());

        // Common Cursor state.vscdb locations
        let potential_paths = vec![
            PathBuf::from(&home)
                .join(".cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
            PathBuf::from(&home)
                .join("Library")
                .join("Application Support")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
            PathBuf::from(&home)
                .join("AppData")
                .join("Roaming")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        ];

        let state_db_path = potential_paths
            .into_iter()
            .find(|p| p.exists())
            .unwrap_or_else(|| {
                PathBuf::from(&home)
                    .join(".cursor")
                    .join("User")
                    .join("globalStorage")
                    .join("state.vscdb")
            });

        Self { state_db_path }
    }

    fn get_auth_token(&self) -> anyhow::Result<String> {
        let conn = Connection::open(&self.state_db_path)
            .map_err(|e| anyhow::anyhow!("Failed to open state.vscdb: {}", e))?;

        let mut stmt = conn
            .prepare("SELECT value FROM ItemTable WHERE key = ?")
            .map_err(|e| anyhow::anyhow!("Failed to prepare statement: {}", e))?;

        // Try common key patterns for Cursor auth token
        let keys = vec![
            "cursor.auth.token",
            "cursor.authToken",
            "workbench.auth.token",
        ];

        for key in keys {
            if let Ok(token) = stmt.query_row([key], |row| row.get::<_, String>(0)) {
                return Ok(token);
            }
        }

        Err(anyhow::anyhow!("No auth token found in state.vscdb"))
    }

    fn fetch_current_period_usage(&self, token: &str) -> anyhow::Result<CursorUsageResponse> {
        let client = reqwest::blocking::Client::new();

        // This is a simplified implementation - actual Cursor API might use gRPC
        let response = client
            .post("https://api2.cursor.sh/dashboard/GetCurrentPeriodUsage")
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({}))
            .send()
            .map_err(|e| anyhow::anyhow!("API request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "API failed with status: {}",
                response.status()
            ));
        }

        response
            .json()
            .map_err(|e| anyhow::anyhow!("Failed to parse response: {}", e))
    }

    fn fetch_plan_info(&self, token: &str) -> anyhow::Result<CursorPlanInfo> {
        let client = reqwest::blocking::Client::new();

        let response = client
            .post("https://api2.cursor.sh/dashboard/GetPlanInfo")
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({}))
            .send()
            .map_err(|e| anyhow::anyhow!("API request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "API failed with status: {}",
                response.status()
            ));
        }

        response
            .json()
            .map_err(|e| anyhow::anyhow!("Failed to parse response: {}", e))
    }

    fn fetch_credits_balance(&self, token: &str) -> anyhow::Result<CursorCreditsBalance> {
        let client = reqwest::blocking::Client::new();

        let response = client
            .post("https://api2.cursor.sh/dashboard/GetCreditGrantsBalance")
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({}))
            .send()
            .map_err(|e| anyhow::anyhow!("API request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "API failed with status: {}",
                response.status()
            ));
        }

        response
            .json()
            .map_err(|e| anyhow::anyhow!("Failed to parse response: {}", e))
    }
}

impl Default for CursorQuotaProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl QuotaProvider for CursorQuotaProvider {
    fn provider_key(&self) -> &'static str {
        "cursor"
    }

    fn provider_label(&self) -> &'static str {
        "Cursor"
    }

    fn is_available(&self) -> bool {
        self.state_db_path.exists()
    }

    fn fetch_quota(&self) -> anyhow::Result<ProviderSnapshot> {
        let token = self.get_auth_token()?;

        let mut windows = Vec::new();
        let mut metadata = HashMap::new();

        // Fetch usage
        if let Ok(usage) = self.fetch_current_period_usage(&token) {
            let remaining = match (usage.limit, usage.current_period_usage) {
                (Some(limit), Some(used)) => Some((limit as f64) - (used as f64)),
                _ => None,
            };

            windows.push(QuotaWindow {
                period_start: None,
                period_end: None,
                limit: usage.limit.map(|l| l as f64),
                used: usage.current_period_usage.map(|u| u as f64),
                remaining,
                unit: "requests".to_string(),
            });
        }

        // Fetch plan info
        if let Ok(plan) = self.fetch_plan_info(&token) {
            if let Some(name) = plan.plan_name {
                metadata.insert("plan_name".to_string(), serde_json::json!(name));
            }
            if let Some(limit) = plan.credits_limit {
                metadata.insert("credits_limit".to_string(), serde_json::json!(limit));
            }
        }

        // Fetch credits balance
        if let Ok(credits) = self.fetch_credits_balance(&token) {
            if let Some(balance) = credits.balance {
                windows.push(QuotaWindow {
                    period_start: None,
                    period_end: None,
                    limit: None,
                    used: None,
                    remaining: Some(balance),
                    unit: "credits".to_string(),
                });
                metadata.insert("credits_balance".to_string(), serde_json::json!(balance));
            }
        }

        Ok(ProviderSnapshot {
            provider_key: self.provider_key().to_string(),
            provider_label: self.provider_label().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            windows,
            metadata,
            error: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_key() {
        let provider = CursorQuotaProvider::new();
        assert_eq!(provider.provider_key(), "cursor");
    }
}
