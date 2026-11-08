use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetLevel {
    Ok,
    Warn,
    Over,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub level: BudgetLevel,
    /// Spent over budget; not clamped, so it can exceed 1.
    pub ratio: f64,
    #[serde(rename = "spentUSD")]
    pub spent_usd: f64,
    #[serde(rename = "budgetUSD")]
    pub budget_usd: f64,
    /// Positive only when over.
    #[serde(rename = "overUSD")]
    pub over_usd: f64,
}

/// Warn once spend crosses this fraction of the budget.
pub const BUDGET_WARN_RATIO: f64 = 0.8;

pub fn budget_status(spent_usd: f64, budget_usd: f64) -> Option<BudgetStatus> {
    if budget_usd.is_nan() || budget_usd <= 0.0 {
        return None;
    }
    let ratio = spent_usd / budget_usd;
    let level = if ratio >= 1.0 {
        BudgetLevel::Over
    } else if ratio >= BUDGET_WARN_RATIO {
        BudgetLevel::Warn
    } else {
        BudgetLevel::Ok
    };
    let over_usd = if level == BudgetLevel::Over { spent_usd - budget_usd } else { 0.0 };
    Some(BudgetStatus { level, ratio, spent_usd, budget_usd, over_usd })
}
