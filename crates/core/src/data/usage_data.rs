//! Every machine's days merged for reports: other machines as synced, this one overlaid with its logs.

use std::path::PathBuf;

use indexmap::IndexMap;

use crate::Core;
use crate::config::resolve_machine_id;
use crate::data::aggregate::sum_day_map;
use crate::data::day_map::{add_counts_by_key, add_token_counts, flag_unpriced, get_or_create_day, merge_all_day_maps};
use crate::data::local_data::{build_machine_data, machine_has_data, merge_persisted_days, rebucket_persisted_days};
use crate::data::types::{DayEntry, DayMap, MachineDays, MachineFile, ProviderData, ProviderDay, TokenCounts};
use crate::day::Day;
use crate::machine_id::machine_data_filename;
use crate::pricing::cost::{PriceMode, resolve_model_cost};
use crate::pricing::model_pricing::ModelPricing;
use crate::providers::{is_synced_provider, sort_provider_keys};
use crate::store::machine_files::{list_data_files, read_data_file};
use crate::store::validate::ValidationOptions;

/// One synced provider-day onto a merged day. Stored costs are kept; models without one are priced,
/// and only that backfill is added to a stored day total: repricing history is recompute-costs' job.
pub fn merge_provider_day(
    pricing: &ModelPricing,
    rec: &mut DayEntry,
    provider: &str,
    day: &ProviderDay,
    date: Option<Day>,
) {
    let without_cost = TokenCounts { cost_usd: None, has_unpriced_tokens: None, ..day.totals.clone() };
    add_token_counts(&mut rec.counts, &without_cost);
    let date_text = date.map(|d| d.to_string());
    let (mut summed, mut backfilled, mut has_model_cost) = (0.0, 0.0, false);
    for (model, counts) in &day.by_model {
        let cost = resolve_model_cost(pricing, provider, model, counts, date_text.as_deref(), PriceMode::Merge, None);
        // A stored partial cost keeps its flag; a fresh estimate prices every token.
        let unpriced = match cost {
            None => counts.input_tokens + counts.output_tokens > 0,
            Some(_) => counts.cost_usd.is_some() && counts.has_unpriced_tokens == Some(true),
        };
        let row = rec.by_model.entry(model.clone()).or_default();
        add_token_counts(row, &TokenCounts { cost_usd: None, has_unpriced_tokens: Some(unpriced), ..counts.clone() });
        if row.has_unpriced_tokens == Some(true) {
            rec.counts.has_unpriced_tokens = Some(true);
        }
        if let Some(cost) = cost {
            row.cost_usd = Some(row.cost_usd.unwrap_or(0.0) + cost);
            summed += cost;
            has_model_cost = true;
            if counts.cost_usd.is_none() {
                backfilled += cost;
            }
        }
    }
    // Projects have no model to price from: their stored costs are summed as written.
    for (project, counts) in day.by_project.iter().flatten() {
        add_counts_by_key(rec.by_project.get_or_insert_default(), project, &flag_unpriced(counts));
    }
    for (cwd, counts) in day.by_cwd.iter().flatten() {
        add_counts_by_key(rec.by_cwd.get_or_insert_default(), cwd, &flag_unpriced(counts));
    }
    let day_cost = match day.totals.cost_usd {
        None => has_model_cost.then_some(summed),
        Some(total) => Some(total + backfilled),
    };
    if let Some(cost) = day_cost {
        rec.counts.cost_usd = Some(rec.counts.cost_usd.unwrap_or(0.0) + cost);
    }
}

fn overlay_days(pricing: &ModelPricing, data: &mut ProviderData, days: &MachineDays) {
    for (date, providers) in days {
        for (provider, day) in providers {
            if !is_synced_provider(provider) {
                continue;
            }
            let map = data.entry(provider.clone()).or_default();
            merge_provider_day(pricing, get_or_create_day(map, *date), provider, day, Some(*date));
        }
    }
}

/// One machine's days, still keyed by its own calendar.
#[derive(Clone, Debug, PartialEq)]
pub struct ZonedUsageSource {
    pub hostname: String,
    pub timezone: String,
    /// Empty for a machine only read from its local logs.
    pub last_updated: String,
    /// The machine this process runs on.
    pub current: bool,
    pub days: MachineDays,
}

/// What reports are built from: `provider_data` is the sources and the live providers merged.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ZonedUsageData {
    pub provider_data: ProviderData,
    /// Per-machine days before the merge; relative windows apply in each source's timezone.
    pub zoned_sources: Vec<ZonedUsageSource>,
    /// Live providers (Cursor), in the viewing machine's timezone.
    pub live_provider_data: ProviderData,
}

/// These machines merged with the live providers, priced the way every report prices them.
pub fn merge_usage_sources(
    pricing: &ModelPricing,
    sources: Vec<ZonedUsageSource>,
    live: ProviderData,
) -> ZonedUsageData {
    let mut provider_data = ProviderData::new();
    for source in &sources {
        overlay_days(pricing, &mut provider_data, &source.days);
    }
    for (key, days) in &live {
        provider_data.insert(key.clone(), days.clone());
    }
    ZonedUsageData { provider_data, zoned_sources: sources, live_provider_data: live }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MachineUsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// `None` when nothing could be priced.
    pub cost_usd: Option<f64>,
    pub has_unpriced_tokens: bool,
    pub days: u64,
    pub first_day: Option<Day>,
    pub last_day: Option<Day>,
    pub providers: Vec<String>,
}

/// One machine's totals through the merge `usage` uses, so the two agree on tokens and cost.
pub fn machine_usage_totals(pricing: &ModelPricing, machine: &MachineFile) -> MachineUsageTotals {
    let mut data = ProviderData::new();
    overlay_days(pricing, &mut data, &machine.days);
    let merged = merge_all_day_maps(data.values());
    let totals = sum_day_map(&merged);
    let mut active: Vec<Day> =
        merged.iter().filter(|(_, d)| d.counts.input_tokens + d.counts.output_tokens > 0).map(|(d, _)| *d).collect();
    active.sort();
    MachineUsageTotals {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cost_usd: totals.has_cost.then_some(totals.cost_usd),
        has_unpriced_tokens: merged.values().any(|d| d.counts.has_unpriced_tokens == Some(true)),
        days: totals.days,
        first_day: active.first().copied(),
        last_day: active.last().copied(),
        providers: sort_provider_keys(&data.keys().cloned().collect::<Vec<_>>()),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PersistedMachine {
    pub path: PathBuf,
    pub machine: MachineFile,
}

/// The data repo's `.git` exists.
pub fn is_cloned(core: &Core) -> bool {
    core.paths.repo.join(".git").exists()
}

/// Synced machine files that parsed.
pub fn load_persisted_machines(core: &Core) -> Vec<PersistedMachine> {
    list_data_files(core)
        .into_iter()
        .filter_map(|path| {
            read_data_file(core, &path, ValidationOptions::default()).map(|machine| PersistedMachine { path, machine })
        })
        .collect()
}

/// This machine's local logs over its persisted file, through the rule sync writes with. A machine
/// never synced is added with an empty `lastUpdated`.
#[must_use]
pub fn merge_persisted_with_local(
    persisted: &[PersistedMachine],
    local: Option<&MachineFile>,
    current_file: &str,
) -> Vec<MachineFile> {
    let Some(local) = local.filter(|l| machine_has_data(l)) else {
        return persisted.iter().map(|p| p.machine.clone()).collect();
    };
    let is_current = |p: &PersistedMachine| p.path.file_name().is_some_and(|n| n == current_file);
    let mut machines: Vec<MachineFile> = persisted
        .iter()
        .map(|entry| {
            if is_current(entry) {
                MachineFile {
                    timezone: local.timezone.clone(),
                    days: merge_persisted_days(Some(&rebucket_persisted_days(&entry.machine, local)), &local.days),
                    ..entry.machine.clone()
                }
            } else {
                entry.machine.clone()
            }
        })
        .collect();
    if !persisted.iter().any(is_current) {
        machines.push(MachineFile { last_updated: String::new(), ..local.clone() });
    }
    machines
}

#[must_use]
pub fn filter_days_by_providers(days: &MachineDays, providers: Option<&[String]>) -> MachineDays {
    let Some(providers) = providers else { return days.clone() };
    days.iter()
        .filter_map(|(date, day)| {
            let kept: IndexMap<String, ProviderDay> =
                day.iter().filter(|(k, _)| providers.contains(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
            (!kept.is_empty()).then_some((*date, kept))
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadedUsage {
    pub zoned: ZonedUsageData,
    /// Synced files only.
    pub machine_data: Vec<MachineFile>,
    /// No config or no clone: only this machine's logs are known.
    pub not_configured: bool,
}

/// Every machine's days for reports, or `None` when there is nothing at all.
pub fn load_merged_provider_data(
    core: &Core,
    pricing: &ModelPricing,
    machine_id: &str,
    local: Option<&MachineFile>,
    providers: Option<&[String]>,
    live: ProviderData,
) -> Option<LoadedUsage> {
    let config = core.try_load_config();
    let not_configured = config.is_none() || !is_cloned(core);
    let persisted = if not_configured { Vec::new() } else { load_persisted_machines(core) };
    let current_file = format!("{}.json", crate::js::trim(machine_id));
    let sources = merge_persisted_with_local(&persisted, local, &current_file)
        .into_iter()
        .map(|machine| ZonedUsageSource {
            current: machine.hostname == machine_id,
            days: filter_days_by_providers(&machine.days, providers),
            hostname: machine.hostname,
            timezone: machine.timezone,
            last_updated: machine.last_updated,
        })
        .collect();
    let live: ProviderData = live.into_iter().filter(|(_, days)| !days.is_empty()).collect();
    let zoned = merge_usage_sources(pricing, sources, live);
    if zoned.provider_data.is_empty() {
        return None;
    }
    Some(LoadedUsage { zoned, machine_data: persisted.into_iter().map(|p| p.machine).collect(), not_configured })
}

/// Machine files merged after each was clipped to its own window; live data uses the viewer's.
pub fn provider_data_for_windows(
    pricing: &ModelPricing,
    data: &ZonedUsageData,
    viewer_zone: &str,
    window_for: impl Fn(&str) -> (Day, Day),
) -> ProviderData {
    let mut out = ProviderData::new();
    for source in &data.zoned_sources {
        let (start, end) = window_for(&source.timezone);
        let clipped: MachineDays =
            source.days.iter().filter(|(d, _)| **d >= start && **d <= end).map(|(d, p)| (*d, p.clone())).collect();
        overlay_days(pricing, &mut out, &clipped);
    }
    let (start, end) = window_for(viewer_zone);
    for (key, days) in &data.live_provider_data {
        let filtered: DayMap =
            days.iter().filter(|(d, _)| **d >= start && **d <= end).map(|(d, e)| (*d, e.clone())).collect();
        if !filtered.is_empty() {
            out.insert(key.clone(), filtered);
        }
    }
    out
}

/// This machine's file from its logs, with the working directories `--dir` needs.
///
/// # Errors
///
/// When the local logs or machine id cannot be read.
pub fn build_local_machine_file(
    core: &Core,
    machine_id: &str,
    providers: Option<&[String]>,
) -> crate::error::Result<MachineFile> {
    let maps = crate::sync::read_local_provider_maps(core, None, providers)?;
    Ok(build_machine_data(machine_id, &maps, core.clock.zone_name(), core.clock.now(), true))
}

/// Machines as reports show them: others as synced, this one overlaid with its local logs.
///
/// # Errors
///
/// When the data repo cannot be read.
pub fn load_reported_machines(core: &Core) -> crate::error::Result<Vec<MachineFile>> {
    let config = core.try_load_config();
    let machine_id = resolve_machine_id(config.as_ref()).map_err(crate::error::Error::new)?;
    let persisted = if config.is_some() && is_cloned(core) { load_persisted_machines(core) } else { Vec::new() };
    let local = build_local_machine_file(core, &machine_id, None)?;
    let current_file = machine_data_filename(&machine_id).map_err(crate::error::Error::new)?;
    Ok(merge_persisted_with_local(&persisted, Some(&local), &current_file))
}

/// Every machine's days for reports; the live providers are fetched while the logs are read.
/// `local`, when given, is this machine's file already read from its logs.
///
/// # Errors
///
/// When the local logs or the data repo cannot be read.
pub fn load_usage(
    core: &Core,
    providers: Option<&[String]>,
    refresh_live: bool,
    local: Option<MachineFile>,
) -> crate::error::Result<Option<LoadedUsage>> {
    let config = core.try_load_config();
    let machine_id = resolve_machine_id(config.as_ref()).map_err(crate::error::Error::new)?;
    let wants_cursor = providers.is_none_or(|p| p.iter().any(|k| k == "cursor"));
    let max_age = if refresh_live { None } else { Some(crate::readers::cursor::cache_ttl_seconds(core)) };
    let (local, cursor) = std::thread::scope(|scope| {
        let cursor = wants_cursor.then(|| scope.spawn(|| crate::readers::cursor::read_cursor_data(core, max_age)));
        let local = local.map_or_else(|| build_local_machine_file(core, &machine_id, providers), Ok);
        (local, cursor.map(|handle| handle.join().unwrap_or_default()))
    });
    let local = local?;
    let mut live = ProviderData::new();
    if let Some(days) = cursor {
        live.insert("cursor".to_owned(), days);
    }
    let rates = core.pricing().current();
    Ok(load_merged_provider_data(core, &rates, &machine_id, Some(&local), providers, live))
}
