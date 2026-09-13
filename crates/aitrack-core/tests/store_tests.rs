//! Integration tests for store module.

use std::collections::HashMap;
use std::fs;
use tempfile::TempDir;

use aitrack_core::data::types::{
    CURRENT_SCHEMA_VERSION, DayBucket, MachineFile, ProviderDay, TokenCounts,
};
use aitrack_core::store::migrations::{UNKNOWN_TIMEZONE, apply_migrations};
use aitrack_core::store::{machine_file_path, read_data_file, write_machine_file};

#[test]
fn test_machine_file_roundtrip() {
    let temp_dir = TempDir::new().unwrap();
    let machine_id = "test-machine";

    let mut machine = MachineFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        hostname: machine_id.to_string(),
        timezone: "UTC".to_string(),
        day_bucket: DayBucket::Local,
        last_updated: "2024-01-01T00:00:00Z".to_string(),
        days: HashMap::new(),
    };

    // Add some test data
    let mut day_providers = HashMap::new();
    let mut by_model = HashMap::new();
    by_model.insert(
        "claude-sonnet".to_string(),
        TokenCounts {
            input_tokens: 1000,
            output_tokens: 500,
            cached_input_tokens: Some(100),
            raw_input_tokens: None,
            cache_creation_input_tokens: None,
            cost_usd: Some(0.05),
        },
    );

    day_providers.insert(
        "claude_code".to_string(),
        ProviderDay {
            by_model: by_model.clone(),
            totals: TokenCounts {
                input_tokens: 1000,
                output_tokens: 500,
                cached_input_tokens: Some(100),
                raw_input_tokens: None,
                cache_creation_input_tokens: None,
                cost_usd: Some(0.05),
            },
        },
    );

    machine.days.insert("2024-01-01".to_string(), day_providers);

    // Write the file
    let file_path = machine_file_path(temp_dir.path(), machine_id).unwrap();
    write_machine_file(&file_path, &machine).unwrap();

    // Read it back
    let read_machine = read_data_file(&file_path).unwrap().unwrap();

    assert_eq!(read_machine.hostname, machine.hostname);
    assert_eq!(read_machine.timezone, machine.timezone);
    assert_eq!(read_machine.schema_version, CURRENT_SCHEMA_VERSION);
    assert_eq!(read_machine.days.len(), 1);
    assert!(read_machine.days.contains_key("2024-01-01"));

    // Check the JSON has trailing newline
    let json_content = fs::read_to_string(&file_path).unwrap();
    assert!(json_content.ends_with('\n'));
}

#[test]
fn test_migration_v1_to_v2() {
    // Simulate a v1 machine file (no schema_version field)
    let v1_machine = MachineFile {
        schema_version: 0, // v1 files have no version or 0
        hostname: "old-machine".to_string(),
        timezone: "".to_string(), // v1 might have empty timezone
        day_bucket: DayBucket::Local,
        last_updated: "2024-01-01T00:00:00Z".to_string(),
        days: HashMap::new(),
    };

    // Apply migrations
    let result = apply_migrations(&v1_machine).unwrap();

    assert_eq!(result.file.schema_version, 2);
    assert_eq!(result.file.timezone, UNKNOWN_TIMEZONE);
    assert_eq!(result.file.day_bucket, DayBucket::Local);
    assert_eq!(result.applied.len(), 1);
    assert_eq!(result.applied[0].from, 1);
    assert_eq!(result.applied[0].to, 2);
}

#[test]
fn test_migration_already_v2() {
    let v2_machine = MachineFile {
        schema_version: 2,
        hostname: "current-machine".to_string(),
        timezone: "UTC".to_string(),
        day_bucket: DayBucket::Local,
        last_updated: "2024-01-01T00:00:00Z".to_string(),
        days: HashMap::new(),
    };

    let result = apply_migrations(&v2_machine).unwrap();

    // Should return the same file with no migrations applied
    assert_eq!(result.file.schema_version, 2);
    assert_eq!(result.applied.len(), 0);
}

#[test]
fn test_json_pretty_format() {
    let temp_dir = TempDir::new().unwrap();
    let machine_id = "test-format";

    let machine = MachineFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        hostname: machine_id.to_string(),
        timezone: "UTC".to_string(),
        day_bucket: DayBucket::Local,
        last_updated: "2024-01-01T00:00:00Z".to_string(),
        days: HashMap::new(),
    };

    let file_path = machine_file_path(temp_dir.path(), machine_id).unwrap();
    write_machine_file(&file_path, &machine).unwrap();

    let json_content = fs::read_to_string(&file_path).unwrap();

    // Check it's pretty-printed (contains newlines and indentation)
    assert!(json_content.contains("  \"schemaVersion\":"));
    assert!(json_content.contains("  \"hostname\":"));
    assert!(json_content.ends_with('\n'));

    // Parse it to verify it's valid JSON
    let parsed: serde_json::Value = serde_json::from_str(&json_content).unwrap();
    assert_eq!(parsed["schemaVersion"], 2);
}
