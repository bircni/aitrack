use super::encryption::encryption_passphrase;
use super::machine_files::serialize_machine_file;
use super::validate::{ValidationOptions, check_raw_machine_file};
use crate::Core;
use crate::data::local_data::merge_persisted_days;
use crate::data::types::MachineFile;

/// Both sides of a conflicted machine file as one, or `None` when either cannot be read. Machine files
/// are per-day ratchets, so every day from both is kept; encrypted if either side was, so a merge never
/// exposes a file. The header is the replayed commit's, this machine's latest word on its own file.
pub fn merge_conflicted_machine_file(core: &Core, path: &str, remote_raw: &str, local_raw: &str) -> Option<String> {
    let options = ValidationOptions { allow_inconsistent_cost_totals: true };
    let passphrase = encryption_passphrase(&core.env);
    let remote = check_raw_machine_file(remote_raw, path, passphrase, options);
    let local = check_raw_machine_file(local_raw, path, passphrase, options);
    let (Some(remote_machine), Some(local_machine)) = (&remote.machine, &local.machine) else { return None };
    let merged = MachineFile {
        days: merge_persisted_days(Some(&remote_machine.days), &local_machine.days),
        ..local_machine.clone()
    };
    let encrypt = remote.encrypted || local.encrypted;
    if encrypt && passphrase.is_none() {
        return None;
    }
    serialize_machine_file(&merged, if encrypt { passphrase } else { None }).ok()
}
