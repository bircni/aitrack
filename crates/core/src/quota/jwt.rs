use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value};

/// The payload of a JWT, without verifying it: only identity and expiry are read.
#[must_use]
pub fn decode_jwt_payload(token: &str) -> Option<Map<String, Value>> {
    let encoded = token.split('.').nth(1).filter(|p| !p.is_empty())?;
    let base64 = encoded.replace('-', "+").replace('_', "/");
    let padded = format!("{base64}{}", "=".repeat((4 - base64.len() % 4) % 4));
    let bytes = STANDARD.decode(padded).ok()?;
    match serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok()? {
        Value::Object(map) => Some(map),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => None,
    }
}

/// The `exp` claim in epoch ms.
#[must_use]
pub fn jwt_expiry_ms(token: &str) -> Option<f64> {
    decode_jwt_payload(token)
        .and_then(|p| p.get("exp").and_then(Value::as_f64))
        .filter(|x| x.is_finite())
        .map(|exp| exp * 1000.0)
}
