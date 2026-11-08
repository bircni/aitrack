use crate::js;

const MAX_FILENAME_BYTES: usize = 255;
const INVALID_FILENAME_CHARACTERS: &str = "<>:\"/\\|?*";
const WINDOWS_RESERVED_NAMES: [&str; 4] = ["con", "prn", "aux", "nul"];

/// Why `value` cannot name a machine file, or `None` when it can.
#[must_use]
pub fn machine_id_validation_error(value: &str) -> Option<&'static str> {
    let id = js::trim(value);
    if id.is_empty() {
        return Some("Machine name is required");
    }
    if id == "." || id == ".." {
        return Some("Machine name must not be \".\" or \"..\"");
    }
    if id.chars().any(|c| INVALID_FILENAME_CHARACTERS.contains(c) || u32::from(c) < 32) {
        return Some("Machine name contains characters that are not safe in a filename");
    }
    if id.ends_with('.') {
        return Some("Machine name must not end with a period");
    }
    if is_windows_reserved(id) {
        return Some("Machine name is reserved by the operating system");
    }
    if id.len() + ".json".len() > MAX_FILENAME_BYTES {
        return Some("Machine name is too long");
    }
    None
}

/// The trimmed id, or the reason it cannot name a machine file.
pub fn normalize_machine_id(value: &str) -> Result<&str, &'static str> {
    machine_id_validation_error(value).map_or_else(|| Ok(js::trim(value)), Err)
}

pub fn machine_data_filename(machine_id: &str) -> Result<String, &'static str> {
    normalize_machine_id(machine_id).map(|id| format!("{id}.json"))
}

/// `/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu`
fn is_windows_reserved(id: &str) -> bool {
    let stem = id.split_once('.').map_or(id, |(stem, _)| stem).to_ascii_lowercase();
    WINDOWS_RESERVED_NAMES.contains(&stem.as_str())
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

#[cfg(test)]
mod tests {
    use super::{machine_data_filename, machine_id_validation_error};

    #[test]
    fn matches_the_typescript_library_for_every_fixture_name() {
        let rows: Vec<(String, Option<String>)> =
            serde_json::from_str(include_str!("../tests/fixtures/js/machine-ids.json")).unwrap();
        for (id, expected) in rows {
            assert_eq!(machine_id_validation_error(&id).map(str::to_owned), expected, "{id:?}");
        }
        assert_eq!(machine_data_filename(" laptop ").unwrap(), "laptop.json");
        assert!(machine_data_filename("con").is_err());
    }
}
