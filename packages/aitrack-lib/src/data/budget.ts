/**
 * Comparing month-to-date spend against a configured monthly budget.
 *
 * Pure: the `usage` command feeds it the calendar-month total and the
 * `budget.monthly` config value, and renders whatever comes back.
 */
export type BudgetLevel = 'ok' | 'warn' | 'over';

export interface BudgetStatus {
  level: BudgetLevel;
  /** Spent / budget, e.g. 0.86. Not clamped — can exceed 1. */
  ratio: number;
  spentUSD: number;
  budgetUSD: number;
  /** Positive only when `level === 'over'`. */
  overUSD: number;
}

/** Warn once spend crosses this fraction of the budget. */
export const BUDGET_WARN_RATIO = 0.8;

export function budgetStatus(spentUSD: number, budgetUSD: number): BudgetStatus | null {
  if (!(budgetUSD > 0)) return null;
  const ratio = spentUSD / budgetUSD;
  const level: BudgetLevel = ratio >= 1 ? 'over' : ratio >= BUDGET_WARN_RATIO ? 'warn' : 'ok';
  return {
    level,
    ratio,
    spentUSD,
    budgetUSD,
    overUSD: level === 'over' ? spentUSD - budgetUSD : 0,
  };
}
