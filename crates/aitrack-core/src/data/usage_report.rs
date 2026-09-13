//! Usage report generation and comparison.

use super::aggregate::{AggregateModelsFilter, aggregate_models_by_day_map};
use super::types::ProviderData;
use super::usage_data::{LoadOptions, load_merged_provider_data};
use super::usage_periods::{
    UsagePeriod, UsageWindow, UsageWindowOptions, compute_previous_usage_window,
    compute_usage_window,
};

#[derive(Debug, Clone)]
pub struct UsageReportOptions {
    pub period: UsagePeriod,
    pub providers: Option<Vec<String>>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub n: Option<usize>,
    pub refresh_live: bool,
}

#[derive(Debug, Clone)]
pub struct UsageReportRow {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tokens: u64,
    pub cached_input_tokens: u64,
    pub has_cached: bool,
    pub cost_usd: f64,
    pub has_cost: bool,
}

#[derive(Debug, Clone)]
pub struct UsageReportProvider {
    pub key: String,
    pub label: String,
    pub rows: Vec<UsageReportRow>,
    pub subtotal_tokens: u64,
    pub subtotal_cost_usd: f64,
    pub subtotal_has_cost: bool,
}

#[derive(Debug, Clone)]
pub struct UsageReportTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tokens: u64,
    pub cached_input_tokens: u64,
    pub has_cached: bool,
    pub cost_usd: f64,
    pub has_cost: bool,
}

#[derive(Debug, Clone)]
pub struct UsageReport {
    pub window_label: String,
    pub providers: Vec<UsageReportProvider>,
    pub totals: UsageReportTotals,
    pub row_count: usize,
}

#[derive(Debug, Clone)]
pub struct UsageComparisonMetric {
    pub current: f64,
    pub previous: f64,
    pub delta: f64,
    pub percent_change: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct UsageModelComparison {
    pub provider_key: String,
    pub provider_label: String,
    pub model: String,
    pub tokens: UsageComparisonMetric,
    pub cost_usd: UsageComparisonMetric,
    pub has_cost: bool,
}

#[derive(Debug, Clone)]
pub struct UsageComparison {
    pub previous_window_label: String,
    pub totals: UsageComparisonTotals,
    pub models: Vec<UsageModelComparison>,
}

#[derive(Debug, Clone)]
pub struct UsageComparisonTotals {
    pub tokens: UsageComparisonMetric,
    pub cost_usd: UsageComparisonMetric,
    pub has_cost: bool,
}

#[derive(Debug, Clone)]
pub struct UsageComparisonReport {
    pub current: UsageReport,
    pub previous: UsageReport,
    pub comparison: UsageComparison,
}

fn build_usage_report_from_data(provider_data: &ProviderData, window: &UsageWindow) -> UsageReport {
    let filter = AggregateModelsFilter {
        start: Some(window.start.clone()),
        end: Some(window.end.clone()),
        year: None,
    };

    let mut providers = Vec::new();
    let mut totals = UsageReportTotals {
        input_tokens: 0,
        output_tokens: 0,
        tokens: 0,
        cached_input_tokens: 0,
        has_cached: false,
        cost_usd: 0.0,
        has_cost: false,
    };
    let mut row_count = 0;

    for (provider_key, day_map) in provider_data {
        let models = aggregate_models_by_day_map(day_map, Some(&filter));
        if models.is_empty() {
            continue;
        }

        let mut rows = Vec::new();
        let mut subtotal_tokens = 0;
        let mut subtotal_cost_usd = 0.0;
        let mut subtotal_has_cost = false;

        for (model, agg) in models {
            let tokens = agg.input_tokens + agg.output_tokens;
            rows.push(UsageReportRow {
                model,
                input_tokens: agg.input_tokens,
                output_tokens: agg.output_tokens,
                tokens,
                cached_input_tokens: agg.cached_input_tokens,
                has_cached: agg.has_cached,
                cost_usd: agg.cost_usd,
                has_cost: agg.has_cost,
            });

            subtotal_tokens += tokens;
            if agg.has_cost {
                subtotal_cost_usd += agg.cost_usd;
                subtotal_has_cost = true;
            }
        }

        row_count += rows.len();

        providers.push(UsageReportProvider {
            key: provider_key.clone(),
            label: provider_key.clone(), // Will use provider registry later
            rows,
            subtotal_tokens,
            subtotal_cost_usd,
            subtotal_has_cost,
        });

        // Update totals
        totals.tokens += subtotal_tokens;
        if subtotal_has_cost {
            totals.cost_usd += subtotal_cost_usd;
            totals.has_cost = true;
        }
    }

    UsageReport {
        window_label: window.label.clone(),
        providers,
        totals,
        row_count,
    }
}

pub fn build_usage_report(options: &UsageReportOptions) -> anyhow::Result<UsageReport> {
    let window_options = UsageWindowOptions {
        period: options.period,
        from: options.from.clone(),
        to: options.to.clone(),
        n: options.n,
    };

    let window = compute_usage_window(&window_options);

    let load_opts = LoadOptions {
        providers: options.providers.clone(),
        refresh_live: options.refresh_live,
    };

    let loaded = load_merged_provider_data(&load_opts)?;

    Ok(build_usage_report_from_data(&loaded.provider_data, &window))
}

pub fn build_usage_comparison(
    options: &UsageReportOptions,
) -> anyhow::Result<UsageComparisonReport> {
    let window_options = UsageWindowOptions {
        period: options.period,
        from: options.from.clone(),
        to: options.to.clone(),
        n: options.n,
    };

    let current_window = compute_usage_window(&window_options);
    let previous_window = compute_previous_usage_window(&window_options, Some(&current_window));

    let load_opts = LoadOptions {
        providers: options.providers.clone(),
        refresh_live: options.refresh_live,
    };

    let loaded = load_merged_provider_data(&load_opts)?;

    let current = build_usage_report_from_data(&loaded.provider_data, &current_window);
    let previous = build_usage_report_from_data(&loaded.provider_data, &previous_window);

    // Build comparison (simplified for now)
    let tokens_metric = UsageComparisonMetric {
        current: current.totals.tokens as f64,
        previous: previous.totals.tokens as f64,
        delta: current.totals.tokens as f64 - previous.totals.tokens as f64,
        percent_change: if previous.totals.tokens > 0 {
            Some(
                ((current.totals.tokens as f64 - previous.totals.tokens as f64)
                    / previous.totals.tokens as f64)
                    * 100.0,
            )
        } else {
            None
        },
    };

    let cost_metric = UsageComparisonMetric {
        current: current.totals.cost_usd,
        previous: previous.totals.cost_usd,
        delta: current.totals.cost_usd - previous.totals.cost_usd,
        percent_change: if previous.totals.cost_usd > 0.0 {
            Some(
                ((current.totals.cost_usd - previous.totals.cost_usd) / previous.totals.cost_usd)
                    * 100.0,
            )
        } else {
            None
        },
    };

    let comparison = UsageComparison {
        previous_window_label: previous_window.label,
        totals: UsageComparisonTotals {
            tokens: tokens_metric,
            cost_usd: cost_metric,
            has_cost: current.totals.has_cost,
        },
        models: Vec::new(), // Simplified for now
    };

    Ok(UsageComparisonReport {
        current,
        previous,
        comparison,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_usage_report_struct() {
        let report = UsageReport {
            window_label: "test".to_string(),
            providers: Vec::new(),
            totals: UsageReportTotals {
                input_tokens: 0,
                output_tokens: 0,
                tokens: 0,
                cached_input_tokens: 0,
                has_cached: false,
                cost_usd: 0.0,
                has_cost: false,
            },
            row_count: 0,
        };
        assert_eq!(report.window_label, "test");
    }
}
