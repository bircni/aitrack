//! Codex (OpenAI) quota provider.

use super::types::{ProviderSnapshot, QuotaProvider, QuotaWindow};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize)]
struct CodexAuth {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenRefreshRequest {
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct TokenRefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WhamUsageResponse {
    #[serde(default)]
    accounts: HashMap<String, AccountUsage>,
}

#[derive(Debug, Deserialize)]
struct AccountUsage {
    #[serde(default)]
    usage: UsageMetrics,
}

#[derive(Debug, Deserialize, Default)]
struct UsageMetrics {
    #[serde(default)]
    total_tokens: f64,
    #[serde(default)]
    limit: Option<f64>,
}

pub struct CodexQuotaProvider {
    auth_path: PathBuf,
}

impl CodexQuotaProvider {
    pub fn new() -> Self {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());

        Self {
            auth_path: PathBuf::from(home).join(".codex").join("auth.json"),
        }
    }

    fn load_auth(&self) -> anyhow::Result<CodexAuth> {
        let content = fs::read_to_string(&self.auth_path)
            .map_err(|e| anyhow::anyhow!("Failed to read auth file: {}", e))?;

        serde_json::from_str(&content)
            .map_err(|e| anyhow::anyhow!("Failed to parse auth file: {}", e))
    }

    fn refresh_token(&self, refresh_token: &str) -> anyhow::Result<String> {
        let client = reqwest::blocking::Client::new();

        let request = TokenRefreshRequest {
            refresh_token: refresh_token.to_string(),
        };

        let response = client
            .post("https://auth.openai.com/oauth/token")
            .json(&request)
            .send()
            .map_err(|e| anyhow::anyhow!("Token refresh request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Token refresh failed with status: {}",
                response.status()
            ));
        }

        let token_response: TokenRefreshResponse = response
            .json()
            .map_err(|e| anyhow::anyhow!("Failed to parse token response: {}", e))?;

        // Update auth file with new tokens
        if let Ok(mut auth) = self.load_auth() {
            auth.access_token = Some(token_response.access_token.clone());
            if let Some(new_refresh) = token_response.refresh_token {
                auth.refresh_token = Some(new_refresh);
            }

            if let Ok(json) = serde_json::to_string_pretty(&auth) {
                let _ = fs::write(&self.auth_path, json);
            }
        }

        Ok(token_response.access_token)
    }

    fn fetch_usage(&self, access_token: &str) -> anyhow::Result<WhamUsageResponse> {
        let client = reqwest::blocking::Client::new();

        let response = client
            .get("https://chatgpt.com/backend-api/wham/usage")
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .map_err(|e| anyhow::anyhow!("Usage API request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Usage API failed with status: {}",
                response.status()
            ));
        }

        response
            .json()
            .map_err(|e| anyhow::anyhow!("Failed to parse usage response: {}", e))
    }

    fn get_access_token(&self) -> anyhow::Result<String> {
        let auth = self.load_auth()?;

        // Check if we have a valid access token
        if let Some(access_token) = auth.access_token {
            // Check if token is expired
            if let Some(expires_at) = auth.expires_at {
                if let Ok(expires) = chrono::DateTime::parse_from_rfc3339(&expires_at) {
                    if expires > chrono::Utc::now() {
                        return Ok(access_token);
                    }
                }
            } else {
                // No expiry info, assume valid
                return Ok(access_token);
            }
        }

        // Token expired or missing, try to refresh
        if let Some(refresh_token) = auth.refresh_token {
            return self.refresh_token(&refresh_token);
        }

        Err(anyhow::anyhow!(
            "No valid access token or refresh token available"
        ))
    }
}

impl Default for CodexQuotaProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl QuotaProvider for CodexQuotaProvider {
    fn provider_key(&self) -> &'static str {
        "codex"
    }

    fn provider_label(&self) -> &'static str {
        "Codex"
    }

    fn is_available(&self) -> bool {
        self.auth_path.exists()
    }

    fn fetch_quota(&self) -> anyhow::Result<ProviderSnapshot> {
        let access_token = self.get_access_token()?;
        let usage_response = self.fetch_usage(&access_token)?;

        // Aggregate usage across all accounts
        let mut total_used = 0.0;
        let mut total_limit: Option<f64> = None;

        for account in usage_response.accounts.values() {
            total_used += account.usage.total_tokens;
            if let Some(limit) = account.usage.limit {
                total_limit = Some(total_limit.unwrap_or(0.0) + limit);
            }
        }

        let remaining = total_limit.map(|limit| (limit - total_used).max(0.0));

        let window = QuotaWindow {
            period_start: None,
            period_end: None,
            limit: total_limit,
            used: Some(total_used),
            remaining,
            unit: "tokens".to_string(),
        };

        let mut metadata = HashMap::new();
        metadata.insert(
            "account_count".to_string(),
            serde_json::json!(usage_response.accounts.len()),
        );

        Ok(ProviderSnapshot {
            provider_key: self.provider_key().to_string(),
            provider_label: self.provider_label().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            windows: vec![window],
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
        let provider = CodexQuotaProvider::new();
        assert_eq!(provider.provider_key(), "codex");
    }
}
