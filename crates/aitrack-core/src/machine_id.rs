//! Machine ID validation and filenames.

use std::sync::LazyLock;

use regex::Regex;

const MAX_FILENAME_BYTES: usize = 255;
const INVALID_FILENAME_CHARACTERS: &str = "<>:\"/\\|?*";

static WINDOWS_RESERVED_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)").expect("reserved name regex")
});

fn has_invalid_filename_character(value: &str) -> bool {
    for character in value.chars() {
        if INVALID_FILENAME_CHARACTERS.contains(character) || (character as u32) < 32 {
            return true;
        }
    }
    false
}

pub fn machine_id_validation_error(value: &str) -> Option<String> {
    let machine_id = value.trim();
    if machine_id.is_empty() {
        return Some("Machine name is required".to_owned());
    }
    if machine_id == "." || machine_id == ".." {
        return Some("Machine name must not be \".\" or \"..\"".to_owned());
    }
    if has_invalid_filename_character(machine_id) {
        return Some("Machine name contains characters that are not safe in a filename".to_owned());
    }
    if machine_id.ends_with('.') {
        return Some("Machine name must not end with a period".to_owned());
    }
    if WINDOWS_RESERVED_NAME.is_match(machine_id) {
        return Some("Machine name is reserved by the operating system".to_owned());
    }
    let filename = format!("{machine_id}.json");
    if filename.len() > MAX_FILENAME_BYTES {
        return Some("Machine name is too long".to_owned());
    }
    None
}

pub fn normalize_machine_id(value: &str) -> anyhow::Result<String> {
    if let Some(error) = machine_id_validation_error(value) {
        return Err(anyhow::anyhow!(error));
    }
    Ok(value.trim().to_owned())
}

pub fn machine_data_filename(machine_id: &str) -> anyhow::Result<String> {
    Ok(format!("{}.json", normalize_machine_id(machine_id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_path_separators() {
        assert!(machine_id_validation_error("").is_some());
        assert!(machine_id_validation_error("a/b").is_some());
        assert!(machine_id_validation_error("con").is_some());
        assert_eq!(normalize_machine_id("  laptop  ").unwrap(), "laptop");
    }
}
