//! Claude quota provider.

use super::types::{ProviderSnapshot, QuotaProvider, QuotaWindow};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize)]
struct ClaudeCredentials {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenRefreshRequest {
    grant_type: String,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct TokenRefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsageResponse {
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

pub struct ClaudeQuotaProvider {
    credentials_path: PathBuf,
}

impl ClaudeQuotaProvider {
    pub fn new() -> Self {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());

        Self {
            credentials_path: PathBuf::from(home)
                .join(".claude")
                .join(".credentials.json"),
        }
    }

    fn load_credentials(&self) -> anyhow::Result<ClaudeCredentials> {
        let content = fs::read_to_string(&self.credentials_path)
            .map_err(|e| anyhow::anyhow!("Failed to read credentials: {}", e))?;

        serde_json::from_str(&content)
            .map_err(|e| anyhow::anyhow!("Failed to parse credentials: {}", e))
    }

    fn refresh_token(&self, refresh_token: &str) -> anyhow::Result<String> {
        let client = reqwest::blocking::Client::new();

        let request = TokenRefreshRequest {
            grant_type: "refresh_token".to_string(),
            refresh_token: refresh_token.to_string(),
        };

        let response = client
            .post("https://platform.claude.com/v1/oauth/token")
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

        // Update credentials file with new tokens
        if let Ok(mut creds) = self.load_credentials() {
            creds.access_token = Some(token_response.access_token.clone());
            if let Some(new_refresh) = token_response.refresh_token {
                creds.refresh_token = Some(new_refresh);
            }
            if let Some(expires_in) = token_response.expires_in {
                let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64);
                creds.expires_at = Some(expires_at.to_rfc3339());
            }

            if let Ok(json) = serde_json::to_string_pretty(&creds) {
                let _ = fs::write(&self.credentials_path, json);
            }
        }

        Ok(token_response.access_token)
    }

    fn fetch_usage(&self, access_token: &str) -> anyhow::Result<AnthropicUsage> {
        let client = reqwest::blocking::Client::new();

        let response = client
            .get("https://api.anthropic.com/v1/usage")
            .header("Authorization", format!("Bearer {}", access_token))
            .header("anthropic-version", "2023-06-01")
            .send()
            .map_err(|e| anyhow::anyhow!("Usage API request failed: {}", e))?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Usage API failed with status: {}",
                response.status()
            ));
        }

        let usage_response: AnthropicUsageResponse = response
            .json()
            .map_err(|e| anyhow::anyhow!("Failed to parse usage response: {}", e))?;

        usage_response
            .usage
            .ok_or_else(|| anyhow::anyhow!("No usage data in response"))
    }

    fn get_access_token(&self) -> anyhow::Result<String> {
        let creds = self.load_credentials()?;

        // Check if we have a valid access token
        if let Some(access_token) = creds.access_token {
            // Check if token is expired
            if let Some(expires_at) = creds.expires_at {
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
        if let Some(refresh_token) = creds.refresh_token {
            return self.refresh_token(&refresh_token);
        }

        Err(anyhow::anyhow!(
            "No valid access token or refresh token available"
        ))
    }
}

impl Default for ClaudeQuotaProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl QuotaProvider for ClaudeQuotaProvider {
    fn provider_key(&self) -> &'static str {
        "claude"
    }

    fn provider_label(&self) -> &'static str {
        "Claude"
    }

    fn is_available(&self) -> bool {
        self.credentials_path.exists()
    }

    fn fetch_quota(&self) -> anyhow::Result<ProviderSnapshot> {
        let access_token = self.get_access_token()?;
        let usage = self.fetch_usage(&access_token)?;

        let window = QuotaWindow {
            period_start: None,
            period_end: None,
            limit: None,
            used: Some((usage.input_tokens + usage.output_tokens) as f64),
            remaining: None,
            unit: "tokens".to_string(),
        };

        let mut metadata = HashMap::new();
        metadata.insert(
            "input_tokens".to_string(),
            serde_json::json!(usage.input_tokens),
        );
        metadata.insert(
            "output_tokens".to_string(),
            serde_json::json!(usage.output_tokens),
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
        let provider = ClaudeQuotaProvider::new();
        assert_eq!(provider.provider_key(), "claude");
    }
}
