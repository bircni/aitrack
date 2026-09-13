//! Budget comparison utilities.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetLevel {
    Ok,
    Warn,
    Over,
}

#[derive(Debug, Clone)]
pub struct BudgetStatus {
    pub level: BudgetLevel,
    /// Spent / budget, e.g. 0.86. Not clamped — can exceed 1.
    pub ratio: f64,
    pub spent_usd: f64,
    pub budget_usd: f64,
    /// Positive only when `level === 'over'`.
    pub over_usd: f64,
}

/// Warn once spend crosses this fraction of the budget.
pub const BUDGET_WARN_RATIO: f64 = 0.8;

pub fn budget_status(spent_usd: f64, budget_usd: f64) -> Option<BudgetStatus> {
    if budget_usd <= 0.0 {
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

    Some(BudgetStatus {
        level,
        ratio,
        spent_usd,
        budget_usd,
        over_usd: if level == BudgetLevel::Over {
            spent_usd - budget_usd
        } else {
            0.0
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_budget_status() {
        let status = budget_status(50.0, 100.0).unwrap();
        assert_eq!(status.level, BudgetLevel::Ok);
        assert_eq!(status.ratio, 0.5);

        let status = budget_status(85.0, 100.0).unwrap();
        assert_eq!(status.level, BudgetLevel::Warn);

        let status = budget_status(110.0, 100.0).unwrap();
        assert_eq!(status.level, BudgetLevel::Over);
        assert_eq!(status.over_usd, 10.0);
    }
}
