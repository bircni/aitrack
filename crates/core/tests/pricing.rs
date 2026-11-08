//! Costs against 4.x's, bit for bit, recorded before 4.x was removed.

use std::path::Path;

use aitrack_core::data::types::TokenCounts;
use aitrack_core::pricing::cost::{
    FallbackCollector, estimate_claude_cost_from_aggregate, estimate_claude_cost_from_stored_counts,
    estimate_codex_cost, estimate_cursor_cost,
};
use aitrack_core::pricing::model_pricing::ModelPricing;
use aitrack_core::pricing::store::PricingStore;
use serde_json::Value;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pricing").join(name)).unwrap()
}

fn bits(cost: Option<f64>) -> Value {
    cost.map_or(Value::Null, |x| Value::String(format!("{:016x}", x.to_bits())))
}

fn check(pricing: &ModelPricing, recorded: &str) {
    let expected: Value = serde_json::from_str(recorded).unwrap();
    assert_eq!(pricing.updated_at(), expected["updatedAt"]);
    let counts: Vec<TokenCounts> = serde_json::from_value(expected["counts"].clone()).unwrap();
    let rows = expected["rows"].as_array().unwrap();
    assert!(rows.len() > 500);
    for row in rows {
        let model = row[0].as_str().unwrap();
        let c = &counts[usize::try_from(row[1].as_u64().unwrap()).unwrap()];
        let date = row[2].as_str();
        let fallbacks = FallbackCollector::default();
        let fb = Some(&fallbacks);
        let got = [
            bits(estimate_claude_cost_from_stored_counts(pricing, model, c, date, fb)),
            bits(estimate_claude_cost_from_aggregate(pricing, model, c.input_tokens, c.output_tokens, date, fb)),
            bits(estimate_codex_cost(
                pricing,
                model,
                c.input_tokens,
                c.output_tokens,
                c.cached_input_tokens.unwrap_or(0),
                date,
                fb,
            )),
            bits(estimate_cursor_cost(pricing, model, c, date)),
            Value::from(fallbacks.drain()),
        ];
        assert_eq!(Value::from(got.to_vec()), Value::from(row.as_array().unwrap()[3..].to_vec()), "{model} {row}");
    }
    for row in expected["arithmetic"].as_array().unwrap() {
        let model = row[0].as_str().unwrap();
        let c: TokenCounts = serde_json::from_value(row[1].clone()).unwrap();
        let date = Some("2026-03-08");
        let got = [
            bits(estimate_claude_cost_from_stored_counts(pricing, model, &c, date, None)),
            bits(estimate_codex_cost(
                pricing,
                model,
                c.input_tokens,
                c.output_tokens,
                c.cached_input_tokens.unwrap_or(0),
                date,
                None,
            )),
            bits(estimate_cursor_cost(pricing, model, &c, date)),
        ];
        assert_eq!(Value::from(got.to_vec()), Value::from(row.as_array().unwrap()[2..].to_vec()), "{row}");
    }
}

#[test]
fn bundled_tables_price_every_model_as_4x_does() {
    check(&PricingStore::bundled(), &fixture("costs-bundled.json"));
}

#[test]
fn a_newer_pack_merges_and_fills_gaps_from_catalogs_as_4x_does() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("pack.json"), fixture("synthetic-pack.json").trim_end()).unwrap();
    let store = PricingStore::open(dir.path());
    check(&store.current(), &fixture("costs-pack.json"));
}
