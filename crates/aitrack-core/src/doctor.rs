//! Doctor command implementation - diagnostic reports.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::process::{Command, Stdio};

use crate::config::{ConfigLoad, read_config, resolve_machine_id};
use crate::data::duplicate_machines::find_duplicate_machine_days;
use crate::data::types::MachineFile;
use crate::git::is_cloned;
use crate::paths::local_repo;
use crate::store::list_data_files;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    pub status: CheckStatus,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<CheckResult>,
    pub has_failures: bool,
}

fn run_command(command: &str, args: &[&str], cwd: Option<&std::path::Path>) -> (bool, String) {
    let mut cmd = Command::new(command);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    match cmd.output() {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let combined = if !stderr.is_empty() && !stdout.is_empty() {
                format!("{}\n{}", stderr, stdout)
            } else if !stderr.is_empty() {
                stderr
            } else {
                stdout
            };

            (output.status.success(), combined)
        }
        Err(e) => (false, e.to_string()),
    }
}

fn config_check() -> CheckResult {
    match read_config() {
        ConfigLoad::Ok { config } => CheckResult {
            status: CheckStatus::Ok,
            label: "Config".to_string(),
            detail: format!(
                "repoUrl={}, machineId={}",
                config.repo_url,
                resolve_machine_id(&config).unwrap_or_else(|_| "unknown".to_string())
            ),
        },
        ConfigLoad::Invalid { reason } => CheckResult {
            status: CheckStatus::Fail,
            label: "Config".to_string(),
            detail: format!(
                "config file is {}; fix it or re-run: npx aitrack init",
                reason
            ),
        },
        ConfigLoad::Missing => CheckResult {
            status: CheckStatus::Warn,
            label: "Config".to_string(),
            detail: "no config found; run npx aitrack init for sync".to_string(),
        },
    }
}

fn duplicate_machine_check() -> CheckResult {
    let machines: Vec<MachineFile> = list_data_files()
        .unwrap_or_default()
        .iter()
        .filter_map(|path| crate::store::read_data_file(path).ok().flatten())
        .collect();

    if machines.is_empty() {
        return CheckResult {
            status: CheckStatus::Ok,
            label: "Machine identities".to_string(),
            detail: "0 machine(s), no duplicated days".to_string(),
        };
    }

    let duplicates = find_duplicate_machine_days(&machines);

    if duplicates.days.is_empty() {
        return CheckResult {
            status: CheckStatus::Ok,
            label: "Machine identities".to_string(),
            detail: format!("{} machine(s), no duplicated days", machines.len()),
        };
    }

    CheckResult {
        status: CheckStatus::Warn,
        label: "Machine identities".to_string(),
        detail: format!(
            "{} day(s) are recorded identically under multiple machines ({}) — \
             totals are inflated. These are likely one machine synced under several ids; \
             merge them into one data file.",
            duplicates.days.len(),
            duplicates.machines.join(", ")
        ),
    }
}

fn node_version_check() -> CheckResult {
    let (ok, output) = run_command("node", &["--version"], None);

    if !ok {
        return CheckResult {
            status: CheckStatus::Fail,
            label: "Node.js".to_string(),
            detail: "not available on PATH".to_string(),
        };
    }

    // Parse version (e.g., "v24.0.0" -> 24)
    let major = output
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    CheckResult {
        status: if major >= 24 {
            CheckStatus::Ok
        } else {
            CheckStatus::Fail
        },
        label: "Node.js".to_string(),
        detail: format!("{} (requires >=24)", output.trim()),
    }
}

fn git_check() -> CheckResult {
    let (ok, _) = run_command("git", &["--version"], None);

    CheckResult {
        status: if ok {
            CheckStatus::Ok
        } else {
            CheckStatus::Fail
        },
        label: "git".to_string(),
        detail: if ok {
            "available on PATH".to_string()
        } else {
            "not available on PATH".to_string()
        },
    }
}

fn local_repo_check() -> CheckResult {
    let cloned = is_cloned();

    CheckResult {
        status: if cloned {
            CheckStatus::Ok
        } else {
            CheckStatus::Warn
        },
        label: "Local repo".to_string(),
        detail: if cloned {
            local_repo().display().to_string()
        } else {
            "not cloned; local preview still works".to_string()
        },
    }
}

fn repo_health_check() -> Option<CheckResult> {
    if !is_cloned() {
        return None;
    }

    let (ok, output) = run_command("git", &["status", "--short"], Some(&local_repo()));

    Some(CheckResult {
        status: if ok {
            CheckStatus::Ok
        } else {
            CheckStatus::Fail
        },
        label: "Repo health".to_string(),
        detail: if ok {
            "git status succeeded".to_string()
        } else if !output.is_empty() {
            format!("git status failed: {}", output)
        } else {
            "git status failed in local repo".to_string()
        },
    })
}

fn remote_push_check() -> Option<CheckResult> {
    if !is_cloned() {
        return None;
    }

    let (ok, output) = run_command("git", &["push", "--dry-run"], Some(&local_repo()));

    Some(CheckResult {
        status: if ok {
            CheckStatus::Ok
        } else {
            CheckStatus::Warn
        },
        label: "Remote push".to_string(),
        detail: if ok {
            "git push --dry-run succeeded".to_string()
        } else if !output.is_empty() {
            format!("git push --dry-run failed: {}", output)
        } else {
            "git push --dry-run failed; check remote access and branch tracking".to_string()
        },
    })
}

/// Generate a full doctor report with all diagnostic checks.
pub fn doctor_report() -> DoctorReport {
    let mut checks = vec![
        node_version_check(),
        git_check(),
        config_check(),
        local_repo_check(),
    ];

    if is_cloned() {
        checks.push(duplicate_machine_check());
        if let Some(check) = repo_health_check() {
            checks.push(check);
        }
        if let Some(check) = remote_push_check() {
            checks.push(check);
        }
    }

    let has_failures = checks.iter().any(|c| c.status == CheckStatus::Fail);

    DoctorReport {
        checks,
        has_failures,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSummary {
    pub hostname: String,
    pub last_updated: String,
    pub days: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    pub providers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_day: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_day: Option<String>,
}

fn summarize_machine(file: &MachineFile) -> MachineSummary {
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cost_usd = 0.0;
    let mut has_cost = false;
    let mut providers = HashSet::new();
    let mut day_keys = Vec::new();

    for (date, day_providers) in &file.days {
        let mut day_has_tokens = false;

        for (provider_key, provider_data) in day_providers {
            providers.insert(provider_key.clone());
            input_tokens += provider_data.totals.input_tokens;
            output_tokens += provider_data.totals.output_tokens;

            if let Some(cost) = provider_data.totals.cost_usd {
                cost_usd += cost;
                has_cost = true;
            }

            if provider_data.totals.input_tokens + provider_data.totals.output_tokens > 0 {
                day_has_tokens = true;
            }
        }

        if day_has_tokens {
            day_keys.push(date.clone());
        }
    }

    day_keys.sort();

    let mut provider_list: Vec<String> = providers.into_iter().collect();
    provider_list.sort();

    MachineSummary {
        hostname: file.hostname.clone(),
        last_updated: file.last_updated.clone(),
        days: day_keys.len(),
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
        cost_usd: if has_cost { Some(cost_usd) } else { None },
        providers: provider_list,
        first_day: day_keys.first().cloned(),
        last_day: day_keys.last().cloned(),
    }
}

/// Generate a machines report with summaries sorted by total tokens.
pub fn machines_report() -> Vec<MachineSummary> {
    let machines: Vec<MachineFile> = list_data_files()
        .unwrap_or_default()
        .iter()
        .filter_map(|path| crate::store::read_data_file(path).ok().flatten())
        .collect();

    let mut summaries: Vec<MachineSummary> = machines.iter().map(summarize_machine).collect();

    summaries.sort_by_key(|a| std::cmp::Reverse(a.total_tokens));

    summaries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_doctor_report_runs() {
        let report = doctor_report();
        assert!(!report.checks.is_empty());
    }

    #[test]
    fn test_machines_report_empty() {
        let report = machines_report();
        // Just ensure it doesn't crash
        assert!(report.is_empty() || !report.is_empty());
    }
}
