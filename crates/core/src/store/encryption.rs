//! The encrypted machine-file envelope 4.x writes: AES-256-GCM with a scrypt key.

use aes_gcm::aead::{AeadInOut, Nonce, Tag};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::env::Env;
use crate::js;

pub const ENCRYPTION_PASSPHRASE_ENV: &str = "AITRACK_ENCRYPTION_PASSPHRASE";
const FORMAT: &str = "aitrack-aes-256-gcm-scrypt-v1";
/// Above any real schema version, so an older aitrack skips the file with "upgrade aitrack".
const ENVELOPE_SCHEMA_VERSION: u32 = 99;
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    schema_version: u32,
    encrypted: String,
    salt: String,
    iv: String,
    tag: String,
    data: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DecryptError {
    #[error("unsupported encryption format \"{0}\"; upgrade aitrack")]
    Format(String),
    #[error("malformed encryption envelope")]
    Malformed,
    #[error("authentication failed")]
    Authentication,
}

/// The passphrase exactly as set; unlike other variables it is not trimmed, and empty is unset.
#[must_use]
pub fn encryption_passphrase(env: &Env) -> Option<&str> {
    env.raw_var(ENCRYPTION_PASSPHRASE_ENV).filter(|value| !value.is_empty())
}

/// Any object with a non-empty string `encrypted` field.
pub fn is_encrypted_envelope(value: &Value) -> bool {
    value.get("encrypted").and_then(Value::as_str).is_some_and(|format| !format.is_empty())
}

#[expect(clippy::expect_used, reason = "the scrypt parameters and key length are constants")]
fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let params = scrypt::Params::new(15, 8, 1).expect("valid scrypt parameters");
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut key).expect("32 bytes is a valid output length");
    key
}

/// The pretty-printed envelope for `plaintext`, with a fresh salt and IV.
///
/// # Panics
///
/// If the OS random source fails.
#[must_use]
#[expect(clippy::expect_used, reason = "the OS random source and AES-GCM do not fail for these sizes")]
pub fn encrypt_text(plaintext: &str, passphrase: &str) -> String {
    let mut salt = [0u8; SALT_BYTES];
    let mut iv = [0u8; IV_BYTES];
    getrandom::fill(&mut salt).expect("the OS provides randomness");
    getrandom::fill(&mut iv).expect("the OS provides randomness");
    let cipher = Aes256Gcm::new(&derive_key(passphrase, &salt).into());
    let mut data = plaintext.as_bytes().to_vec();
    let tag = cipher
        .encrypt_inout_detached(&Nonce::<Aes256Gcm>::from(iv), FORMAT.as_bytes(), data.as_mut_slice().into())
        .expect("plaintext fits AES-GCM's limits");
    let envelope = Envelope {
        schema_version: ENVELOPE_SCHEMA_VERSION,
        encrypted: FORMAT.to_owned(),
        salt: STANDARD.encode(salt),
        iv: STANDARD.encode(iv),
        tag: STANDARD.encode(tag),
        data: STANDARD.encode(data),
    };
    js::to_string_pretty(&envelope).expect("an envelope serializes")
}

fn decode(value: Option<&Value>, bytes: Option<usize>) -> Result<Vec<u8>, DecryptError> {
    let decoded = value.and_then(Value::as_str).and_then(|text| STANDARD.decode(text).ok()).unwrap_or_default();
    if decoded.is_empty() || bytes.is_some_and(|n| decoded.len() != n) {
        return Err(DecryptError::Malformed);
    }
    Ok(decoded)
}

/// The plaintext, or why it cannot be had: an unknown format, a malformed field, or a wrong passphrase or tampering.
///
/// # Errors
///
/// When the envelope is malformed or the passphrase does not open it.
pub fn decrypt_envelope(envelope: &Value, passphrase: &str) -> Result<String, DecryptError> {
    let format = envelope.get("encrypted").and_then(Value::as_str).unwrap_or_default();
    if format != FORMAT {
        return Err(DecryptError::Format(format.to_owned()));
    }
    let salt = decode(envelope.get("salt"), Some(SALT_BYTES))?;
    let iv = decode(envelope.get("iv"), Some(IV_BYTES))?;
    let tag = decode(envelope.get("tag"), Some(TAG_BYTES))?;
    let mut data = decode(envelope.get("data"), None)?;
    let cipher = Aes256Gcm::new(&derive_key(passphrase, &salt).into());
    let nonce = Nonce::<Aes256Gcm>::try_from(iv.as_slice()).map_err(|_| DecryptError::Malformed)?;
    let tag = Tag::<Aes256Gcm>::try_from(tag.as_slice()).map_err(|_| DecryptError::Malformed)?;
    cipher
        .decrypt_inout_detached(&nonce, FORMAT.as_bytes(), data.as_mut_slice().into(), &tag)
        .map_err(|_| DecryptError::Authentication)?;
    String::from_utf8(data).map_err(|_| DecryptError::Authentication)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_the_4x_envelope_shape() {
        let envelope = encrypt_text("{\n  \"hello\": \"wörld\"\n}", "pass phrase ");
        let value: Value = serde_json::from_str(&envelope).unwrap();
        let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["schemaVersion", "encrypted", "salt", "iv", "tag", "data"]);
        assert_eq!(value["schemaVersion"], 99);
        assert!(is_encrypted_envelope(&value));
        assert_eq!(decrypt_envelope(&value, "pass phrase ").unwrap(), "{\n  \"hello\": \"wörld\"\n}");
        assert_eq!(decrypt_envelope(&value, "pass phrase"), Err(DecryptError::Authentication));
        let mut tampered = value.clone();
        tampered["data"] = Value::String(STANDARD.encode(b"xxxxxxxxxxxxxxxxxxxx"));
        assert_eq!(decrypt_envelope(&tampered, "pass phrase "), Err(DecryptError::Authentication));
        let mut future = value.clone();
        future["encrypted"] = Value::String("aitrack-v9".into());
        assert_eq!(
            decrypt_envelope(&future, "x").unwrap_err().to_string(),
            "unsupported encryption format \"aitrack-v9\"; upgrade aitrack"
        );
        let mut short = value;
        short["iv"] = Value::String(STANDARD.encode([0u8; 4]));
        assert_eq!(decrypt_envelope(&short, "pass phrase "), Err(DecryptError::Malformed));
        assert!(!is_encrypted_envelope(&serde_json::json!({"encrypted": ""})));
    }
}
