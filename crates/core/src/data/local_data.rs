//! This machine's file: built from the logs, laid over what is persisted, in the order 4.x writes it.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::data::compact::{compact_days, is_compacted_day};
use crate::data::types::{
    CURRENT_SCHEMA_VERSION, CountsByKey, DayBucket, DayMap, MachineDays, MachineFile, ProviderDay, TokenCounts,
};
use crate::day::Day;
use crate::js::locale_compare;
use crate::pricing::model_pricing::ModelPricing;
use crate::time::{UNKNOWN_TIMEZONE, iso_millis};

/// The fields a machine file stores, in its key order; `hasUnpricedTokens` only when true.
fn token_count_fields(counts: &TokenCounts) -> TokenCounts {
    TokenCounts {
        has_unpriced_tokens: (counts.has_unpriced_tokens == Some(true)).then_some(true),
        unpriced_before_cost: false,
        ..counts.clone()
    }
}

/// Sorted by key, so the serialized file does not change when only the read order did.
fn sorted_counts(by_key: Option<&CountsByKey>) -> Option<CountsByKey> {
    let mut entries: Vec<(&String, &TokenCounts)> = by_key?.iter().collect();
    if entries.is_empty() {
        return None;
    }
    entries.sort_by(|a, b| locale_compare(a.0, b.0));
    Some(entries.into_iter().map(|(k, v)| (k.clone(), token_count_fields(v))).collect())
}

/// This machine's file from its providers' day maps. With `include_local_dirs`, keeps the working
/// directories of work with no remote, for `--dir` on this machine; never synced.
#[must_use]
pub fn build_machine_data(
    machine_id: &str,
    providers: &IndexMap<String, DayMap>,
    timezone: &str,
    now: jiff::Timestamp,
    include_local_dirs: bool,
) -> MachineFile {
    let mut days: MachineDays = IndexMap::new();
    for (provider, day_map) in providers {
        for (date, day) in day_map {
            let by_model =
                day.by_model.iter().map(|(model, counts)| (model.clone(), token_count_fields(counts))).collect();
            let provider_day = ProviderDay {
                by_model,
                totals: token_count_fields(&day.counts),
                by_project: sorted_counts(day.by_project.as_ref()),
                by_cwd: if include_local_dirs { sorted_counts(day.by_cwd.as_ref()) } else { None },
            };
            days.entry(*date).or_default().insert(provider.clone(), provider_day);
        }
    }
    MachineFile {
        schema_version: CURRENT_SCHEMA_VERSION,
        hostname: machine_id.to_owned(),
        timezone: timezone.to_owned(),
        day_bucket: DayBucket::Local,
        last_updated: iso_millis(now),
        days,
    }
}

#[must_use]
pub fn machine_has_data(machine: &MachineFile) -> bool {
    !machine.days.is_empty()
}

const fn day_tokens(day: &ProviderDay) -> u64 {
    day.totals.input_tokens + day.totals.output_tokens
}

/// How many persisted provider-days a fresh read still covers with fewer tokens, so would not replace.
#[must_use]
pub fn ratcheted_provider_days(persisted: Option<&MachineDays>, fresh: &MachineDays) -> usize {
    persisted.map_or(0, |persisted| {
        persisted
            .iter()
            .flat_map(|(date, providers)| providers.iter().map(move |(key, day)| (date, key, day)))
            .filter(|(date, key, day)| {
                fresh
                    .get(*date)
                    .and_then(|f| f.get(*key))
                    .is_some_and(|fresh_day| day_tokens(fresh_day) < day_tokens(day))
            })
            .count()
    })
}

/// Persisted days overlaid with fresh ones: the larger day wins, because tools prune their logs.
/// Dates are sorted and providers ordered by `localeCompare`, so the file is stable.
#[must_use]
pub fn merge_persisted_days(persisted: Option<&MachineDays>, fresh: &MachineDays) -> MachineDays {
    let mut dates: Vec<Day> =
        persisted.into_iter().flat_map(|p| p.keys().copied()).chain(fresh.keys().copied()).collect();
    dates.sort();
    dates.dedup();
    let mut days = MachineDays::new();
    for date in dates {
        let mut providers: IndexMap<String, ProviderDay> =
            persisted.and_then(|p| p.get(&date)).cloned().unwrap_or_default();
        for (key, fresh_day) in fresh.get(&date).into_iter().flatten() {
            let persisted_day = providers.get(key);
            // An equal day keeps its compacted form, so fresh logs do not undo it on every sync.
            let unchanged_compacted =
                persisted_day.is_some_and(|p| is_compacted_day(p) && day_tokens(fresh_day) == day_tokens(p));
            match persisted_day {
                None => {
                    providers.insert(key.clone(), fresh_day.clone());
                }
                Some(p) if day_tokens(fresh_day) >= day_tokens(p) && !unchanged_compacted => {
                    providers.insert(key.clone(), fresh_day.clone());
                }
                Some(p) if unchanged_compacted && p.by_project.is_none() && fresh_day.by_project.is_some() => {
                    // Backfill projects without undoing the compaction.
                    let backfilled = ProviderDay { by_project: fresh_day.by_project.clone(), ..p.clone() };
                    providers.insert(key.clone(), backfilled);
                }
                Some(_) => {}
            }
        }
        let mut sorted: Vec<(String, ProviderDay)> = providers.into_iter().collect();
        sorted.sort_by(|a, b| locale_compare(&a.0, &b.0));
        days.insert(date, sorted.into_iter().collect());
    }
    days
}

/// UTC-12 to UTC+14: the furthest a timezone change can move a message's calendar date.
const MAX_ZONE_SHIFT_DAYS: i64 = 2;

fn provider_dates(days: &MachineDays, provider: &str) -> Vec<Day> {
    let mut dates: Vec<Day> = days.iter().filter(|(_, p)| p.contains_key(provider)).map(|(d, _)| *d).collect();
    dates.sort();
    dates
}

fn tokens_in_range(days: &MachineDays, provider: &str, dates: &[Day], from: Day, to: Day) -> u64 {
    dates
        .iter()
        .filter(|date| **date >= from && **date <= to)
        .filter_map(|date| days.get(date).and_then(|p| p.get(provider)))
        .map(day_tokens)
        .sum()
}

/// The persisted days to merge with after this machine changed timezone: a provider's days the logs
/// fully explain are dropped so re-bucketed fresh days replace them rather than counting twice.
#[must_use]
pub fn rebucket_persisted_days(persisted: &MachineFile, fresh: &MachineFile) -> MachineDays {
    if persisted.timezone == fresh.timezone || persisted.timezone == UNKNOWN_TIMEZONE || persisted.timezone.is_empty() {
        return persisted.days.clone();
    }
    let mut providers: Vec<&String> = Vec::new();
    let mut seen = HashSet::new();
    for day in persisted.days.values() {
        for key in day.keys() {
            if seen.insert(key) {
                providers.push(key);
            }
        }
    }
    let mut drop_from: HashMap<&str, Day> = HashMap::new();
    for provider in providers {
        let persisted_dates = provider_dates(&persisted.days, provider);
        let fresh_dates = provider_dates(&fresh.days, provider);
        let (Some(first_persisted), Some(first_fresh), Some(last_persisted)) =
            (persisted_dates.first(), fresh_dates.first(), persisted_dates.last())
        else {
            continue;
        };
        // Older history means the oldest logged day may be partial, so it keeps the ratchet too.
        let earliest = (*first_persisted).min(*first_fresh);
        let from = if earliest < first_fresh.shift(-MAX_ZONE_SHIFT_DAYS) { first_fresh.shift(1) } else { earliest };
        let to = last_persisted.shift(MAX_ZONE_SHIFT_DAYS);
        if tokens_in_range(&fresh.days, provider, &fresh_dates, from, to)
            >= tokens_in_range(&persisted.days, provider, &persisted_dates, from, to)
        {
            drop_from.insert(provider, from);
        }
    }
    if drop_from.is_empty() {
        return persisted.days.clone();
    }
    persisted
        .days
        .iter()
        .filter_map(|(date, providers)| {
            let kept: IndexMap<String, ProviderDay> = providers
                .iter()
                .filter(|(key, _)| drop_from.get(key.as_str()).is_none_or(|from| date < from))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            (!kept.is_empty()).then_some((*date, kept))
        })
        .collect()
}

/// The stable order a machine file is written in.
#[must_use]
pub fn canonical_days(days: &MachineDays) -> MachineDays {
    merge_persisted_days(Some(days), &MachineDays::new())
}

/// What a write path stores for this machine: the logs over what is persisted, then compaction.
pub fn outgoing_days(
    pricing: &ModelPricing,
    persisted: Option<&MachineDays>,
    fresh: &MachineDays,
    compact_after_days: Option<u64>,
    today: Day,
) -> MachineDays {
    let merged = merge_persisted_days(persisted, fresh);
    match compact_after_days {
        Some(after) => compact_days(pricing, &merged, after, today),
        None => merged,
    }
}
