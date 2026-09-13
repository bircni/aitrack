//! Schema migrations registry.

pub mod v2;

pub use v2::migrate_to_v2;

/// Stand-in for a machine file whose producing timezone was never recorded.
/// Deliberately not a valid IANA zone so it cannot be mistaken for one.
pub const UNKNOWN_TIMEZONE: &str = "unknown";

use crate::data::types::{CURRENT_SCHEMA_VERSION, MachineFile};

/// A file whose `schemaVersion` is newer than this build understands.
#[derive(Debug)]
pub struct SchemaFromTheFutureError {
    pub version: u32,
}

impl std::fmt::Display for SchemaFromTheFutureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "machine file schemaVersion {} is newer than this aitrack understands \
             (supports up to {}); upgrade aitrack",
            self.version, CURRENT_SCHEMA_VERSION
        )
    }
}

impl std::error::Error for SchemaFromTheFutureError {}

fn schema_version_of(machine: &MachineFile) -> u32 {
    let version = machine.schema_version;
    if version > 0 { version } else { 1 }
}

#[derive(Debug, Clone)]
pub struct AppliedMigration {
    pub from: u32,
    pub to: u32,
    pub description: String,
}

pub struct MigrationResult {
    pub file: MachineFile,
    pub applied: Vec<AppliedMigration>,
}

/// Bring a parsed machine file up to the current schema version.
pub fn apply_migrations(file: &MachineFile) -> anyhow::Result<MigrationResult> {
    let mut version = schema_version_of(file);

    if version == CURRENT_SCHEMA_VERSION {
        return Ok(MigrationResult {
            file: file.clone(),
            applied: Vec::new(),
        });
    }

    if version > CURRENT_SCHEMA_VERSION {
        return Err(SchemaFromTheFutureError { version }.into());
    }

    let mut current = file.clone();
    let mut applied = Vec::new();

    while version < CURRENT_SCHEMA_VERSION {
        match version {
            1 => {
                current = migrate_to_v2(&current)?;
                applied.push(AppliedMigration {
                    from: 1,
                    to: 2,
                    description: "add schemaVersion and mark day keys as local-time".to_string(),
                });
                version = 2;
            }
            _ => {
                return Err(anyhow::anyhow!(
                    "no migration registered from schema version {}",
                    version
                ));
            }
        }
    }

    Ok(MigrationResult {
        file: current,
        applied,
    })
}
