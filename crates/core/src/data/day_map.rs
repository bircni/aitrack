use crate::data::types::{CountsByKey, DayEntry, DayMap, TokenCounts};
use crate::day::Day;

/// Where a message's usage is counted; `cwd` only for work with no git remote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attribution {
    pub project: String,
    pub cwd: Option<String>,
}

pub fn get_or_create_day(days: &mut DayMap, date: Day) -> &mut DayEntry {
    days.entry(date).or_default()
}

pub fn add_token_counts(dest: &mut TokenCounts, source: &TokenCounts) {
    let add = |dest: &mut Option<u64>, source: Option<u64>| {
        if let Some(n) = source {
            *dest = Some(dest.unwrap_or(0) + n);
        }
    };
    dest.input_tokens += source.input_tokens;
    dest.output_tokens += source.output_tokens;
    add(&mut dest.raw_input_tokens, source.raw_input_tokens);
    add(&mut dest.cached_input_tokens, source.cached_input_tokens);
    add(&mut dest.cache_creation_input_tokens, source.cache_creation_input_tokens);
    add(&mut dest.cache_creation_1h_input_tokens, source.cache_creation_1h_input_tokens);
    if source.has_unpriced_tokens == Some(true) {
        dest.has_unpriced_tokens = Some(true);
    }
    if let Some(cost) = source.cost_usd {
        dest.cost_usd = Some(dest.cost_usd.unwrap_or(0.0) + cost);
    }
}

/// Tokens with a missing cost are flagged, so a partly priced sum says so.
#[must_use]
pub fn flag_unpriced(counts: &TokenCounts) -> TokenCounts {
    let mut counts = counts.clone();
    if counts.cost_usd.is_none() && counts.input_tokens + counts.output_tokens > 0 {
        counts.has_unpriced_tokens = Some(true);
    }
    counts
}

pub fn add_counts_by_key(record: &mut CountsByKey, key: &str, counts: &TokenCounts) {
    add_token_counts(record.entry(key.to_owned()).or_default(), counts);
}

pub fn add_project_usage(day: &mut DayEntry, attribution: &Attribution, counts: &TokenCounts) {
    add_counts_by_key(day.by_project.get_or_insert_default(), &attribution.project, counts);
    if let Some(cwd) = &attribution.cwd {
        add_counts_by_key(day.by_cwd.get_or_insert_default(), cwd, counts);
    }
}

/// One model's usage onto a day: the model row and the day totals. Readers call this once per
/// event; merging must not, since a merged day already holds both.
pub fn add_model_usage(day: &mut DayEntry, model: &str, counts: &TokenCounts, attribution: Option<&Attribution>) {
    let priced = flag_unpriced(counts);
    add_token_counts(day.by_model.entry(model.to_owned()).or_default(), &priced);
    add_token_counts(&mut day.counts, &priced);
    if let Some(attribution) = attribution {
        add_project_usage(day, attribution, &priced);
    }
}

pub fn merge_day_maps(dst: &mut DayMap, source: &DayMap) {
    for (date, source_day) in source {
        let dst_day = get_or_create_day(dst, *date);
        add_token_counts(&mut dst_day.counts, &source_day.counts);
        for (model, counts) in &source_day.by_model {
            add_counts_by_key(&mut dst_day.by_model, model, counts);
        }
        for (project, counts) in source_day.by_project.iter().flatten() {
            add_counts_by_key(dst_day.by_project.get_or_insert_default(), project, counts);
        }
        for (cwd, counts) in source_day.by_cwd.iter().flatten() {
            add_counts_by_key(dst_day.by_cwd.get_or_insert_default(), cwd, counts);
        }
    }
}

/// A fresh map holding all of these merged, so a day several share counts once.
pub fn merge_all_day_maps<'a>(maps: impl IntoIterator<Item = &'a DayMap>) -> DayMap {
    let mut merged = DayMap::new();
    for map in maps {
        merge_day_maps(&mut merged, map);
    }
    merged
}

#[must_use]
pub fn filter_day_map_by_year(days: &DayMap, year: i16) -> DayMap {
    days.iter().filter(|(date, _)| date.year() == year).map(|(d, e)| (*d, e.clone())).collect()
}
