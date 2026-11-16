//! opentrack's settings shared through the data repo: one file any machine may write, where the newest `updatedAt` wins.

use jiff::Timestamp;
use serde::Serialize;
use serde_json::{Map, Value};

use super::encryption::{
    ENCRYPTION_PASSPHRASE_ENV, decrypt_envelope, encrypt_text, encryption_passphrase, is_encrypted_envelope,
};
use super::machine_files::MachineFileError;
use crate::Core;
use crate::error::{Error, Result};
use crate::fs::{is_missing_path, write_file_atomic};
use crate::js;
use crate::time::iso_millis;

/// Outside `data/`, which every version lists as machine files and stages as a whole.
pub const SHARED_SETTINGS_PATH: &str = "opentrack/settings.json";
const SCHEMA_VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedSettings {
    pub updated_at: Timestamp,
    /// As written, with keys this version does not know, so a rewrite keeps them.
    pub settings: Map<String, Value>,
    pub encrypted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedSettingsFile<'a> {
    schema_version: u64,
    updated_at: String,
    settings: &'a Map<String, Value>,
}

fn parse(raw: &str, passphrase: Option<&str>) -> Result<SharedSettings> {
    let unreadable = |reason: &str| Error::new(format!("Cannot read {SHARED_SETTINGS_PATH}: {reason}"));
    let mut parsed: Value = serde_json::from_str(raw).map_err(|_| unreadable("it is not JSON"))?;
    let encrypted = is_encrypted_envelope(&parsed);
    if encrypted {
        let passphrase = passphrase.ok_or_else(|| {
            unreadable(&format!("it is encrypted; set {ENCRYPTION_PASSPHRASE_ENV} to the data repo passphrase"))
        })?;
        let plaintext = decrypt_envelope(&parsed, passphrase)
            .map_err(|error| unreadable(&format!("it could not be decrypted ({error})")))?;
        parsed = serde_json::from_str(&plaintext).map_err(|_| unreadable("it is not JSON"))?;
    }
    if parsed.get("schemaVersion").and_then(Value::as_u64).is_none_or(|version| version > SCHEMA_VERSION) {
        return Err(unreadable("a newer opentrack wrote it; upgrade opentrack"));
    }
    let updated_at = parsed.get("updatedAt").and_then(Value::as_str).and_then(|text| text.parse().ok());
    match (updated_at, parsed.get_mut("settings").map(Value::take)) {
        (Some(updated_at), Some(Value::Object(settings))) => Ok(SharedSettings { updated_at, settings, encrypted }),
        _ => Err(unreadable("it has no updatedAt or settings")),
    }
}

/// The shared settings in the clone, or `None` when no machine has shared any.
///
/// # Errors
///
/// When the file is there but cannot be read; it must then not be overwritten.
pub fn read_shared_settings(core: &Core) -> Result<Option<SharedSettings>> {
    match std::fs::read_to_string(core.paths.repo.join(SHARED_SETTINGS_PATH)) {
        Ok(raw) => parse(&raw, encryption_passphrase(&core.env)).map(Some),
        Err(error) if is_missing_path(&error) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// # Errors
///
/// When `encrypt` is set without a passphrase, or the file cannot be written.
pub fn write_shared_settings(
    core: &Core,
    updated_at: Timestamp,
    settings: &Map<String, Value>,
    encrypt: bool,
) -> Result<(), MachineFileError> {
    let file = SharedSettingsFile { schema_version: SCHEMA_VERSION, updated_at: iso_millis(updated_at), settings };
    let json = js::stringify_pretty(&file);
    let contents = if encrypt {
        encrypt_text(&json, encryption_passphrase(&core.env).ok_or(MachineFileError::MissingPassphrase)?)?
    } else {
        json
    };
    write_file_atomic(&core.paths.repo.join(SHARED_SETTINGS_PATH), contents, None)?;
    Ok(())
}

/// The side of a conflict to keep: the newer one, or the readable one, so a replay never stops on this file.
#[must_use]
pub fn newest_shared_settings(core: &Core, remote: Option<String>, local: Option<String>) -> Option<String> {
    let passphrase = encryption_passphrase(&core.env);
    let updated_at =
        |raw: &Option<String>| raw.as_deref().and_then(|raw| parse(raw, passphrase).ok()).map(|s| s.updated_at);
    match (updated_at(&remote), updated_at(&local)) {
        (Some(theirs), Some(ours)) if ours > theirs => local,
        (None, Some(_)) => local,
        _ => remote.or(local),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;
    use crate::output::VecOutput;
    use crate::time::Clock;

    #[test]
    fn round_trips_plain_and_encrypted_and_refuses_what_it_cannot_read() {
        let home = tempfile::tempdir().unwrap();
        let core = |vars: &[(&str, &str)]| {
            let vars: Vec<_> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            Core::new(Env::new(home.path(), vars), Clock::system(), Box::new(VecOutput::default()))
        };
        let (plain, keyed) = (core(&[]), core(&[(ENCRYPTION_PASSPHRASE_ENV, "pass")]));
        assert_eq!(read_shared_settings(&plain).unwrap(), None);
        let at: Timestamp = "2026-03-10T12:00:00.5Z".parse().unwrap();
        let settings = Map::from_iter([("theme".to_owned(), Value::from("dark"))]);

        write_shared_settings(&plain, at, &settings, false).unwrap();
        let path = plain.paths.repo.join(SHARED_SETTINGS_PATH);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"schemaVersion\": 1,\n  \"updatedAt\": \"2026-03-10T12:00:00.500Z\",\n  \"settings\": {\n    \"theme\": \"dark\"\n  }\n}"
        );
        let shared = SharedSettings { updated_at: at, settings: settings.clone(), encrypted: false };
        assert_eq!(read_shared_settings(&plain).unwrap(), Some(shared.clone()));

        assert!(write_shared_settings(&plain, at, &settings, true).is_err(), "no passphrase");
        write_shared_settings(&keyed, at, &settings, true).unwrap();
        let older = std::fs::read_to_string(&path).unwrap();
        assert!(!older.contains("theme"));
        assert_eq!(read_shared_settings(&keyed).unwrap(), Some(SharedSettings { encrypted: true, ..shared }));
        assert!(read_shared_settings(&plain).unwrap_err().0.contains(ENCRYPTION_PASSPHRASE_ENV));

        write_shared_settings(&plain, at + jiff::SignedDuration::from_secs(1), &settings, false).unwrap();
        let newer = std::fs::read_to_string(&path).unwrap();
        let newest =
            |core, remote: &str, local: &str| newest_shared_settings(core, Some(remote.into()), Some(local.into()));
        assert_eq!(newest(&keyed, &older, &newer).as_ref(), Some(&newer));
        assert_eq!(newest(&keyed, &newer, &older).as_ref(), Some(&newer));
        assert_eq!(newest(&plain, &newer, &older).as_ref(), Some(&newer), "the unreadable side loses");
        assert_eq!(newest(&plain, &older, "{").as_ref(), Some(&older), "the remote, when neither can be read");
        assert_eq!(newest_shared_settings(&plain, None, Some(older.clone())), Some(older));

        std::fs::write(&path, r#"{"schemaVersion":2,"updatedAt":"2026-03-10T12:00:00Z","settings":{}}"#).unwrap();
        assert!(read_shared_settings(&plain).unwrap_err().0.contains("upgrade opentrack"));
    }
}
