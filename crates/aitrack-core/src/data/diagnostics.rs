//! Diagnostic utilities for usage data.

use super::types::{MachineFile, ProviderData};

#[derive(Debug, Clone)]
pub struct DiagnosticInfo {
    pub total_days: usize,
    pub total_providers: usize,
    pub machines: Vec<MachineDiagnostic>,
}

#[derive(Debug, Clone)]
pub struct MachineDiagnostic {
    pub hostname: String,
    pub timezone: String,
    pub days_count: usize,
    pub providers_count: usize,
}

pub fn diagnose_machine_file(machine: &MachineFile) -> MachineDiagnostic {
    let days_count = machine.days.len();
    let mut providers = std::collections::HashSet::new();

    for day_providers in machine.days.values() {
        for provider_key in day_providers.keys() {
            providers.insert(provider_key.clone());
        }
    }

    MachineDiagnostic {
        hostname: machine.hostname.clone(),
        timezone: machine.timezone.clone(),
        days_count,
        providers_count: providers.len(),
    }
}

pub fn diagnose_provider_data(data: &ProviderData) -> DiagnosticInfo {
    let mut total_days_set = std::collections::HashSet::new();

    for day_map in data.values() {
        for date in day_map.keys() {
            total_days_set.insert(date.clone());
        }
    }

    DiagnosticInfo {
        total_days: total_days_set.len(),
        total_providers: data.len(),
        machines: Vec::new(),
    }
}
