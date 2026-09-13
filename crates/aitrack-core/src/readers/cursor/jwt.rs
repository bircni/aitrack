//! JWT payload decoding for Cursor access tokens.

use base64::prelude::*;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct JwtPayload {
    pub sub: Option<String>,
}

/// Decode JWT payload (untrusted remote input, tolerates garbage).
pub fn decode_jwt_payload(token: &str) -> Option<JwtPayload> {
    let parts: Vec<&str> = token.split('.').collect();
    let encoded_payload = parts.get(1)?;

    // Convert URL-safe base64 to standard base64
    let base64 = encoded_payload.replace('-', "+").replace('_', "/");

    // Add padding
    let padded = format!("{}{}", base64, "=".repeat((4 - base64.len() % 4) % 4));

    // Decode base64
    let decoded = BASE64_STANDARD.decode(padded.as_bytes()).ok()?;
    let json_str = String::from_utf8(decoded).ok()?;

    // Parse JSON
    serde_json::from_str(&json_str).ok()
}
