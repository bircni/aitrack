use std::cmp::Ordering;

/// Larger cost first, then more tokens; equal entries keep their order, as a stable sort does.
pub fn compare_by_cost_then_tokens(a_cost: f64, a_tokens: u64, b_cost: f64, b_tokens: u64) -> Ordering {
    b_cost.partial_cmp(&a_cost).unwrap_or(Ordering::Equal).then(b_tokens.cmp(&a_tokens))
}
