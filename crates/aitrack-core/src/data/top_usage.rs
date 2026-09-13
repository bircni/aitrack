//! Top usage ranking utilities.

use super::aggregate::ModelAgg;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageSortKey {
    Input,
    Output,
    Cost,
    Days,
}

/// Sort models by the specified key in descending order.
pub fn sort_models_by(
    models: &HashMap<String, ModelAgg>,
    sort_key: UsageSortKey,
) -> Vec<(String, ModelAgg)> {
    let mut entries: Vec<_> = models.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

    entries.sort_by(|a, b| {
        let val_a = match sort_key {
            UsageSortKey::Input => a.1.input_tokens as f64,
            UsageSortKey::Output => a.1.output_tokens as f64,
            UsageSortKey::Cost => a.1.cost_usd,
            UsageSortKey::Days => a.1.days as f64,
        };
        let val_b = match sort_key {
            UsageSortKey::Input => b.1.input_tokens as f64,
            UsageSortKey::Output => b.1.output_tokens as f64,
            UsageSortKey::Cost => b.1.cost_usd,
            UsageSortKey::Days => b.1.days as f64,
        };

        // Descending order
        val_b
            .partial_cmp(&val_a)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    entries
}

/// Take the top N models by a given sort key.
pub fn top_models(
    models: &HashMap<String, ModelAgg>,
    n: usize,
    sort_key: UsageSortKey,
) -> Vec<(String, ModelAgg)> {
    let sorted = sort_models_by(models, sort_key);
    sorted.into_iter().take(n).collect()
}
