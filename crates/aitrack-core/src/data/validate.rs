//! Validation helpers for machine files.

use super::types::MachineFile;

/// Basic validation for a machine file.
pub fn validate_machine_file(machine: &MachineFile) -> anyhow::Result<()> {
    if machine.hostname.is_empty() {
        return Err(anyhow::anyhow!("Missing hostname"));
    }

    if machine.timezone.is_empty() {
        return Err(anyhow::anyhow!("Missing timezone"));
    }

    Ok(())
}
