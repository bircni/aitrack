//! Duplicate machine detection.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use super::types::MachineFile;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateMachineDays {
    /// Dates recorded identically under more than one machine.
    pub days: Vec<String>,
    /// The machines involved, sorted.
    pub machines: Vec<String>,
}

/// Find days that appear identically under more than one machine.
///
/// The same machine synced under two ids (a hostname that changed with the
/// network, say) leaves two data files holding byte-identical days, and every
/// all-time total then counts that usage twice. Identical payloads are the
/// signal: two machines genuinely used on the same day produce different numbers.
pub fn find_duplicate_machine_days(machines: &[MachineFile]) -> DuplicateMachineDays {
    // Map: date -> (payload_json -> hostnames)
    let mut by_day: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();

    for machine in machines {
        for (date, providers) in &machine.days {
            let payload = serde_json::to_string(&providers).unwrap_or_default();

            by_day
                .entry(date.clone())
                .or_default()
                .entry(payload)
                .or_default()
                .push(machine.hostname.clone());
        }
    }

    let mut colliding_days = HashSet::new();
    let mut colliding_machines = HashSet::new();

    for (date, payloads) in &by_day {
        for hostnames in payloads.values() {
            if hostnames.len() < 2 {
                continue;
            }
            colliding_days.insert(date.clone());
            for host in hostnames {
                colliding_machines.insert(host.clone());
            }
        }
    }

    let mut days: Vec<String> = colliding_days.into_iter().collect();
    days.sort();

    let mut machines_vec: Vec<String> = colliding_machines.into_iter().collect();
    machines_vec.sort();

    DuplicateMachineDays {
        days,
        machines: machines_vec,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::types::{DayBucket, ProviderDay, TokenCounts};
    use std::collections::HashMap;

    #[test]
    fn test_find_duplicate_machine_days_no_duplicates() {
        let machine1 = MachineFile {
            schema_version: 2,
            hostname: "machine1".to_string(),
            timezone: "UTC".to_string(),
            day_bucket: DayBucket::Local,
            last_updated: "2024-01-01".to_string(),
            days: HashMap::new(),
        };

        let result = find_duplicate_machine_days(&[machine1]);
        assert!(result.days.is_empty());
        assert!(result.machines.is_empty());
    }

    #[test]
    fn test_find_duplicate_machine_days_with_duplicates() {
        let mut day_data = HashMap::new();
        let mut provider_data = HashMap::new();
        provider_data.insert(
            "claude_code".to_string(),
            ProviderDay {
                by_model: HashMap::new(),
                totals: TokenCounts {
                    input_tokens: 100,
                    output_tokens: 50,
                    cached_input_tokens: None,
                    raw_input_tokens: None,
                    cache_creation_input_tokens: None,
                    cost_usd: None,
                },
            },
        );
        day_data.insert("2024-01-01".to_string(), provider_data.clone());

        let machine1 = MachineFile {
            schema_version: 2,
            hostname: "machine1".to_string(),
            timezone: "UTC".to_string(),
            day_bucket: DayBucket::Local,
            last_updated: "2024-01-01".to_string(),
            days: day_data.clone(),
        };

        let machine2 = MachineFile {
            schema_version: 2,
            hostname: "machine2".to_string(),
            timezone: "UTC".to_string(),
            day_bucket: DayBucket::Local,
            last_updated: "2024-01-01".to_string(),
            days: day_data,
        };

        let result = find_duplicate_machine_days(&[machine1, machine2]);
        assert_eq!(result.days, vec!["2024-01-01"]);
        assert_eq!(result.machines, vec!["machine1", "machine2"]);
    }
}
