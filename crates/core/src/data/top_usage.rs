use std::cmp::Ordering;

use indexmap::IndexMap;
use serde::Serialize;

use crate::data::aggregate::{DateFilter, aggregate_models, date_in_filter, has_unpriced_usage};
use crate::data::compact::is_synthetic_model;
use crate::data::project_usage::{ProjectUsage, aggregate_projects};
use crate::data::sort::compare_by_cost_then_tokens;
use crate::data::types::ProviderData;
use crate::providers::provider_label;

/// Ranking days, models or projects by tokens or by cost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TopSort {
    Tokens,
    Cost,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayEntryAccumulator {
    pub date: String,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub by_provider: IndexMap<String, u64>,
    pub unpriced_models: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAccumulator {
    pub provider_key: String,
    pub provider: String,
    pub model: String,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub days: u64,
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAccumulator {
    pub project: String,
    /// The remainder with no project, ranked like the rest so it is not hidden.
    pub unattributed: bool,
    pub tokens: u64,
    pub cost: Option<f64>,
    pub has_unpriced_tokens: bool,
    pub by_provider: IndexMap<String, u64>,
}

fn compare_top(a: (u64, Option<f64>), b: (u64, Option<f64>), sort: TopSort) -> Ordering {
    let (a_cost, b_cost) = (a.1.unwrap_or(0.0), b.1.unwrap_or(0.0));
    match sort {
        TopSort::Tokens => b.0.cmp(&a.0).then(b_cost.partial_cmp(&a_cost).unwrap_or(Ordering::Equal)),
        TopSort::Cost => compare_by_cost_then_tokens(a_cost, a.0, b_cost, b.0),
    }
}

/// The provider with the most tokens; the first such on a tie.
pub fn top_provider_key(by_provider: &IndexMap<String, u64>) -> Option<&str> {
    let mut entries: Vec<(&String, &u64)> = by_provider.iter().collect();
    entries.sort_by(|a, b| b.1.cmp(a.1));
    entries.first().map(|(key, _)| key.as_str())
}

pub fn top_days(data: &ProviderData, limit: usize, sort: TopSort, filter: &DateFilter) -> Vec<DayEntryAccumulator> {
    let mut by_date: IndexMap<String, DayEntryAccumulator> = IndexMap::new();
    for (provider, days) in data {
        for (date, day) in days {
            if !date_in_filter(*date, filter) {
                continue;
            }
            let key = date.to_string();
            let accumulator = by_date.entry(key.clone()).or_insert_with(|| DayEntryAccumulator {
                date: key,
                tokens: 0,
                cost: None,
                by_provider: IndexMap::new(),
                unpriced_models: Vec::new(),
            });
            let tokens = day.counts.input_tokens + day.counts.output_tokens;
            accumulator.tokens += tokens;
            *accumulator.by_provider.entry(provider.clone()).or_default() += tokens;
            for (model, counts) in &day.by_model {
                if has_unpriced_usage(counts)
                    && !is_synthetic_model(model)
                    && !accumulator.unpriced_models.contains(model)
                {
                    accumulator.unpriced_models.push(model.clone());
                }
            }
            if let Some(cost) = day.counts.cost_usd {
                accumulator.cost = Some(accumulator.cost.unwrap_or(0.0) + cost);
            }
        }
    }
    let mut all: Vec<DayEntryAccumulator> = by_date.into_values().collect();
    all.sort_by(|a, b| compare_top((a.tokens, a.cost), (b.tokens, b.cost), sort));
    all.truncate(limit);
    all
}

pub fn top_models(data: &ProviderData, limit: usize, sort: TopSort, filter: &DateFilter) -> Vec<ModelAccumulator> {
    let mut all: Vec<ModelAccumulator> = Vec::new();
    for (provider, days) in data {
        all.extend(aggregate_models(days, filter).into_iter().map(|(model, agg)| ModelAccumulator {
            provider_key: provider.clone(),
            provider: provider_label(provider).to_owned(),
            model,
            tokens: agg.input_tokens + agg.output_tokens,
            cost: agg.has_cost.then_some(agg.cost_usd),
            days: agg.days,
            has_unpriced_tokens: agg.has_unpriced_tokens,
        }));
    }
    all.sort_by(|a, b| compare_top((a.tokens, a.cost), (b.tokens, b.cost), sort));
    all.truncate(limit);
    all
}

fn to_project_accumulator(usage: &ProjectUsage) -> ProjectAccumulator {
    ProjectAccumulator {
        project: usage.project.clone(),
        unattributed: usage.unattributed,
        tokens: usage.tokens,
        cost: usage.has_cost.then_some(usage.cost_usd),
        has_unpriced_tokens: usage.has_unpriced_tokens,
        by_provider: usage.providers.iter().map(|p| (p.key.clone(), p.tokens)).collect(),
    }
}

pub fn top_projects(data: &ProviderData, limit: usize, sort: TopSort, filter: &DateFilter) -> Vec<ProjectAccumulator> {
    let breakdown = aggregate_projects(data, filter);
    let mut all: Vec<ProjectAccumulator> =
        breakdown.projects.iter().chain(breakdown.unattributed.as_ref()).map(to_project_accumulator).collect();
    all.sort_by(|a, b| compare_top((a.tokens, a.cost), (b.tokens, b.cost), sort));
    all.truncate(limit);
    all
}

/// Models left unpriced in a top-days or top-models ranking, sorted.
pub fn unpriced_top_models(days: &[DayEntryAccumulator], models: &[ModelAccumulator]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let unpriced = days
        .iter()
        .flat_map(|d| d.unpriced_models.iter())
        .chain(models.iter().filter(|m| m.has_unpriced_tokens).map(|m| &m.model));
    for name in unpriced {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    names.sort();
    names
}
