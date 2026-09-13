//! V2 migration - add schemaVersion and mark day keys as local-time.

use super::UNKNOWN_TIMEZONE;
use crate::data::types::MachineFile;

/// Migrate a machine file from v1 to v2.
///
/// v1 files have no `schemaVersion` and bucket day keys in the writing machine's
/// local time with no record of which zone. This step stamps the version and
/// records `dayBucket: 'local'` — the keys cannot be re-bucketed without the
/// original timestamps, so the ambiguity is made explicit rather than hidden.
///
/// `timezone` becomes `'unknown'`, not a real zone: the producing machine's zone
/// is unrecoverable after the fact, and writing a plausible-looking `'UTC'`
/// would be indistinguishable from a machine that genuinely ran in UTC and would
/// mislead any later normalization that trusts the field.
pub fn migrate_to_v2(machine: &MachineFile) -> anyhow::Result<MachineFile> {
    let mut migrated = machine.clone();

    migrated.schema_version = 2;

    // Set timezone to UNKNOWN_TIMEZONE if it's empty or missing
    if migrated.timezone.is_empty() {
        migrated.timezone = UNKNOWN_TIMEZONE.to_string();
    }

    // Day bucket is always 'local' for v1 files
    migrated.day_bucket = crate::data::types::DayBucket::Local;

    Ok(migrated)
}
