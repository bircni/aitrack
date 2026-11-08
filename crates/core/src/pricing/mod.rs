pub mod catalog;
pub mod cost;
pub mod model_pricing;
pub mod rates;
pub mod store;
pub mod supplement;

use self::cost::{FallbackCollector, estimate_claude_cost_from_stored_counts, estimate_codex_cost};
use self::model_pricing::ModelPricing;
use crate::data::types::TokenCounts;
use crate::day::Day;
use crate::readers::provider::Pricing;

/// The readers' view of the rates, recording family-fallback guesses when asked to.
pub struct ReaderPricing<'a> {
    pub pricing: &'a ModelPricing,
    pub fallbacks: Option<&'a FallbackCollector>,
}

impl Pricing for ReaderPricing<'_> {
    fn fingerprint(&self) -> String {
        self.pricing.fingerprint().to_owned()
    }

    fn claude_cost(&self, model: &str, counts: &TokenCounts, date: Day) -> Option<f64> {
        estimate_claude_cost_from_stored_counts(self.pricing, model, counts, Some(&date.to_string()), self.fallbacks)
    }

    fn codex_cost(&self, model: &str, input: u64, output: u64, cached: u64, date: Day) -> Option<f64> {
        estimate_codex_cost(self.pricing, model, input, output, cached, Some(&date.to_string()), self.fallbacks)
    }
}
pub mod reprice;
