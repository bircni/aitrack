use std::collections::HashSet;

use indexmap::IndexMap;
use serde::Serialize;

use crate::data::types::MachineFile;
use crate::day::Day;
use crate::js::{self, locale_compare};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct DuplicateMachineDays {
    /// Dates recorded identically under more than one machine.
    pub days: Vec<String>,
    /// The machines involved, sorted.
    pub machines: Vec<String>,
}

/// One machine synced under two ids leaves identical days; distinct machines never match exactly.
///
/// # Panics
///
/// Never in practice: a day always serializes.
#[must_use]
#[expect(
    clippy::expect_used,
    reason = "map keys are strings or dates and the output is an in-memory buffer, so serializing cannot fail"
)]
pub fn find_duplicate_machine_days(machines: &[MachineFile]) -> DuplicateMachineDays {
    let mut by_day: IndexMap<Day, IndexMap<String, Vec<&str>>> = IndexMap::new();
    for machine in machines {
        for (date, providers) in &machine.days {
            let payload = js::to_string(providers).expect("a day serializes");
            by_day.entry(*date).or_default().entry(payload).or_default().push(&machine.hostname);
        }
    }
    let mut days: Vec<String> = Vec::new();
    let mut hosts: Vec<String> = Vec::new();
    let (mut seen_days, mut seen_hosts) = (HashSet::new(), HashSet::new());
    for (date, payloads) in &by_day {
        for hostnames in payloads.values().filter(|h| h.len() >= 2) {
            if seen_days.insert(*date) {
                days.push(date.to_string());
            }
            for host in hostnames {
                if seen_hosts.insert(*host) {
                    hosts.push((*host).to_owned());
                }
            }
        }
    }
    days.sort_by(|a, b| locale_compare(a, b));
    hosts.sort_by(|a, b| locale_compare(a, b));
    DuplicateMachineDays { days, machines: hosts }
}
