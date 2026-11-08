use std::path::{Component, Path, PathBuf};

use indexmap::IndexMap;
use serde::Serialize;

use crate::data::aggregate::{DateFilter, date_in_filter, has_unpriced_usage};
use crate::data::day_map::{add_token_counts, flag_unpriced};
use crate::data::project::{ALL_MODELS, UNATTRIBUTED_PROJECT};
use crate::data::sort::compare_by_cost_then_tokens;
use crate::data::types::{DayEntry, DayMap, ProviderData, TokenCounts};
use crate::providers::{is_synced_provider, provider_label};
use crate::readers::paths::absolute;

/// What a project-scoped report covers: a remote's `owner/repo`, or a folder with no remote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectSelector {
    Project(String),
    Dir(PathBuf),
}

impl ProjectSelector {
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Project(project) => project.clone(),
            Self::Dir(dir) => format!("{} (no remote)", dir.display()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProviderUsage {
    pub key: String,
    pub label: String,
    pub tokens: u64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_unpriced_tokens: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub project: String,
    pub tokens: u64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub has_cost: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_unpriced_tokens: bool,
    pub providers: Vec<ProjectProviderUsage>,
    /// The remainder of days that carry no, or only a partial, project split.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unattributed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ProjectBreakdown {
    pub projects: Vec<ProjectUsage>,
    /// Tokens synced before projects were recorded, and anything the split does not cover.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unattributed: Option<ProjectUsage>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Totals {
    tokens: u64,
    cost_usd: f64,
    has_cost: bool,
    has_unpriced_tokens: bool,
}

impl Totals {
    fn add(&mut self, counts: &TokenCounts) {
        self.tokens += counts.input_tokens + counts.output_tokens;
        if let Some(cost) = counts.cost_usd {
            self.cost_usd += cost;
            self.has_cost = true;
        }
        if has_unpriced_usage(counts) {
            self.has_unpriced_tokens = true;
        }
    }
}

#[derive(Default)]
struct Accumulator {
    totals: Totals,
    providers: IndexMap<String, Totals>,
}

fn accumulate(accumulators: &mut IndexMap<String, Accumulator>, project: &str, provider: &str, counts: &TokenCounts) {
    if counts.input_tokens + counts.output_tokens == 0 && counts.cost_usd.is_none() {
        return;
    }
    let accumulator = accumulators.entry(project.to_owned()).or_default();
    accumulator.totals.add(counts);
    accumulator.providers.entry(provider.to_owned()).or_default().add(counts);
}

fn sort_by_cost_then_tokens<T>(items: &mut [T], key: impl Fn(&T) -> (f64, u64)) {
    items.sort_by(|a, b| {
        let ((a_cost, a_tokens), (b_cost, b_tokens)) = (key(a), key(b));
        compare_by_cost_then_tokens(a_cost, a_tokens, b_cost, b_tokens)
    });
}

fn to_usage(project: &str, accumulator: &Accumulator) -> ProjectUsage {
    let mut providers: Vec<ProjectProviderUsage> = accumulator
        .providers
        .iter()
        .map(|(key, totals)| ProjectProviderUsage {
            key: key.clone(),
            label: provider_label(key).to_owned(),
            tokens: totals.tokens,
            cost_usd: totals.cost_usd,
            has_cost: totals.has_cost,
            has_unpriced_tokens: totals.has_unpriced_tokens,
        })
        .collect();
    sort_by_cost_then_tokens(&mut providers, |p| (p.cost_usd, p.tokens));
    ProjectUsage {
        project: project.to_owned(),
        tokens: accumulator.totals.tokens,
        cost_usd: accumulator.totals.cost_usd,
        has_cost: accumulator.totals.has_cost,
        has_unpriced_tokens: accumulator.totals.has_unpriced_tokens,
        providers,
        unattributed: false,
    }
}

/// What the day's project split leaves unexplained, attributed to nobody.
fn remainder(day: &DayEntry, attributed: &TokenCounts) -> Option<TokenCounts> {
    let tokens = i128::from(day.counts.input_tokens + day.counts.output_tokens)
        - i128::from(attributed.input_tokens + attributed.output_tokens);
    if tokens <= 0 {
        return None;
    }
    Some(TokenCounts {
        input_tokens: u64::try_from(tokens).expect("positive"),
        cost_usd: day.counts.cost_usd.map(|cost| 0f64.max(cost - attributed.cost_usd.unwrap_or(0.0))),
        has_unpriced_tokens: (day.counts.has_unpriced_tokens == Some(true)
            && attributed.has_unpriced_tokens != Some(true))
        .then_some(true),
        ..TokenCounts::default()
    })
}

/// Usage per project for the synced providers (Cursor has no project data). Each day's projects plus
/// its remainder add up to the day's total, so these rows always sum to the usage report.
#[must_use]
pub fn aggregate_projects(data: &ProviderData, filter: &DateFilter) -> ProjectBreakdown {
    let mut accumulators: IndexMap<String, Accumulator> = IndexMap::new();
    for (provider, days) in data {
        if !is_synced_provider(provider) {
            continue;
        }
        for (date, day) in days {
            if !date_in_filter(*date, filter) {
                continue;
            }
            let mut attributed = TokenCounts::default();
            for (project, counts) in day.by_project.iter().flatten() {
                accumulate(&mut accumulators, project, provider, counts);
                add_token_counts(&mut attributed, counts);
            }
            if let Some(rest) = remainder(day, &attributed) {
                accumulate(&mut accumulators, UNATTRIBUTED_PROJECT, provider, &flag_unpriced(&rest));
            }
        }
    }
    let unattributed = accumulators
        .shift_remove(UNATTRIBUTED_PROJECT)
        .map(|accumulator| ProjectUsage { unattributed: true, ..to_usage(UNATTRIBUTED_PROJECT, &accumulator) });
    let mut projects: Vec<ProjectUsage> = accumulators.iter().map(|(p, a)| to_usage(p, a)).collect();
    sort_by_cost_then_tokens(&mut projects, |p| (p.cost_usd, p.tokens));
    ProjectBreakdown { projects, unattributed }
}

/// `path.relative(dir, cwd)` stays inside `dir`.
fn dir_contains(dir: &Path, cwd: &Path) -> bool {
    let normal = |path: &Path| -> Vec<String> {
        absolute(path)
            .components()
            .filter(|c| !matches!(c, Component::RootDir))
            .map(|c| {
                let text = c.as_os_str().to_string_lossy().into_owned();
                if cfg!(windows) { text.to_lowercase() } else { text }
            })
            .collect()
    };
    let (dir, cwd) = (normal(dir), normal(cwd));
    cwd.len() >= dir.len() && cwd[..dir.len()] == dir[..]
}

fn slice_of(day: &DayEntry, selector: &ProjectSelector) -> Option<TokenCounts> {
    match selector {
        ProjectSelector::Project(project) => day.by_project.as_ref()?.get(project).cloned(),
        ProjectSelector::Dir(dir) => {
            let inside: Vec<&TokenCounts> = day
                .by_cwd
                .iter()
                .flatten()
                .filter(|(cwd, _)| dir_contains(dir, Path::new(cwd)))
                .map(|(_, c)| c)
                .collect();
            if inside.is_empty() {
                return None;
            }
            let mut sum = TokenCounts::default();
            for counts in inside {
                add_token_counts(&mut sum, counts);
            }
            Some(sum)
        }
    }
}

/// Each day reduced to one project's share, as a single model row since the split has no models.
#[must_use]
pub fn project_provider_data(data: &ProviderData, selector: &ProjectSelector) -> ProviderData {
    let mut scoped = ProviderData::new();
    for (provider, days) in data {
        if !is_synced_provider(provider) {
            continue;
        }
        let kept: DayMap = days
            .iter()
            .filter_map(|(date, day)| {
                let slice = slice_of(day, selector)?;
                let by_model = IndexMap::from([(ALL_MODELS.to_owned(), slice.clone())]);
                Some((*date, DayEntry { counts: slice, by_model, by_project: None, by_cwd: None }))
            })
            .collect();
        if !kept.is_empty() {
            scoped.insert(provider.clone(), kept);
        }
    }
    scoped
}
