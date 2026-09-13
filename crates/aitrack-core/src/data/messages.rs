//! Remediation messages shared across commands.

/// The command that fixes an unconfigured install.
pub const INIT_HINT: &str = "npx aitrack init";

pub const NO_CONFIG_MESSAGE: &str = "No config found. Run: npx aitrack init";

pub const REPO_NOT_CLONED_MESSAGE: &str = "Repo not cloned. Run: npx aitrack init";

pub const REPO_URL_UNSET_MESSAGE: &str = "Warning: repoUrl is not set. Run: npx aitrack init";
